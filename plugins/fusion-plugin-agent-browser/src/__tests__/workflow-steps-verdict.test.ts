import { describe, expect, it } from "vitest";
import { inferWorkflowStepVerdictFromProse, parseWorkflowStepVerdict } from "../../../../packages/engine/src/executor.js";
import { AGENT_BROWSER_WORKFLOW_STEPS } from "../workflow-steps.js";

describe("browser-evidence-review verdict parsing", () => {
  it("parses clean trailing JSON output", () => {
    const output = '{"verdict":"APPROVE","notes":""}';
    expect(parseWorkflowStepVerdict(output)).toEqual({ verdict: "APPROVE", notes: "" });
  });

  it("parses fast-bail JSON output", () => {
    const output = '{"verdict":"APPROVE","notes":"out of scope: no browser-derived evidence in diff"}';
    expect(parseWorkflowStepVerdict(output)).toEqual({
      verdict: "APPROVE",
      notes: "out of scope: no browser-derived evidence in diff",
    });
  });

  it("keeps prose fallback for revision requests", () => {
    const output = "REQUEST REVISION\nclaim about pricing page lacks a screenshot";
    const inferred = inferWorkflowStepVerdictFromProse(output);
    expect(inferred?.verdict).toBe("REVISE");
    expect(inferred?.notes).toContain("claim about pricing page lacks a screenshot");
  });

  it("template declares structured verdict envelope", () => {
    const step = AGENT_BROWSER_WORKFLOW_STEPS.find((entry) => entry.stepId === "browser-evidence-review");
    expect(step?.prompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}');
  });
});
