/**
 * FNXC:PlanningReseedCycleBudget 2026-10-22-11:08 (RUFU-768):
 * A card whose Plan Review crashes before it can emit a verdict had NO card-level bound, so the
 * planning loop re-ran forever. The bound that was supposed to cover it,
 * `plan-review-session-failure-budget.ts` (RUFU-251), states in its own scope guard that charging
 * happens ONLY inside a live Plan Review REVISE episode, so a first-pass crash is deliberately
 * excluded and falls back to the filesystem-twin retry. That fallback is bounded PER CADENCE, not
 * per card: at exhaustion `triage.ts` writes `status = resolvePlanningRetryHoldStatus(...)` which
 * returns `needs-replan` whenever a non-empty PROMPT.md exists, together with
 * `recoveryRetryCount: null`. `needs-replan` is then consumed by triage's next admission pass, so
 * every escalation grants a fresh budget of `MAX_RECOVERY_RETRIES` = 3 and the counter that was
 * supposed to bound the loop is zeroed by the escalation itself. Seven observed crashes on one card
 * is therefore two and a third cycles of designed behaviour, not a new bug: the loop has no ceiling.
 *
 * This module supplies the missing ceiling WITHOUT adding a second planning authority and WITHOUT
 * touching the revision-only `planReviewAttemptCount`, which is deliberately revision-only:
 *
 * - the count is a card-level episode marker on `sourceMetadata`, the same key-level shape RUFU-273
 *   uses for `planAdmissionStall`, so no schema change and no parallel persisted column;
 * - it counts GRANTED reseed cycles, never verdicts, so it is independent of the REVISE-episode guard
 *   that excludes the crash shape from the RUFU-251 budget;
 * - exhaustion parks the card `failed` with a named error instead of returning `needs-replan`,
 *   because the RUFU-251 header itself records the asymmetry that makes this the terminal arm: a
 *   failed card has no automatic planning claimant while `needs-replan` is always consumed.
 *
 * The ceiling resets to zero on a clean planning handoff, alongside the existing
 * `recoveryRetryCount: null` clear, so a card that recovers is not permanently taxed for the episode.
 */
import type { Task, TaskStore } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";

/** `sourceMetadata` key holding the granted-reseed-cycle count for one card. */
export const PLANNING_RESEED_CYCLE_METADATA_KEY = "planningReseedCycles" as const;

/**
 * Reseed cycles granted before the card is parked. Three cycles x `MAX_RECOVERY_RETRIES` = 9 planning
 * attempts, which is strictly more than the single cadence the previous code allowed and still small
 * enough that a wedged card stops burning planner turns inside one operator shift.
 */
export const PLANNING_RESEED_CYCLE_LIMIT = 3;

/** Prefix of the parked error, so the reason is greppable and distinguishable from a plain failure. */
export const PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX = "PLANNING_RESEED_CYCLE_EXHAUSTED";

export type PlanningReseedCycleDecision = {
  /** Cycles already granted before this escalation. */
  granted: number;
  /** Cycles granted after this escalation is recorded (equals `granted` when parking). */
  next: number;
  /** True when granting another cycle would exceed {@link PLANNING_RESEED_CYCLE_LIMIT}. */
  exhausted: boolean;
};

/**
 * Reads the granted-cycle count defensively: a missing, non-numeric, negative, or non-finite value
 * reads as zero, because this marker must never be able to fabricate a bound out of a bad write.
 */
export function readPlanningReseedCycleCount(
  task: Pick<Task, "sourceMetadata"> | undefined,
): number {
  const raw = task?.sourceMetadata?.[PLANNING_RESEED_CYCLE_METADATA_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/** Decide the next cycle state for one escalation; pure, so the bound is testable without a store. */
export function evaluatePlanningReseedCycle(
  task: Pick<Task, "sourceMetadata"> | undefined,
  limit: number = PLANNING_RESEED_CYCLE_LIMIT,
): PlanningReseedCycleDecision {
  const granted = readPlanningReseedCycleCount(task);
  const next = granted + 1;
  return { granted, next, exhausted: next > limit };
}

/** Patch fragment that records a granted cycle. Merge is key-level, like every other episode marker. */
export function planningReseedCyclePatch(next: number): {
  sourceMetadataPatch: Record<string, number>;
} {
  return { sourceMetadataPatch: { [PLANNING_RESEED_CYCLE_METADATA_KEY]: next } };
}

/** Patch fragment that returns the card to an untaxed state after a clean planning handoff. */
export function planningReseedCycleResetPatch(): {
  sourceMetadataPatch: Record<string, number>;
} {
  return { sourceMetadataPatch: { [PLANNING_RESEED_CYCLE_METADATA_KEY]: 0 } };
}

/** The parked error sentence; carries counts only, never planner output or transport text. */
export function planningReseedCycleExhaustedError(granted: number, limit: number): string {
  return `${PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX}: planning re-seeded ${granted} times past its ${limit}-cycle ceiling; operator repair is required`;
}

/** Fixed outcome vocabulary for the ceiling row; never planner text, transport text, or error prose. */
export type PlanningReseedCycleOutcome = "re-seeded" | "parked";

/**
 * FNXC:PlanningReseedCycleBudget 2026-10-22-11:08 (RUFU-768):
 * One row per escalation so an operator can count cycles per card without reading the History log.
 * The ceiling's whole purpose is that a card stops, so the parked row is the durable proof that the
 * stop happened; without it the park is only a `failed` row indistinguishable from any other failure.
 * Metadata is ids/counts/fixed enums only. Emission uses the FN-9175 bounded seam, so an absent,
 * throwing, or hanging sink cannot prevent the park or the re-seed it records.
 */
export function emitPlanningReseedCycleAudit(
  store: TaskStore,
  input: {
    taskId: string;
    runContext?: EngineRunContext | undefined;
    cycles: number;
    limit: number;
    outcome: PlanningReseedCycleOutcome;
  },
): Promise<void> {
  return emitBoundedRunAudit(store, {
    taskId: input.taskId,
    agentId: input.runContext?.agentId ?? "triage",
    runId: input.runContext?.runId ?? generateSyntheticRunId("planning-reseed-cycle-budget", input.taskId),
    domain: "database",
    mutationType: "task:planning-reseed-cycle",
    target: input.taskId,
    metadata: {
      taskId: input.taskId,
      cycles: input.cycles,
      limit: input.limit,
      outcome: input.outcome,
    },
  });
}
