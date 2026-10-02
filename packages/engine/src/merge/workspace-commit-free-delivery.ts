/*
FNXC:WorkspaceMergeFinalization 2026-10-02-21:52 (RUFU-504):
A workspace card whose declared repositories were all already integrated delivers real work and still
produces zero commits: every `fusion/<id>` branch tip equals (or is contained in) the repository's own
integration branch. Before this file the workspace lane could only express two outcomes — "some repo landed
with a sha" or "nothing happened" — so `finalizeWorkspaceTask` wrote `mergeConfirmed: anyLanded`, the shared
finalizer's `hasDurableMergeProof` saw no proof, and the card was refused with the generic
`missing-merge-confirmation`. That refusal is unrecoverable from inside the lane: the stale `failed` row it
leaves behind is itself a merge blocker, so fixing the cause does not release cards already terminalised by
it (measured on the saneca review lane: 15 parked siblings on one sentence).

Rules this file owns:
  • Zero commits is only a DELIVERY when git corroborates it per repository. A land-result status of
    `empty` is a claim under test, never the proof — the same posture the singular lane's
    `enforceZeroCommitLandingProof` takes (RUFU-274) and the reason `noCommitsExpected` is not consulted
    here (the marker is optional; the probe is the evidence).
  • One probe implementation for the whole lane. The empty-merge finalize guard and the delivery decision
    both read this module, so the two cannot disagree about what "zero ahead" meant on a given pass.
  • An unprovable repository is never folded into a delivery. It yields `undelivered`, which keeps today's
    refusal, because claiming a commit-free delivery the probe could not corroborate is exactly the
    RUFU-262 shape this repo already lost work to.
  • No sha is ever invented. `landed` keeps the only sha-bearing status; a commit-free delivery carries
    branch-tip SHAs as *evidence about the branch*, in a field that is not read as a landing.
*/

/**
 * The structural minimum this module reads off a landing result. Declared here rather than imported from
 * `merger-ai.js` on purpose: the engine already dissolved one cycle between the workspace merge modules
 * (`isRepoLanded` → `workspace-land-predicate.ts`), and a type-only import would still make the lane's
 * dependency graph circular to a static reader. `WorkspaceRepoLandResult` satisfies this shape.
 */
export interface WorkspaceRepoLandingLike {
  repo: string;
  repoRootDir: string;
  integrationBranch: string;
  branch: string;
  status: "landed" | "empty" | "failed";
}

/** What the probe established about one repository's branch, at probe time. */
export type WorkspaceCommitFreeBasis =
  /** Branch tip resolves and is an ancestor of the repo's integration branch: zero commits ahead. */
  | "zero-ahead"
  /** Branch gone, or tip NOT an ancestor (ahead-but-net-zero, i.e. reverted/lost shape). */
  | "unproven";

export interface WorkspaceCommitFreeProbeInput {
  /** The `workspaceWorktrees` key (repo-relative path). */
  repo: string;
  /** Absolute path to that sub-repo's checkout, which is where the refs are resolved. */
  repoRootDir: string;
  /** The `fusion/<id>` branch this card carried in that repository. */
  branch: string;
  /** The per-repo integration branch the landing would have reached. */
  integrationBranch: string;
}

export interface WorkspaceCommitFreeRepoEvidence extends WorkspaceCommitFreeProbeInput {
  basis: WorkspaceCommitFreeBasis;
  /** Present whenever the branch resolved, including the `unproven` ahead-but-empty shape. */
  branchTipSha?: string;
}

/**
 * Injected so this module owns the DECISION while the caller owns the shellout. `merger-ai.ts` passes its
 * own `git`/`gitOk`; a test passes an in-process table. A skipped probe is an absent probe: this must never
 * gain a default that reports `zero-ahead` without having looked.
 */
export type WorkspaceTipAncestryProbe = (
  input: WorkspaceCommitFreeProbeInput,
) => Promise<{ basis: WorkspaceCommitFreeBasis; branchTipSha?: string }>;

/** Runs one git command and resolves with trimmed stdout, rejecting on a non-zero exit. */
export type GitTextRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * Builds the probe over a git runner, so the literal ancestry expression lives in THIS module and is
 * reachable from a test with a real repository. The convention matches `merger-ai.ts`'s `git()`: a rejected
 * run means git said no (`merge-base --is-ancestor` exits 1 when the sha is not an ancestor), never an
 * exception worth surfacing — an unresolvable branch and a refused ancestry are both simply "not proven".
 */
export function createTipAncestryProbe(runGit: GitTextRunner): WorkspaceTipAncestryProbe {
  return async ({ repoRootDir, branch, integrationBranch }) => {
    const tip = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRootDir).catch(() => "");
    if (!tip) return { basis: "unproven" };
    try {
      await runGit(["merge-base", "--is-ancestor", tip, integrationBranch], repoRootDir);
      return { basis: "zero-ahead", branchTipSha: tip };
    } catch {
      // Tip exists but is NOT contained in the integration branch: ahead-but-net-zero, the FN-8141
      // reverted/lost shape. Never a delivery.
      return { basis: "unproven", branchTipSha: tip };
    }
  };
}

/** Repositories whose landing produced a sha carry their own proof and need no ancestry probe. */
export function reposNeedingCommitFreeProbe(repos: WorkspaceRepoLandingLike[]): WorkspaceRepoLandingLike[] {
  return repos.filter((repo) => repo.status !== "landed");
}

export async function probeWorkspaceCommitFree(
  repos: WorkspaceCommitFreeProbeInput[],
  probe: WorkspaceTipAncestryProbe,
): Promise<WorkspaceCommitFreeRepoEvidence[]> {
  const evidence: WorkspaceCommitFreeRepoEvidence[] = [];
  for (const repo of repos) {
    const result = await probe(repo);
    evidence.push({ ...repo, basis: result.basis, ...(result.branchTipSha ? { branchTipSha: result.branchTipSha } : {}) });
  }
  return evidence;
}

export type WorkspaceDeliveryKind =
  /** At least one repository received a recorded commit. Today's only accepted delivery. */
  | "landed-delivery"
  /** No repository produced a commit, and every repository was proven zero-ahead. */
  | "commit-free-delivery"
  /** Neither: keep the existing refusal. */
  | "undelivered";

export interface WorkspaceDeliveryDecision {
  kind: WorkspaceDeliveryKind;
  /**
   * What `mergeDetails.mergeConfirmed` and `MergeResult.mergeConfirmed` become. `hasDurableMergeProof`
   * reads exactly this, so it is the whole of what this decision changes downstream.
   */
  mergeConfirmed: boolean;
  /** Written as `mergeDetails.noOpReason` for a commit-free delivery; never an error sentence. */
  noOpReason?: string;
  /** Per-repo basis, kept so a later reader can tell commit-free from landed without re-probing. */
  commitFreeBasis?: Record<string, WorkspaceCommitFreeBasis>;
  /** Branch tips observed, as corroboration of the basis — NOT landing shas. */
  commitFreeBranchTipShas?: Record<string, string>;
}

/**
 * The lane's whole terminal judgement, as a pure function of the landing results plus per-repo ancestry
 * evidence. Kept pure so the two directions that matter — "zero commits is a delivery only when proven" and
 * "one unproven repo is not a delivery" — are testable without a repository or a store.
 */
export function decideWorkspaceDelivery(input: {
  repoCount: number;
  landedCount: number;
  evidence: WorkspaceCommitFreeRepoEvidence[];
}): WorkspaceDeliveryDecision {
  const basis: Record<string, WorkspaceCommitFreeBasis> = {};
  const tipShas: Record<string, string> = {};
  for (const repo of input.evidence) {
    basis[repo.repo] = repo.basis;
    if (repo.branchTipSha) tipShas[repo.repo] = repo.branchTipSha;
  }
  const hasBasis = Object.keys(basis).length > 0;
  if (input.landedCount > 0) {
    return { kind: "landed-delivery", mergeConfirmed: true, ...(hasBasis ? { commitFreeBasis: basis } : {}) };
  }
  if (input.repoCount > 0 && input.repoCount === input.evidence.length && input.evidence.every((r) => r.basis === "zero-ahead")) {
    return {
      kind: "commit-free-delivery",
      mergeConfirmed: true,
      noOpReason: COMMIT_FREE_DELIVERY_REASON,
      commitFreeBasis: basis,
      ...(Object.keys(tipShas).length > 0 ? { commitFreeBranchTipShas: tipShas } : {}),
    };
  }
  return { kind: "undelivered", mergeConfirmed: false, ...(hasBasis ? { commitFreeBasis: basis } : {}) };
}

/**
 * The sentence stored as `mergeDetails.noOpReason`. It states the claim git was made to corroborate, so a
 * reader can re-derive it — and it is deliberately not phrased as a failure, because a commit-free delivery
 * is a completed card, not a parked one.
 */
export const COMMIT_FREE_DELIVERY_REASON =
  "commit-free delivery: every declared repository's task branch tip is an ancestor of that repository's integration branch, so the landing created no new commit anywhere";

/** Aggregate counts for the delivery summary line on the card. */
export function summarizeCommitFreeEvidence(evidence: WorkspaceCommitFreeRepoEvidence[]): string {
  return evidence.map((repo) => `${repo.repo} {basis=${repo.basis}${repo.branchTipSha ? `; tip=${repo.branchTipSha.slice(0, 12)}` : "; tip=none"}}`).join("; ");
}
