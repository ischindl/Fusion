// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { resolveStoreForProjectId } from "../context.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-15:56:
HARD ACCEPTANCE CONDITION for the runtime unload switch: turning a project's engine off must not
take its board down with it.

Measured before the feature, the board was already the victim — `/api/tasks/page` answered in
11–26 s while `/api/health` (no DB read) answered in 0.09 s, because minute-long engine passes held
the pool. Unloading the runtime is only a fix if the read path survives it, so this pins the route
layer's store resolution for a project whose lanes are disarmed, in both engine shapes the daemon
actually produces:
  - the engine instance exists with its TaskStore (the normal case — startup built the store and
    disarmed only the lanes), and
  - no engine instance exists at all (a lazily-unstarted project), which must fall through to the
    registry store rather than error.
Both must answer with the project's cards. Nothing here may consult the runtime gate: reads are not
a lane.
*/

const card = { id: "FN-ON-BOARD", title: "still readable", column: "todo" } as unknown as Task;

function storeServing(tasks: Task[]) {
  return { listTasks: vi.fn(async () => tasks), getProjectId: () => "proj-off" };
}

describe("board reads ignore the runtime gate", () => {
  it("serves the project's cards from the engine's store while its runtime is off", async () => {
    const store = storeServing([card]);
    const engine = {
      getTaskStore: () => store,
      // The state under test: every lane disarmed.
      isRuntimeEnabled: () => false,
      getProjectId: () => "proj-off",
    };
    const engineManager = { getEngine: vi.fn(() => engine) };

    const resolved = await resolveStoreForProjectId(
      "proj-off",
      storeServing([]) as never,
      { engineManager } as never,
    );

    const board = await resolved.listTasks({ slim: true, derive: false, excludeLog: true });
    expect(board.map((task: Task) => task.id)).toEqual(["FN-ON-BOARD"]);
  });

  it("falls through to a registry store when the project has no engine instance at all", async () => {
    const fallback = storeServing([card]);
    const engineManager = { getEngine: vi.fn(() => undefined), onProjectAccessed: vi.fn() };

    const resolved = await resolveStoreForProjectId(
      "proj-off",
      fallback as never,
      { engineManager, engine: { getProjectId: () => "proj-off" } } as never,
    );

    expect(await resolved.listTasks({ slim: true })).toHaveLength(1);
  });
});
