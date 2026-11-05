/**
 * FNXC:ReviewRevisionWait 2026-09-29-15:05 (RUFU-280):
 * Matrix for the predicate that keeps an authored review revision from being read as a stall.
 *
 * The two clauses are conjoined on purpose, so the matrix exercises each clause ALONE as well as
 * together: dropping either one silently re-parks a card that is provably still working, and the
 * contrast test on the engine side (`verdictless-pre-merge-gate-rerun.test.ts` case (e)) depends on
 * the conjunction holding, because its REVISE fixture carries neither clause.
 *
 * FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447):
 * The second clause is now ANY pending step bounded by `REVIEW_REVISION_PARK_DEFER_HORIZON_MS`, so the
 * matrix gained the age axis (inside / past the horizon) and the shape RUFU-280 could not see: an
 * authored `REVISE` whose findings exist only in the verdict's notes, or whose remediation append never
 * landed. The fixture clock is anchored to the real clock rather than a fixed 2026 date, because the
 * default `Date.now()` path IS the production path and a frozen past date would silently put every
 * case outside the horizon. Age-sensitive cases inject `nowMs` explicitly; nothing here sleeps.
 */
import { describe, expect, it } from "vitest";
import {
  AWAITING_REVIEW_REVISION_STALL_REASON,
  findAwaitingReviewRevisionGate,
  isAwaitingReviewRevision,
  REVIEW_REVISION_PARK_DEFER_HORIZON_MS,
} from "../tasks/review-revision-wait.js";
import { deriveTaskStallReason } from "../tasks/task-stall-reason.js";
/*
FNXC:GateBarrelParity 2026-09-30-07:19 (RUFU-280 code-review remediation, P1):
The engine-core merge-gate project resolves `@fusion/core` through the REDUCED `index.gate.ts` barrel,
so a symbol exported only from `index.ts` is not a build failure there - it is a `__vite_ssr_import_0__`
TypeError at the first call, in the lane that decides whether a card merges. `getInReviewStallReason`
imports this predicate from `@fusion/core`, so the parity is load-bearing and is asserted below in the
same dual-import shape `workflow-step-results.test.ts` and `agent-log-read-guard.test.ts` already use.
*/
import {
  AWAITING_REVIEW_REVISION_STALL_REASON as GATE_AWAITING_SENTENCE,
  findAwaitingReviewRevisionGate as findAwaitingReviewRevisionGateFromGateBarrel,
  isAwaitingReviewRevision as isAwaitingReviewRevisionFromGateBarrel,
  REVIEW_REVISION_PARK_DEFER_HORIZON_MS as GATE_DEFER_HORIZON_MS,
} from "../index.gate.js";
import {
  AWAITING_REVIEW_REVISION_STALL_REASON as MAIN_AWAITING_SENTENCE,
  findAwaitingReviewRevisionGate as findAwaitingReviewRevisionGateFromMainBarrel,
  isAwaitingReviewRevision as isAwaitingReviewRevisionFromMainBarrel,
  REVIEW_REVISION_PARK_DEFER_HORIZON_MS as MAIN_DEFER_HORIZON_MS,
} from "../index.js";
import type { ReviewRevisionWaitSubject as ReviewRevisionWaitSubjectFromGateBarrel } from "../index.gate.js";
import { getInReviewStallReason } from "../tasks/in-review-stall.js";
import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER } from "../merge/task-merge.js";
import { hasPendingRemediationWork } from "../tasks/remediation-steps.js";
import type { HumanMergeApprovalState, Task, TaskStep, WorkflowStepResult } from "../types.js";

/*
Anchored to the real clock: the predicate's default (`Date.now()`) is what production runs, and the
fixture rows sit seconds old against it, i.e. inside the defer horizon by construction. Ageing a case
is done by stamping the AUTHORED ROW older (`olderThanHorizon`), never by waiting on a wall clock.
*/
const NOW = Date.now();

/** A row clock strictly older than the defer horizon — the expiry cases stamp their authored row with it. */
function olderThanHorizon(): string {
  return new Date(NOW - REVIEW_REVISION_PARK_DEFER_HORIZON_MS - 60_000).toISOString();
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return { name: "remediate findings", status: "pending", ...overrides } as TaskStep;
}

/** A remediation-carried step: `remediation` provenance is what makes it structural. */
function pendingRemediation(): TaskStep {
  return step({ remediation: { workflowStepId: "code-review", findingIds: ["f-1"] } } as Partial<TaskStep>);
}

function reviewRow(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    status: "failed",
    verdict: "REVISE",
    reviewInputFingerprint: "sha256:aaaa",
    startedAt: at(-60_000),
    completedAt: at(-30_000),
    output: "",
    notes: "",
    phase: "pre-merge",
    ...overrides,
  } as WorkflowStepResult;
}

/**
 * The stall ladder has a `no-worktree-no-merge-confirmed` arm that runs BEFORE its merge-blocker arm,
 * so the ladder-facing cases need a checkout to stand on. The derived-chip path never consults one.
 */
function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-280",
    column: "in-review",
    status: undefined,
    paused: false,
    updatedAt: at(0),
    worktree: "/tmp/rufu-280-worktree",
    steps: [pendingRemediation()],
    workflowStepResults: [reviewRow()],
    ...overrides,
  } as unknown as Task;
}

describe("isAwaitingReviewRevision — conjunction of authored verdict and pending remediation", () => {
  it("names the gate for an authored REVISE whose remediation is still pending", () => {
    const task = card();
    expect(isAwaitingReviewRevision(task)).toBe(true);
    expect(findAwaitingReviewRevisionGate(task)).toBe("code-review");
  });

  it("is false when no step of any kind is still pending — the revision was already corrected", () => {
    const task = card({ steps: [step({ status: "done", completedAt: at(0) } as Partial<TaskStep>)] });
    expect(hasPendingRemediationWork(task)).toBe(false);
    expect(isAwaitingReviewRevision(task)).toBe(false);
  });

  /*
  FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447): this is the case RUFU-280 asserted as
  FALSE and the case this change exists to flip. A reviewer who names the corrections in the verdict's
  `notes` publishes no `step.remediation` provenance, and neither does an executor that died between
  the verdict write and the remediation append — yet the card still owes steps, and RUFU-269 measured
  that shape reaching the deadlock park anyway.
  */
  it("classifies a notes-only REVISE whose board carries only ordinary pending steps", () => {
    const notesOnly = reviewRow({
      notes: "Fix: lockfile drift in plugin workspaces. Fix: add the regression test. Fix: stale doc.",
    });
    const task = card({
      steps: [
        step({ name: "Preflight", status: "done" } as Partial<TaskStep>),
        step({ name: "Implement", status: "pending" } as Partial<TaskStep>),
        step({ name: "Docs", status: "pending" } as Partial<TaskStep>),
      ],
      workflowStepResults: [notesOnly],
    });
    expect(hasPendingRemediationWork(task)).toBe(false);
    expect(isAwaitingReviewRevision(task)).toBe(true);
    expect(findAwaitingReviewRevisionGate(task)).toBe("code-review");
  });

  it("is false for an authored REVISE with no durable review input — that is a plumbing death, not a finding", () => {
    // `reviewInputFingerprint` absent is the FN-279 unproven shape; the verdict-less recovery lane owns it.
    const task = card({ workflowStepResults: [reviewRow({ reviewInputFingerprint: undefined })] });
    expect(isAwaitingReviewRevision(task)).toBe(false);
  });

  it("is false for a verdict-less row regardless of status or error prose", () => {
    const withError = card({
      workflowStepResults: [reviewRow({
        verdict: undefined,
        error: "Code review gate failed before producing a verdict; awaiting review corrections",
      })],
    });
    expect(isAwaitingReviewRevision(withError)).toBe(false);
  });

  it("ignores rows from a post-merge phase — those gates never gate the merge", () => {
    const task = card({ workflowStepResults: [reviewRow({ phase: "post-merge" })] });
    expect(isAwaitingReviewRevision(task)).toBe(false);
  });

  it("lets the NEWEST row win its own gate: a later APPROVE releases a card an earlier round revised", () => {
    const task = card({
      workflowStepResults: [
        reviewRow({ completedAt: at(-120_000) }),
        reviewRow({ verdict: "APPROVE", status: "passed", completedAt: at(-10_000) }),
      ],
    });
    expect(isAwaitingReviewRevision(task)).toBe(false);
  });

  it("keeps deferring when the newest row is the revision, even if an older round approved", () => {
    const task = card({
      workflowStepResults: [
        reviewRow({ verdict: "APPROVE", status: "passed", completedAt: at(-120_000) }),
        reviewRow({ completedAt: at(-10_000) }),
      ],
    });
    expect(isAwaitingReviewRevision(task)).toBe(true);
  });

  it("reduces to the gate that owes the revision when several gates are in play", () => {
    const task = card({
      workflowStepResults: [
        reviewRow({ workflowStepId: "security-review", verdict: "APPROVE", status: "passed", completedAt: at(-40_000) }),
        reviewRow({ completedAt: at(-20_000) }),
      ],
    });
    expect(findAwaitingReviewRevisionGate(task)).toBe("code-review");
  });

  it("is false with no review rows at all, whatever the step board says", () => {
    expect(isAwaitingReviewRevision(card({ workflowStepResults: [] }))).toBe(false);
    expect(isAwaitingReviewRevision(card({ workflowStepResults: undefined }))).toBe(false);
    expect(findAwaitingReviewRevisionGate(card({ workflowStepResults: undefined }))).toBeUndefined();
  });
})

/*
FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447):
The deferral is bounded, and the bound is the only thing that kept the broadened clause from deleting
the operator alarm entirely. Past `REVIEW_REVISION_PARK_DEFER_HORIZON_MS` the predicate goes false, the
card falls back to `merge-blocker`, the episode re-keys, and the ordinary deadlock park — which the
wedge table DOES alert on — becomes reachable again. A deferral with no expiry is a card that can never
be reported stuck, which is a worse failure than the one RUFU-280 removed.
*/
describe("the defer horizon bounds how long a revision can defer the park", () => {
  /** Notes-only `REVISE` plus ordinary pending steps: the shape only the broadened clause can see. */
  function notesOnlyCard(overrides: Partial<Task> = {}): Task {
    return card({
      steps: [
        step({ name: "Implement", status: "done" } as Partial<TaskStep>),
        step({ name: "Test", status: "pending" } as Partial<TaskStep>),
      ],
      ...overrides,
    });
  }

  it("defers while the authored row is younger than the horizon", () => {
    const task = notesOnlyCard();
    expect(isAwaitingReviewRevision(task, { nowMs: NOW })).toBe(true);
  });

  it("releases the card to the ordinary classification once the authored row ages past the horizon", async () => {
    const aged = reviewRow({ startedAt: olderThanHorizon(), completedAt: olderThanHorizon() });
    const task = notesOnlyCard({ workflowStepResults: [aged] });
    expect(isAwaitingReviewRevision(task, { nowMs: NOW })).toBe(false);
    expect(findAwaitingReviewRevisionGate(task, { nowMs: NOW })).toBeUndefined();
    // Both authorities hand the released card back to the ordinary blocker, so the alertable park and the
    // operator's `merge-blocker` chip stay reachable — the alarm never stops existing.
    expect(getInReviewStallReason(task, { now: NOW })?.code).toBe("merge-blocker");
    expect((await deriveTaskStallReason(task, { now: NOW }))?.code).toBe("merge-blocker");
  });

  it("bounds the STRUCTURAL shape too, so no provenance buys an indefinite reprieve", () => {
    const aged = reviewRow({ startedAt: olderThanHorizon(), completedAt: olderThanHorizon() });
    expect(isAwaitingReviewRevision(card({ workflowStepResults: [aged] }), { nowMs: NOW })).toBe(false);
    // Contrast on the same fixture with a fresh row: the row's age is the only difference.
    expect(isAwaitingReviewRevision(card(), { nowMs: NOW })).toBe(true);
  });

  it("ages from the authored row's own clock, never from `updatedAt` a foreign write bumped", () => {
    // A stale card touched five minutes ago by an unrelated write still defers: the row, not the row's
    // `updatedAt`, is what the horizon measures (otherwise every board write would extend the grace).
    const task = notesOnlyCard({ updatedAt: new Date(NOW - 5 * 60_000).toISOString() });
    expect(isAwaitingReviewRevision(task, { nowMs: NOW })).toBe(true);
  });

  it("refuses the deferral for an untimeable authored row — no date, no reprieve", () => {
    const task = notesOnlyCard({
      workflowStepResults: [reviewRow({ completedAt: undefined as unknown as string, startedAt: undefined as unknown as string })],
    });
    expect(isAwaitingReviewRevision(task, { nowMs: NOW })).toBe(false);
  });

  it("is false for pending ordinary steps with no authored REVISE — execution is never a revision", () => {
    // This is the `hasPendingReviewRemediationWork` trap: under `reopen-trailing` that helper is true for
    // any mid-implementation card, and labeling one a review revision is the false claim the
    // verdict-first clause order prevents.
    const executing = card({ workflowStepResults: [] });
    expect(isAwaitingReviewRevision(executing, { nowMs: NOW })).toBe(false);
    const approved = card({
      workflowStepResults: [reviewRow({ verdict: "APPROVE", status: "passed" })],
    });
    expect(isAwaitingReviewRevision(approved, { nowMs: NOW })).toBe(false);
  });

  it("keeps a review-convergence human hold out of the revision class in both authorities", async () => {
    /*
    The convergence ladder parks its terminal escalation as `status: "awaiting-approval"` +
    `awaitingApprovalReason: "code-review-non-convergence"`. The predicate itself never reads `status` (its
    subject type excludes it on purpose), so what keeps a human-arbitration hold from being labelled "the
    engine is applying corrections" is the AUTHORITIES: the engine mirror exempts the two human-hold
    statuses at the top of its ladder, and the read side gates its own awaiting arm on the same status set
    (`FNXC:ReviewRevisionHoldParity`). Asserted at both authorities because their agreement IS the
    invariant — a chip promising corrections on a card whose only outstanding move is operator arbitration
    is the RUFU-280 consent-precedence defect wearing a different code.
    */
    const held = notesOnlyCard({
      status: "awaiting-approval",
      awaitingApprovalReason: "code-review-non-convergence",
    });
    expect(getInReviewStallReason(held, { now: NOW })).toBeUndefined();
    const derived = await deriveTaskStallReason(held, { now: NOW });
    expect(derived?.code).not.toBe("awaiting-review-revision");
    // Non-vacuity: the SAME card with the hold lifted is the deferred case asserted above.
    expect((await deriveTaskStallReason(notesOnlyCard(), { now: NOW }))?.code).toBe("awaiting-review-revision");
  });
})

describe("the two stall authorities both name the awaiting-revision state", () => {
  it("getInReviewStallReason returns the new code instead of the failed-steps merge blocker", () => {
    const signal = getInReviewStallReason(card());
    expect(signal?.code).toBe("awaiting-review-revision");
    expect(signal?.reason).toBe(AWAITING_REVIEW_REVISION_STALL_REASON);
  });

  it("deriveTaskStallReason reports the same sentence the stall signal uses", async () => {
    const stall = await deriveTaskStallReason(card(), { now: NOW });
    expect(stall).toEqual({
      code: "awaiting-review-revision",
      reason: AWAITING_REVIEW_REVISION_STALL_REASON,
      observedAt: at(0),
    });
  });

  /*
  A pending remediation step is ITSELF a merge blocker ("task has incomplete steps"), and that arm of
  `getTaskMergeBlocker` precedes the approval arms — so the only shape where one card is both awaiting
  a revision and reported as never-ran is the composed failed-status refusal RUFU-276 documented.
  That is what this ordering guard exists for; the case below proves it is not vacuous.
  */
  it("a never-ran required gate outranks the awaiting arm — the chip must not swallow it", async () => {
    const refusal = `AUTO_MERGE_RETRY_REJECTED: Cannot merge RUFU-280: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`;
    const stall = await deriveTaskStallReason(card({ status: "failed", error: refusal }), {
      now: NOW,
      requiredPreMergeStepIds: ["code-review", "completion-summary"],
    });
    expect(stall?.code).toBe("pre-merge-gate-pending");
  });

  it("the same card with an ordinary blocker reports the awaiting code, so the guard above is not vacuous", async () => {
    const stall = await deriveTaskStallReason(card(), {
      now: NOW,
      requiredPreMergeStepIds: ["code-review", "completion-summary"],
    });
    expect(stall?.code).toBe("awaiting-review-revision");
  });

  /*
  FN-514's exemption is the arm directly above this one, and it is only reachable while the merge door
  reports one of the two operator-decision sentences. Once remediation is pending, `getTaskMergeBlocker`
  answers "task has incomplete steps" first, so the reachable proof of the ordering is the rejected card
  with a quiet step board: it must stay exempt (undefined), not become a revision chip.
  */
  it("the human-wait exemption still runs FIRST — an operator decision is never re-labelled", () => {
    const rejected: HumanMergeApprovalState = {
      enabled: true,
      generation: 1,
      remediationGeneration: 1,
      rejection: {
        requestId: "r-1",
        instruction: "rebase onto main",
        rejectedBy: "operator",
        rejectedAt: at(-120_000),
        candidate: {
          lockGeneration: 1,
          workflowSignature: "builtin:coding@7",
          reviewEpisodeId: at(-300_000),
          contentSignature: "singular:fp:abc",
          targetSignature: "merge:.@origin:fusion/rufu-280->main",
        },
        remediationGeneration: 1,
        state: "pending",
      },
    };
    const rejectedCard = card({
      humanMergeApproval: rejected,
      steps: [{ name: "impl", status: "done", completedAt: at(-600_000) } as TaskStep],
    });
    expect(getInReviewStallReason(rejectedCard, { now: NOW })).toBeUndefined();
  });

  /*
  FNXC:ReviewRevisionConsentPrecedence 2026-09-30-07:19 (RUFU-280 code-review remediation, P0):
  Auto-merge CONSENT outranks the new code. Both authorities already honoured it before this arm
  existed - the engine mirror suppresses the whole ladder at `context.autoMerge === false`, and the
  read ladder's terminal rung answers `held-human-review` on the same fact - so an unconditional
  deferral made the chip claim a withheld-consent card was "working through review corrections": a
  promise the engine is forbidden to keep. The reachable pairing is the blocker one: pending
  remediation is ITSELF the merge blocker ("task has incomplete steps"), so an awaiting-revision card
  always has a blocker standing and the `held-human-review` pairing is unreachable for this shape by
  construction rather than skipped by choice.
  */
  it("withheld auto-merge consent keeps the blocker classification instead of promising remediation", async () => {
    const withheld = await deriveTaskStallReason(card(), { now: NOW, autoMergeAllowed: false });
    expect(withheld?.code).toBe("merge-blocker");
    expect(withheld?.reason).not.toBe(AWAITING_REVIEW_REVISION_STALL_REASON);
    // Contrast on the identical card: granted consent is the awaiting case asserted above.
    expect((await deriveTaskStallReason(card(), { now: NOW }))?.code).toBe("awaiting-review-revision");
  });

  it("the engine mirror says nothing about the same withheld card, so the two authorities still agree", () => {
    expect(getInReviewStallReason(card(), { now: NOW, autoMerge: false })).toBeUndefined();
  });
});

describe("the predicate reaches consumers through both @fusion/core barrels", () => {
  it("resolves the same behaviour through the main barrel and the reduced gate barrel", () => {
    const awaiting = card();
    const settled = card({ workflowStepResults: [] });
    for (const predicate of [
      isAwaitingReviewRevision,
      isAwaitingReviewRevisionFromMainBarrel,
      isAwaitingReviewRevisionFromGateBarrel,
    ]) {
      expect(predicate(awaiting)).toBe(true);
      expect(predicate(settled)).toBe(false);
    }
    for (const gate of [
      findAwaitingReviewRevisionGate,
      findAwaitingReviewRevisionGateFromMainBarrel,
      findAwaitingReviewRevisionGateFromGateBarrel,
    ]) {
      expect(gate(awaiting)).toBe("code-review");
      expect(gate(settled)).toBeUndefined();
    }
    expect(GATE_AWAITING_SENTENCE).toBe(MAIN_AWAITING_SENTENCE);
    expect(GATE_AWAITING_SENTENCE).toBe(AWAITING_REVIEW_REVISION_STALL_REASON);
    /*
    FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447): the horizon constant joined the exported
    set, so parity now covers it too — the engine-core lane reads the predicate AND its bound through the
    gate barrel, and a bound that resolves to `undefined` there compares as `ageMs <= undefined` → false,
    silently un-deferring every card in the gate lane.
    */
    expect(MAIN_DEFER_HORIZON_MS).toBe(REVIEW_REVISION_PARK_DEFER_HORIZON_MS);
    expect(GATE_DEFER_HORIZON_MS).toBe(REVIEW_REVISION_PARK_DEFER_HORIZON_MS);
    expect(GATE_DEFER_HORIZON_MS).toBe(6 * 60 * 60 * 1000);
    // The type-only export is the compile-time half of the parity: a gate-barrel consumer must be able
    // to name the subject without reaching past the barrel into `../tasks/review-revision-wait.js`.
    const gateBarrelSubject: ReviewRevisionWaitSubjectFromGateBarrel = { workflowStepResults: [], steps: [] };
    expect(isAwaitingReviewRevisionFromGateBarrel(gateBarrelSubject)).toBe(false);
  });
});
