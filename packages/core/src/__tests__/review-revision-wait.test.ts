/**
 * FNXC:ReviewRevisionWait 2026-09-29-15:05 (RUFU-280):
 * Matrix for the predicate that keeps an authored review revision from being read as a stall.
 *
 * The two clauses are conjoined on purpose, so the matrix exercises each clause ALONE as well as
 * together: dropping either one silently re-parks a card that is provably still working, and the
 * contrast test on the engine side (`verdictless-pre-merge-gate-rerun.test.ts` case (e)) depends on
 * the conjunction holding, because its REVISE fixture carries neither clause.
 */
import { describe, expect, it } from "vitest";
import {
  AWAITING_REVIEW_REVISION_STALL_REASON,
  findAwaitingReviewRevisionGate,
  isAwaitingReviewRevision,
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
} from "../index.gate.js";
import {
  AWAITING_REVIEW_REVISION_STALL_REASON as MAIN_AWAITING_SENTENCE,
  findAwaitingReviewRevisionGate as findAwaitingReviewRevisionGateFromMainBarrel,
  isAwaitingReviewRevision as isAwaitingReviewRevisionFromMainBarrel,
} from "../index.js";
import type { ReviewRevisionWaitSubject as ReviewRevisionWaitSubjectFromGateBarrel } from "../index.gate.js";
import { getInReviewStallReason } from "../tasks/in-review-stall.js";
import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER } from "../merge/task-merge.js";
import { hasPendingRemediationWork } from "../tasks/remediation-steps.js";
import type { HumanMergeApprovalState, Task, TaskStep, WorkflowStepResult } from "../types.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

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

  it("is false when remediation is no longer pending — the revision was already corrected", () => {
    const task = card({ steps: [step({ status: "done", completedAt: at(0) } as Partial<TaskStep>)] });
    expect(hasPendingRemediationWork(task)).toBe(false);
    expect(isAwaitingReviewRevision(task)).toBe(false);
  });

  it("is false for pending work that carries no remediation provenance", () => {
    const task = card({ steps: [step()] });
    expect(isAwaitingReviewRevision(task)).toBe(false);
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
    // The type-only export is the compile-time half of the parity: a gate-barrel consumer must be able
    // to name the subject without reaching past the barrel into `../tasks/review-revision-wait.js`.
    const gateBarrelSubject: ReviewRevisionWaitSubjectFromGateBarrel = { workflowStepResults: [], steps: [] };
    expect(isAwaitingReviewRevisionFromGateBarrel(gateBarrelSubject)).toBe(false);
  });
});
