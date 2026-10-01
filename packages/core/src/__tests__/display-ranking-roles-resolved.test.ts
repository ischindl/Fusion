/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:00 (batch-core feed: task-priority.ts 3 → 0, assigned-task-ranking.ts 2 → 0):

THE INVARIANT: display ordering and assigned-work ranking ask core's column-ROLE helpers, never the
column's name.

Both files are converted onto `column-roles.ts` rather than onto another optional set. That module
already owns the legacy-id degraded mode, so passing `undefined` flags reproduces the previous
behaviour exactly — there is no bespoke fallback in either file left to get wrong. Where the earlier
conversions in this batch had to invent a documented default, these two inherit one that is already
tested, which is the shape the remaining files should prefer wherever a role helper fits.

WHY THESE SURVIVED. Every failure here is WRONG ORDER or a MISCOUNT, never an error:

  - the complete lane loses recency ordering, so the newest completions are not at the top of Done;
  - the review lane stops floating actively-merging cards, so the card an operator is waiting on
    sits wherever the queue puts it;
  - Wake Delta counts a SHIPPED card as open assigned work, so a coordinator is asked to unblock or
    reassign tasks that already landed.

Nobody files a bug titled "the Done column is sorted slightly wrong", which is how three of these sat
in one function.

FNXC:TaskQueueOrder 2026-09-24-01:27 (RUFU-287 — repointing this file onto the surviving module):

FN-509 deleted `tasks/task-priority.ts` outright ("replace task priority levels with arrival-ordered
queue and per-card Boost") and moved the display sorter into `tasks/task-queue-order.ts`. This file was
left importing the deleted path, so it collected ZERO cases — a merge kept this side's test while the
other side deleted the module it names. There is now no `priority` field anywhere in the domain
(`grep -rn priority packages/core/src/tasks/` → no match), so a level fixture would pin a dead contract.

WHAT CHANGED HERE, case by case:

  - the hold-lane case asserted `priority: "urgent"` floating. Rewritten onto the axis that replaced
    levels: a renamed waiting lane is neither intake nor complete, so it takes the queue comparator —
    Boost first, then oldest arrival. Unlike the pre-FN-509 version of this case, this one is now real
    revert evidence (see below), because the three lane branches now disagree on the same fixture.
  - the complete-lane and review-lane cases keep their subject: arrival-recency and merge-active
    float are both still the contract. Only the `priority` keys and the comment that reasoned about
    levels go.
  - the no-flags case asserted that a legacy `todo` lane still priority-sorted. Levels are gone, so it
    now pins the OTHER half of the degraded mode: the legacy `done` id still resolves to the complete
    branch when no flags arrive, which is the fallback `column-roles.ts` owns and the board needs while
    an older checkout hydrates without trait flags.
  - the Wake Delta half is untouched: it asserts terminal-column exclusion via `flagsByColumnId`, not
    ordering, and remains the ONLY coverage of that parameter (`grep -rn flagsByColumnId packages/core/src`
    → the product plus these cases).

NOT WEAKENED TO BUY GREEN: no assertion below was widened, and no case was deleted to avoid a stale
subject — the hold-lane and no-flags cases were REWRITTEN onto the current contract instead. The plain
comparator is deliberately NOT re-tested here; `task-queue-order.test.ts` owns it (including "ignores a
legacy priority value entirely"). What this file owns is the axis that file does not exercise: RENAMED
column ids resolved through explicit role flags, which is the whole point of the invariant above.

REVERT PROOF, measured on this revision (each product edit made temporarily, then reverted; `git status`
confirmed clean before commit):

  - key the manual-intake, complete and review branches on their legacy id LITERALS instead of the role
    helpers → exactly 3 of the 8 cases fail, the three RENAMED-lane cases; the legacy no-flags case and
    the Boost case keep passing, because the Boost lane reaches neither branch.
  - drop the legacy-id fallback from `isCompleteColumnRole` (flags-only) → exactly 2 fail, the no-flags
    display case and the no-flags Wake Delta case, which is the degraded mode being pinned on both surfaces.
  - replace the generic lane's `compareTasksByQueueOrder` fallback with newest-arrival-first → exactly 1
    fails, the Boost/arrival case, so that lane's routing is pinned too.
  - drop the active-first disjunct from the generic comparator → exactly 1 fails, the review-lane case.
*/
import { describe, expect, it } from "vitest";
import { sortTasksForDisplayColumn, type TaskQueueBoost } from "../tasks/task-queue-order.js";
import { rankAssignedTasksForWakeDelta } from "../agents/assigned-task-ranking.js";
import type { ColumnRoleTraitFlags } from "../column-roles.js";

const HOLD_FLAGS = { hold: true } as unknown as ColumnRoleTraitFlags;
const INTAKE_FLAGS = { intake: true, manualIntake: true } as unknown as ColumnRoleTraitFlags;
const COMPLETE_FLAGS = { complete: true } as unknown as ColumnRoleTraitFlags;
const REVIEW_FLAGS = { mergeBlocker: true } as unknown as ColumnRoleTraitFlags;

const at = (iso: string) => ({ columnMovedAt: iso, updatedAt: iso, createdAt: iso });

/** A boost belongs to the card's current stay in one column, so its scope fields must match the fixture. */
const boostIn = (column: string, columnEntryAt: string, sequence: string): TaskQueueBoost => ({
  sequence,
  workflowId: "builtin:coding",
  column,
  columnEntryAt,
  requestId: `req-${column}-${sequence}`,
});

describe("sortTasksForDisplayColumn resolves the column's role", () => {
  it("newest-firsts a RENAMED manual-intake lane", () => {
    // Pre-fix: `parked` !== "ideas", so the lane fell through to the queue comparator and showed the
    // OLDEST ideas at the top of the intake backlog.
    const tasks = [
      { id: "FN-1", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-2", ...at("2026-01-02T00:00:00Z") },
    ] as never[];

    expect(
      sortTasksForDisplayColumn(tasks, "parked", { columnFlags: INTAKE_FLAGS }).map((t: { id: string }) => t.id),
    ).toEqual(["FN-2", "FN-1"]);
  });

  it("recency-sorts a RENAMED complete lane, newest arrival first", () => {
    const tasks = [
      { id: "FN-OLD", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-NEW", ...at("2026-02-01T00:00:00Z") },
    ] as never[];

    // The generic queue comparator would put FN-OLD first (oldest arrival); the complete lane orders by
    // arrival recency instead, so the newest shipping card heads the lane.
    expect(
      sortTasksForDisplayColumn(tasks, "shipped", { columnFlags: COMPLETE_FLAGS }).map((t: { id: string }) => t.id),
    ).toEqual(["FN-NEW", "FN-OLD"]);
  });

  it("floats an actively-merging card in a RENAMED review lane", () => {
    const tasks = [
      { id: "FN-IDLE", status: null, ...at("2026-01-01T00:00:00Z") },
      { id: "FN-MERGING", status: "merging", ...at("2026-01-01T00:00:00Z") },
    ] as never[];

    // Arrival and id tiebreaks would rank FN-IDLE first; merge-active wins in the review lane because
    // that is the card the operator is waiting on.
    expect(
      sortTasksForDisplayColumn(tasks, "signoff", { columnFlags: REVIEW_FLAGS }).map((t: { id: string }) => t.id),
    ).toEqual(["FN-MERGING", "FN-IDLE"]);
  });

  it("Boost-then-arrival sorts a RENAMED waiting lane, with no activity float", () => {
    // FN-509 replaced priority levels: the ONLY way a card leaves arrival order is an explicit Boost,
    // and a waiting lane is not review/WIP, so nothing floats out of the queue order.
    const boosted = at("2026-01-03T00:00:00Z");
    const tasks = [
      { id: "FN-OLDEST", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-MIDDLE", ...at("2026-01-02T00:00:00Z") },
      { id: "FN-BOOSTED", column: "backlog", ...boosted, queueBoost: boostIn("backlog", boosted.columnMovedAt, "7") },
    ] as never[];

    expect(
      sortTasksForDisplayColumn(tasks, "backlog", { columnFlags: HOLD_FLAGS }).map((t: { id: string }) => t.id),
    ).toEqual(["FN-BOOSTED", "FN-OLDEST", "FN-MIDDLE"]);
  });

  it("keeps the legacy ids when no flags are supplied", () => {
    // The degraded mode owned by column-roles.ts: no flags → legacy ids, byte-identical to before.
    const tasks = [
      { id: "FN-OLD", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-NEW", ...at("2026-02-01T00:00:00Z") },
    ] as never[];

    expect(sortTasksForDisplayColumn(tasks, "done").map((t: { id: string }) => t.id)).toEqual(["FN-NEW", "FN-OLD"]);
  });
});

describe("rankAssignedTasksForWakeDelta excludes each card's own terminal columns", () => {
  const assigned = (id: string, column: string) => ({ id, column, title: `${id} title`, dependencies: [] });

  it("excludes a card in a RENAMED complete lane from open assigned work", () => {
    // Pre-fix: `shipped` is not `done`, so a coordinator was asked to unblock shipped work.
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "building"), assigned("FN-DONE", "shipped")] as never[],
      { agentId: "AG-1", flagsByColumnId: new Map([["shipped", COMPLETE_FLAGS]]) },
    );

    expect(result.totalOpen).toBe(1);
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-OPEN"]);
  });

  it("keeps the legacy ids for a column absent from the flag map", () => {
    // The degraded mode owned by column-roles.ts: no flags → legacy ids, byte-identical to before.
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "todo"), assigned("FN-DONE", "done")] as never[],
      { agentId: "AG-1" },
    );

    expect(result.totalOpen).toBe(1);
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-OPEN"]);
  });

  it("still counts a card in a non-terminal renamed column as open", () => {
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "signoff")] as never[],
      { agentId: "AG-1", flagsByColumnId: new Map([["signoff", REVIEW_FLAGS]]) },
    );

    expect(result.totalOpen).toBe(1);
  });
});
