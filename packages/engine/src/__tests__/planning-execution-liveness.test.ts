import { afterEach, describe, expect, it } from "vitest";

import {
  getTaskPlanningOrExecutionLivenessSignal,
  isPlanningContinuationDispatchClaim,
  isTaskPlanningOrExecutionLive,
  PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX,
  planningContinuationDispatchLeaseOwner,
  type PlanningExecutionLivenessDeps,
} from "../agents/planning-execution-liveness.js";
import { registerPlanningLivenessProbe } from "../agents/planning-liveness.js";

const unregisters: Array<() => void> = [];

function inertDeps(overrides: PlanningExecutionLivenessDeps = {}): PlanningExecutionLivenessDeps {
  return {
    activeSessionRegistry: {
      pathsForTask: () => [],
      isPathActive: () => false,
    },
    executingTaskLock: { has: () => false },
    isTaskActive: () => false,
    isPlanningLive: () => false,
    ...overrides,
  };
}

afterEach(() => {
  while (unregisters.length > 0) unregisters.pop()?.();
});

/*
FNXC:PlanningExecutionLiveness 2026-09-06-00:29:
Each owner is exercised in isolation so a future short-circuit cannot hide the planner signal that
prevents Plan Review from racing PROMPT.md creation. Global probes are always unregistered because
the registry is process-wide and a leaked probe would invalidate unrelated recovery tests.

FNXC:MergeRebuild0919 2026-09-19-21:45:
Both lines added this file; the signal-resolution logic is identical, so the merge is the union of
the two case sets. Ours contributes the process-wide probe cases (a leaked-registry guard upstream
never covered); canonical contributes the planning-processor throw and the planning-continuation
dispatch lease-owner helpers, which this line keeps because triage still refuses to replace a
running dispatch claim.
*/
describe("planning and execution liveness", () => {
  it.each([
    ["active-session", inertDeps({
      activeSessionRegistry: {
        pathsForTask: (taskId) => taskId === "FN-299" ? ["/worktree"] : [],
        isPathActive: (path) => path === "/worktree",
      },
    })],
    ["executing-lock", inertDeps({ executingTaskLock: { has: (taskId) => taskId === "FN-299" } })],
    ["task-active", inertDeps({ isTaskActive: (taskId) => taskId === "FN-299" })],
    ["planning-processor", inertDeps({ getPlanningTaskIds: () => new Set(["FN-299"]) })],
    ["planning-probe", inertDeps({ isPlanningLive: (taskId) => taskId === "FN-299" })],
  ] as const)("returns the %s signal when that owner alone is live", (signal, deps) => {
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-299", deps)).toBe(signal);
    expect(isTaskPlanningOrExecutionLive("FN-299", deps)).toBe(true);
  });

  it("returns no signal when no owner or planning probe is active", () => {
    const deps = inertDeps();
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-299", deps)).toBeUndefined();
    expect(isTaskPlanningOrExecutionLive("FN-299", deps)).toBe(false);
  });

  it("preserves the historical false result when no process-wide probe is registered", () => {
    const deps = inertDeps({ isPlanningLive: undefined });
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-299", deps)).toBeUndefined();
    expect(isTaskPlanningOrExecutionLive("FN-299", deps)).toBe(false);
  });

  it("fails closed when a process-wide planning probe throws", () => {
    unregisters.push(registerPlanningLivenessProbe(() => {
      throw new Error("probe unavailable");
    }));
    const deps = inertDeps({ isPlanningLive: undefined });
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-299", deps)).toBe("planning-probe");
    expect(isTaskPlanningOrExecutionLive("FN-299", deps)).toBe(true);
  });

  it("fails closed when the planning-processor getter throws", () => {
    const deps = inertDeps({ getPlanningTaskIds: () => { throw new Error("boom"); } });
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-299", deps)).toBe("planning-processor");
    expect(isTaskPlanningOrExecutionLive("FN-299", deps)).toBe(true);
  });

  it("does not leak a planning owner to another task id", () => {
    const deps = inertDeps({
      getPlanningTaskIds: () => new Set(["FN-299"]),
      isPlanningLive: (taskId) => taskId === "FN-299",
    });
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-OTHER", deps)).toBeUndefined();
    expect(isTaskPlanningOrExecutionLive("FN-OTHER", deps)).toBe(false);
  });

  it("derives a stable, prefixed lease owner from item id + attempt", () => {
    const owner = planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 2 });
    expect(owner).toBe(`${PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX}item-1:2`);
    expect(isPlanningContinuationDispatchClaim({ state: "running", leaseOwner: owner })).toBe(true);
    expect(isPlanningContinuationDispatchClaim({ state: "running", leaseOwner: "someone-else" })).toBe(false);
    expect(isPlanningContinuationDispatchClaim({ state: "held", leaseOwner: owner })).toBe(false);
  });
});
