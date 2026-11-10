import { describe, expect, it } from "vitest";
import { analyzeWorkflowLifecycle, type WorkflowIr } from "../index.js";

function baseIr(nodes: WorkflowIr["nodes"], edges: WorkflowIr["edges"]): WorkflowIr {
  return {
    version: "v2",
    name: "lifecycle-validation-test",
    columns: [
      { id: "todo", name: "Todo", traits: [] },
      { id: "in-progress", name: "In progress", traits: [] },
      { id: "in-review", name: "In review", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ],
    nodes,
    edges,
  };
}

describe("analyzeWorkflowLifecycle", () => {
  it("warns when a full custom workflow omits summary and merge lifecycle primitives", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "end", condition: "success" },
      ],
    ));

    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "missing-completion-summary",
      "missing-merge-region",
    ]));
  });

  it("warns about terminal success paths that bypass the merge region", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        { id: "completion-summary", kind: "prompt", column: "in-review", config: { summaryTarget: "task" } },
        { id: "merge-gate", kind: "merge-gate", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "completion-summary", condition: "success" },
        { from: "completion-summary", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    ));

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsafe-terminal-before-merge", nodeId: "execute" }),
    ]));
  });

  it("warns when Plan Review is placed after execution and blocking gates lack failure routes", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        {
          id: "plan-review",
          kind: "optional-group",
          column: "in-progress",
          config: {
            name: "Plan Review",
            defaultOn: true,
            template: {
              nodes: [{ id: "plan-review-step", kind: "prompt", config: { gateMode: "gate" } }],
              edges: [],
            },
          },
        },
        { id: "completion-summary", kind: "prompt", column: "in-review", config: { summaryTarget: "task" } },
        { id: "merge-gate", kind: "merge-gate", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "plan-review", condition: "success" },
        { from: "plan-review", to: "completion-summary", condition: "success" },
        { from: "completion-summary", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
      ],
    ));

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "optional-group-after-execution", nodeId: "plan-review" }),
      expect.objectContaining({ code: "review-gate-without-failure-route", nodeId: "plan-review" }),
    ]));
  });

  it("does not warn for fragment templates", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "fragment-node", kind: "prompt", column: "todo", config: { prompt: "Reusable" } },
        { id: "end", kind: "end", column: "todo" },
      ],
      [
        { from: "start", to: "fragment-node" },
        { from: "fragment-node", to: "end" },
      ],
    ), { kind: "fragment" });

    expect(warnings).toEqual([]);
  });
});

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
The save-time refusal is only advice if the author learns of the shape BEFORE the save, so the analyzer
that feeds the editor carries the same rule. These legs pin it to the SAME predicate and the SAME code
string the refusal uses: an editor keying its copy off a drifted literal would warn about a shape it never
refuses, or stay silent on the one shape it does.
*/
describe("analyzeWorkflowLifecycle: the post-merge-in-complete-column advisory", () => {
  /** The same graph drawn twice: the terminal column carries the `complete` trait, the review column does not. */
  function irWithPostMergeGateIn(columnId: string): WorkflowIr {
    return {
      version: "v2",
      name: "lifecycle-advisory-test",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "in-review", name: "In review", traits: [{ trait: "review" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "merge", kind: "merge-gate", column: "in-review" },
        { id: "post-merge-verification", kind: "optional-group", column: columnId, config: { phase: "post-merge" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "merge" },
        { from: "merge", to: "post-merge-verification", condition: "success" },
        { from: "post-merge-verification", to: "end", condition: "success" },
      ],
    };
  }

  it("names the node, the complete column, and the consequence", () => {
    const warnings = analyzeWorkflowLifecycle(irWithPostMergeGateIn("done"));
    const advisory = warnings.find((warning) => warning.code === "post-merge-node-in-complete-column");
    expect(advisory).toBeDefined();
    expect(advisory!.nodeId).toBe("post-merge-verification");
    // The copy must state the consequence and the remedy, not just re-state the config key.
    expect(advisory!.message).toContain("'done'");
    expect(advisory!.message).toMatch(/refused|refuse/i);
  });

  it("stays silent on the shape the rule permits: the same gate drawn into the review column", () => {
    const warnings = analyzeWorkflowLifecycle(irWithPostMergeGateIn("in-review"));
    expect(warnings.map((warning) => warning.code)).not.toContain("post-merge-node-in-complete-column");
  });
});
