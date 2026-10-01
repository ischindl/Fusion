import {
  derivePostMergeEvidenceContract,
  normalizePostMergeReporterBaseUrl,
  parseDeclaredPostMergeEvidence,
  resolveGitlabConfig,
  resolveGitlabEnabled,
  type DeclaredPostMergeEvidence,
  type GlobalSettings,
  type PostMergeEvidenceContract,
  type PostMergeReporterEndpoint,
  type ProjectSettings,
} from "@fusion/core";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { emitBoundedRunAudit, type RunAuditSinkHost, type RunAuditLogger } from "../util/emit-bounded-run-audit.js";

/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
Engine half of the post-merge evidence contract. Core owns the decision rule and stays pure — it cannot
shell out and must not touch the filesystem — so the repo facts are read here and handed to
`derivePostMergeEvidenceContract`. Two sources, in this precedence:
  1. project settings `postMergeEvidence` (an operator declaration, wins outright, in both directions);
  2. observed repo facts from the project root: `git remote get-url origin` plus a count of
     `.github/workflows/*.yml|yaml`.

The reporter is a PROPERTY OF THE PROJECT, so it is read from the project root the store is bound to
(`store.getRootDir()`), not from the card's worktree — a landed card's worktree is normally already gone,
and deriving from a missing directory would silently fall back to demanding CI from a board that has none.

Measured before this fact existed: only 2 of 26 boards in this fleet can name the GitHub Actions delivery
record the built-in gate demands; 66 of 98 durable post-merge refusals name a missing CI pipeline, and each
saneca landing cost one operator waiver.

Why a cache: this is consulted on every finalization attempt of every landed card, and a `git remote` call
per attempt would put a shellout in the merge hot path. A successful observation is cached per project
root; an observation whose facts could NOT be read is deliberately not cached, so a transient failure
(mid-checkout, unmounted path) is retried on the next pass rather than remembered for the process life.
*/

const execAsync = promisify(exec);

/** Process-lifetime cache keyed by project root. Unreadable observations are never stored. */
const contractCache = new Map<string, PostMergeEvidenceContract>();
/** One audit row per (project root, reason): the derivation is stable, so a repeat row is noise. */
const auditedKeys = new Set<string>();

/** Presence-only view of the project secrets store: a key either exists here or it does not. */
export interface PostMergeSecretPresence {
  listSecrets?: () => Promise<Array<{ id?: string; key?: string }> | null>;
}

/** The public store surface this resolver needs; a store without it simply yields no contract. */
export interface PostMergeContractStore {
  getRootDir?: () => string;
  readRawProjectSettings?: () => Promise<Record<string, unknown>>;
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
  Two more reads, both for the reporter-endpoint layer only, and both optional: a store double that
  implements neither behaves exactly as it did before this change (no endpoint candidates, so an OneDev/GitLab
  board resolves `none` like RUFU-430 shipped), and `derivePostMergeEvidenceContract` never asks them.
  Global settings are read through the SAME `getGlobalSettingsStore().getSettings()` shape
  `auth/provider-registration.ts` already uses, because GitLab configuration is project → global layered and
  a project-only read would hide an instance configured once at the machine level.
  */
  getGlobalSettingsStore?: () =>
    | { getSettings(): Promise<Partial<GlobalSettings>> }
    | undefined
    | Promise<{ getSettings(): Promise<Partial<GlobalSettings>> } | undefined>;
  getSecretsStore?: () => Promise<PostMergeSecretPresence | null> | PostMergeSecretPresence | null;
}

/** Inputs the endpoint resolver reads configuration from; everything is injected-able, nothing is guessed. */
export interface PostMergeReporterEndpointInput {
  /** Raw project settings layer, exactly as `readRawProjectSettings` returned it (undefined when unreadable). */
  projectSettings?: Record<string, unknown>;
  /** The operator declaration parsed from those settings, when there was one. */
  declared?: DeclaredPostMergeEvidence;
  /**
   * Global settings layer, resolved by the caller from the store's global settings store.
   * Injectable so a test supplies the layer directly instead of touching a machine-level settings file;
   * an absent or throwing reader means "no global layer", which is what GitLab resolution defaults to.
   */
  readGlobalSettings?: () => Promise<Partial<GlobalSettings> | undefined>;
  /** Presence-only secret lookup for a declared secret REFERENCE (never a credential value). */
  hasProjectSecret?: (secretKey: string) => Promise<boolean>;
}

export interface PostMergeContractResolverDeps {
  /** Injectable `git remote get-url origin` reader (tests replace the shellout). */
  readRemoteUrl?: (repoDir: string) => Promise<string | null>;
  /** Injectable workflow counter (tests replace the filesystem read). */
  countGitHubWorkflowFiles?: (repoDir: string) => Promise<number>;
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
  Endpoint/credential lookups are one injected function, in the same style as `readRemoteUrl` above, so a test
  never touches a real settings layer, the real secrets store, or the network. Its output is only ever a
  CANDIDATE list: which platform claims this board and whether a credential is wired up. Core decides what
  that list means, including the fail-closed cases an endpoint must never erase (`no-remote`,
  `repo-facts-unreadable`, an operator's `none`).
  */
  resolveReporterEndpoints?: (input: PostMergeReporterEndpointInput) => Promise<PostMergeReporterEndpoint[]>;
  auditHost?: RunAuditSinkHost;
  log?: RunAuditLogger;
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-00:05 (RUFU-430):
These two readers decide whether a completion gate may be relaxed, so they must tell apart "the repository
says it has no origin" from "we could not ask the repository". The first version ran only
`git remote get-url origin`, and on every no-remote board that command exits 2 with `No such remote 'origin'`
— measured on `/home/schindler/ai/vllm-rocm` right after this shipped, where VLLM-083 stayed blocked with
`required post-merge evidence gate 'post-merge-verification' has not reported` because the throw was read as
"facts unreadable" and failed closed. A probe now establishes that the directory IS a readable repository;
having one, a missing origin is a FACT (no reporter) rather than a failure, and only an unprobed repo or a
git error that is not "no such remote" keeps demanding evidence. Same discipline for `.github/workflows`:
ENOENT/ENOTDIR is "no workflow files", never a swallowed permission error.
*/
const NO_SUCH_REMOTE = /no such remote|no remote named|error: no remote/i;

/** Throws when `repoDir` is not a readable git repository — the fail-closed precondition. */
async function assertGitRepository(repoDir: string): Promise<void> {
  await execAsync("git rev-parse --is-inside-work-tree", { cwd: repoDir, timeout: 5_000 });
}

export async function readOriginRemoteUrl(repoDir: string): Promise<string | null> {
  await assertGitRepository(repoDir);
  try {
    const { stdout } = await execAsync("git remote get-url origin", { cwd: repoDir, timeout: 5_000 });
    const url = stdout.trim();
    return url ? url : null;
  } catch (error) {
    // A repository that names no origin answers the question; any other git failure does not.
    if (NO_SUCH_REMOTE.test(String((error as { message?: string })?.message ?? error))) return null;
    throw error;
  }
}

export async function countGitHubWorkflowFiles(repoDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(join(repoDir, ".github", "workflows"));
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    throw error;
  }
  return entries.filter((entry) => /\.(yml|yaml)$/i.test(entry)).length;
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
The default endpoint resolver. Each candidate is read from the ONE place that platform's configuration lives,
and becomes a candidate only when it is a usable base URL:

- GitLab: the existing `resolveGitlabConfig` resolver (project → global → `gitlab.com` defaults) with
  `resolveGitlabEnabled` respected, because a board whose integration is switched off must not be claimed by a
  default. The credential half mirrors `resolveGitlabAuth`'s token precedence chain (project token → global
  token → per-project global token → `GITLAB_TOKEN`) as a PRESENCE test only: no value is ever read into this
  module, so none can reach the audit row, the cache, or a log line.
- OneDev: this repo has no OneDev settings surface, so the only available fact is the operator's own
  declaration (`postMergeEvidence.baseUrl` + `tokenSecret`). A declared URL serving a different host than the
  origin is filtered by core's host+port matcher, so a stale declaration cannot claim a moved board.

Fail-toward-absent, never fail-toward-reporter: a throwing settings or secrets sink yields no candidate, which
is exactly the pre-change answer. An unavailable lookup is never evidence that a reporter exists — the mirror
image of why RUFU-430 refuses to derive `none` from a failed git command.

One consequence is worth stating because it tightens a gate rather than loosening one: Fusion's GitLab
integration is ENABLED by default against `gitlab.com`, so a board whose origin really is gitlab.com becomes
reportable without the operator configuring anything. That is the intended platform truth — the alternative
keeps a GitLab-hosted board exempt because nobody touched a settings panel — and the escape hatch is the
existing one: a GitLab board with no CI at all declares `postMergeEvidence.provider: "none"`, which stays
authoritative over any endpoint candidate.
*/
export async function resolveDefaultReporterEndpoints(
  input: PostMergeReporterEndpointInput,
): Promise<PostMergeReporterEndpoint[]> {
  const endpoints: PostMergeReporterEndpoint[] = [];
  const project = (input.projectSettings ?? {}) as Partial<ProjectSettings>;

  let global: Partial<GlobalSettings> | undefined;
  try {
    global = await input.readGlobalSettings?.();
  } catch {
    global = undefined;
  }

  try {
    if (resolveGitlabEnabled({ project, global })) {
      const { instanceUrl } = resolveGitlabConfig({ project, global });
      const baseUrl = normalizePostMergeReporterBaseUrl(instanceUrl);
      if (baseUrl) {
        endpoints.push({
          provider: "gitlab",
          baseUrl,
          credentialConfigured: hasConfiguredCredential([
            project.gitlabAuthToken,
            global?.gitlabAuthToken,
            (global as Record<string, unknown> | undefined)?.projectGitlabAuthToken,
            process.env.GITLAB_TOKEN,
          ]),
        });
      }
    }
  } catch {
    // An invalid GitLab configuration is no candidate: never a crash, never a claimed reporter.
  }

  const declared = input.declared;
  if (declared?.provider === "onedev") {
    const baseUrl = normalizePostMergeReporterBaseUrl(declared.baseUrl);
    if (baseUrl) {
      // `tokenSecret` is a REFERENCE; what counts is that the named project secret exists, not its value.
      const credentialConfigured = declared.tokenSecret && input.hasProjectSecret
        ? await input.hasProjectSecret(declared.tokenSecret).catch(() => false)
        : false;
      endpoints.push({ provider: "onedev", baseUrl, credentialConfigured });
    }
  }

  return endpoints;
}

/** Presence, never value: a credential counts only as a non-empty string at one of its configured layers. */
function hasConfiguredCredential(values: unknown[]): boolean {
  return values.some((value) => typeof value === "string" && value.trim().length > 0);
}

/** Presence-only project-secret lookup; an unreadable secrets store answers "no credential". */
function makeProjectSecretPresence(store: PostMergeContractStore | null | undefined) {
  return async function hasProjectSecret(secretKey: string): Promise<boolean> {
    if (!secretKey) return false;
    try {
      const secrets = typeof store?.getSecretsStore === "function" ? await store.getSecretsStore() : null;
      const rows = (await secrets?.listSecrets?.()) ?? [];
      return rows.some((row) => row?.key === secretKey || row?.id === secretKey);
    } catch {
      return false;
    }
  };
}

/**
 * Resolve the project's post-merge evidence contract.
 *
 * Returns `undefined` when the project root cannot be determined — callers then behave exactly as they did
 * before this change, because a missing observation is never evidence that a completion gate may be
 * relaxed. This is the fail-closed direction the whole card is deliberately built on.
 */
export async function resolvePostMergeEvidenceContract(
  store: PostMergeContractStore | null | undefined,
  deps: PostMergeContractResolverDeps = {},
): Promise<PostMergeEvidenceContract | undefined> {
  let rootDir: string | undefined;
  try {
    rootDir = typeof store?.getRootDir === "function" ? store.getRootDir() : undefined;
  } catch {
    rootDir = undefined;
  }
  if (!rootDir) return undefined;
  const cached = contractCache.get(rootDir);
  if (cached) return cached;

  const readRemote = deps.readRemoteUrl ?? readOriginRemoteUrl;
  const countWorkflows = deps.countGitHubWorkflowFiles ?? countGitHubWorkflowFiles;

  let remoteUrl: string | null = null;
  let workflowFileCount: number | null = null;
  let factsReadable = true;
  try {
    remoteUrl = await readRemote(rootDir);
    workflowFileCount = await countWorkflows(rootDir);
  } catch {
    // Missing checkout, unreadable directory, git failure: keep today's blocking behavior.
    factsReadable = false;
  }

  let declared: DeclaredPostMergeEvidence | undefined;
  let projectSettings: Record<string, unknown> | undefined;
  if (typeof store?.readRawProjectSettings === "function") {
    try {
      projectSettings = (await store.readRawProjectSettings()) ?? undefined;
      declared = parseDeclaredPostMergeEvidence(projectSettings?.postMergeEvidence);
    } catch {
      declared = undefined;
    }
  }

  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
  Endpoint candidates are read only for a repo whose facts WERE readable — with no origin there is nothing to
  match against, and the fail-closed reasons (`no-remote`, `repo-facts-unreadable`) must survive the new layer
  untouched. A lookup that throws is swallowed here into "no candidates", so a broken secrets mount can never
  relax a gate; the result is additive, and the whole batch is computed once with the observation it belongs
  to, so the RUFU-430 cache (and its no-cache-on-failure rule) still covers it.
  */
  const readEndpoints = deps.resolveReporterEndpoints ?? resolveDefaultReporterEndpoints;
  let endpoints: PostMergeReporterEndpoint[] = [];
  if (factsReadable) {
    try {
      endpoints = await readEndpoints({
        projectSettings,
        declared,
        readGlobalSettings: async () => {
          const layer = typeof store?.getGlobalSettingsStore === "function"
            ? await store.getGlobalSettingsStore()
            : undefined;
          return (await layer?.getSettings?.()) ?? {};
        },
        hasProjectSecret: makeProjectSecretPresence(store),
      });
    } catch {
      endpoints = [];
    }
  }

  const contract = derivePostMergeEvidenceContract({
    declared,
    repo: { factsReadable, remoteUrl, githubWorkflowFileCount: workflowFileCount },
    endpoints,
  });

  if (factsReadable) contractCache.set(rootDir, contract);
  await emitOnce(rootDir, contract, deps);
  return contract;
}

/*
FNXC:RunAudit 2026-09-30-22:29 (RUFU-430): one row per (project root, reason) through the bounded seam,
with provider/source/reason only.

FNXC:RunAudit 2026-10-01-00:12, corrected 2026-10-01-00:26 (RUFU-430): the first shipped row NEVER LANDED —
production logged `[run-audit] failed to record merge:post-merge-evidence-contract` twice and the bounded
seam swallowed it. Measured cause: the event carried NO `target`, and `project.run_audit_events.target` is
NOT NULL (1,773,528 rows, zero with a null target). The `domain:"merge"` it also carried is NOT the proven
cause and was never claimed as more than hygiene: the column has no CHECK constraint and 13,926 rows carry
the out-of-enum `task-lifecycle`, so out-of-enum domains do land. The merge lane therefore emits the shape
every other merge event uses — `domain:"git"`, `agentId:"merger"`, constant `target` `post-merge-evidence` —
and the engine test asserts those fields, not just the absence of the remote URL, because telemetry that is
silently dropped is exactly the failure FN-9175's seam is designed to make invisible. The remote URL is deliberately NEVER recorded — a remote can carry
credentials — and the project path is not recorded either, so the row stays ids/counts/fixed-enums-only.
*/
async function emitOnce(
  rootDir: string,
  contract: PostMergeEvidenceContract,
  deps: PostMergeContractResolverDeps,
): Promise<void> {
  const key = `${rootDir}:${contract.reason}`;
  if (auditedKeys.has(key)) return;
  auditedKeys.add(key);
  await emitBoundedRunAudit(
    deps.auditHost ?? null,
    {
      mutationType: "merge:post-merge-evidence-contract",
      agentId: "merger",
      runId: `post-merge-evidence-contract:${contract.provider}:${contract.reason}`,
      target: "post-merge-evidence",
      domain: "git",
      /*
      FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
      Two extra fields, both non-secret BY CONSTRUCTION and both present only when an endpoint was actually
      chosen: `endpointHost` is `host` or `host:port` (never a scheme, path, or the userinfo a git remote is
      allowed to embed), and `credentialConfigured` states that a token or secret REFERENCE is wired up. A
      reporter-less board gets neither field, so the row cannot be read as "a credential exists here" when no
      endpoint was named. Raw remote URLs, secret keys, secret values, and endpoint paths stay out.
      */
      metadata: {
        provider: contract.provider,
        source: contract.source,
        reason: contract.reason,
        ...(contract.endpointHost
          ? { endpointHost: contract.endpointHost, credentialConfigured: contract.credentialConfigured === true }
          : {}),
      },
    },
    { log: deps.log },
  );
}

/** Test seam: the cache is process-lifetime, and tests must observe fresh derivations. */
export function resetPostMergeEvidenceContractCacheForTest(): void {
  contractCache.clear();
  auditedKeys.clear();
}
