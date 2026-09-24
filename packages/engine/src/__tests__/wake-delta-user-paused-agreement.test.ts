/*
FNXC:TaskDispatch 2026-09-23-21:35 (RUFU-264 — cross-surface park agreement):

THE INVARIANT: a row carrying EITHER park flag (`paused` or `userPaused`) is
non-actionable on every heartbeat surface, and a row carrying neither is
actionable on the surface whose population it belongs to.

Two coordination projections consume heartbeat candidacy and both had drifted in
the same direction from the same authority — `FNXC:TaskDispatch 2026-07-19-14:40`
(scheduler.ts): "`userPaused` is a durable operator stop even when legacy
`paused` is false; candidacy caching and every dispatch selector must treat
either flag as parked."

  - `rankAssignedTasksForWakeDelta` (@fusion/core) — the titled Wake Delta
    inventory of an agent's ASSIGNED rows. Pre-fix it consulted only `paused`,
    so operator-parked Move-Task cards (serialized `userPaused: true,
    paused: undefined`) surfaced as `[ready_todo]` work while the scheduler
    would never dispatch them. Measured 2026-09-22T00:55Z (agent-5683bf15): 7
    parked cards offered as actionable, true parked count 8 shown as 2.
  - `isRunnableAutoClaimCandidate` — the UNASSIGNED auto-claim gate. Pre-fix it
    refused only `paused`, so an operator-cancelled backlog card was claimable.

Because the two surfaces cover DISJOINT populations (assigned vs unassigned),
agreement is tested as a per-cell VERDICT agreement over the flag matrix, with
each surface fed its own population shape. A future flag-clearing "fix"
(re-adding a `userPaused: false` write, or dropping the flag from one
projection's read) breaks a cell here; neither surface may silently relearn the
old rule.

RENAMED-COLUMN CONTROL: every cell also runs on a board whose lanes are
`drafting`/`wip`/`shipped`. The park guard precedes any column→tier mapping, so
it must hold independent of workflow vocabulary — a failure there means the fix
got wired into the legacy-id branch instead of the flag.
*/
import { describe, expect, it } from "vitest";
import { rankAssignedTasksForWakeDelta } from "@fusion/core";
import type { ColumnRoleTraitFlags, Task } from "@fusion/core";

import { isRunnableAutoClaimCandidate } from "../scheduling/auto-claim-snapshot.js";

interface Board {
  label: string;
  hold: string;
  wip: string;
  complete: string;
  /** Ranking needs role flags to treat a renamed complete lane as terminal. */
  flagsByColumnId?: ReadonlyMap<string, ColumnRoleTraitFlags>;
}

const LEGACY: Board = { label: "legacy", hold: "todo", wip: "in-progress", complete: "done" };
const RENAMED: Board = {
  label: "renamed",
  hold: "drafting",
  wip: "wip",
  complete: "shipped",
  flagsByColumnId: new Map([["shipped", { complete: true } as unknown as ColumnRoleTraitFlags]]),
};

function baseTask(over: Partial<Task>): Task {
  return {
    id: "FN-1",
    column: "todo",
    dependencies: [],
    ...over,
  } as unknown as Task;
}

interface FlagCell {
  label: string;
  flags: { paused?: boolean | null; userPaused?: boolean | null };
  /** Ground truth the two surfaces must agree on. */
  actionable: boolean;
}

const CELLS: FlagCell[] = [
  { label: "no flags", flags: {}, actionable: true },
  { label: "explicit nulls", flags: { paused: null, userPaused: null }, actionable: true },
  { label: "engine park (paused only)", flags: { paused: true }, actionable: false },
  // The exact RUFU-264 Move-Task hard-cancel serialization (false → undefined).
  { label: "operator park (userPaused only)", flags: { userPaused: true, paused: false }, actionable: false },
  // pauseTask(..., { userPaused: true }) sets both (RUFU-196/198 shape).
  { label: "both flags", flags: { paused: true, userPaused: true }, actionable: false },
];

describe("wake-delta inventory and auto-claim candidacy agree on the park flags (RUFU-264)", () => {
  for (const board of [LEGACY, RENAMED]) {
    describe(`${board.label} board`, () => {
      for (const cell of CELLS) {
        it(`${cell.label}: both surfaces return actionable=${cell.actionable}`, () => {
          // Surface 1: the ASSIGNED inventory row.
          const assignedRow = baseTask({
            id: "FN-ASSIGNED",
            column: board.hold,
            assignedAgentId: "agent-1",
            ...cell.flags,
          });
          const rank = rankAssignedTasksForWakeDelta([assignedRow], {
            agentId: "agent-1",
            roles: { hold: board.hold, wip: board.wip },
            flagsByColumnId: board.flagsByColumnId,
          });
          const inventoryActionable = rank.ranked.some((line) => line.task.id === "FN-ASSIGNED");

          // Surface 2: the UNASSIGNED auto-claim gate — same column, same flags,
          // no assignee, because auto-claim only ever considers unclaimed work.
          const candidateRow = baseTask({ id: "FN-OPEN", column: board.hold, ...cell.flags });
          const claimActionable = isRunnableAutoClaimCandidate(
            candidateRow,
            new Map([["FN-OPEN", candidateRow]]),
            new Map([["FN-OPEN", { hold: board.hold, complete: board.complete }]]),
          );

          expect(inventoryActionable, `${board.label}/${cell.label}: wake-delta`).toBe(cell.actionable);
          expect(claimActionable, `${board.label}/${cell.label}: auto-claim`).toBe(cell.actionable);
          expect(inventoryActionable, `${board.label}/${cell.label}: surfaces must agree`).toBe(claimActionable);

          // An operator-parked row additionally lands in the OPERATOR bucket of
          // the inventory split (never miscounted as an engine park).
          if (cell.flags.userPaused === true) {
            expect(rank.notActionableCount).toBe(1);
            expect(rank.operatorPausedCount).toBe(1);
            expect(rank.enginePausedCount).toBe(0);
          }
        });
      }
    });
  }

  /*
  Pin that the renamed control's lane ids are disjoint from the legacy ones, or
  the renamed matrix above is secretly a copy of legacy.
  */
  it("renamed control lanes are disjoint from the legacy ids", () => {
    expect([RENAMED.hold, RENAMED.wip, RENAMED.complete]).not.toContain("todo");
    expect([RENAMED.hold, RENAMED.wip, RENAMED.complete]).not.toContain("in-progress");
    expect([RENAMED.hold, RENAMED.wip, RENAMED.complete]).not.toContain("done");
  });

  it("an unflagged RENAMED-lane row is actionable on both surfaces (renamed board is live, not dead)", () => {
    const assigned = baseTask({ id: "FN-ASSIGNED", column: RENAMED.hold, assignedAgentId: "agent-1" });
    const rank = rankAssignedTasksForWakeDelta([assigned], {
      agentId: "agent-1",
      roles: { hold: RENAMED.hold, wip: RENAMED.wip },
      flagsByColumnId: RENAMED.flagsByColumnId,
    });
    expect(rank.ranked.map((line) => line.task.id)).toEqual(["FN-ASSIGNED"]);

    const open = baseTask({ id: "FN-OPEN", column: RENAMED.hold });
    expect(isRunnableAutoClaimCandidate(
      open,
      new Map([["FN-OPEN", open]]),
      new Map([["FN-OPEN", { hold: RENAMED.hold, complete: RENAMED.complete }]]),
    )).toBe(true);
  });
});
