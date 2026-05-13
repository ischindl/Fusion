import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { installExecMock } from "./fixtures/exec-mock.js";

describe("workflow integration contracts", () => {
  // FN-4150/FN-3768 track future workflow-step template + runWorkflowSteps coverage.
  it("guards against execSync usage in workflow-oriented execution fixtures", () => {
    const execMock = installExecMock();
    execMock.assertExecSyncUnused();
    expect(typeof plugin.manifest.id).toBe("string");
  });

  it("does not currently contribute plugin workflow step templates", () => {
    expect(plugin.workflowStepTemplates).toBeUndefined();
  });

  it("exposes no plugin workflow step IDs to runWorkflowSteps today", () => {
    const workflowStepTemplates = plugin.workflowStepTemplates ?? [];
    expect(workflowStepTemplates).toEqual([]);
    expect(workflowStepTemplates.some((template) => template.id.startsWith("plugin:"))).toBe(false);
  });
});
