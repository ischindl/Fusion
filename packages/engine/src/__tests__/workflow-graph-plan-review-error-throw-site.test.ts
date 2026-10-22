import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, PLAN_REVIEW_GROUP_ID, type TaskDetail, type WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

/*
FNXC:ErrorThrowSite 2026-10-22-13:38:
RUFU-773 behavior coverage at the narrowest seam that produces the reported artifact: the graph
executor running the REAL built-in Plan Review optional group with a `prompt` handler that throws the
downstream `TypeError`. This is the path the persisted History line came from
(`[pre-merge] Workflow step failed: Plan Review` + `Plan Review failed before producing a verdict:
Cannot read properties of undefined (reading 'trim')`), and the assertion is that the same body now
also names the throw site while the message stays an exact prefix and the History action string,
recorded status, and failure routing are unchanged.
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

const RUFU_773_MESSAGE = "Cannot read properties of undefined (reading 'trim')";

/** The real built-in Plan Review group node, so the ids under test are the production ones
 *  (`plan-review` group / `plan-review-step` prompt template). */
const planReviewNode = BUILTIN_CODING_WORKFLOW_IR.nodes.find((node) => node.id === PLAN_REVIEW_GROUP_ID)!;

function planReviewIr(): WorkflowIr {
  return {
    version: "v2",
    name: "plan-review-throw-site-test",
    columns: BUILTIN_CODING_WORKFLOW_IR.columns,
    nodes: [
      { id: "start", kind: "start" },
      planReviewNode,
      { id: "after", kind: "prompt", config: { prompt: "implement" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: PLAN_REVIEW_GROUP_ID },
      { from: PLAN_REVIEW_GROUP_ID, to: "after", condition: "success" },
      { from: PLAN_REVIEW_GROUP_ID, to: "end", condition: "failure" },
      { from: "after", to: "end" },
    ],
  };
}

/** A stand-in for the reviewer-session crash: a real TypeError whose stack names the frames the
 *  engine would have lost. */
function reviewerSessionTypeError(): TypeError {
  const error = new TypeError(RUFU_773_MESSAGE);
  error.stack = [
    `TypeError: ${RUFU_773_MESSAGE}`,
    "    at buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)",
    "    at runGraphCustomNode (/app/packages/engine/dist/executor/run-graph-custom-node.js:402:11)",
    "    at WorkflowGraphExecutor.executeNodeWithRetries (/app/packages/engine/dist/workflows/workflow-graph-executor.js:2216:20)",
    "    at runOptionalGroup (/app/packages/engine/dist/workflows/workflow-graph-loop.js:297:21)",
    "    at neverShownBecauseTheBoundIsFour (/app/packages/engine/dist/executor/execute-workflow-graph.js:915:18)",
  ].join("\n");
  return error;
}

describe("workflow-graph-executor: a thrown Plan Review TypeError names its throw site (RUFU-773)", () => {
  it("SYMPTOM: the verdict-less Plan Review failure body carries the message AND the bounded frames", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logTaskEntry = vi.fn();
    const visited: string[] = [];
    const handler: WorkflowNodeHandler = async (node) => {
      visited.push(node.id);
      if (node.id === "plan-review-step") throw reviewerSessionTypeError();
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 2,
      logTaskEntry,
      recordWorkflowStepResult: async (_taskId, result) => {
        records.push(result as unknown as Record<string, unknown>);
      },
    });

    const task = { id: "RUFU-773", enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID] } as TaskDetail;
    await executor.run(task, settingsOn(), planReviewIr());

    // The reviewer node really is the one that ran and threw (no seam/handler shortcut).
    expect(visited).toContain("plan-review-step");

    const terminal = records.find((record) => record.workflowStepId === PLAN_REVIEW_GROUP_ID && record.status !== "pending");
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ status: "failed", workflowStepName: "Plan Review" });
    expect(terminal?.verdict).toBeUndefined();

    const output = terminal?.output as string;
    // Original message survives as an exact prefix of the synthesized diagnostic.
    expect(output.startsWith(`Plan Review failed before producing a verdict: ${RUFU_773_MESSAGE}`)).toBe(true);
    // The throw site is now on the card, bounded to four frames, single-line, message line dropped.
    expect(output).toContain("at buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)");
    expect(output).toContain(" | at runOptionalGroup (/app/packages/engine/dist/workflows/workflow-graph-loop.js:297:21)");
    expect(output).not.toContain("neverShownBecauseTheBoundIsFour");
    expect(output).not.toContain("TypeError: ");
    expect(output).not.toContain("\n");

    // The History action string matched by workflow-step-satisfaction.ts and the executor's own
    // Plan Review reconstruction is byte-intact; only its body grew.
    expect(logTaskEntry).toHaveBeenCalledWith(
      "[pre-merge] Workflow step failed: Plan Review",
      expect.stringContaining("at buildReviewerPrompt"),
    );
  });

  it("CONTROL: failure routing and the recorded status are unchanged by the appended frames", async () => {
    const records: Array<Record<string, unknown>> = [];
    const visited: string[] = [];
    const handler: WorkflowNodeHandler = async (node) => {
      visited.push(node.id);
      if (node.id === "plan-review-step") throw reviewerSessionTypeError();
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 2,
      recordWorkflowStepResult: async (_taskId, result) => {
        records.push(result as unknown as Record<string, unknown>);
      },
    });

    const task = { id: "RUFU-773", enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID] } as TaskDetail;
    const result = await executor.run(task, settingsOn(), planReviewIr());

    expect(visited).not.toContain("after");
    expect(result.outcome).toBe("failure");
    const terminal = records.find((record) => record.workflowStepId === PLAN_REVIEW_GROUP_ID && record.status !== "pending");
    expect(terminal?.status).toBe("failed");
  });

  it("SURFACE: a message-only error (no stack) keeps the historical body byte-for-byte", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id === "plan-review-step") {
        throw Object.assign(new Error(RUFU_773_MESSAGE), { stack: undefined });
      }
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 1,
      recordWorkflowStepResult: async (_taskId, result) => {
        records.push(result as unknown as Record<string, unknown>);
      },
    });

    const task = { id: "RUFU-773", enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID] } as TaskDetail;
    await executor.run(task, settingsOn(), planReviewIr());

    const terminal = records.find((record) => record.workflowStepId === PLAN_REVIEW_GROUP_ID && record.status !== "pending");
    expect(terminal?.output).toBe(`Plan Review failed before producing a verdict: ${RUFU_773_MESSAGE}`);
  });
});
