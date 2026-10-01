import {
  derivePostMergeEvidenceContract,
  parseDeclaredPostMergeEvidence,
  type PostMergeEvidenceContract,
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

/** The public store surface this resolver needs; a store without it simply yields no contract. */
export interface PostMergeContractStore {
  getRootDir?: () => string;
  readRawProjectSettings?: () => Promise<Record<string, unknown>>;
}

export interface PostMergeContractResolverDeps {
  /** Injectable `git remote get-url origin` reader (tests replace the shellout). */
  readRemoteUrl?: (repoDir: string) => Promise<string | null>;
  /** Injectable workflow counter (tests replace the filesystem read). */
  countGitHubWorkflowFiles?: (repoDir: string) => Promise<number>;
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

  let declared;
  if (typeof store?.readRawProjectSettings === "function") {
    try {
      declared = parseDeclaredPostMergeEvidence((await store.readRawProjectSettings())?.postMergeEvidence);
    } catch {
      declared = undefined;
    }
  }

  const contract = derivePostMergeEvidenceContract({
    declared,
    repo: { factsReadable, remoteUrl, githubWorkflowFileCount: workflowFileCount },
  });

  if (factsReadable) contractCache.set(rootDir, contract);
  await emitOnce(rootDir, contract, deps);
  return contract;
}

/*
FNXC:RunAudit 2026-09-30-22:29 (RUFU-430): one row per (project root, reason) through the bounded seam,
with provider/source/reason only.

FNXC:RunAudit 2026-10-01-00:12 (RUFU-430): the first shipped row NEVER LANDED. The bounded seam swallowed
`[run-audit] failed to record merge:post-merge-evidence-contract` twice on 2026-09-30 because the event
carried `domain:"merge"` and no `target`, while `project.run_audit_events` declares NOT NULL `target` /
`project_id` and `RunAuditDomain = "database" | "git" | "filesystem" | "sandbox"`. Telemetry that is
silently dropped is the exact failure this seam is designed to make invisible, so the merge lane uses the
same shape every other merge event uses — `domain:"git"`, `agentId:"merger"`, constant `target` — and the
engine test asserts those fields, not just the absence of the remote URL. The remote URL is deliberately NEVER recorded — a remote can carry
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
      metadata: {
        provider: contract.provider,
        source: contract.source,
        reason: contract.reason,
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
