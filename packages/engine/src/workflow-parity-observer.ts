import {
  compareWorkflowRunAudits,
  compareWorkflowRunObservations,
  isExperimentalFeatureEnabled,
  WORKFLOW_PARITY_DRIFT_MUTATION,
  WORKFLOW_PARITY_OBSERVED_MUTATION,
  type RunAuditEvent,
  type Settings,
  type TaskStore,
  type WorkflowParityDiff,
  type WorkflowRunObservation,
} from "@fusion/core";
import { generateSyntheticRunId } from "./run-audit.js";

export const WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG = "workflowInterpreterDualObserve" as const;

export interface WorkflowParityObserverLegacyRunResult {
  taskId: string;
  observation: WorkflowRunObservation;
  auditEvents: RunAuditEvent[];
}

export interface WorkflowParityObserverShadowRunResult {
  observation: WorkflowRunObservation;
  auditEvents: RunAuditEvent[];
}

export interface WorkflowParityObserverInput {
  settings: Pick<Settings, "experimentalFeatures"> | undefined;
  store: Pick<TaskStore, "recordRunAuditEvent">;
  agentId: string;
  legacy: WorkflowParityObserverLegacyRunResult;
  runShadow: () => Promise<WorkflowParityObserverShadowRunResult>;
}

function buildErrorDiff(error: unknown): WorkflowParityDiff {
  return {
    field: "shadow.error",
    legacy: null,
    interpreter: error instanceof Error ? error.message : String(error),
    category: "audit",
    severity: "error",
  };
}

/**
 * Observe-only parity seam. Never mutates/blocks authoritative legacy behavior.
 */
export async function observeWorkflowParity(input: WorkflowParityObserverInput): Promise<void> {
  if (!isExperimentalFeatureEnabled(input.settings, WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG)) {
    return;
  }

  const { store, agentId, legacy } = input;
  const runId = generateSyntheticRunId("workflow-shadow", legacy.taskId);

  try {
    const shadow = await input.runShadow();
    const observationReport = compareWorkflowRunObservations(legacy.observation, shadow.observation);
    const auditReport = compareWorkflowRunAudits(legacy.auditEvents, shadow.auditEvents);
    const diffs = [...observationReport.diffs, ...auditReport.diffs];
    const agree = diffs.length === 0;

    await store.recordRunAuditEvent?.({
      taskId: legacy.taskId,
      agentId,
      runId,
      domain: "database",
      mutationType: WORKFLOW_PARITY_OBSERVED_MUTATION,
      target: legacy.taskId,
      metadata: {
        agree,
      },
    });

    if (!agree) {
      await store.recordRunAuditEvent?.({
        taskId: legacy.taskId,
        agentId,
        runId,
        domain: "database",
        mutationType: WORKFLOW_PARITY_DRIFT_MUTATION,
        target: legacy.taskId,
        metadata: {
          agree,
          diffs,
        },
      });
    }
  } catch (error) {
    await store.recordRunAuditEvent?.({
      taskId: legacy.taskId,
      agentId,
      runId,
      domain: "database",
      mutationType: WORKFLOW_PARITY_OBSERVED_MUTATION,
      target: legacy.taskId,
      metadata: {
        agree: false,
      },
    });

    await store.recordRunAuditEvent?.({
      taskId: legacy.taskId,
      agentId,
      runId,
      domain: "database",
      mutationType: WORKFLOW_PARITY_DRIFT_MUTATION,
      target: legacy.taskId,
      metadata: {
        agree: false,
        diffs: [buildErrorDiff(error)],
      },
    });
  }
}
