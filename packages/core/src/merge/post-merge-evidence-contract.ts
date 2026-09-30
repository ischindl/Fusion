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
- Non-GitHub hosts (OneDev, self-hosted GitLab, Gitea, plain ssh) are `none` for now: their pipelines exist
  but no reporter here can read them, and `none` is the honest description of what the gate can be shown.
  A real OneDev/GitLab reporter is follow-up work; it will add a provider, not change this shape.
*/

/** Which post-merge evidence reporter a project has. */
export type PostMergeEvidenceProvider = "github-actions" | "none";

/** Whether the value came from the operator or from observed repo facts. */
export type PostMergeEvidenceSource = "declared" | "derived";

/** Why this provider was chosen — recorded so an operator can see the decision without re-deriving it. */
export type PostMergeEvidenceReason =
  | "operator-declared"
  | "github-remote-with-workflows"
  | "github-remote-without-workflows"
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
  /** Free text the operator typed; never interpreted. */
  note?: string;
}

const GITHUB_HOSTS = ["github.com", "www.github.com"];

/**
 * Read the operator's declaration out of a raw project-settings value.
 * Tolerant by design: an unreadable or unknown declaration must not change today's behavior, so it is
 * dropped rather than guessed at. Accepts both `{ provider: "none" }` and the bare string `"none"`.
 */
export function parseDeclaredPostMergeEvidence(raw: unknown): DeclaredPostMergeEvidence | undefined {
  if (typeof raw === "string") {
    const provider = raw.trim().toLowerCase();
    return provider === "none" || provider === "github-actions" ? { provider } : undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = (raw as Record<string, unknown>).provider;
  if (typeof candidate !== "string") return undefined;
  const provider = candidate.trim().toLowerCase();
  if (provider !== "none" && provider !== "github-actions") return undefined;
  const note = (raw as Record<string, unknown>).note;
  return typeof note === "string" && note.trim() ? { provider, note: note.trim().slice(0, 300) } : { provider };
}

/** GitHub over https or ssh — the only host whose Actions runs can satisfy the shard contract. */
function isGitHubRemote(remoteUrl: string): boolean {
  const value = remoteUrl.trim().toLowerCase();
  if (!value) return false;
  // scp-style `git@github.com:org/repo.git`, ssh:// and https:// all carry the host literally.
  return GITHUB_HOSTS.some((host) => value.includes(`${host}:`) || value.includes(`${host}/`));
}

/**
 * Decide which post-merge evidence reporter a project has.
 * Declaration first, then observed facts; an unreadable repo keeps today's blocking behavior.
 */
export function derivePostMergeEvidenceContract(input: {
  declared?: DeclaredPostMergeEvidence;
  repo: PostMergeRepoFacts;
  observedAt?: string;
}): PostMergeEvidenceContract {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const declared = input.declared;
  if (declared) {
    return { provider: declared.provider, source: "declared", reason: "operator-declared", observedAt };
  }
  if (!input.repo.factsReadable) {
    return { provider: "github-actions", source: "derived", reason: "repo-facts-unreadable", observedAt };
  }
  const remote = (input.repo.remoteUrl ?? "").trim();
  if (!remote) {
    return { provider: "none", source: "derived", reason: "no-remote", observedAt };
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

/** True when the project cannot produce the post-landing CI delivery record the built-in gate demands. */
export function isPostMergeEvidenceUnreportable(
  contract: PostMergeEvidenceContract | null | undefined,
): boolean {
  return contract?.provider === "none";
}
