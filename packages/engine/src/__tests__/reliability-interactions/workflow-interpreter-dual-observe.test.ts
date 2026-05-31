import { describe, expect, it, vi } from "vitest";
import {
  observeWorkflowParity,
  WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG,
} from "../../workflow-parity-observer.js";
import type { WorkflowRunObservation } from "@fusion/core";

const baseObservation: WorkflowRunObservation = {
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
};

describe("FN-5768 workflow interpreter dual-observe", () => {
  it("is strict no-op when flag is off", async () => {
    const recordRunAuditEvent = vi.fn();
    const runShadow = vi.fn();

    await observeWorkflowParity({
      settings: { experimentalFeatures: {} },
      store: { recordRunAuditEvent },
      agentId: "executor",
      legacy: {
        taskId: "FN-1",
        observation: baseObservation,
        auditEvents: [],
      },
      runShadow,
    });

    expect(runShadow).not.toHaveBeenCalled();
    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("records parity-observed agree=true when observations match", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

    await observeWorkflowParity({
      settings: { experimentalFeatures: { [WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG]: true } },
      store: { recordRunAuditEvent },
      agentId: "executor",
      legacy: {
        taskId: "FN-2",
        observation: baseObservation,
        auditEvents: [],
      },
      runShadow: async () => ({ observation: baseObservation, auditEvents: [] }),
    });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "workflow:parity-observed",
        metadata: expect.objectContaining({ agree: true }),
      }),
    );
  });

  it("records parity drift and keeps authoritative result unchanged", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const legacyResult = { authoritative: true };

    await observeWorkflowParity({
      settings: { experimentalFeatures: { [WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG]: true } },
      store: { recordRunAuditEvent },
      agentId: "executor",
      legacy: {
        taskId: "FN-3",
        observation: baseObservation,
        auditEvents: [],
      },
      runShadow: async () => ({
        observation: {
          ...baseObservation,
          terminalColumn: "in-review",
        },
        auditEvents: [],
      }),
    });

    expect(legacyResult).toEqual({ authoritative: true });
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
    expect(recordRunAuditEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mutationType: "workflow:parity-observed" }),
    );
    expect(recordRunAuditEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        mutationType: "workflow:parity-drift",
        metadata: expect.objectContaining({
          agree: false,
          diffs: expect.arrayContaining([expect.objectContaining({ field: "terminalColumn" })]),
        }),
      }),
    );
  });

  it("captures shadow errors fail-soft without rethrow", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

    await expect(
      observeWorkflowParity({
        settings: { experimentalFeatures: { [WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG]: true } },
        store: { recordRunAuditEvent },
        agentId: "executor",
        legacy: {
          taskId: "FN-4",
          observation: baseObservation,
          auditEvents: [],
        },
        runShadow: async () => {
          throw new Error("shadow exploded");
        },
      }),
    ).resolves.toBeUndefined();

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
    expect(recordRunAuditEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mutationType: "workflow:parity-observed",
        metadata: expect.objectContaining({ agree: false }),
      }),
    );
    expect(recordRunAuditEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        mutationType: "workflow:parity-drift",
        metadata: expect.objectContaining({
          diffs: expect.arrayContaining([expect.objectContaining({ field: "shadow.error" })]),
        }),
      }),
    );
  });
});
