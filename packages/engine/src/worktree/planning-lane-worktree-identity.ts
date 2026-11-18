/*
FNXC:PlanningLaneWorktreeIdentity 2026-11-18-17:55 (RUFU-893):
ONE HONEST OWNER FOR THE WORKTREE IDENTITY OF A CARD THAT HAS NEVER EXECUTED.

THE DEFECT THIS RULE CLOSES. `SelfHealingManager.reconcileTaskWorktreeMetadata` decided "this card's
checkout is gone" from two facts about a DIRECTORY (`existsSync(task.worktree)` and a realpath
membership test over the registered-worktree inventory) and then nulled `worktree`, `branch`, and
`branchWriteOrigin`. It never asked git whether the BRANCH held commits. A branch is the only thing
that carries commits — a worktree directory is a checkout of it and is recreable from it by
`worktree-acquisition` — so a sweep that clears the pair on directory evidence can delete the board's
sole link to undelivered work. Measured before the change: 28 cards stood in this project's planning
lanes carrying a pointer, 12 of them naming a ref git had never heard of and 4 naming a ref AHEAD of
`main` (1, 2, 5 and 2 commits), all of them one sweep pass away from having both pointers dropped.

WHY A PURE LEAF HOLDS THE RULE AND THE SWEEP HOLDS ONLY OBSERVATIONS. The same class of defect has now
been fixed three times in three places (RUFU-448 turned one `self-healing` try/catch into per-card
containment; RUFU-548 turned a two-valued branch probe into a tri-state one; RUFU-439 refused to read
an unreadable `git worktree list` as absence), and each fix restated the classification inline where it
was needed. A rule that lives inside a sweep body gets re-derived by the next sweep and drifts again, so
the decision table lives here, has no I/O at all — no store, no filesystem, no shell, no git — and is
exercised directly by `__tests__/worktree/planning-lane-worktree-identity.test.ts`, which is the ONLY
suite that exercises it. The sweep passes in tri-state verdicts; it may not pre-decide them.

THE TWO DIRECTIONS, AND WHY THE ASYMMETRY IS THE POINT.
- `clear` requires PROOF that nothing can be lost: either the ref does not exist (then no commit was
  ever on it), or the ref's tip is contained in the integration branch (then every commit on it is
  already delivered). Both are answers git gave.
- `refuse` is the answer to "could not look", and it is the DEFAULT. An unanswerable question never
  becomes a no-commit verdict — that inversion is exactly what RUFU-548 measured (16 cards stranded
  because an absence read collapsed two states into one) and what RUFU-803's zero-unique-commit
  reclassification then mislabelled as landed.
- `keep` is neither: it is a live checkout naming this branch, which is a fact that REPAIRS the
  pointer's premise rather than clearing it. It writes nothing and announces nothing.

`unknown` is never collapsed into `absent` anywhere in this table, and no branch ref, worktree
registration, or directory is ever DELETED by anything this rule can return — the strongest action is
nulling three task fields, and the only removal owner in this area remains
`worktree-acquisition.recreateMissingTaskWorktree`, which rebuilds rather than removes.
*/

/** What the sweep may do about a card's persisted worktree identity. */
export type PlanningLanePointerAction = "clear" | "keep" | "refuse";

/**
 * Why a `clear` was authorised. Recorded so a log line can name its own authority instead of implying
 * a git verdict that was never asked: `completion-fanout-named` is a delivery event, the other two are
 * git answers.
 */
export type PlanningLanePointerClearBasis = "git-ref-absent" | "git-ref-contained" | "completion-fanout-named";

/**
 * The closed refusal vocabulary. Every value is a fixed code that reaches run-audit and the card's
 * History line; none of them is a sentence, and the sweep may not invent a value outside this set.
 *
 * - `ref-divergent` — the branch ref exists and its tip is NOT contained in the integration branch,
 *   i.e. measured possible lost work. This is the finding the change exists to stop reporting as clean.
 * - `probe-unknown` — a probe could not be asked or its answer was unusable. "Could not look" is never
 *   a no-commit verdict.
 * - `unmanaged-path-present` — the persisted directory exists and is not the managed per-id path, so
 *   only this card knows where it is; clearing the pointer would strand that directory with no owner.
 * - `workspace-card` — per-repository pointers and their own lease/land chain own this card; a verdict
 *   read in the entry repository describes none of its member repositories.
 * - `operator-branch` — the branch was operator-supplied, so this sweep never acquired it and cannot
 *   judge it. `isFusionDeletableBranch` is the same authority.
 * - `held-or-live` — an operator pause, an engine park, a checkout claim, or a live session owns this
 *   card right now. Yanking identity from a held or running card is the FN-5256 class.
 * - `lane-vocabulary-unreadable` — the lane could not be resolved by role, so the sweep cannot name the
 *   lifecycle owner it would be overriding. A refusal, never an empty candidate set and never a guess.
 */
export type PlanningLanePointerRefusalCode =
  | "ref-divergent"
  | "probe-unknown"
  | "unmanaged-path-present"
  | "workspace-card"
  | "operator-branch"
  | "held-or-live"
  | "lane-vocabulary-unreadable";

/** Tri-state ref presence. `unknown` is a first-class answer, not a failed `absent`. */
export type PlanningLaneRefPresence = "present" | "absent" | "unknown";

/** Tri-state worktree-registration verdict, shaped like RUFU-439's `probeBranchWorktreeRegistration`. */
export type PlanningLaneRegistration = "registered" | "absent" | "unknown";

/**
 * Tri-state containment verdict for a PRESENT ref. `not-applicable` is only honest when the ref is
 * absent (there is no tip to contain); carried beside a present ref it means the containment probe was
 * never run, which the rule treats as `unknown`.
 */
export type PlanningLaneContainment = "contained" | "divergent" | "unknown" | "not-applicable";

/**
 * Which lifecycle owner the card's column belongs to, resolved by TRAIT ROLE and never by a column-id
 * literal — a renamed or custom board is the case that silently disabled the same guard in three other
 * sweeps (FNXC:WorkflowResolvedColumns 2026-07-31-16:40).
 *
 * - `planning` — an intake or hold column: the card has never run a step, which is what makes a
 *   pointer clear recoverable in principle and therefore what this rule is allowed to judge.
 * - `completion-fanout-named` — a card the caller NAMED through `includeTaskIds`, i.e.
 *   `SelfHealingManager.reconcileCompletedTask` clearing a card it is completing. Its authority is the
 *   delivery event, not an inference, and containment-by-ancestry is provably unsound for it: a
 *   squash-merged tip stays non-ancestor of the integration branch forever (recorded in
 *   `self-healing.ts` FNXC:StaleActiveBranchDoneSpam 2026-08-03-01:47), so gating it would refuse
 *   honest completions. Its behaviour is deliberately unchanged by this rule.
 * - `unrecognised` — a column that carries none of the planning, WIP, review, or complete roles. The
 *   sweep cannot name that lane's owner, so it refuses instead of clearing. The change of direction is
 *   deliberate and loss-free: today such a lane is cleared on directory evidence alone, which is the
 *   FN-5256 hazard surviving on a custom board.
 */
export type PlanningLaneClass = "planning" | "completion-fanout-named" | "unrecognised";

/** Everything the rule is allowed to know. Each field is a measurement taken by the sweep. */
export interface PlanningLanePointerObservations {
  /** Role-resolved lane classification. Never derived from a column-id literal. */
  laneClass: PlanningLaneClass;
  refPresence: PlanningLaneRefPresence;
  registration: PlanningLaneRegistration;
  containment: PlanningLaneContainment;
  /** A persisted worktree path exists on disk (follows symlinks; a symlink pointing at nothing is absent). */
  persistedPathPresent: boolean;
  /** The persisted path is the managed per-id path under the configured worktrees root. */
  persistedPathIsManaged: boolean;
  /** Operator pause, engine park, checkout claim, external block, or a live session on this card. */
  heldOrLive: boolean;
  /** `task.workspaceWorktrees` is non-empty. */
  workspaceCard: boolean;
  /** `classifyTaskBranchOrigin` resolved the pointer as operator-supplied. */
  operatorSuppliedBranch: boolean;
}

/** The rule's answer, with the refusal code or clear basis attached so the caller can report it honestly. */
export interface PlanningLanePointerDecision {
  action: PlanningLanePointerAction;
  code?: PlanningLanePointerRefusalCode;
  basis?: PlanningLanePointerClearBasis;
}

/**
 * The decision table. Order is the contract: authority vetoes first, then the live-checkout fact, then
 * the path observation, then the git verdicts. Reading it top to bottom answers every card; a branch of
 * this table may not be duplicated in the sweep body.
 */
export function decidePlanningLaneWorktree(
  obs: PlanningLanePointerObservations,
): PlanningLanePointerDecision {
  /*
   * The completion fan-out is a DIFFERENT AUTHORITY, not a planning-lane inference: the caller is
   * completing this card right now and clearing its identity is part of that delivery. Applying the
   * git gate here would break honest completions, so the veto set and the probes below are both
   * skipped. Kept inside the table (rather than short-circuited in the sweep) so this one function
   * remains the whole decision, and so the test proves the fan-out is not silently gated.
   */
  if (obs.laneClass === "completion-fanout-named") {
    return { action: "clear", basis: "completion-fanout-named" };
  }

  /* Vetoes: cards this pass has no standing to touch, regardless of what git would say. */
  if (obs.heldOrLive) return { action: "refuse", code: "held-or-live" };
  if (obs.workspaceCard) return { action: "refuse", code: "workspace-card" };
  if (obs.operatorSuppliedBranch) return { action: "refuse", code: "operator-branch" };

  /*
   * An unnameable lane is refused before any probe is spent: the sweep cannot know whether that lane is
   * someone else's live execution lane, and the FN-5256 guard exists precisely because clearing the
   * identity of a live card yanks a running shell's checkout. Refusal is loss-free, an unproven clear is
   * not, so the over-inclusion direction here is refusal.
   *
   * ONE CODE COVERS BOTH SHAPES (`lane-vocabulary-unreadable`, the spec's closed set): the resolution threw
   * and no vocabulary exists to read, or the vocabulary read fine but this card's column matches no role
   * this sweep owns. Both leave the same question unanswered — is this card ours to clear — and an operator
   * reading the History line gets the same actionable fact either way.
   */
  if (obs.laneClass === "unrecognised") return { action: "refuse", code: "lane-vocabulary-unreadable" };

  /*
   * A live registered worktree names this branch: the persisted pointer's premise is ALIVE, so there is
   * nothing to clear and nothing was lost. This is `keep`, not a refusal — it writes nothing and
   * announces nothing, and the existing rebind arm upstream still owns the case where the card's own
   * path is the one that moved.
   */
  if (obs.registration === "registered") return { action: "keep" };

  /*
   * A present directory that is NOT the managed per-id path is known only to this card. Acquisition can
   * rebuild a path it can derive; it can never rediscover a path whose pointer this pass just dropped.
   */
  if (obs.persistedPathPresent && !obs.persistedPathIsManaged) {
    return { action: "refuse", code: "unmanaged-path-present" };
  }

  /* Any unreadable observation refuses. Neither `unknown` may collapse into an absence verdict. */
  if (obs.refPresence === "unknown") return { action: "refuse", code: "probe-unknown" };
  if (obs.registration === "unknown") return { action: "refuse", code: "probe-unknown" };

  /* PROOF 1: no ref in any namespace means no commit was ever carried by this name. */
  if (obs.refPresence === "absent") return { action: "clear", basis: "git-ref-absent" };

  /* Present ref: only containment in the integration branch proves nothing is undelivered. */
  if (obs.containment === "contained") return { action: "clear", basis: "git-ref-contained" };
  if (obs.containment === "divergent") return { action: "refuse", code: "ref-divergent" };
  /* `unknown`, and a present ref whose containment probe never answered, refuse. */
  return { action: "refuse", code: "probe-unknown" };
}

/*
FNXC:PlanningLaneWorktreeIdentity 2026-11-18-18:50 (RUFU-893):
WHAT THE VERDICT SAYS, kept beside the table that produces it so a code and its explanation cannot drift
apart, and so a test can assert an operator-facing sentence without booting a store.

Two rules the sentences obey, both drawn from the failure this card was filed for:
- A refusal names the branch ref and, for `ref-divergent`, whether it is contained in the integration
  branch plus the outstanding commit count — the figure that decides whether to rebase or to abandon. It
  never names a worktree path or a sha: a path invites an operator to delete the thing that still holds the
  work, and a sha is a number nobody can act on from a card face.
- A clear says what was PROVEN, not merely what was done, because the pointer pair is the only record that a
  card ever had an identity, and after the write the History line is all that is left to read.
*/

/** The facts a refusal sentence may state. None of them may reach run-audit. */
export interface PlanningLaneIdentitySentenceFacts {
  branchName: string;
  integrationBranch: string | null;
  divergentCommitCount: number | null;
}

/** The operator-facing sentence for a withheld clear. Printable ASCII only. */
export function planningLaneIdentityRefusalSentence(
  code: PlanningLanePointerRefusalCode,
  facts: PlanningLaneIdentitySentenceFacts,
): string {
  const { branchName, integrationBranch, divergentCommitCount } = facts;
  switch (code) {
    case "ref-divergent": {
      const ahead = divergentCommitCount === null
        ? "commits that are"
        : `${divergentCommitCount} commit${divergentCommitCount === 1 ? "" : "s"} that ${divergentCommitCount === 1 ? "is" : "are"}`;
      const against = integrationBranch ? ` in ${integrationBranch}` : " in the integration branch";
      return `[worktree-identity] Kept the worktree/branch pointers: the branch ref ${branchName} still exists and its tip is NOT contained${against}, so it carries ${ahead} not delivered. Clearing the pointers here would hand that ref to a force-delete that cannot tell divergent work from merged work. Merge or rebase the branch, or clear the pointers by hand if the work is abandoned.`;
    }
    case "probe-unknown":
      return `[worktree-identity] Kept the worktree/branch pointers: git could not answer whether the branch ref ${branchName} still exists or whether its work is delivered, and an unanswerable question is not permission to delete. This is retried once the repository answers again.`;
    case "unmanaged-path-present":
      return "[worktree-identity] Kept the worktree/branch pointers: the recorded worktree path still exists OUTSIDE Fusion's managed worktrees root, so another lane owns that checkout and dropping the only pointer to it would lose the path permanently.";
    case "workspace-card":
      return "[worktree-identity] Kept the worktree/branch pointers: this is a workspace (multi-repository) card, whose per-repository identities are owned by the workspace land and lease lane, not by this sweep.";
    case "operator-branch":
      return `[worktree-identity] Kept the worktree/branch pointers: the branch ${branchName} was named by an operator rather than derived from the task id, so this sweep neither clears nor deletes it.`;
    case "held-or-live":
      return "[worktree-identity] Kept the worktree/branch pointers: the card is paused or holds a checkout claim, so an operator or a still-owned checkout stands behind this identity. Retry or Resume releases it.";
    case "lane-vocabulary-unreadable":
    default:
      return "[worktree-identity] Kept the worktree/branch pointers: the project's lane vocabulary does not place this card's lane where this sweep owns identity (it may have been unreadable entirely), so it cannot tell whether this card is its to clear, and an unproven clear is not a repair.";
  }
}

/**
 * What an applied clear was proven by, said BEFORE the write. Printable ASCII only.
 *
 * Every variant ends by naming what the pass did NOT touch. The sweep clears pointers only; it never
 * deletes a ref, a directory, or a `.git/worktrees/` administration entry — and the sentence has to carry
 * that, because an operator reading "cleared the branch pointers" on a card whose work is on `main` must
 * not conclude the branch was deleted too.
 */
export function planningLaneIdentityClearSentence(basis: PlanningLanePointerClearBasis): string {
  const untouched = "Only the pointers were cleared: no branch, no commit and no directory was touched.";
  switch (basis) {
    case "git-ref-absent":
      return `[worktree-identity] Cleared the worktree/branch pointers: the recorded worktree was gone and git confirmed the branch ref no longer exists, so no commit was ever carried by this name. ${untouched}`;
    case "git-ref-contained":
      return `[worktree-identity] Cleared the worktree/branch pointers: the branch ref still exists and its tip is already contained in the integration branch, so the identity describes delivered work. ${untouched}`;
    case "completion-fanout-named":
    default:
      return `[worktree-identity] Cleared the worktree/branch pointers as part of completing this card. ${untouched}`;
  }
}
