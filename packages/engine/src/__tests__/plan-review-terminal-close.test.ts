/*
FNXC:TerminalPlanReviewClose 2026-11-14-03:30 (RUFU-599 reproduction 3, SANE-532):
A card whose Plan Review row records an ACCEPTED terminal close (`passed` + `CLOSE_NO_OP` + a leading
`NO-OP:` / `DUPLICATE:` sentinel) kept executing its step list and completing as ordinary work. The resume
authority read that row through `isPlanReviewSatisfied`, which answers true for any `passed` row, treated the
card's END as a released gate, and placed the run on the node AFTER Plan Review — SANE-532 ran three steps
this way and SANE-534 closed `done`.

Pinned here:
  - the terminal-close predicate requires the full accepted shape, including the sentinel that legalised the
    close at the authoring gate, and only the LATEST non-superseded Plan Review row can be terminal;
  - an accepted close releases NOTHING forward (`isGateReleased` false);
  - placement for such a card pins Plan Review whatever lane it stands in, while an ordinary approved plan
    still advances past the gate exactly as before.
*/
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_REVIEW_GROUP_ID,
  acceptedTerminalPlanReviewClose,
  getBuiltinWorkflow,
  isTerminalPlanReviewCloseRow,
  parseWorkflowIr,
  type TaskDetail,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { isGateReleased, resolveResumePlacement } from "../workflows/resume-placement.js";

const codingIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

function task(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "RUFU-599-T",
    title: "terminal close",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    ...over,
  } as unknown as TaskDetail;
}

function closeRow(over: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: PLAN_REVIEW_GROUP_ID,
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    status: "passed",
    reviewKind: "plan",
    verdict: "CLOSE_NO_OP",
    notes: "NO-OP: the requested guard already ships on main",
    completedAt: "2026-11-14T10:00:00.000Z",
    ...over,
  } as unknown as WorkflowStepResult;
}

describe("terminal Plan Review close — one accepted-close fact", () => {
  it("recognises the full accepted shape", () => {
    expect(isTerminalPlanReviewCloseRow(closeRow())).toBe(true);
    expect(acceptedTerminalPlanReviewClose([closeRow()])?.verdict).toBe("CLOSE_NO_OP");
  });

  it.each([
    ["a superseded close", closeRow({ supersededAt: "2026-11-14T11:00:00.000Z" })],
    ["a close without the sentinel that legalised it", closeRow({ notes: "reviewer said it looks like a no-op" })],
    ["an ordinary approval", closeRow({ verdict: "APPROVE_WITH_NOTES", notes: "fine" })],
    ["a refused close (invalid request keeps failed evidence)", closeRow({ status: "failed" })],
    ["a still-open gate", closeRow({ status: "pending", verdict: undefined, notes: undefined })],
    ["a different gate's row", closeRow({ workflowStepId: "code-review" })],
  ] as const)("%s is not terminal", (_label, row) => {
    expect(isTerminalPlanReviewCloseRow(row)).toBe(false);
    expect(acceptedTerminalPlanReviewClose([row])).toBeUndefined();
  });

  it("reads only the LATEST Plan Review row, so a re-plan ends the close", () => {
    const supersededClose = closeRow();
    const requeued = closeRow({ status: "pending", verdict: undefined, notes: undefined, completedAt: "2026-11-14T12:00:00.000Z" });
    expect(acceptedTerminalPlanReviewClose([supersededClose, requeued])).toBeUndefined();
    expect(acceptedTerminalPlanReviewClose([requeued, closeRow({ completedAt: "2026-11-14T13:00:00.000Z" })])?.status).toBe("passed");
  });
});

describe("terminal Plan Review close — the close authorises closing, never executing", () => {
  it("does not release the gate forward", () => {
    expect(isGateReleased(closeRow())).toBe(false);
    // An ordinary approved plan still releases the gate (the RUFU-300 behaviour is untouched).
    expect(isGateReleased(closeRow({ verdict: "APPROVE_WITH_NOTES", notes: "approved" }))).toBe(true);
  });

  it("places a close-carrying card back on Plan Review instead of on execution", () => {
    for (const column of ["todo", "in-progress", "in-review"]) {
      const placement = resolveResumePlacement({
        ir: codingIr,
        task: task({ column, workflowStepResults: [closeRow()] }),
      });
      expect(placement.nodeId, column).toBe(PLAN_REVIEW_GROUP_ID);
      expect(placement.releasedNodeIds, column).not.toContain(PLAN_REVIEW_GROUP_ID);
    }
  });

  it("still advances a card whose plan was approved normally", () => {
    const approved = closeRow({ verdict: "APPROVE_WITH_NOTES", notes: "approved" });
    const placement = resolveResumePlacement({
      ir: codingIr,
      task: task({ column: "in-progress", workflowStepResults: [approved] }),
    });
    expect(placement.releasedNodeIds).toContain(PLAN_REVIEW_GROUP_ID);
    expect(placement.nodeId).not.toBe(PLAN_REVIEW_GROUP_ID);
  });

  it("leaves placement alone for a card that never closed", () => {
    const placement = resolveResumePlacement({ ir: codingIr, task: task({ column: "in-progress" }) });
    expect(placement.nodeId).not.toBe(PLAN_REVIEW_GROUP_ID);
  });
});

/*
FNXC:TerminalPlanReviewClose 2026-11-14-04:20 (RUFU-599 reproduction 3):
The placement pins the card onto Plan Review; these two cases pin what happens when the run arrives there with
an already-accepted close. Neither may buy a reviewer session (the prompt handler is never called), and the
first must terminalise through the close route instead of falling through to `execute`.
*/
function closeIr(withRoute: boolean): WorkflowIr {
  return {
    version: "v2",
    name: "terminal-close-reentry",
    columns: [{ id: "todo", name: "Todo", traits: [] }, { id: "done", name: "Done", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: PLAN_REVIEW_GROUP_ID, kind: "optional-group", config: { name: "Plan Review", reviewKind: "plan", defaultOn: true, template: { nodes: [{ id: "review", kind: "prompt", config: { prompt: "review" } }], edges: [] } } },
      ...(withRoute ? [{ id: "plan-review-no-op", kind: "gate" as const, config: { workflowAction: "plan-review-no-op" } }] : []),
      { id: "execute", kind: "prompt", config: { prompt: "execute" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: PLAN_REVIEW_GROUP_ID },
      { from: PLAN_REVIEW_GROUP_ID, to: "execute", condition: "success" },
      ...(withRoute
        ? [{ from: PLAN_REVIEW_GROUP_ID, to: "plan-review-no-op", condition: "outcome:close-no-op" }, { from: "plan-review-no-op", to: "end", condition: "success" }]
        : [{ from: PLAN_REVIEW_GROUP_ID, to: "end", condition: "failure" }]),
      { from: "execute", to: "end" },
    ],
  };
}

describe("terminal Plan Review close — a re-entry reaches the close, not a reviewer", () => {
  it("re-traverses the accepted close without dispatching a reviewer or executing", async () => {
    const dispatched: string[] = [];
    const recorded: WorkflowStepResult[] = [];
    const complete = vi.fn(async () => true);
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { dispatched.push(node.id); return { outcome: "success" as const }; } },
      recordWorkflowStepResult: async (_id, result) => { recorded.push(result); },
      completePlanReviewNoOp: complete,
    });
    const result = await executor.run(
      {
        id: "SANE-532",
        enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
        workflowStepResults: [closeRow()],
      } as unknown as TaskDetail,
      { experimentalFeatures: { workflowGraphExecutor: true } },
      closeIr(true),
    );

    expect(dispatched).toEqual([]);
    expect(result.visitedNodeIds).toContain("plan-review-no-op");
    expect(result.visitedNodeIds).not.toContain("execute");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: "SANE-532" }), {
      kind: "no-op",
      reason: "the requested guard already ships on main",
    });
    // The accepted row is re-used as-is: no lease, no rewrite of the close evidence.
    expect(recorded).toEqual([]);
  });

  it("holds a route-less IR without a reviewer session and without rewriting the accepted row", async () => {
    const dispatched: string[] = [];
    const recorded: WorkflowStepResult[] = [];
    const hold = vi.fn(async () => {});
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { dispatched.push(node.id); return { outcome: "success" as const }; } },
      recordWorkflowStepResult: async (_id, result) => { recorded.push(result); },
      holdPlanReviewNoOp: hold,
    });

    const result = await executor.run(
      {
        id: "SANE-532",
        enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
        workflowStepResults: [closeRow()],
      } as unknown as TaskDetail,
      { experimentalFeatures: { workflowGraphExecutor: true } },
      closeIr(false),
    );

    expect(result.suspended).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_GROUP_ID });
    expect(result.visitedNodeIds).toEqual([PLAN_REVIEW_GROUP_ID]);
    expect(dispatched).toEqual([]);
    expect(recorded).toEqual([]);
    expect(hold).toHaveBeenCalledWith(
      expect.objectContaining({ id: "SANE-532" }),
      expect.objectContaining({ reason: "terminal-route-unavailable", nodeId: PLAN_REVIEW_GROUP_ID }),
    );
  });
});
