import type { RunAuditEvent } from "./types.js";

export const WORKFLOW_PARITY_OBSERVED_MUTATION = "workflow:parity-observed" as const;
export const WORKFLOW_PARITY_DRIFT_MUTATION = "workflow:parity-drift" as const;

export type WorkflowStage = "triage" | "execute" | "review" | "merge";
export type WorkflowParityDiffCategory = "lifecycle" | "invariant" | "audit";
export type WorkflowParityDiffSeverity = "info" | "warning" | "error";

export interface WorkflowReliabilityInvariantSignals {
  fileScopeGuardOutcome: string | null;
  squashMergeContractOutcome: string | null;
  autoMergeTerminalUntilMergedRespected: boolean;
  moveTaskHardCancelRespected: boolean;
}

/**
 * Observe-only workflow snapshot used for parity checks.
 * Legacy remains authoritative; interpreter observations are advisory diagnostics only.
 */
export interface WorkflowRunObservation {
  stageTransitions: WorkflowStage[];
  terminalColumn: string | null;
  terminalStatus: string | null;
  reviewVerdict: string | null;
  mergeOutcome: string | null;
  invariants: WorkflowReliabilityInvariantSignals;
}

export interface WorkflowParityDiff {
  field: string;
  legacy: unknown;
  interpreter: unknown;
  category: WorkflowParityDiffCategory;
  severity: WorkflowParityDiffSeverity;
}

export interface WorkflowParityDriftReport {
  agree: boolean;
  diffs: WorkflowParityDiff[];
}

function isEqualScalarArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function pushDiff(
  diffs: WorkflowParityDiff[],
  field: string,
  legacy: unknown,
  interpreter: unknown,
  category: WorkflowParityDiffCategory,
  severity: WorkflowParityDiffSeverity = "warning",
): void {
  diffs.push({ field, legacy, interpreter, category, severity });
}

/**
 * Pure observation comparison contract for dual-observe shadow checks.
 * Legacy observation is authoritative; interpreter drift is diagnostics only.
 */
export function compareWorkflowRunObservations(
  legacy: WorkflowRunObservation,
  interpreter: WorkflowRunObservation,
): WorkflowParityDriftReport {
  const diffs: WorkflowParityDiff[] = [];

  if (!isEqualScalarArray(legacy.stageTransitions, interpreter.stageTransitions)) {
    pushDiff(
      diffs,
      "stageTransitions",
      legacy.stageTransitions,
      interpreter.stageTransitions,
      "lifecycle",
      "error",
    );
  }

  const lifecycleChecks: Array<[field: string, legacyValue: unknown, interpreterValue: unknown]> = [
    ["terminalColumn", legacy.terminalColumn, interpreter.terminalColumn],
    ["terminalStatus", legacy.terminalStatus, interpreter.terminalStatus],
    ["reviewVerdict", legacy.reviewVerdict, interpreter.reviewVerdict],
    ["mergeOutcome", legacy.mergeOutcome, interpreter.mergeOutcome],
  ];

  for (const [field, legacyValue, interpreterValue] of lifecycleChecks) {
    if (legacyValue !== interpreterValue) {
      pushDiff(diffs, field, legacyValue, interpreterValue, "lifecycle", "error");
    }
  }

  const invariantChecks: Array<[field: string, legacyValue: unknown, interpreterValue: unknown]> = [
    [
      "invariants.fileScopeGuardOutcome",
      legacy.invariants.fileScopeGuardOutcome,
      interpreter.invariants.fileScopeGuardOutcome,
    ],
    [
      "invariants.squashMergeContractOutcome",
      legacy.invariants.squashMergeContractOutcome,
      interpreter.invariants.squashMergeContractOutcome,
    ],
    [
      "invariants.autoMergeTerminalUntilMergedRespected",
      legacy.invariants.autoMergeTerminalUntilMergedRespected,
      interpreter.invariants.autoMergeTerminalUntilMergedRespected,
    ],
    [
      "invariants.moveTaskHardCancelRespected",
      legacy.invariants.moveTaskHardCancelRespected,
      interpreter.invariants.moveTaskHardCancelRespected,
    ],
  ];

  for (const [field, legacyValue, interpreterValue] of invariantChecks) {
    if (legacyValue !== interpreterValue) {
      pushDiff(diffs, field, legacyValue, interpreterValue, "invariant", "error");
    }
  }

  return {
    agree: diffs.length === 0,
    diffs,
  };
}

export const WORKFLOW_COMPARABLE_AUDIT_MUTATIONS = [
  "task:move",
  "task:update",
  "task:pause",
  "task:unpause",
  "task:dependency:add",
  "merge:request-enqueued",
  "merge:dependency-parity-diff",
  "merge:lease-parity-diff",
] as const;

const WORKFLOW_COMPARABLE_AUDIT_MUTATION_SET = new Set<string>(WORKFLOW_COMPARABLE_AUDIT_MUTATIONS);

export interface WorkflowAuditObservation {
  mutationType: string;
  target: string;
  phase: string | null;
}

export function extractWorkflowAuditObservations(events: readonly RunAuditEvent[]): WorkflowAuditObservation[] {
  return events
    .filter(
      (event) =>
        event.domain === "database"
        && WORKFLOW_COMPARABLE_AUDIT_MUTATION_SET.has(String(event.mutationType)),
    )
    .map((event) => ({
      mutationType: String(event.mutationType),
      target: event.target,
      phase: typeof event.metadata?.phase === "string" ? event.metadata.phase : null,
    }));
}

export function compareWorkflowRunAudits(
  legacyEvents: readonly RunAuditEvent[],
  interpreterEvents: readonly RunAuditEvent[],
): WorkflowParityDriftReport {
  const legacy = extractWorkflowAuditObservations(legacyEvents);
  const interpreter = extractWorkflowAuditObservations(interpreterEvents);
  const diffs: WorkflowParityDiff[] = [];

  if (legacy.length !== interpreter.length) {
    pushDiff(diffs, "audit.length", legacy.length, interpreter.length, "audit");
  }

  const count = Math.max(legacy.length, interpreter.length);
  for (let index = 0; index < count; index += 1) {
    const left = legacy[index];
    const right = interpreter[index];
    if (!left || !right) {
      pushDiff(diffs, `audit[${index}]`, left ?? null, right ?? null, "audit");
      continue;
    }

    if (left.mutationType !== right.mutationType) {
      pushDiff(
        diffs,
        `audit[${index}].mutationType`,
        left.mutationType,
        right.mutationType,
        "audit",
      );
    }

    if (left.target !== right.target) {
      pushDiff(diffs, `audit[${index}].target`, left.target, right.target, "audit");
    }

    if (left.phase !== right.phase) {
      pushDiff(diffs, `audit[${index}].phase`, left.phase, right.phase, "audit");
    }
  }

  return {
    agree: diffs.length === 0,
    diffs,
  };
}

// ── Observation builders (CU-U5) ─────────────────────────────────────────────
// Construct a WorkflowRunObservation from real run data so the legacy and
// interpreter sides can be compared without either side hand-rolling the shape.

/** Conservative defaults: a run that didn't signal an invariant is assumed to
 *  have respected the terminal/cancel contracts (the common, non-drift case). */
export const DEFAULT_WORKFLOW_INVARIANTS: WorkflowReliabilityInvariantSignals = {
  fileScopeGuardOutcome: null,
  squashMergeContractOutcome: null,
  autoMergeTerminalUntilMergedRespected: true,
  moveTaskHardCancelRespected: true,
};

const COLUMN_TO_STAGE: Record<string, WorkflowStage | undefined> = {
  triage: "triage",
  todo: "triage",
  "in-progress": "execute",
  "in-review": "review",
  done: "merge",
};

/**
 * Map the ordered list of columns a run passed through to workflow stages,
 * collapsing consecutive repeats. This is how the legacy side derives its
 * stageTransitions — from the real task-move history rather than a guess.
 */
export function deriveStageTransitions(columnSequence: readonly string[]): WorkflowStage[] {
  const stages: WorkflowStage[] = [];
  for (const column of columnSequence) {
    const stage = COLUMN_TO_STAGE[column];
    if (stage && stages[stages.length - 1] !== stage) stages.push(stage);
  }
  return stages;
}

export interface WorkflowObservationTaskInput {
  column: string;
  status?: string | null;
  review?: { verdict?: string } | null;
  mergeDetails?: { outcome?: string } | null;
}

export interface WorkflowObservationBuildOptions {
  /** Explicit stage sequence (wins over columnSequence). */
  stageTransitions?: readonly WorkflowStage[];
  /** Ordered columns the run passed through; mapped to stages when stageTransitions is absent. */
  columnSequence?: readonly string[];
  invariants?: Partial<WorkflowReliabilityInvariantSignals>;
}

/**
 * Build a parity observation from a task's terminal persisted state (the legacy
 * authoritative side). stageTransitions come from the caller's recorded column
 * history when available, else fall back to the terminal column alone.
 */
export function buildWorkflowObservationFromTask(
  task: WorkflowObservationTaskInput,
  options?: WorkflowObservationBuildOptions,
): WorkflowRunObservation {
  const stageTransitions = options?.stageTransitions
    ? [...options.stageTransitions]
    : deriveStageTransitions(options?.columnSequence ?? [task.column]);
  return {
    stageTransitions,
    terminalColumn: task.column ?? null,
    terminalStatus: task.status ?? null,
    reviewVerdict: task.review?.verdict ?? null,
    mergeOutcome: task.mergeDetails?.outcome ?? (task.column === "done" ? "merged" : null),
    invariants: { ...DEFAULT_WORKFLOW_INVARIANTS, ...options?.invariants },
  };
}

/** Aggregate of dual-observe parity audit events — the graduation signal. */
export interface WorkflowParitySummary {
  /** Total `workflow:parity-observed` events in scope. */
  observed: number;
  /** Of those, how many reported agree=true. */
  agreed: number;
  /** Total `workflow:parity-drift` events in scope. */
  drift: number;
  /** agreed / observed in [0,1]; 0 when nothing observed yet. */
  agreeRate: number;
  /** Count of drift occurrences per observation field, most-divergent first. */
  driftFieldCounts: Record<string, number>;
  /** Most recent drift events (capped) for inspection. */
  recentDrift: Array<{ taskId: string; timestamp: string; diffs: WorkflowParityDiff[] }>;
}

export interface WorkflowObservationParts {
  stageTransitions: readonly WorkflowStage[];
  terminalColumn?: string | null;
  terminalStatus?: string | null;
  reviewVerdict?: string | null;
  mergeOutcome?: string | null;
  invariants?: Partial<WorkflowReliabilityInvariantSignals>;
}

/**
 * Build a parity observation from explicit parts (the interpreter/shadow side
 * assembles these from its graph-walk result).
 */
export function buildWorkflowObservation(parts: WorkflowObservationParts): WorkflowRunObservation {
  return {
    stageTransitions: [...parts.stageTransitions],
    terminalColumn: parts.terminalColumn ?? null,
    terminalStatus: parts.terminalStatus ?? null,
    reviewVerdict: parts.reviewVerdict ?? null,
    mergeOutcome: parts.mergeOutcome ?? null,
    invariants: { ...DEFAULT_WORKFLOW_INVARIANTS, ...parts.invariants },
  };
}
