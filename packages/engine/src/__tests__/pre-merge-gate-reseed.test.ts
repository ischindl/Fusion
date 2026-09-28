import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  evaluatePreMergeApprovals: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
}));
/*
FNXC:LifecycleContainment 2026-09-02-22:41:
RUFU-178: the re-seed now clamps its targetColumn through the SHARED core helper, so the module
mock keeps the real `clampReviewGateEntry` — a hand-cloned fake would let the seed and the column
boundary drift while the suite stayed green, which is the whole failure mode the extraction removed.
*/
vi.mock("@fusion/core", async (importOriginal) => ({
  ...((await importOriginal() as typeof import("@fusion/core"))),
  ...core,
}));

import {
  rerouteFailedNoVerdictPreMergeGateToReview,
  rerouteUnrunPreMergeGateToReview,
} from "../merge/pre-merge-gate-reseed.js";

const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any;
const subject = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9243",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  ...overrides,
}) as any;

function store(seeded = true) {
  return {
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
    moveTask: vi.fn(),
  } as any;
}

const required = new Set(["security-review", "code-review"]);

beforeEach(() => {
  core.evaluatePreMergeApprovals.mockReturnValue([
    { workflowStepId: "security-review", state: "missing" },
    { workflowStepId: "code-review", state: "missing" },
  ]);
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "optional-group", column: "in-progress", config: {} },
      { id: "code-review", kind: "step-review", column: "in-review", config: {} },
    ],
  });
});

describe("unrun pre-merge gate reseed", () => {
  it("seeds the earliest missing gate without mutating review evidence or moving the card", async () => {
    const task = subject();
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "security-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-progress",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it.each([
    ["undefined results", subject({ workflowStepResults: undefined }), required, singular, "seeded"],
    ["empty results", subject({ workflowStepResults: [] }), required, singular, "seeded"],
    ["all reported", subject(), required, singular, "no-unrun-gate"],
    ["no enabled gates", subject(), new Set<string>(), singular, "no-unrun-gate"],
    ["workspace content", subject(), required, { kind: "workspace" }, "not-singular"],
    ["workspace task", subject({ workspaceWorktrees: {} }), required, singular, "not-singular"],
    ["operator hold", subject({ paused: true }), required, singular, "operator-held"],
  ] as const)("declines %s without writes", async (_label, task, requiredIds, content, reason) => {
    if (reason === "no-unrun-gate" && requiredIds.size > 0) core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
    const before = structuredClone(task);
    const fake = store();
    const result = await rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: requiredIds, mergeContent: content as any });
    expect(result.reason).toBe(reason);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("preserves last-result semantics and marks a raced seed as an active continuation", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "missing" },
    ]);
    const task = subject({ workflowStepResults: [{ workflowStepId: "security-review", status: "failed" }, { workflowStepId: "security-review", status: "passed", verdict: "APPROVE" }] });
    const before = structuredClone(task);
    const fake = store(false);
    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("declines a missing gate absent from the workflow route", async () => {
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "no-review-route" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:LifecycleContainment 2026-09-02-22:41:
  RUFU-178 (the RUFU-172 wedge): the gate the re-seed picks can be authored in a LATER lane the card
  has already passed. The continuation must never name that column — the boundary enters backward
  review-gate moves in place, so the seed names the card's current column instead.
  */
  it("clamps a planning-lane plan-review gate to the review lane the card stands in", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([{ workflowStepId: "plan-review", state: "missing" }]);
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({
      name: "Coding",
      columns: [
        { id: "todo", name: "Ready", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
      ],
      nodes: [{ id: "plan-review", kind: "optional-group", column: "todo", config: {} }],
    });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: new Set(["plan-review"]), mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "plan-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "plan-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-review",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
  });

  it("keeps the node column for a forward review-gate entry", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([{ workflowStepId: "code-review", state: "missing" }]);
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({
      name: "Coding",
      columns: [
        { id: "in-progress", name: "WIP", traits: [{ trait: "wip", config: {} }] },
        { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
      ],
      nodes: [{ id: "code-review", kind: "step-review", column: "in-review", config: {} }],
    });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject({ column: "in-progress" }), { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "code-review", sourceColumn: "in-progress", targetColumn: "in-review",
    }));
  });

  it("re-seeds exactly a failed no-verdict code review while retaining its finding evidence", async () => {
    const task = subject({
      steps: [{ name: "Documentation & Delivery", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      nodeId: "code-review",
      runId: expect.stringContaining("failed-no-verdict-pre-merge-gate-reseed"),
    }));
    expect(task).toEqual(before);
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]).toMatchObject({ status: "done" });
  });

  it.each([
    ["a real REVISE", { status: "failed", verdict: "REVISE" }],
    ["a pending result", { status: "pending" }],
    ["a bypassed result", { status: "skipped", bypassedBy: "operator" }],
    ["a post-merge result", { status: "failed", phase: "post-merge" }],
  ])("does not re-run %s", async (_label, result) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", ...result }] });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("refuses duplicate dispatch, manual hold, and selection change", async () => {
    const retryTask = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }] });
    const duplicate = store(false);
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(duplicate, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });

    for (const [task, content, expected] of [
      [subject({ paused: true, workflowStepResults: retryTask.workflowStepResults }), singular, "operator-held"],
    ] as const) {
      const fake = store();
      await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required,
        mergeContent: content as any,
      })).resolves.toMatchObject({ rerouted: false, reason: expected });
      expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    }

    /*
    FNXC:NoVerdictWorkspaceSeed 2026-09-28-09:15 (RUFU-391): this lane used to answer a workspace card
    with "not-singular". The idle seed reads no merge content at all, so that guard never protected
    anything — it only kept workspace cards from the review re-run they were owed, and on a board of
    workspace cards that meant the verdict-less gate was never re-run. Non-singular content now seeds;
    the unrun-gate lane keeps its own content guard untouched.
    */
    const workspaceFake = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(workspaceFake, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "workspace" } as any,
    })).resolves.toMatchObject({ rerouted: true, nodeId: "code-review" });
    expect(workspaceFake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);

    const changed = store(false);
    changed.seedWorkspaceCodeReviewContinuationIfIdle.mockResolvedValueOnce({ seeded: false, reason: "workflow-selection-changed" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(changed, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: ["code-review"] },
    })).resolves.toMatchObject({ rerouted: false, reason: "workflow-selection-changed" });
  });
});
