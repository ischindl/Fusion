/**
 * The shared worktree-content vocabulary: what a card's checkout holds, relative to the work the card
 * was supposed to deliver.
 *
 * FNXC:ZeroCommitDeliveryProof 2026-09-26-01:30 (RUFU-274):
 * This lives in the pure types barrel rather than in `merge/zero-commit-landing-proof.ts` because three
 * layers name the same states and must not name them differently: the row shape
 * (`MergeDetails.uncommittedWorkHold.contentState`), the pure decision table
 * (`evaluateZeroCommitLandingProof`), and the git observation
 * (`classifyTaskWorktreeContent` in `@fusion/engine`). Declaring it in a module that imports nothing
 * keeps `types/task/task-core.ts` free of an import cycle back into `merge/`.
 *
 * The first four states are the existing removal classification
 * (`WorktreeRemovalContentClassification` in `packages/engine/src/worktree/worktree-backend.ts`) reused
 * rather than duplicated; `unverifiable` and `absent` are the two answers the removal classifier cannot
 * give because it either throws or never runs.
 *
 * - `clean` — nothing tracked is modified and nothing untracked exists.
 * - `regenerable-ignored` — only allowlisted build/dependency/cache output (FN-9233 scratch).
 * - `ignored-only` — ignored content that is NOT on the regenerable allowlist.
 * - `deliverable` — modified or untracked files that could be the card's work.
 * - `unverifiable` — the tree could not be classified (failed or timed-out probe).
 * - `absent` — the recorded worktree path is provably gone and no other checkout holds the card's branch.
 */
export type WorktreeContentState =
  | "clean"
  | "regenerable-ignored"
  | "ignored-only"
  | "deliverable"
  | "unverifiable"
  | "absent";

/**
 * One exported worktree-content classification, shared by the zero-diff finalize guard, the cleanup-proof
 * gate and the refusal marker, so the three can never disagree about what the tree held.
 *
 * It is a discriminated union rather than a bare enum because the refusal marker, the run-audit row and
 * the operator sentence all need the COUNTS that justify a refusal, and a state that carries its own
 * evidence cannot state a contradiction (`{ state: "clean", modifiedCount: 4 }` is not expressible).
 *
 * The RUFU-274 spec's four-state example classification (`clean` / `dirty` / `pathMissing` /
 * `probeFailed`) maps onto this vocabulary: `dirty` = `deliverable`, `probeFailed` = `unverifiable`,
 * `pathMissing` = `absent`. The two extra states exist because the removal classifier already
 * distinguishes regenerable scratch from ignored content that is not regenerable, and the spec requires
 * scratch-only trees never to count as uncommitted delivery — a rule a four-state union cannot express
 * without losing the removal gate's existing `ignored-only` distinction.
 */
export type WorktreeContentClassification =
  | { state: "clean" }
  | { state: "regenerable-ignored"; scratchEntryCount?: number }
  | { state: "ignored-only"; entryCount?: number }
  | {
      state: "deliverable";
      modifiedCount: number;
      untrackedCount: number;
      /** Non-ignored paths observed, for the row-visible sentence. Bounded by the probe; never content. */
      paths?: readonly string[];
    }
  | { state: "unverifiable"; probeDetail?: string }
  | { state: "absent" };

/**
 * Convenience for a probe that proved the tree holds nothing.
 *
 * FNXC:ZeroCommitDeliveryProof 2026-09-26-01:30 (RUFU-274): the ONLY way to assert emptiness without a
 * probe is to name this constant, which is greppable. It is not a default value anywhere: a guard that
 * defaults its content parameter to this would recreate RUFU-262's implicit-clean assumption.
 */
export const CLEAN_WORKTREE_CONTENT: WorktreeContentClassification = { state: "clean" };
