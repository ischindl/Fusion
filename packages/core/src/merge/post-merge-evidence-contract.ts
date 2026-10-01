/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
The built-in `post-merge-verification` gate demands a GitHub Actions delivery record — the landed SHA,
the first push-to-main run at or after it, a Pipeline smoke conclusion, four Test shard conclusions and
four `test-timings-shard-N` artifacts. That contract is baked into the built-in IR prompt and applied to
every project, but measured across this fleet only 2 of 26 boards can name it at all (a GitHub remote with
`.github/workflows`). The consequences were measured before this fact existed: 66 of 98 durable post-merge
`failed` rows refuse because the repo has no CI pipeline, 12 rows are operator waivers (11 of them on one
saneca day), and the same impossible instruction produced 10 approvals on boards where Actions cannot
exist — so the gate's verdict depended on how one reviewer agent read an unsatisfiable sentence.

This module names the missing input: WHICH evidence reporter a project actually has. It is a pure fact,
built from repo facts the engine already reads plus an optional operator declaration, and it feeds the same
core seam that RUFU-429 widened for delivery shape. A required gate whose reporter cannot run is not a
violation and never was; it is a requirement this project never had.

Deliberate bounds:
- An unreadable repo is `github-actions` (today's behavior), never `none`. Deriving "no reporter" from a
  failed command would turn a transient filesystem error into a silently disabled completion gate.
- A declaration wins over derivation, so an operator can force either direction without a code change.
- A non-GitHub host is `none` UNLESS a reporter endpoint is positively configured for that exact host:
  OneDev and GitLab are real reporters now (`onedev`, `gitlab`), but the provider is derived from a
  configured endpoint whose host matches the origin, never from a hostname that merely looks plausible.
  Gitea/Bitbucket/plain ssh stay `none` — this module still does not claim a reporter it cannot name.

FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
The OneDev/GitLab reporter named as follow-up work above now exists, and the shape it needed is exactly the
one predicted here: two providers, one derived reason each, and non-secret endpoint facts (host[:port] plus a
credential-configured boolean) on the contract. What did NOT change is the exemption rule. Every consumer
still asks `isPostMergeEvidenceUnreportable(contract)`; nobody asks which host the board sits on. That
inversion is the whole point — before this change a saneca or GitLab landing was exempted for the wrong
reason ("not GitHub"), which both forgave boards that do have a pipeline and demanded GitHub Actions
vocabulary from boards that could never produce it.

Fusion still does not query any CI API. A reporter here means "a human reviewer can be told where to read
the delivery record", exactly as for Actions; RUFU-456 owns surfacing this in the editor and Settings, and
no HTTP client, polling loop, or UI is added by this module.
*/

import { normalizeHttpUrl } from "../git/gitlab-config.js";

/** Which post-merge evidence reporter a project has. */
export type PostMergeEvidenceProvider = "github-actions" | "onedev" | "gitlab" | "none";

/** Whether the value came from the operator or from observed repo facts. */
export type PostMergeEvidenceSource = "declared" | "derived";

/** Why this provider was chosen — recorded so an operator can see the decision without re-deriving it. */
export type PostMergeEvidenceReason =
  | "operator-declared"
  | "github-remote-with-workflows"
  | "github-remote-without-workflows"
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
  One reason per new host, deliberately NOT a reuse of `non-github-remote`. `non-github-remote` now means
  precisely what the exemption needs it to mean: a remote whose host has no configured reporter endpoint, so
  no CI record can be produced here. Overloading it for OneDev/GitLab boards that DO have an endpoint would
  make the exemption predicate unreadable — an operator triaging "why is this board exempt?" (or not) has to
  be able to tell the two apart from the stored reason alone.
  */
  | "onedev-endpoint"
  | "gitlab-endpoint"
  | "non-github-remote"
  | "no-remote"
  | "repo-facts-unreadable";

export interface PostMergeEvidenceContract {
  provider: PostMergeEvidenceProvider;
  source: PostMergeEvidenceSource;
  reason: PostMergeEvidenceReason;
  /** UTC ISO stamp of the observation. A negative verdict recorded BEFORE this instant is a verdict about
   *  a contract this project could never satisfy; one recorded after it is a real gate decision. */
  observedAt: string;
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
  Endpoint facts are NON-SECRET BY CONSTRUCTION: the host with its port and nothing else. No scheme, no path,
  no userinfo, no token — a OneDev board's project path or an embedded access token must never reach a run
  audit row, task metadata, or a log line. `credentialConfigured` is a boolean precisely so "a token is
  wired up here" stays observable without the token ever being held by this module.
  */
  /** `host` or `host:port` of the reporter endpoint, never a full URL. */
  endpointHost?: string;
  /** True when a credential reference is configured for that endpoint; the value is never stored here. */
  credentialConfigured?: boolean;
}

/** Repo facts the derivation needs. Provided by the engine, which owns shellout; core never shells out. */
export interface PostMergeRepoFacts {
  /** False when the remote could not be read at all (missing checkout, git failure). Never a `none`. */
  factsReadable: boolean;
  /** `git remote get-url origin`, or null/empty when the repo has no remote configured. */
  remoteUrl?: string | null;
  /** Count of `.github/workflows/*.{yml,yaml}` files. `undefined` = not inspected. */
  githubWorkflowFileCount?: number | null;
}

/** The shape accepted from project settings `postMergeEvidence`. Unknown shapes are ignored, not trusted. */
export interface DeclaredPostMergeEvidence {
  provider: PostMergeEvidenceProvider;
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
  The declaration grew two optional endpoint fields, and each is dropped INDIVIDUALLY when it cannot be read
  rather than voiding the whole declaration: a typo in a base URL must not silently cancel the operator's
  answer to "which CI does this board have", because cancelling it falls through to derivation and derivation
  of an unmatched host is `none` — a gate relaxed because a setting was misspelled. The provider sentence is
  what the gate acts on, so it survives a malformed enrichment.
  */
  /** Reporter base URL, validated by the same rules as a GitLab instance URL (no userinfo, http(s) only). */
  baseUrl?: string;
  /** Reference to the project secret holding the reporter token. A reference only — never a credential. */
  tokenSecret?: string;
  /** Free text the operator typed; never interpreted. */
  note?: string;
}

/**
 * A reporter endpoint candidate the engine read out of configuration, tagged with the platform it belongs to.
 * Core validates and matches it; core never reads settings, the network, or the secrets store.
 */
export interface PostMergeReporterEndpoint {
  provider: Extract<PostMergeEvidenceProvider, "onedev" | "gitlab">;
  /** Absolute http(s) base URL as configured. */
  baseUrl: string;
  /** True when a token/secret reference is configured for this endpoint. Never the token itself. */
  credentialConfigured?: boolean;
}

const GITHUB_HOSTS = ["github.com", "www.github.com"];

/** Protocol-default ports, so `http://host` and `http://host:80` are the same reporter. */
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ssh: "22", git: "22" };

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
A secret is referenced, never stored: the charset rejects anything that could BE a credential or a URL
(`@`, `/`, whitespace, a scheme) while admitting the identifier shapes this fleet's secret keys use.
Accepting a free-form string here would put a token in project settings and then in every settings read.
*/
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

const DECLARED_PROVIDERS = ["none", "github-actions", "onedev", "gitlab"] as const;

function asDeclaredProvider(value: unknown): PostMergeEvidenceProvider | undefined {
  if (typeof value !== "string") return undefined;
  const provider = value.trim().toLowerCase();
  return (DECLARED_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as PostMergeEvidenceProvider)
    : undefined;
}

/** Validate a declared/configured reporter base URL; returns undefined when it is not a usable http(s) URL. */
export function normalizePostMergeReporterBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizeHttpUrl(value.trim(), "Post-merge evidence reporter URL");
  } catch {
    return undefined;
  }
}

/**
 * Read the operator's declaration out of a raw project-settings value.
 * Tolerant by design: an unreadable or unknown declaration must not change today's behavior, so it is
 * dropped rather than guessed at. Accepts both `{ provider: "none" }` and the bare string `"none"`.
 * A malformed optional field (`baseUrl`, `tokenSecret`) drops that field, not the declaration.
 */
export function parseDeclaredPostMergeEvidence(raw: unknown): DeclaredPostMergeEvidence | undefined {
  if (typeof raw === "string") {
    const provider = asDeclaredProvider(raw);
    return provider ? { provider } : undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fields = raw as Record<string, unknown>;
  const provider = asDeclaredProvider(fields.provider);
  if (!provider) return undefined;
  const declared: DeclaredPostMergeEvidence = { provider };
  const baseUrl = normalizePostMergeReporterBaseUrl(fields.baseUrl);
  if (baseUrl) declared.baseUrl = baseUrl;
  const tokenSecret = typeof fields.tokenSecret === "string" ? fields.tokenSecret.trim() : "";
  if (SECRET_REF_PATTERN.test(tokenSecret)) declared.tokenSecret = tokenSecret;
  const note = fields.note;
  if (typeof note === "string" && note.trim()) declared.note = note.trim().slice(0, 300);
  return declared;
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
Endpoint → origin matching compares HOST AND PORT after userinfo is stripped, which is what makes a
token-bearing remote safe: `https://glpat-xxxx@gitlab.example.com/ai/x.git` and
`https://gitlab.example.com/ai/x.git` produce the same key, and the credential never enters the returned
value because only the hostname and port are ever read out of the parsed URL. The port matters because this
fleet's OneDev is `http://192.168.12.60:6610/...` — a host-only comparison would let an endpoint configured
for a different service on the same machine claim the board.
The one honest gap: git's scheme-less scp syntax (`git@host:org/repo.git`) has no port slot, so such a remote
proves host equality only and the endpoint's port is trusted.
*/
interface OriginHostKey {
  host: string;
  port?: string;
}

function originHostKey(rawUrl: string): OriginHostKey | undefined {
  const value = rawUrl.trim();
  if (!value) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (!host) return undefined;
      const protocol = parsed.protocol.replace(/:$/u, "");
      const port = parsed.port || DEFAULT_PORTS[protocol] || "";
      return port ? { host, port } : { host };
    } catch {
      return undefined;
    }
  }
  // scp-style `[user@]host:path`: strip the user, then take the host before the colon.
  const withoutUser = value.replace(/^[^@/:]+@/u, "");
  const host = withoutUser.split("/", 1)[0].split(":", 1)[0].toLowerCase();
  return host ? { host } : undefined;
}

/**
 * Host[:port] of a reporter endpoint, the only endpoint fact this contract ever reports.
 *
 * FNXC:PostMergeEvidenceContract 2026-10-01-06:51 (RUFU-457):
 * A protocol-default port is dropped from this LABEL even though matching compares it: the audit row is an
 * operator's answer to "which reporter was chosen", and `gitlab.com:443` reads like a second server. A
 * NON-default port is kept and is the distinction the field exists for — this fleet's OneDev is reached on
 * `:6610`, so its label has to say so. Origin matching is unaffected and still compares host AND port.
 */
function endpointHostLabel(baseUrl: string): string | undefined {
  const key = originHostKey(baseUrl);
  if (!key) return undefined;
  if (!key.port) return key.host;
  const protocol = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(baseUrl.trim())?.[1];
  if (protocol && DEFAULT_PORTS[protocol.toLowerCase()] === key.port) return key.host;
  return `${key.host}:${key.port}`;
}

function reporterEndpointsMatch(remoteKey: OriginHostKey | undefined, endpointKey: OriginHostKey | undefined): boolean {
  if (!remoteKey || !endpointKey) return false;
  if (remoteKey.host !== endpointKey.host) return false;
  if (!remoteKey.port || !endpointKey.port) return true;
  return remoteKey.port === endpointKey.port;
}

/** GitHub over https or ssh — the only host whose Actions runs can satisfy the shard contract. */
function isGitHubRemote(remoteUrl: string): boolean {
  const value = remoteUrl.trim().toLowerCase();
  if (!value) return false;
  // scp-style `git@github.com:org/repo.git`, ssh:// and https:// all carry the host literally.
  return GITHUB_HOSTS.some((host) => value.includes(`${host}:`) || value.includes(`${host}/`));
}

/** Attach the non-secret endpoint facts to a contract, only when a host label could be read. */
function withEndpointFacts(
  contract: Omit<PostMergeEvidenceContract, "endpointHost" | "credentialConfigured">,
  baseUrl: string | undefined,
  credentialConfigured: boolean | undefined,
): PostMergeEvidenceContract {
  const endpointHost = baseUrl ? endpointHostLabel(baseUrl) : undefined;
  if (!endpointHost) return contract;
  return { ...contract, endpointHost, ...(credentialConfigured ? { credentialConfigured: true } : {}) };
}

/**
 * Decide which post-merge evidence reporter a project has.
 * Declaration first, then observed facts; an unreadable repo keeps today's blocking behavior.
 *
 * FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457): `endpoints` are configuration-read candidates
 * (the engine's GitLab instance URL, a declared OneDev base URL). They are consulted only for a host that
 * matches the origin, and only AFTER the declaration and the two fail-closed guards, so an endpoint can add a
 * reporter but can never erase `no-remote`, `repo-facts-unreadable`, or an operator's `none`.
 */
export function derivePostMergeEvidenceContract(input: {
  declared?: DeclaredPostMergeEvidence;
  repo: PostMergeRepoFacts;
  endpoints?: PostMergeReporterEndpoint[];
  observedAt?: string;
}): PostMergeEvidenceContract {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const declared = input.declared;
  const remote = (input.repo.remoteUrl ?? "").trim();
  const remoteKey = remote ? originHostKey(remote) : undefined;
  /** First configured endpoint whose host[:port] equals the origin's, in the order the engine supplied. */
  const matchingEndpoint = (provider?: PostMergeEvidenceProvider): PostMergeReporterEndpoint | undefined =>
    (input.endpoints ?? []).find(
      (endpoint) =>
        (!provider || endpoint.provider === provider) &&
        reporterEndpointsMatch(remoteKey, originHostKey(endpoint.baseUrl ?? "")),
    );

  if (declared) {
    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
    A provider declaration that ALSO names the endpoint this origin actually serves reports the endpoint
    reason, because that is the stronger fact — it says "the operator named OneDev AND the configured OneDev
    host is the one the card was pushed to". A provider declaration with no matching endpoint keeps
    `operator-declared`: the operator's word is still what the gate acts on (a declaration wins over
    derivation in both directions), but the row does not claim a host match that never happened.
    */
    const declaresEndpoint = declared.provider === "onedev" || declared.provider === "gitlab";
    const declaredEndpointMatches =
      declaresEndpoint &&
      Boolean(declared.baseUrl) &&
      reporterEndpointsMatch(remoteKey, originHostKey(declared.baseUrl ?? ""));
    const configuredEndpoint =
      declaresEndpoint && !declaredEndpointMatches && input.repo.factsReadable
        ? matchingEndpoint(declared.provider)
        : undefined;
    if (configuredEndpoint) {
      return withEndpointFacts(
        { provider: declared.provider, source: "declared", reason: `${declared.provider}-endpoint` as PostMergeEvidenceReason, observedAt },
        configuredEndpoint.baseUrl,
        configuredEndpoint.credentialConfigured,
      );
    }
    if (declaredEndpointMatches) {
      return withEndpointFacts(
        { provider: declared.provider, source: "declared", reason: `${declared.provider}-endpoint` as PostMergeEvidenceReason, observedAt },
        declared.baseUrl,
        Boolean(declared.tokenSecret),
      );
    }
    return withEndpointFacts(
      { provider: declared.provider, source: "declared", reason: "operator-declared", observedAt },
      declared.baseUrl,
      Boolean(declared.tokenSecret),
    );
  }
  if (!input.repo.factsReadable) {
    return { provider: "github-actions", source: "derived", reason: "repo-facts-unreadable", observedAt };
  }
  if (!remote) {
    return { provider: "none", source: "derived", reason: "no-remote", observedAt };
  }
  const endpoint = matchingEndpoint();
  if (endpoint) {
    return withEndpointFacts(
      { provider: endpoint.provider, source: "derived", reason: `${endpoint.provider}-endpoint` as PostMergeEvidenceReason, observedAt },
      endpoint.baseUrl,
      endpoint.credentialConfigured,
    );
  }
  if (!isGitHubRemote(remote)) {
    return { provider: "none", source: "derived", reason: "non-github-remote", observedAt };
  }
  const workflowCount = input.repo.githubWorkflowFileCount;
  if (typeof workflowCount === "number" && workflowCount === 0) {
    return { provider: "none", source: "derived", reason: "github-remote-without-workflows", observedAt };
  }
  // A GitHub remote whose workflow directory was not inspected stays blocking: absence of an inspection
  // is not evidence that the reporter is missing.
  return { provider: "github-actions", source: "derived", reason: "github-remote-with-workflows", observedAt };
}

/**
 * True when the project cannot produce the post-landing CI delivery record the built-in gate demands.
 *
 * FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
 * THIS is the only exemption predicate, and it answers "can any CI record be produced here at all", never
 * "is the host GitHub". No consumer may key an exemption on a hostname, a provider string, or a substring of
 * the remote: with `onedev` and `gitlab` now in the union, "not GitHub" no longer implies "nothing to show",
 * and a host-shaped exemption would silently forgive boards that do owe pipeline evidence while keeping the
 * GitHub-only vocabulary demanded of boards that cannot produce it.
 */
export function isPostMergeEvidenceUnreportable(
  contract: PostMergeEvidenceContract | null | undefined,
): boolean {
  return contract?.provider === "none";
}
