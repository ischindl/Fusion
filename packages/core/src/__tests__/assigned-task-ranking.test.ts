import { describe, expect, it } from "vitest";
import {
  formatAssignedTasksWakeDeltaSection,
  rankAssignedTasksForWakeDelta,
  WAKE_DELTA_ASSIGNED_TASKS_CAP,
  type AssignedTaskLike,
} from "../agents/assigned-task-ranking.js";

function task(partial: Partial<AssignedTaskLike> & Pick<AssignedTaskLike, "id" | "column">): AssignedTaskLike {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

describe("rankAssignedTasksForWakeDelta", () => {
  it("orders in_progress before ready_todo before partial_blocked", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-T", column: "todo", title: "Ready", createdAt: "2026-07-03T00:00:00.000Z" }),
        task({ id: "FN-B", column: "todo", title: "Blocked", dependencies: ["FN-X"], createdAt: "2026-07-02T00:00:00.000Z" }),
        task({ id: "FN-P", column: "in-progress", title: "Active", createdAt: "2026-07-01T00:00:00.000Z" }),
      ],
      { agentId: "agent-1", boundTaskId: "FN-P" },
    );
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-P", "FN-T", "FN-B"]);
    expect(result.ranked[0]?.labels).toContain("bound");
  });

  it("excludes done/archived, counts paused as not actionable, and keeps open custom columns titled", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-1", column: "todo", title: "Open" }),
        task({ id: "FN-2", column: "done", title: "Done" }),
        task({ id: "FN-3", column: "todo", title: "Paused", paused: true }),
        task({ id: "FN-4", column: "in-review", title: "Review" }),
        task({ id: "FN-5", column: "ready-for-dev", title: "Custom workflow ready" }),
      ],
      { agentId: "agent-1" },
    );
    // todo first, then other-tier open columns (in-review + custom) by createdAt
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-1", "FN-4", "FN-5"]);
    expect(result.ranked.find((r) => r.task.id === "FN-5")?.tier).toBe("other");
    expect(result.notActionableCount).toBe(1); // paused only
    expect(result.totalOpen).toBe(4); // excludes done
    // RUFU-264: a legacy-`paused`-only row is the ENGINE park bucket.
    expect(result.operatorPausedCount).toBe(0);
    expect(result.enginePausedCount).toBe(1);
  });

  /*
  FNXC:WakeDeltaMultiAssign 2026-09-23-21:35 (RUFU-264):
  The exact reported symptom: a Move-Task hard cancel serializes as
  `userPaused: true` with `paused: false/null`, and the projection — consulting
  only the legacy flag — ranked it `[ready_todo]` assigned work the scheduler
  would never dispatch. The dispatch invariant
  (`FNXC:TaskDispatch 2026-07-19-14:40`, scheduler.ts) says either flag is parked;
  this inventory drifted from it and each no-task heartbeat chased the lie.
  */
  it("ranks a userPaused row with legacy paused false as not_actionable (RUFU-264 symptom)", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-PARKED", column: "todo", title: "Operator parked", userPaused: true, paused: false }),
        task({ id: "FN-LIVE", column: "todo", title: "Genuinely ready" }),
      ],
      { agentId: "agent-1" },
    );
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-LIVE"]);
    expect(result.ranked.some((r) => r.task.id === "FN-PARKED")).toBe(false);
    expect(result.notActionableCount).toBe(1);
    expect(result.operatorPausedCount).toBe(1);
    expect(result.enginePausedCount).toBe(0);
    // count-only: the parked row never appears as a titled line at all
    expect(formatAssignedTasksWakeDeltaSection(result)).not.toContain("FN-PARKED");
  });

  it("counts a both-flag row as operator-parked (operator hold wins identity)", () => {
    // pauseTask(..., { userPaused: true }) sets BOTH flags (RUFU-196/198 shape).
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-BOTH", column: "todo", paused: true, userPaused: true })],
      { agentId: "agent-1" },
    );
    expect(result.notActionableCount).toBe(1);
    expect(result.operatorPausedCount).toBe(1);
    expect(result.enginePausedCount).toBe(0);
  });

  it("counts a paused-only row as engine-parked and userPaused:null as operator-parked", () => {
    const engine = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-ENG", column: "todo", paused: true })],
      { agentId: "agent-1" },
    );
    expect(engine.notActionableCount).toBe(1);
    expect(engine.operatorPausedCount).toBe(0);
    expect(engine.enginePausedCount).toBe(1);

    // Dashboard/operator-hold serialization maps false to `undefined`/`null`.
    const operatorNullLegacy = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-OP", column: "todo", userPaused: true, paused: null })],
      { agentId: "agent-1" },
    );
    expect(operatorNullLegacy.notActionableCount).toBe(1);
    expect(operatorNullLegacy.operatorPausedCount).toBe(1);
    expect(operatorNullLegacy.enginePausedCount).toBe(0);
  });

  it("caps titled lines and marks truncated", () => {
    const tasks = Array.from({ length: WAKE_DELTA_ASSIGNED_TASKS_CAP + 4 }, (_, i) =>
      task({
        id: `FN-${i}`,
        column: "todo",
        title: `Task ${i}`,
        createdAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const result = rankAssignedTasksForWakeDelta(tasks, { agentId: "agent-1" });
    expect(result.ranked).toHaveLength(WAKE_DELTA_ASSIGNED_TASKS_CAP);
    expect(result.truncated).toBe(true);
  });

  it("annotates foreign lease", () => {
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-1", column: "todo", title: "Held", checkedOutBy: "other-agent" })],
      { agentId: "agent-1" },
    );
    expect(result.ranked[0]?.labels.some((l) => l.includes("held-by-other"))).toBe(true);
  });
});

describe("formatAssignedTasksWakeDeltaSection", () => {
  it("omits empty inventory", () => {
    const result = rankAssignedTasksForWakeDelta([], { agentId: "agent-1" });
    expect(formatAssignedTasksWakeDeltaSection(result)).toBe("");
  });

  it("omits single bound-only titled inventory by default", () => {
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-1", column: "in-progress", title: "Only" })],
      { agentId: "agent-1", boundTaskId: "FN-1" },
    );
    expect(formatAssignedTasksWakeDeltaSection(result, { boundTaskId: "FN-1" })).toBe("");
  });

  it("renders multi inventory with coordination framing", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-1", column: "in-progress", title: "A" }),
        task({ id: "FN-2", column: "todo", title: "B" }),
      ],
      { agentId: "agent-1", boundTaskId: "FN-1" },
    );
    const text = formatAssignedTasksWakeDeltaSection(result, { boundTaskId: "FN-1" });
    expect(text).toContain("coordination inventory");
    expect(text).toContain("FN-1");
    expect(text).toContain("FN-2");
    expect(text).toContain("(bound)");
  });

  it("splits the not-actionable line into operator-parked vs engine-parked buckets (RUFU-264)", () => {
    /*
    The old literal `(paused)` merged both parks and undercounted the reported
    tick (8 true parked cards shown as 2), so a coordinator could not tell
    "operator said stop" from "engine parked it" — nor even see the true total.
    */
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-1", column: "todo", title: "A" }),
        task({ id: "FN-OP", column: "todo", title: "Operator hold", userPaused: true, paused: false }),
        task({ id: "FN-ENG", column: "in-progress", title: "Engine park", paused: true }),
      ],
      { agentId: "agent-1" },
    );
    const text = formatAssignedTasksWakeDeltaSection(result);
    expect(text).toContain("also assigned not actionable now: 2 (operator-paused: 1, engine-paused: 1)");
    expect(text).not.toContain("FN-OP");
    expect(text).not.toContain("FN-ENG");
  });

  it("renders hand-constructed results without the split fields via ?? 0 defaults", () => {
    const text = formatAssignedTasksWakeDeltaSection({
      ranked: [],
      totalOpen: 1,
      notActionableCount: 1,
      truncated: false,
    } as never);
    expect(text).toContain("also assigned not actionable now: 1 (operator-paused: 0, engine-paused: 0)");
  });
});
