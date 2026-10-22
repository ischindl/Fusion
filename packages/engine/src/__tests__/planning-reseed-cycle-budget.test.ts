/**
 * FNXC:PlanningReseedCycleBudget 2026-10-22-11:08 (RUFU-768):
 * Acceptance for the card-level planning ceiling. The defect was not a wrong number but a missing
 * ceiling: every planning escalation cleared `recoveryRetryCount` and returned the card to
 * `needs-replan`, which triage's next admission pass always consumes, so each exhaustion granted a
 * fresh cadence and a card crashing at Plan Review before any verdict looped forever. These tests
 * therefore assert TERMINATION of the escalation loop and the shape of the park, not a counter value.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import {
  PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX,
  PLANNING_RESEED_CYCLE_LIMIT,
  PLANNING_RESEED_CYCLE_METADATA_KEY,
  evaluatePlanningReseedCycle,
  planningReseedCycleExhaustedError,
  planningReseedCyclePatch,
  planningReseedCycleResetPatch,
  readPlanningReseedCycleCount,
} from "../executor/planning-reseed-cycle-budget.js";

function taskWith(metadata: Record<string, unknown> | undefined): Pick<Task, "sourceMetadata"> {
  return { sourceMetadata: metadata as Task["sourceMetadata"] };
}

describe("planning reseed cycle ceiling", () => {
  it("reads every unusable marker as zero so a bad write can never fabricate a bound", () => {
    expect(readPlanningReseedCycleCount(undefined)).toBe(0);
    expect(readPlanningReseedCycleCount(taskWith(undefined))).toBe(0);
    expect(readPlanningReseedCycleCount(taskWith({ [PLANNING_RESEED_CYCLE_METADATA_KEY]: "7" }))).toBe(0);
    expect(readPlanningReseedCycleCount(taskWith({ [PLANNING_RESEED_CYCLE_METADATA_KEY]: -3 }))).toBe(0);
    expect(readPlanningReseedCycleCount(taskWith({ [PLANNING_RESEED_CYCLE_METADATA_KEY]: Number.NaN }))).toBe(0);
  });

  it("grants cycles up to the ceiling and refuses the one past it", () => {
    expect(evaluatePlanningReseedCycle(taskWith(undefined))).toEqual({ granted: 0, next: 1, exhausted: false });
    const atCeiling = taskWith({ [PLANNING_RESEED_CYCLE_METADATA_KEY]: PLANNING_RESEED_CYCLE_LIMIT });
    expect(evaluatePlanningReseedCycle(atCeiling)).toEqual({
      granted: PLANNING_RESEED_CYCLE_LIMIT,
      next: PLANNING_RESEED_CYCLE_LIMIT + 1,
      exhausted: true,
    });
  });

  it("terminates: a crash that persists its escalation patch reaches the park without a manual reset", () => {
    /*
     * The regression being guarded is the self-clearing counter: the old escalation wrote
     * `recoveryRetryCount: null` and `needs-replan`, so state never accumulated. Here the escalation
     * patch is applied the way the seam applies it, and the loop must end on its own.
     */
    let metadata: Record<string, unknown> = {};
    let escalations = 0;
    let parked = false;
    while (!parked && escalations < 50) {
      const decision = evaluatePlanningReseedCycle(taskWith(metadata));
      escalations += 1;
      if (decision.exhausted) {
        parked = true;
        break;
      }
      metadata = { ...metadata, ...planningReseedCyclePatch(decision.next).sourceMetadataPatch };
    }
    expect(parked).toBe(true);
    // One park per PLANNING_RESEED_CYCLE_LIMIT granted cycles, never the 50 the loop would allow.
    expect(escalations).toBe(PLANNING_RESEED_CYCLE_LIMIT + 1);
  });

  it("untaxes the card on a clean handoff so recovery is not punished for the episode", () => {
    expect(planningReseedCycleResetPatch().sourceMetadataPatch[PLANNING_RESEED_CYCLE_METADATA_KEY]).toBe(0);
    const afterReset = taskWith(planningReseedCycleResetPatch().sourceMetadataPatch);
    expect(evaluatePlanningReseedCycle(afterReset).granted).toBe(0);
  });

  it("names the park with the prefix and counts, and records no planner text", () => {
    const error = planningReseedCycleExhaustedError(3, PLANNING_RESEED_CYCLE_LIMIT);
    expect(error).toContain(PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX);
    expect(error).toContain("3");
    expect(error).toContain(String(PLANNING_RESEED_CYCLE_LIMIT));
    expect(error).toContain("operator repair is required");
  });
});
