import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  resolveWorkflowIrForTask: vi.fn(),
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON: "in-review-stall-deadlock",
}));
vi.mock("@fusion/core", () => core);

import { rerouteSingularStaleContentToReview } from "../merge/stale-content-review-reroute.js";

const currentFingerprint = "current-diff";
const task = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9234",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "security-review", reviewInputFingerprint: "old-diff" }],
  ...overrides,
}) as any;
const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: currentFingerprint } } as any;

function store(seeded = true) {
  return {
    getTaskWorkflowSelection: vi.fn(() => ({ stepIds: ["security-review", "code-review"] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
  } as any;
}

beforeEach(() => {
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "step-review", column: "in-review", config: { name: "Code Review", reviewKind: "code", defaultOn: true } },
      { id: "code-review", kind: "step-review", column: "in-review", config: { name: "Code Review", reviewKind: "code", defaultOn: true } },
    ],
  });
});

describe("singular stale-content review reroute", () => {
  it("seeds the earliest required stale lane without changing review evidence", async () => {
    const subject = task();
    const subjectBefore = structuredClone(subject);
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(subject).toEqual(subjectBefore);
  });

  it.each([
    ["no-progress", task({ workflowStepResults: [{ workflowStepId: "security-review", reviewInputFingerprint: currentFingerprint }, { workflowStepId: "code-review", reviewInputFingerprint: currentFingerprint }] }), singular, store()],
    ["active-continuation", task(), singular, store(false)],
    ["no-review-route", task(), singular, store()],
    ["not-singular", task(), { kind: "workspace" }, store()],
    ["operator-held", task({ paused: true }), singular, store()],
  ] as const)("refuses %s without mutating results", async (reason, subject, content, fake) => {
    if (reason === "no-review-route") core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const before = structuredClone(subject.workflowStepResults);
    const result = await rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: content as any,
    });
    expect(result).toMatchObject({ rerouted: false, reason });
    expect(subject.workflowStepResults).toEqual(before);
    if (reason !== "active-continuation") expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
   * FNXC:StaleContentParkRecovery 2026-10-09-20:04 (RUFU-343):
   * RUFU-301 is the measured shape: a COMPLETED singular card parked by the engine's own review-stall
   * watchdog whose embedded refusal names a stale content-bound approval. A bare `task.paused` veto here
   * meant the only lane that could re-seed review declined the card while reporting nothing but
   * `operator-held`, so no consumer could name the class it was refusing. Admission is now provenance-
   * keyed AND opt-in: the recovery route's `allowDeadlockPark` opens exactly the deadlock park, while a
   * manual hold, a user override, `autoMerge: false`, an unrelated automation pause, and a pause with no
   * reason at all stay refused even when the caller opted in.
   */
  const stalledPark = () => task({
    status: null,
    paused: true,
    pausedReason: "in-review-stall-deadlock",
    error: "In-review stall deadlock: completed-review-status-none — 6 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). "
      + "AUTO_MERGE_RETRY_REJECTED: Cannot merge FN-9234: Cannot merge FN-9234: code-review 'APPROVE' "
      + "was issued for older review input; re-review current content before merging.",
  });

  it("refuses the engine's stall-deadlock park unless the caller owns lifting it", async () => {
    const subject = stalledPark();
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("seeds review for the stall-deadlock park when the recovery route opts in", async () => {
    const subject = stalledPark();
    const before = structuredClone(subject);
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular, allowDeadlockPark: true,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(subject).toEqual(before);
  });

  it.each([
    ["an operator pause", { paused: true }],
    ["an unrelated automation pause", { paused: true, pausedReason: "capacity-oversubscribed" }],
    ["a user override", { paused: true, pausedReason: "in-review-stall-deadlock", userPaused: true }],
    ["a per-task auto-merge opt-out", { paused: true, pausedReason: "in-review-stall-deadlock", autoMerge: false }],
    ["a soft-deleted card", { paused: true, pausedReason: "in-review-stall-deadlock", deletedAt: new Date().toISOString() }],
  ] as const)("keeps %s refused even when the caller opted in", async (_label, overrides) => {
    const subject = task(overrides);
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular, allowDeadlockPark: true,
    })).resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
   * FNXC:StaleContentParkAdmission 2026-10-09-21:16 (RUFU-343 remediation):
   * The pause REASON is not the park. A later terminal can overwrite the row's `error` while leaving the
   * watchdog's pause marker behind, and then the failure the operator sees is no longer a stall the
   * watchdog owns. Comparing `pausedReason` alone admitted exactly this card and its recovery cleared the
   * pause, deleting the only view of the newer failure; the canonical predicate refuses it even when the
   * content claim is still true, which is why this fixture keeps a genuine stale-content sentence.
   */
  it("refuses a pause marker whose watchdog sentence has been replaced, even opted in", async () => {
    const subject = task({
      status: "failed",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      error: "In-review merge deferred (retry 3/3): Cannot merge FN-9234: code-review 'APPROVE' was "
        + "issued for older review input; re-review current content before merging.",
    });
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular, allowDeadlockPark: true,
    })).resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });
});
