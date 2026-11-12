import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  MANUAL_RETRY_RESET_COUNTER_KEYS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
  buildManualRetryResetPatchIfCurrent,
} from "../tasks/manual-retry-reset.js";

const RETRY_SUMMARY_COUNTER_REGEX = /toCount\(task\.(\w+)\)/g;

describe("buildAutoPauseClearPatch", () => {
  it("clears the deadlock auto-pause for auto-paused tasks", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  it("does not clear an explicit user pause", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });

  it("clears the branch-conflict auto-pause for a fresh retry", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: "branch-conflict-unrecoverable",
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  /*
  FNXC:BranchConflictRecovery 2026-11-02-23:20 (RUFU-432):
  The terminal branch-conflict recovery park named Retry as its remedy while `buildAutoPauseClearPatch`
  refused to lift its reason, so a plain `fn task retry` reset the counters and left the card parked —
  the operator pressed the door the sentence pointed at and a second Retry was needed to actually move.
  These two cases pin the lift and the limit of the lift.
  */
  it("clears the terminal branch-conflict recovery park for a fresh retry", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  it("still refuses to lift an operator pause that happens to carry the recovery-exhausted reason", () => {
    // The recovery park is an engine disposition; an operator hold is not, and the allowlist must
    // never become a way for an automatic Retry to overrule a human.
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: true,
      pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
    })).toEqual({});
  });

  it("lifts the recovery park through the plain Retry patch, in the shape every Retry surface spreads", () => {
    const live = {
      paused: true,
      userPaused: undefined,
      pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
      branch: "fusion/rufu-432",
      worktree: "/wt/rufu-432",
      status: "failed",
      error: "Branch-conflict recovery exhausted",
    };
    const patch = buildManualRetryResetPatchIfCurrent(live as never, live as never, buildManualRetryResetPatch());
    expect(patch).not.toBeNull();
    expect(patch).toMatchObject({ paused: false, pausedReason: null });
    // The budget the park spent is the budget the Retry zeroes — this pairing is what makes the
    // engine's applied-park suppression revocable rather than permanent.
    expect(patch).toHaveProperty("recoveryRetryCount", 0);
  });

  it("does not clear an unrelated automatic pause reason", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: "token_budget_exceeded",
    })).toEqual({});
  });

  it("is a no-op when the task is not paused", () => {
    expect(buildAutoPauseClearPatch({
      paused: undefined,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });
});

describe("buildManualRetryResetPatchIfCurrent", () => {
  const expected = {
    branch: "fusion/fn-9434",
    worktree: "/tmp/fn-9434",
    status: "failed",
    error: "branch conflict",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
  } as never;

  it("refuses a stale retry after a scheduler replaces the checkout", () => {
    expect(buildManualRetryResetPatchIfCurrent({
      ...expected,
      worktree: "/tmp/fn-9434-replacement",
    }, expected, { status: null })).toBeNull();
  });

  it("clears only the current branch-conflict automatic pause", () => {
    expect(buildManualRetryResetPatchIfCurrent(expected, expected, { status: null })).toMatchObject({
      status: null,
      paused: false,
      pausedReason: null,
    });
  });
});

describe("buildManualRetryResetPatch", () => {
  it("resets all manual retry counters to zero", () => {
    const patch = buildManualRetryResetPatch();

    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
      expect(patch[key]).toBe(0);
    }
    expect(patch.graphResumeRetryCount).toBe(0);
    expect(patch.consecutiveToolFailureRetryCount).toBe(0);
    expect(patch.toolFailureDetectorLogCursor).toBeNull();
    expect(patch.toolFailureRetryExhaustedAuditEmitted).toBe(false);
  });

  it("includes all retry-summary counters in the reset key list", () => {
    const retrySummarySource = readFileSync(new URL("../tasks/retry-summary.ts", import.meta.url), "utf-8");
    const retrySummaryKeys = new Set<string>();
    let match: RegExpExecArray | null = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    while (match) {
      retrySummaryKeys.add(match[1]);
      match = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    }

    for (const key of retrySummaryKeys) {
      expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain(key);
    }
  });

  it("sets mergeRetries only when requested", () => {
    expect(buildManualRetryResetPatch()).not.toHaveProperty("mergeRetries");
    expect(buildManualRetryResetPatch({ resetMergeRetries: true })).toMatchObject({ mergeRetries: 0 });
  });

  it("clears nextRecoveryAt", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ nextRecoveryAt: null });
  });

  // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 — an operator manual retry is an honest exit
  // that clears the skip-bypass taint marker so the retried task can promote on its skips.
  it("clears the FN-8141 skip-bypass taint marker (bulkCompletionRefusalAt)", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ bulkCompletionRefusalAt: null });
  });

  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — Retry is the sanctioned un-park for a plan-premise terminal park: the patch carries a
  KEY-level sourceMetadataPatch clearing exactly `planPremiseRejection` (pinned literal so a
  constant rename that would orphan persisted episodes is caught here), never a whole-field wipe —
  unrelated sourceMetadata provenance keys must survive a Retry.
  */
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The patch now clears TWO diagnostic episodes, both at the key level. This assertion previously read
  `toEqual({ planPremiseRejection: null })` and was updated — not loosened — when RUFU-273 added the
  planning-admission clear: the object is still pinned literally, so a constant rename that would orphan
  persisted episodes is still caught, and the whole-field wipe guard below is unchanged.
  */
  /*
  FNXC:StrandedContinuationReclaim 2026-11-11-23:45 (RUFU-547):
  The fifth key is the stranded-reclaim episode. Same reasoning as the two above, in its sharpest form:
  RUFU-547 moved the announce ledger and the reached ladder rung onto this carrier precisely because the
  work-item row they used to lean on is re-created under the sweep's hands, and a carrier that survives an
  operator Retry would keep both promises locked against a card the operator just released. The literal is
  re-pinned here — not loosened — so a constant rename that orphans a persisted episode is still caught.
  */
  it("clears the plan-premise, planning-admission, deterministic-spec, branch-conflict-refusal and stranded-reclaim episodes at the key level, never the whole field", () => {
    /*
    FNXC:BranchConflictRecovery 2026-11-04-14:36 (RUFU-395):
    The third key is this family's own refusal register. RUFU-395 made `refusalCount` the sole
    authority for the terminal park, so a Retry that lifted the pause while leaving the register would
    be a no-op: the next refusal recomputes exhaustion from the surviving count and re-parks the card
    the operator just released. The literal stays pinned on purpose — a constant rename that would
    orphan a persisted episode is still caught here rather than in production.
    */
    expect(buildManualRetryResetPatch().sourceMetadataPatch).toEqual({ planPremiseRejection: null, planAdmissionStall: null, deterministicSpecRejection: null, branchConflictRecoveryEpisode: null, strandedContinuationReclaim: null });
    expect(buildManualRetryResetPatch({ resetMergeRetries: true }).sourceMetadataPatch).toEqual({ planPremiseRejection: null, planAdmissionStall: null, deterministicSpecRejection: null, branchConflictRecoveryEpisode: null, strandedContinuationReclaim: null });
    expect(buildManualRetryResetPatch()).not.toHaveProperty("sourceMetadata");
  });

  /*
  FNXC:DeterministicSpecRejection 2026-11-08-03:20 (RUFU-485):
  RUFU-485's short-circuit parks on the SECOND identical deterministic refusal, so these cases are what
  make an operator Retry a real door rather than a no-op: the identity the park reads must be gone, the
  unrelated provenance keys sharing the same JSONB carrier must not be collateral damage, and the
  borrowed dispatch counter must still reset through the shared list so a re-planned card can consume
  its full cadence again.
  */
  it("clears the deterministic-spec episode at the key level while unrelated provenance keys survive", () => {
    const patch = buildManualRetryResetPatch();
    expect(patch.sourceMetadataPatch).toMatchObject({ deterministicSpecRejection: null });
    // Key-level only: the Retry never claims the whole `sourceMetadata` field, so `duplicateOfTaskIds`,
    // `handoffFrom` and `contentFingerprint` written by other lanes survive a Retry.
    expect(patch).not.toHaveProperty("sourceMetadata");
    // And the cadence the hold arm borrowed is zeroed by the same statement (RUFU-395's pairing rule).
    expect(patch.recoveryRetryCount).toBe(0);
    expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain("recoveryRetryCount");
  });

  it("leaves RUFU-768's re-seed marker and RUFU-393's capacity episode out of this card's clear list", () => {
    // Scope boundary: the re-seed ceiling is a different lane's tested surface and resets only on a
    // clean planning handoff, and the WIP-admission episode's release owner is the hold/release sweep.
    // An accidental clear here would silently raise that ceiling or overrule a capacity gate.
    const keys = Object.keys(buildManualRetryResetPatch().sourceMetadataPatch ?? {});
    expect(keys).not.toContain("planningReseedCycles");
    expect(keys).not.toContain("wipAdmissionStall");
  });

  it("lifts the recovery park AND empties its register in one patch, so a Retry is not a no-op", () => {
    /*
    The pairing is the whole point of RUFU-395's lift: the park reads the register, the suppression
    reads the pause state, and both must go in the SAME statement or the card re-parks on its next
    refusal with the pause already lifted — a worse failure than the permanent park, because the card
    looks released while behaving as if it were not.
    */
    const live = {
      paused: true,
      userPaused: undefined,
      pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
      recoveryRetryCount: 3,
      sourceMetadata: { branchConflictRecoveryEpisode: { refusalCount: 3, firstAt: "2026-11-04T00:00:00.000Z", lastAt: "2026-11-04T00:00:00.000Z", lastSource: "self-owned-reclaim" } },
      status: "failed",
      error: "Branch-conflict recovery exhausted",
    };
    const patch = buildManualRetryResetPatchIfCurrent(live as never, live as never, buildManualRetryResetPatch());
    expect(patch).not.toBeNull();
    expect(patch).toMatchObject({ paused: false, pausedReason: null, recoveryRetryCount: 0 });
    expect(Object.keys((patch as { sourceMetadataPatch: Record<string, unknown> }).sourceMetadataPatch)).toContain("branchConflictRecoveryEpisode");
  });

  it("refuses to lift a userPaused card through the automatic clear, but still empties its register", () => {
    /*
    RUFU-395 acceptance: a `userPaused` card is never auto-cleared; a manual retry on one is still
    honored. These are two authorities and the fix must not lose the second one.
    `buildManualRetryResetPatch` carries no `paused` claim of its own — the pause lift is
    `buildAutoPauseClearPatch`, layered by `buildManualRetryResetPatchIfCurrent`, which refuses an
    operator hold by design (an automatic Retry may not overrule a human). What the retry patch DOES
    do for a held card is empty the register, so when the operator eventually un-pauses, the card
    starts from zero refusals instead of re-parking on the count it was held with.
    */
    const held = {
      paused: true,
      userPaused: true,
      pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
      recoveryRetryCount: 3,
      sourceMetadata: { branchConflictRecoveryEpisode: { refusalCount: 3, firstAt: "", lastAt: "", lastSource: "pr-reclaim" } },
    };
    expect(buildAutoPauseClearPatch(held as never)).toEqual({});
    const explicit = buildManualRetryResetPatch();
    expect("paused" in explicit).toBe(false);
    expect(explicit.sourceMetadataPatch).toMatchObject({ branchConflictRecoveryEpisode: null });
    // The composed patch for a held card keeps the hold and still clears the register.
    const composed = buildManualRetryResetPatchIfCurrent(held as never, held as never, explicit);
    expect(composed).not.toBeNull();
    expect(composed).not.toHaveProperty("paused");
    expect(composed!.sourceMetadataPatch).toMatchObject({ branchConflictRecoveryEpisode: null });
  });
});
