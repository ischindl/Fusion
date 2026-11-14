import { describe, expect, it } from "vitest";
/*
FNXC:BoardOrdering 2026-11-13-09:30:
RUFU-526 - the acceptance of the ATTENTION RANK, asserted as a rank and never as a pixel position:
jsdom computes no layout and returns zero rects (`packages/core`/`packages/dashboard` vitest config
says so), so an assertion about a viewport here could not fail. Real rect containment is proven in the
browser lane by `board-attention.browser.test.ts`.

This file owns the shared comparator's contract: a card that needs the operator outranks an idle one,
lane membership is untouched, the order is a pure function of the rows, and the three boundaries the
requirement names - an in-flight card, a deliberate Boost, a hand-picked sort - still hold.
*/
import {
  sortTasksForDisplayColumn,
  type ColumnRoleTraitFlags,
  type TaskQueueSortable,
  type TaskQueueBoost,
} from "../tasks/task-queue-order.js";

const TODO_FLAGS: ColumnRoleTraitFlags = {
  intake: true,
  hold: false,
  countsTowardWip: false,
  mergeBlocker: false,
  humanReview: false,
  complete: false,
};

/** A review lane: `mergeBlocker` is the trait that opens the ladder's review-scope gate. */
const REVIEW_FLAGS: ColumnRoleTraitFlags = {
  intake: false,
  hold: false,
  countsTowardWip: true,
  mergeBlocker: true,
  humanReview: false,
  complete: false,
};

const INTAKE_ONLY_FLAGS: ColumnRoleTraitFlags & { manualIntake: boolean } = { ...TODO_FLAGS, manualIntake: true };

const COMPLETE_FLAGS: ColumnRoleTraitFlags = {
  intake: false,
  hold: false,
  countsTowardWip: false,
  mergeBlocker: false,
  humanReview: false,
  complete: true,
};

interface Row extends TaskQueueSortable {
  error?: string | null;
  pausedReason?: string | null;
  awaitingApprovalReason?: string | null;
  blockedBy?: string | null;
  overlapBlockedBy?: string | null;
  dependencies?: string[];
  enabledWorkflowSteps?: string[];
  workflowStepResults?: Array<{ workflowStepId: string; status: string }>;
  stallReason?: { code: string };
}

/**
 * An idle `todo` card: no field the ladder reads is set.
 * `minute` is the arrival knob - distinct minutes keep FIFO strict without inventing fake dates.
 */
function idle(id: string, minute: number): Row {
  return { id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() };
}

const idsOf = (rows: readonly Row[]): string[] => rows.map((row) => row.id);

/*
A boost that survives `resolveEffectiveQueueBoost`'s validation: the entry marker must equal the
card's current `columnMovedAt ?? createdAt` stay, or the record is treated as belonging to an earlier
visit and is not a boost at all.
*/
function boostOf(row: Row, sequence: string): TaskQueueBoost {
  return {
    sequence,
    workflowId: "workflow-1",
    column: row.column ?? "todo",
    columnEntryAt: row.columnMovedAt ?? row.createdAt,
    requestId: `req-${sequence}`,
  };
}

describe("sortTasksForDisplayColumn - attention outranks idle in the default order", () => {
  it("lifts one failed card out of 200 idle todo cards to rank 1", () => {
    // The reported measurement: the failure sat ~201st, below every fold. Newest-created puts it
    // last in FIFO, so a pass that still ordered by arrival would leave it at index 199.
    const tasks = Array.from({ length: 200 }, (_, index) => idle(`FN-${index + 1}`, index + 1));
    tasks.push({ ...idle("FN-9001", 201), status: "failed", error: "merge failed" });

    const ordered = sortTasksForDisplayColumn(tasks, "todo", { columnFlags: TODO_FLAGS });

    expect(ordered[0]?.id).toBe("FN-9001");
    expect(ordered.findIndex((row) => row.id === "FN-9001")).toBe(0);
  });

  it("keeps the surviving FIFO order among the cards that stay idle", () => {
    const tasks = [idle("FN-1", 1), idle("FN-2", 2), idle("FN-3", 3), { ...idle("FN-4", 4), error: "boom" }];
    const ordered = sortTasksForDisplayColumn(tasks, "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-4", "FN-1", "FN-2", "FN-3"]);
  });

  it("orders a lane carrying one card per tier by the ladder, not by arrival", () => {
    const rows: Row[] = [
      { ...idle("FN-60", 6), dependencies: ["FN-001"] },
      { ...idle("FN-10", 1), error: "boom" },
      { ...idle("FN-40", 4), pausedReason: "duplicate-decision-required" },
      { ...idle("FN-50", 5), overlapBlockedBy: "FN-002" },
      { ...idle("FN-20", 2), awaitingApprovalReason: "human-plan-approval" },
      { ...idle("FN-70", 7), status: "queued" },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-10", "FN-20", "FN-40", "FN-50", "FN-60", "FN-70"]);
  });

  it("ranks a failed required gate above a zero-error card in a review lane", () => {
    // The acceptance line, stated without opening either card: only the gate differs.
    const rows: Row[] = [
      { ...idle("FN-clean", 1), status: "in-progress" },
      {
        ...idle("FN-gated", 2),
        status: "in-progress",
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }],
      },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS });
    expect(ordered[0]?.id).toBe("FN-gated");
  });

  it("ranks a gate with zero result rows the same way a failed row is ranked", () => {
    const rows: Row[] = [
      { ...idle("FN-passed", 1), enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] },
      { ...idle("FN-missing", 2), enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-missing", "FN-passed"]);
  });

  it("leaves a review lane's advisory_failure and skipped gates where they are", () => {
    // Non-blocking by contract: an advisory REVISE or an audited waiver must not hold the board's head.
    const rows: Row[] = [
      { ...idle("FN-advisory", 1), enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "advisory_failure" }] },
      { ...idle("FN-waived", 2), enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "skipped" }] },
      { ...idle("FN-later", 3) },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-advisory", "FN-waived", "FN-later"]);
  });

  it("does not open the review-only tiers in a plain todo lane", () => {
    // A todo card has never reached its gates, so "no result row" is normal there. Ranking it as
    // attention would float the entire backlog to the top - the exact failure mode of the report.
    const rows: Row[] = [
      { ...idle("FN-1", 1), enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
      { ...idle("FN-2", 2), enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
      { ...idle("FN-3", 3), stallReason: { code: "merge-blocker" } },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });
});

describe("sortTasksForDisplayColumn - lane membership and counts never move", () => {
  it("returns a permutation: the same ids, the same count, per column role", () => {
    const rows: Row[] = [
      { ...idle("FN-1", 1), error: "boom" },
      idle("FN-2", 2),
      { ...idle("FN-3", 3), pausedReason: "duplicate-decision-required" },
      { ...idle("FN-4", 4), dependencies: ["FN-001"] },
      { ...idle("FN-5", 5), awaitingApprovalReason: "human-plan-approval" },
      { ...idle("FN-6", 6), enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
    ];
    for (const [column, flags] of [
      ["todo", TODO_FLAGS],
      ["in-review", REVIEW_FLAGS],
      ["done", COMPLETE_FLAGS],
    ] as const) {
      const ordered = sortTasksForDisplayColumn(rows, column, { columnFlags: flags });
      expect(ordered).toHaveLength(rows.length);
      expect([...idsOf(ordered)].sort()).toEqual([...idsOf(rows)].sort());
    }
  });

  it("does not mutate the caller's array", () => {
    const rows: Row[] = [{ ...idle("FN-1", 1), error: "boom" }, idle("FN-2", 2)];
    const snapshot = idsOf(rows);
    sortTasksForDisplayColumn(rows, "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(rows)).toEqual(snapshot);
  });
});

describe("sortTasksForDisplayColumn - the order is a pure function of the rows", () => {
  /*
  "Same input produces identical order on a second render; a no-change poll causes no visual reorder."
  Polling revalidation can hand the same set over in a different arrival order, so the stronger proof
  is that the ORDER OF INPUT DOES NOT SURVIVE - any permutation of the same rows sorts identically.
  That is only true because every bucket ends in the numeric-id tiebreak.
  */
  const rows: Row[] = [
    { ...idle("FN-1", 1), error: "boom" },
    idle("FN-2", 2),
    { ...idle("FN-3", 3), pausedReason: "branch-conflict-recovery-exhausted" },
    { ...idle("FN-4", 4), blockedBy: "FN-001" },
    { ...idle("FN-5", 5), awaitingApprovalReason: "human-plan-approval" },
    { ...idle("FN-10", 6), status: "failed" },
    { ...idle("FN-11", 7), overlapBlockedBy: "FN-002" },
  ];

  it("produces the identical sequence on a second call", () => {
    const first = idsOf(sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS }));
    const second = idsOf(sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS }));
    expect(second).toEqual(first);
  });

  it("produces the identical sequence from a shuffled input", () => {
    const expected = idsOf(sortTasksForDisplayColumn(rows, "in-review", { columnFlags: REVIEW_FLAGS }));
    for (const seed of [1, 2, 3, 4, 5]) {
      const shuffled = [...rows].sort((a, b) => ((seed * a.id.length) % 7) - ((seed * b.id.length) % 7) || a.id.localeCompare(b.id));
      expect(idsOf(sortTasksForDisplayColumn(shuffled, "in-review", { columnFlags: REVIEW_FLAGS })), `seed ${seed}`).toEqual(expected);
    }
  });
});

describe("sortTasksForDisplayColumn - the boundaries the requirement names", () => {
  it("keeps an in-flight card ahead of a waiting card that needs attention", () => {
    const active: Row = { ...idle("FN-active", 1), status: "merging" };
    const broken: Row = { ...idle("FN-broken", 2), status: "in-progress", error: "boom" };
    const ordered = sortTasksForDisplayColumn([broken, active], "in-review", {
      columnFlags: REVIEW_FLAGS,
      isActive: (candidate) => candidate.id === "FN-active",
    });
    expect(idsOf(ordered)).toEqual(["FN-active", "FN-broken"]);
  });

  it("keeps a deliberate Boost ahead of an idle card's turn AND ahead of an unboosted failure", () => {
    const boostedIdle: Row = idle("FN-boosted", 9);
    boostedIdle.queueBoost = boostOf(boostedIdle, "42");
    const failing: Row = { ...idle("FN-failing", 1), error: "boom" };
    const plain: Row = idle("FN-plain", 2);
    // The Boost bucket stays FIRST: attention ranks inside it, never ahead of it, or a stale failure
    // would bury the card the operator just pushed to the head.
    const ordered = sortTasksForDisplayColumn([plain, failing, boostedIdle], "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-boosted", "FN-failing", "FN-plain"]);
  });

  it("keeps boost recency as the term inside the bucket, then ranks by attention", () => {
    const boostedIdleOld: Row = idle("FN-a", 1);
    boostedIdleOld.queueBoost = boostOf(boostedIdleOld, "50");
    const boostedIdleNew: Row = idle("FN-b", 2);
    boostedIdleNew.queueBoost = boostOf(boostedIdleNew, "60");
    const boostedFailing: Row = { ...idle("FN-c", 3), error: "boom" };
    boostedFailing.queueBoost = boostOf(boostedFailing, "55");
    const ordered = sortTasksForDisplayColumn([boostedIdleOld, boostedIdleNew, boostedFailing], "todo", {
      columnFlags: TODO_FLAGS,
    });
    /*
    The database expresses "a Boost exists" and "which Boost is newer" as ONE term
    (`QUEUE_BOOST_SEQUENCE DESC`), so the client resolves recency before the tier as well. Sliding the
    tier between presence and recency would rank this group by tier in TypeScript and by recency in
    SQL - the two halves of one ladder disagreeing about a group the operator can see on one screen.
    Sequence 60 > 55 > 50 therefore wins over the failure at 55.
    */
    expect(idsOf(ordered)).toEqual(["FN-b", "FN-c", "FN-a"]);
  });

  it("leaves manual intake newest-first even when a card needs attention", () => {
    const rows: Row[] = [{ ...idle("FN-old-broken", 1), error: "boom" }, idle("FN-new", 2)];
    const ordered = sortTasksForDisplayColumn(rows, "ideas", { columnFlags: INTAKE_ONLY_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-new", "FN-old-broken"]);
  });

  it("leaves the Complete lane ordered by arrival even when a card carries an error", () => {
    const rows: Row[] = [
      { ...idle("FN-early", 1), error: "boom", columnMovedAt: "2026-01-01T00:00:00.000Z" },
      { ...idle("FN-late", 2), columnMovedAt: "2026-02-01T00:00:00.000Z" },
    ];
    const ordered = sortTasksForDisplayColumn(rows, "done", { columnFlags: COMPLETE_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-late", "FN-early"]);
  });

  it("gives a lane with no attention signal today's arrival order unchanged", () => {
    const rows = [idle("FN-3", 3), idle("FN-1", 1), idle("FN-2", 2)];
    const ordered = sortTasksForDisplayColumn(rows, "todo", { columnFlags: TODO_FLAGS });
    expect(idsOf(ordered)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });
});
