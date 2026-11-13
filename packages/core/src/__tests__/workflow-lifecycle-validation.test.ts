import { describe, expect, it } from "vitest";
import { analyzeWorkflowLifecycle, type WorkflowIr } from "../index.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";

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

/*
FNXC:ParseFailureRouting 2026-11-12-23:58 (RUFU-501):
A refused plan is a writer failure with a known repair, so the edge that carries it decides whether the card
can still be repaired. Entering a complete-trait column writes that column under `bypassGuards: true`, so a
card routed there over an unreadable plan is terminal with no retraction path — while the graph terminal is
inert as a column destination (KTD-1) and is the designed sink for a parse failure. These cases pin both
halves of that line, plus the catalog check that keeps the advisory from firing on shipped graphs.
*/
describe("analyzeWorkflowLifecycle: a parse refusal routed into a complete-trait column", () => {
  function irWithParseFailureInto(condition: string, targetColumnId: string): WorkflowIr {
    return {
      version: "v2",
      name: "parse-failure-routing-test",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "in-progress", name: "In progress", traits: [] },
        { id: "in-review", name: "In review", traits: [{ trait: "review" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "plan", kind: "prompt", column: "todo", config: { seam: "planning" } },
        { id: "parse", kind: "parse-steps", column: "in-progress", config: { artifact: "plan", parser: "step-headings" } },
        { id: "landed", kind: "prompt", column: targetColumnId, config: { seam: "execute" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "parse", condition: "success" },
        { from: "parse", to: "landed", condition: condition as WorkflowIr["edges"][number]["condition"] },
        { from: "landed", to: "end", condition: "success" },
      ],
    };
  }

  it.each(["failure", "outcome:parse-error"])(
    "names the parse node, the complete column, and the consequence for a %s edge",
    (condition) => {
      const advisory = analyzeWorkflowLifecycle(irWithParseFailureInto(condition, "done"))
        .find((warning) => warning.code === "parse-failure-routes-to-terminal");
      expect(advisory).toBeDefined();
      expect(advisory!.nodeId).toBe("parse");
      expect(advisory!.message).toContain("'done'");
      expect(advisory!.message).toMatch(/terminal lane/);
    },
  );

  it.each(["success", "outcome:no-steps"])(
    "stays silent on the %s routing, which carries no refusal",
    (condition) => {
      const codes = analyzeWorkflowLifecycle(irWithParseFailureInto(condition, "done"))
        .map((warning) => warning.code);
      expect(codes).not.toContain("parse-failure-routes-to-terminal");
    },
  );

  it("stays silent on the untagged edge, which is the graph's ordinary forward routing", () => {
    const ir = irWithParseFailureInto("success", "done");
    ir.edges = ir.edges.map((edge) => (edge.from === "parse" ? { from: edge.from, to: edge.to } : edge));
    const codes = analyzeWorkflowLifecycle(ir).map((warning) => warning.code);
    expect(codes).not.toContain("parse-failure-routes-to-terminal");
  });

  it("treats any other outcome tag as a refusal, because the author named a non-success exit", () => {
    const codes = analyzeWorkflowLifecycle(irWithParseFailureInto("outcome:invalid-plan-dependency", "done"))
      .map((warning) => warning.code);
    expect(codes).toContain("parse-failure-routes-to-terminal");
  });

  it("stays silent when the refusal targets the graph terminal, which is inert as a destination (KTD-1)", () => {
    const ir = irWithParseFailureInto("failure", "in-review");
    ir.edges = ir.edges.filter((edge) => edge.from !== "parse");
    ir.edges.push({ from: "parse", to: "end", condition: "failure" });
    const codes = analyzeWorkflowLifecycle(ir).map((warning) => warning.code);
    expect(codes).not.toContain("parse-failure-routes-to-terminal");
  });

  it("stays silent when the refusal targets a node in a non-terminal column", () => {
    const codes = analyzeWorkflowLifecycle(irWithParseFailureInto("failure", "in-review"))
      .map((warning) => warning.code);
    expect(codes).not.toContain("parse-failure-routes-to-terminal");
  });

  it("fires on no shipped built-in graph", () => {
    for (const definition of BUILTIN_WORKFLOWS) {
      const codes = analyzeWorkflowLifecycle(definition.ir, { kind: definition.kind })
        .map((warning) => warning.code);
      expect(codes, definition.id).not.toContain("parse-failure-routes-to-terminal");
    }
  });
});
