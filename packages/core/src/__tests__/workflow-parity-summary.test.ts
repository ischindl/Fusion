import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  WORKFLOW_PARITY_OBSERVED_MUTATION,
  WORKFLOW_PARITY_DRIFT_MUTATION,
} from "../workflow-parity.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("getWorkflowParitySummary (CU-U5)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  function observe(taskId: string, agree: boolean, diffs?: unknown[]): void {
    store.recordRunAuditEvent({
      taskId,
      agentId: "store",
      runId: `parity:${taskId}`,
      domain: "database",
      mutationType: WORKFLOW_PARITY_OBSERVED_MUTATION as never,
      target: taskId,
      metadata: { agree },
    });
    if (!agree && diffs) {
      store.recordRunAuditEvent({
        taskId,
        agentId: "store",
        runId: `parity-drift:${taskId}`,
        domain: "database",
        mutationType: WORKFLOW_PARITY_DRIFT_MUTATION as never,
        target: taskId,
        metadata: { agree, diffs },
      });
    }
  }

  it("returns zeros when no parity events recorded", () => {
    const summary = store.getWorkflowParitySummary();
    expect(summary).toMatchObject({ observed: 0, agreed: 0, drift: 0, agreeRate: 0 });
    expect(summary.driftFieldCounts).toEqual({});
  });

  it("computes agree-rate and per-field drift counts", () => {
    observe("FN-1", true);
    observe("FN-2", true);
    observe("FN-3", false, [
      { field: "stageTransitions", legacy: [], interpreter: [], category: "lifecycle", severity: "error" },
      { field: "mergeOutcome", legacy: "merged", interpreter: null, category: "lifecycle", severity: "error" },
    ]);
    observe("FN-4", false, [
      { field: "stageTransitions", legacy: [], interpreter: [], category: "lifecycle", severity: "error" },
    ]);

    const summary = store.getWorkflowParitySummary();
    expect(summary.observed).toBe(4);
    expect(summary.agreed).toBe(2);
    expect(summary.drift).toBe(2);
    expect(summary.agreeRate).toBeCloseTo(0.5, 5);
    expect(summary.driftFieldCounts).toEqual({ stageTransitions: 2, mergeOutcome: 1 });
    expect(summary.recentDrift.length).toBe(2);
    expect(summary.recentDrift[0].diffs.length).toBeGreaterThan(0);
  });
});
