import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:SelfHealing 2026-06-21-12:45:
Forward progress (a step reaching a terminal forward status) must clear the lifetime
stuck-kill streak so only CONSECUTIVE no-progress stalls count toward maxStuckKills.
stuckKillCount is otherwise incremented by self-healing on each stuck-kill and reset ONLY
by a manual retry, so a long task that genuinely advances between intermittent stalls could
be terminalized by accumulation. Asserted across every updateStep surface (legacy done,
skipped, graph-source done) and proven NOT to reset on non-forward transitions (in-progress
advance, ignored regressions). Complements the FN-5048 verification-fan-out cap.
*/
describe("TaskStore.updateStep stuck-kill streak reset on forward progress", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  const withStreak = async (streak: number) => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();
    await store.updateTask(task.id, { stuckKillCount: streak });
    return { store, task };
  };

  it("done clears the streak and logs the reset", async () => {
    const { store, task } = await withStreak(4);
    const updated = await store.updateStep(task.id, 0, "done");
    expect(updated.stuckKillCount ?? 0).toBe(0);
    expect(updated.log.some((e) => e.action.includes("Reset stuck-kill streak"))).toBe(true);
  });

  it("skipped clears the streak", async () => {
    const { store, task } = await withStreak(5);
    const updated = await store.updateStep(task.id, 0, "skipped");
    expect(updated.stuckKillCount ?? 0).toBe(0);
  });

  it("graph-source done clears the streak (graph surface)", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();
    // Graph-source writes bypass lazy step-init from PROMPT.md, so materialize the
    // step list with a legacy write first (mirrors store-update-step-order's graph tests).
    await store.updateStep(task.id, 0, "in-progress");
    await store.updateTask(task.id, { stuckKillCount: 3 });
    const updated = await store.updateStep(task.id, 0, "done", { source: "graph" });
    expect(updated.stuckKillCount ?? 0).toBe(0);
  });

  it("in-progress (step advance) does NOT clear the streak — only terminal forward progress does", async () => {
    const { store, task } = await withStreak(3);
    const updated = await store.updateStep(task.id, 0, "in-progress");
    expect(updated.stuckKillCount ?? 0).toBe(3);
  });

  it("an IGNORED out-of-order done does NOT clear the streak (no real progress)", async () => {
    const { store, task } = await withStreak(2);
    // step 0 still pending → done on step 2 is rejected/ignored, so no forward progress.
    const updated = await store.updateStep(task.id, 2, "done");
    expect(updated.steps[2].status).toBe("pending");
    expect(updated.stuckKillCount ?? 0).toBe(2);
  });

  it("a no-op write does not log a spurious reset when there is no streak", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();
    const updated = await store.updateStep(task.id, 0, "done");
    expect(updated.log.some((e) => e.action.includes("Reset stuck-kill streak"))).toBe(false);
  });
});
