/*
FNXC:WorkflowStepTimeoutLane 2026-11-18-02:25 (RUFU-684):
The lane vocabulary is the contract three consumers share — the executor's budget decision, the
`task:workflow-step-timeout` audit row, and the durable census. Each rule below is the lane a NAMED
surface must land in, taken from the card's Surface Enumeration, so a rename or a reordered rule that
silently moves a lane is caught here rather than in the middle of a review budget decision.
*/
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_STEP_TIMEOUT_FLOOR_MS,
  WORKFLOW_STEP_TIMEOUT_LANES,
  asWorkflowStepTimeoutLane,
  classifyWorkflowPromptStepLane,
  isReviewTypePromptStep,
  resolveWorkflowStepTimeoutBudget,
} from "../workflows/workflow-step-timeout-lane.js";
import {
  DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS,
  DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
} from "../workflows/builtin-workflow-settings.js";

describe("classifyWorkflowPromptStepLane", () => {
  it("exposes the closed lane vocabulary the audit row and the census both spell", () => {
    expect(WORKFLOW_STEP_TIMEOUT_LANES).toEqual([
      "plan-review",
      "code-review",
      "post-merge-verification",
      "completion-summary",
      "other-prompt-step",
    ]);
    expect(asWorkflowStepTimeoutLane("code-review")).toBe("code-review");
    expect(asWorkflowStepTimeoutLane("Code Review")).toBeNull();
    expect(asWorkflowStepTimeoutLane(undefined)).toBeNull();
  });

  it("resolves Plan Review from every shape a caller can hold", () => {
    expect(classifyWorkflowPromptStepLane({ nodeId: "graph:plan-review-step", name: "Plan Review" })).toBe("plan-review");
    expect(classifyWorkflowPromptStepLane({ name: "Plan Review" })).toBe("plan-review");
    expect(classifyWorkflowPromptStepLane({ stepId: "plan-review", name: "Spec Gate" })).toBe("plan-review");
    expect(classifyWorkflowPromptStepLane({ nodeId: "graph:plan-review-step", name: "Plan Review", phase: "pre-merge" })).toBe("plan-review");
  });

  it("resolves Code Review from group id, review kind, and authored name", () => {
    expect(classifyWorkflowPromptStepLane({ nodeId: "graph:code-review-step", name: "Code Review", optionalGroupId: "code-review" })).toBe("code-review");
    expect(classifyWorkflowPromptStepLane({ stepId: "code-review", name: "Code Review" })).toBe("code-review");
    expect(classifyWorkflowPromptStepLane({ stepId: "quality-gate", name: "Quality Gate", reviewKind: "code" })).toBe("code-review");
  });

  it("keeps the completion summary out of the review lanes", () => {
    expect(classifyWorkflowPromptStepLane({ nodeId: "graph:completion-summary", name: "Summarize the change" })).toBe("completion-summary");
    expect(classifyWorkflowPromptStepLane({ stepId: "completion-summary", name: "Completion summary" })).toBe("completion-summary");
    expect(classifyWorkflowPromptStepLane({ stepId: "completion-summary", name: "Completion Summary" })).toBe("completion-summary");
    expect(isReviewTypePromptStep({ stepId: "completion-summary", name: "Completion Summary" })).toBe(false);
  });

  it("names the post-merge validation surface from phase or from its authored name", () => {
    expect(classifyWorkflowPromptStepLane({ stepId: "post-merge-verification", name: "Post-merge verification", phase: "post-merge" })).toBe("post-merge-verification");
    // A History line carries a name and no phase; it must not become a different lane than the engine's verdict.
    expect(classifyWorkflowPromptStepLane({ name: "Post-merge verification" })).toBe("post-merge-verification");
    expect(classifyWorkflowPromptStepLane({ stepId: "verify-landed", name: "Landed build check", phase: "post-merge" })).toBe("other-prompt-step");
  });

  it("keeps every other prompt-mode step in the catch-all lane", () => {
    expect(classifyWorkflowPromptStepLane({ nodeId: "graph:docs-delivery", name: "Documentation & Delivery" })).toBe("other-prompt-step");
    expect(classifyWorkflowPromptStepLane({ stepId: "browser-verification", name: "Browser Verification" })).toBe("other-prompt-step");
  });

  it("classifies the review-type predicate over the same surfaces, including author flags", () => {
    expect(isReviewTypePromptStep({ nodeId: "graph:code-review-step", name: "Code Review", optionalGroupId: "code-review" })).toBe(true);
    expect(isReviewTypePromptStep({ name: "Docs review" })).toBe(true);
    expect(isReviewTypePromptStep({ name: "Spec verification" })).toBe(true);
    expect(isReviewTypePromptStep({ name: "Ship it", reviewCanFixInline: true })).toBe(true);
    expect(isReviewTypePromptStep({ name: "Summarize the change" })).toBe(false);
  });
});

describe("resolveWorkflowStepTimeoutBudget", () => {
  it("routes review lanes to the review knob and everything else to the shared knob", () => {
    const settings = { workflowStepTimeoutMs: 900_000, workflowReviewStepTimeoutMs: 1_800_000 };
    expect(resolveWorkflowStepTimeoutBudget(settings, { stepId: "code-review", name: "Code Review" })).toMatchObject({
      lane: "code-review",
      reviewType: true,
      knob: "workflowReviewStepTimeoutMs",
      timeoutMs: 1_800_000,
    });
    expect(resolveWorkflowStepTimeoutBudget(settings, { stepId: "completion-summary", name: "Completion Summary" })).toMatchObject({
      lane: "completion-summary",
      reviewType: false,
      knob: "workflowStepTimeoutMs",
      timeoutMs: 900_000,
    });
    expect(resolveWorkflowStepTimeoutBudget(settings, { nodeId: "graph:execute", name: "Implement" })).toMatchObject({
      lane: "other-prompt-step",
      timeoutMs: 900_000,
    });
  });

  it("falls back to each lane's code-owned default when nothing is stored", () => {
    expect(resolveWorkflowStepTimeoutBudget({}, { stepId: "plan-review", name: "Plan Review" })).toMatchObject({
      knob: "workflowReviewStepTimeoutMs",
      timeoutMs: DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS,
    });
    expect(resolveWorkflowStepTimeoutBudget({}, { nodeId: "graph:execute", name: "Implement" })).toMatchObject({
      knob: "workflowStepTimeoutMs",
      timeoutMs: DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
    });
    expect(resolveWorkflowStepTimeoutBudget(null, { stepId: "code-review", name: "Code Review" }).timeoutMs)
      .toBe(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS);
  });

  /*
   * FNXC:WorkflowStepTimeoutLane 2026-11-19-07:10 (RUFU-684):
   * Not a hypothetical: the census re-run found two live boards that had already raised the SHARED knob to
   * rescue their reviews (2 700 s and 1 800 s). A review lane that read its own knob alone would arm those
   * cards at 1 800 s and shorten a review that today completes -- turning a shipped fix into a new source of
   * unreviewed merges. The review budget is therefore never below the shared budget.
   */
  it("never drops a review lane below a shared budget an operator already raised", () => {
    // Shared knob raised, review knob never configured: the shared value keeps bounding reviews.
    expect(resolveWorkflowStepTimeoutBudget({ workflowStepTimeoutMs: 2_700_000 }, { stepId: "code-review", name: "Code Review" }).timeoutMs)
      .toBe(2_700_000);
    // A review value smaller than an already-raised shared value does not shrink the lane.
    expect(resolveWorkflowStepTimeoutBudget(
      { workflowStepTimeoutMs: 2_700_000, workflowReviewStepTimeoutMs: 900_000 },
      { stepId: "plan-review", name: "Plan Review" },
    ).timeoutMs).toBe(2_700_000);
    // The rule is one-directional: non-review lanes keep the shared number exactly as configured.
    expect(resolveWorkflowStepTimeoutBudget({ workflowStepTimeoutMs: 2_700_000 }, { nodeId: "graph:execute", name: "Implement" }).timeoutMs)
      .toBe(2_700_000);
    // And it never invents slack for a lane that never asked: an unset shared knob leaves the review value.
    expect(resolveWorkflowStepTimeoutBudget({ workflowReviewStepTimeoutMs: 1_800_000 }, { stepId: "code-review", name: "Code Review" }).timeoutMs)
      .toBe(1_800_000);
  });

  it("keeps the 60 s floor under both knobs, whatever an operator stored", () => {
    expect(resolveWorkflowStepTimeoutBudget({ workflowStepTimeoutMs: 1, workflowReviewStepTimeoutMs: 1 }, { stepId: "code-review", name: "Code Review" }).timeoutMs)
      .toBe(WORKFLOW_STEP_TIMEOUT_FLOOR_MS);
    expect(resolveWorkflowStepTimeoutBudget({ workflowStepTimeoutMs: 1 }, { nodeId: "graph:execute", name: "Implement" }).timeoutMs)
      .toBe(WORKFLOW_STEP_TIMEOUT_FLOOR_MS);
  });
});
