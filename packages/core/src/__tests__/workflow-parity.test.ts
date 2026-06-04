import { describe, expect, it } from "vitest";
import {
  compareWorkflowRunAudits,
  compareWorkflowRunObservations,
  buildWorkflowObservationFromTask,
  buildWorkflowObservation,
  deriveStageTransitions,
  DEFAULT_WORKFLOW_INVARIANTS,
  type RunAuditEvent,
  type WorkflowRunObservation,
} from "../index.js";

function observation(overrides: Partial<WorkflowRunObservation> = {}): WorkflowRunObservation {
  return {
    stageTransitions: ["triage", "execute", "review", "merge"],
    terminalColumn: "done",
    terminalStatus: null,
    reviewVerdict: "APPROVE",
    mergeOutcome: "merged",
    invariants: {
      fileScopeGuardOutcome: "pass",
      squashMergeContractOutcome: "pass",
      autoMergeTerminalUntilMergedRespected: true,
      moveTaskHardCancelRespected: true,
    },
    ...overrides,
  };
}

function auditEvent(mutationType: string, target: string, phase: string): RunAuditEvent {
  return {
    id: `${mutationType}-${target}`,
    timestamp: new Date().toISOString(),
    taskId: "FN-1",
    agentId: "executor",
    runId: "run-1",
    domain: "database",
    mutationType,
    target,
    metadata: { phase },
  };
}

describe("workflow parity", () => {
  it("agrees for identical observations", () => {
    const report = compareWorkflowRunObservations(observation(), observation());
    expect(report).toEqual({ agree: true, diffs: [] });
  });

  it("reports lifecycle transition drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({ stageTransitions: ["triage", "execute", "merge"] }),
    );
    expect(report.agree).toBe(false);
    expect(report.diffs).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "stageTransitions", category: "lifecycle" })]),
    );
  });

  it("reports terminal status and review verdict drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({ terminalColumn: "in-review", reviewVerdict: "REVISE" }),
    );
    expect(report.agree).toBe(false);
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "terminalColumn" }),
        expect.objectContaining({ field: "reviewVerdict" }),
      ]),
    );
  });

  it("reports file-scope guard invariant drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({ invariants: { ...observation().invariants, fileScopeGuardOutcome: "fail" } }),
    );
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "invariants.fileScopeGuardOutcome", category: "invariant" }),
      ]),
    );
  });

  it("reports squash merge invariant drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({ invariants: { ...observation().invariants, squashMergeContractOutcome: "blocked" } }),
    );
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "invariants.squashMergeContractOutcome", category: "invariant" }),
      ]),
    );
  });

  it("reports auto-merge terminal invariant drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({
        invariants: { ...observation().invariants, autoMergeTerminalUntilMergedRespected: false },
      }),
    );
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "invariants.autoMergeTerminalUntilMergedRespected", category: "invariant" }),
      ]),
    );
  });

  it("reports moveTask hard-cancel invariant drift", () => {
    const report = compareWorkflowRunObservations(
      observation(),
      observation({ invariants: { ...observation().invariants, moveTaskHardCancelRespected: false } }),
    );
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "invariants.moveTaskHardCancelRespected", category: "invariant" }),
      ]),
    );
  });

  it("agrees on identical comparable run-audit slices", () => {
    const events = [
      auditEvent("task:move", "FN-1", "execute"),
      auditEvent("task:update", "FN-1", "review"),
    ];
    const report = compareWorkflowRunAudits(events, events);
    expect(report).toEqual({ agree: true, diffs: [] });
  });

  it("reports run-audit drift", () => {
    const legacy = [auditEvent("task:move", "FN-1", "execute")];
    const interpreter = [auditEvent("task:update", "FN-2", "review")];
    const report = compareWorkflowRunAudits(legacy, interpreter);
    expect(report.agree).toBe(false);
    expect(report.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "audit[0].mutationType", category: "audit" }),
        expect.objectContaining({ field: "audit[0].target", category: "audit" }),
        expect.objectContaining({ field: "audit[0].phase", category: "audit" }),
      ]),
    );
  });
});

describe("observation builders (CU-U5)", () => {
  it("deriveStageTransitions maps columns to stages and collapses repeats", () => {
    expect(deriveStageTransitions(["todo", "in-progress", "in-progress", "in-review", "done"]))
      .toEqual(["triage", "execute", "review", "merge"]);
    expect(deriveStageTransitions([])).toEqual([]);
  });

  it("buildWorkflowObservationFromTask reads terminal lifecycle + derives stages from columnSequence", () => {
    const obs = buildWorkflowObservationFromTask(
      { column: "done", status: null, review: { verdict: "APPROVE" }, mergeDetails: { outcome: "merged" } },
      { columnSequence: ["todo", "in-progress", "in-review", "done"] },
    );
    expect(obs.stageTransitions).toEqual(["triage", "execute", "review", "merge"]);
    expect(obs.terminalColumn).toBe("done");
    expect(obs.reviewVerdict).toBe("APPROVE");
    expect(obs.mergeOutcome).toBe("merged");
    expect(obs.invariants).toEqual(DEFAULT_WORKFLOW_INVARIANTS);
  });

  it("buildWorkflowObservationFromTask infers merged from terminal column when mergeDetails absent", () => {
    const obs = buildWorkflowObservationFromTask({ column: "done" });
    expect(obs.mergeOutcome).toBe("merged");
    expect(obs.stageTransitions).toEqual(["merge"]); // terminal-only fallback
  });

  it("a task and an equivalent interpreter parts observation compare as agree", () => {
    const legacy = buildWorkflowObservationFromTask(
      { column: "done", review: { verdict: "APPROVE" }, mergeDetails: { outcome: "merged" } },
      { columnSequence: ["in-progress", "in-review", "done"] },
    );
    const interpreter = buildWorkflowObservation({
      stageTransitions: ["execute", "review", "merge"],
      terminalColumn: "done",
      reviewVerdict: "APPROVE",
      mergeOutcome: "merged",
    });
    expect(compareWorkflowRunObservations(legacy, interpreter).agree).toBe(true);
  });

  it("a divergent stage sequence surfaces an error-severity lifecycle drift", () => {
    const legacy = buildWorkflowObservationFromTask({ column: "done" }, { columnSequence: ["in-progress", "in-review", "done"] });
    const interpreter = buildWorkflowObservation({ stageTransitions: ["execute", "merge"], terminalColumn: "done", mergeOutcome: "merged" });
    const report = compareWorkflowRunObservations(legacy, interpreter);
    expect(report.agree).toBe(false);
    expect(report.diffs).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "stageTransitions", category: "lifecycle", severity: "error" })]),
    );
  });
});
