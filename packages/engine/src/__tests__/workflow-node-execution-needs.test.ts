import { describe, expect, it } from "vitest";
import type { WorkflowIrNode } from "@fusion/core";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";

function node(overrides: Partial<WorkflowIrNode> = {}): WorkflowIrNode {
  return { id: "node", kind: "prompt", ...overrides };
}

describe("workflowNodeRequiresWorktree", () => {
  it.each([
    ["coding tool mode", node({ config: { toolMode: "coding" } })],
    ["script node", node({ kind: "script" })],
    ["named script", node({ config: { scriptName: "validate" } })],
    ["CLI command", node({ config: { executor: "cli", cliCommand: "pnpm lint" } })],
    ["CLI agent", node({ config: { executor: "cli-agent" } })],
  ])("requires a worktree for %s", (_name, workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode)).toBe(true);
  });

  it.each([
    ["explicit inline fix config", node({ config: { reviewCanFixInline: true } }), undefined],
    ["structured code review", node({ id: "review", config: { reviewKind: "code" } }), undefined],
    ["structured browser verification", node({ id: "verify", config: { reviewKind: "code" } }), "browser-verification"],
    ["code review optional group", node(), "code-review"],
    ["browser verification optional group", node(), "browser-verification"],
  ])("requires a worktree for %s without an inline-fix option", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(true);
  });

  it("keeps inline-fix reviews read-only when disabled", () => {
    expect(workflowNodeRequiresWorktree(node({ config: { reviewKind: "code" } }), { reviewerInlineFixes: false })).toBe(false);
    expect(workflowNodeRequiresWorktree(node(), {
      optionalGroupId: "code-review",
      reviewerInlineFixes: false,
    })).toBe(false);
  });

  it.each([
    ["canonical Plan Review node", node({ id: "plan-review-step", config: { reviewKind: "code" } }), undefined],
    ["Plan Review kind", node({ config: { reviewKind: "plan", reviewCanFixInline: true } }), undefined],
    ["Plan Review optional group", node({ config: { reviewKind: "code" } }), "plan-review"],
    ["deterministic verification", node({ config: { workflowAction: "deterministic-verification", reviewKind: "code" } }), undefined],
  ])("keeps %s excluded from checkout preparation", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(false);
  });
});
