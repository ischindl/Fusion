/**
 * FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583):
 * Unit cover for the lifecycle derivation and the structural ratchet that keeps it truthful.
 *
 * The reported defect this closes is a *missing fact*: `rowToTask` maps `deletedAt` to `undefined`
 * on a live row, `JSON.stringify` then drops the key, and a consumer's `deletedAt is falsy` filter is
 * blind by construction — so a soft-deleted card read as alive. The projection answers with one of
 * three literals for EVERY row instead, which is only safe if the derivation is TOTAL (no input
 * answers nothing) and if `deletedAt` keeps winning over archival evidence (a soft delete stamps the
 * archive sentinel lane too, so a tombstone keyed on lane alone would read as merely `archived`).
 *
 * The second half is a code-construct ratchet, not a prose assertion: `deletedAt` must never become
 * a member of `BOARD_FEED_DROPPED_COLUMNS`. Membership there removes the column from the board
 * SELECT list (RUFU-902), which would leave every board-shaped tombstone un-marked while still
 * returning the row — the exact "looks alive" shape this task exists to retire, reintroduced from
 * the other side.
 */
import { describe, expect, it } from "vitest";

import {
  deriveTaskLifecycle,
  readTaskLifecycle,
  withTaskLifecycle,
  withTaskLifecycleAll,
  TASK_LIFECYCLE_FIELD,
} from "../task-store/lifecycle-projection.js";
import { BOARD_FEED_DROPPED_COLUMNS } from "../postgres/board-feed.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";
import type { Task } from "../types.js";

/** The smallest row that satisfies the Task shape for derivation purposes. */
function row(overrides: Partial<Task> & { id?: string } = {}): Task {
  const now = "2026-11-13T00:00:00.000Z";
  return {
    id: overrides.id ?? "RUFU-5830",
    title: overrides.title ?? "lifecycle probe",
    description: overrides.description ?? "lifecycle probe",
    column: overrides.column ?? "todo",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    ...overrides,
  } as Task;
}

describe("deriveTaskLifecycle", () => {
  it("answers live for a plain live row", () => {
    expect(deriveTaskLifecycle(row())).toBe("live");
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the precedence clause that makes the
  projection honest about the row a soft delete actually writes. `softDeleteTaskRow` stamps the
  sentinel `archived` column ALONGSIDE `deletedAt`, so a derivation that tested the lane first would
  label every real tombstone `archived` — a wrong answer for precisely the cards a forensic caller
  asked about. Both shapes must answer `deleted`.
  */
  it("lets deletedAt win over every archival fact, including the sentinel-lane shape a delete writes", () => {
    const deletedAt = "2026-11-12T10:00:00.000Z";

    expect(deriveTaskLifecycle(row({ deletedAt }))).toBe("deleted");
    // The real soft-delete shape: sentinel lane AND a deletion timestamp together.
    expect(deriveTaskLifecycle(row({ deletedAt, column: "archived" as Task["column"] }))).toBe("deleted");
    expect(deriveTaskLifecycle(row({ deletedAt, archivedAt: deletedAt }))).toBe("deleted");
  });

  it("answers archived for each admissible archival fact on its own", () => {
    expect(deriveTaskLifecycle(row({ archivedAt: "2026-11-11T10:00:00.000Z" }))).toBe("archived");
    for (const lane of ARCHIVED_SENTINEL_LANES) {
      expect(deriveTaskLifecycle(row({ column: lane as Task["column"] }))).toBe("archived");
    }
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): totality. Every falsy or empty variant
  answers `live` rather than `undefined`, because the whole point of the field is that a consumer can
  read it and never have to interpret an absence. An empty-string timestamp is not evidence of
  anything, so it must not manufacture an `archived` label either.
  */
  it("is total: no input shape answers nothing, and no falsy value invents archival evidence", () => {
    const empties = [
      row(),
      row({ deletedAt: undefined, archivedAt: undefined }),
      row({ deletedAt: "", archivedAt: "" }),
      row({ column: "" as Task["column"] }),
      // A row carrying only an unrelated field still answers.
      row({ status: "failed" as Task["status"] }),
    ];
    for (const input of empties) {
      const derived = deriveTaskLifecycle(input);
      expect(derived).toBeTruthy();
      expect(["live", "deleted", "archived"]).toContain(derived);
    }
    expect(deriveTaskLifecycle(row({ deletedAt: "", archivedAt: "" }))).toBe("live");
  });
});

describe("withTaskLifecycle", () => {
  it("stamps the field on every row without mutating the caller's row", () => {
    const live = row({ id: "RUFU-5831" });
    const doomed = row({ id: "RUFU-5832", deletedAt: "2026-11-12T10:00:00.000Z" });

    const stampedLive = withTaskLifecycle(live);
    const stampedDoomed = withTaskLifecycle(doomed);

    expect(stampedLive[TASK_LIFECYCLE_FIELD]).toBe("live");
    expect(stampedDoomed[TASK_LIFECYCLE_FIELD]).toBe("deleted");
    // The store hands out memoized/frozen snapshots on some paths (RUFU-201), so a stamp that wrote
    // in place would either corrupt a shared snapshot or throw. Copies are the contract.
    expect(live).not.toHaveProperty(TASK_LIFECYCLE_FIELD);
    expect(doomed).not.toHaveProperty(TASK_LIFECYCLE_FIELD);
  });

  it("survives an additive enrichment spread, which is what the routes do after the stamp", () => {
    // `branchProgress` / `plannerOverseerState` / `awaitingPlanning` all rebuild `{...task, ...}`.
    // A stamped key must survive that, or the route's own enrichment would un-mark the row.
    const stamped = withTaskLifecycle(row({ id: "RUFU-5833", deletedAt: "2026-11-12T10:00:00.000Z" }));
    const enriched = { ...stamped, branchProgress: [{ name: "fusion/rufu-583" }] };
    expect(readTaskLifecycle(enriched)).toBe("deleted");
  });

  it("stamps every row of a list projection, preserving order", () => {
    const rows = [
      row({ id: "RUFU-5834" }),
      row({ id: "RUFU-5835", deletedAt: "2026-11-12T10:00:00.000Z" }),
      row({ id: "RUFU-5836", archivedAt: "2026-11-11T10:00:00.000Z" }),
    ];
    const stamped = withTaskLifecycleAll(rows);
    expect(stamped.map((t) => t.id)).toEqual(["RUFU-5834", "RUFU-5835", "RUFU-5836"]);
    expect(stamped.map((t) => t[TASK_LIFECYCLE_FIELD])).toEqual(["live", "deleted", "archived"]);
    // EVERY row is stamped, not just the interesting ones: the contract is that no row is silent.
    expect(stamped.every((t) => readTaskLifecycle(t) !== undefined)).toBe(true);
  });

  it("reads back undefined for a payload that never passed through the projection", () => {
    // A pre-contract payload must not default to `live`; distinguishing the two is the whole point.
    expect(readTaskLifecycle({ id: "RUFU-5837" })).toBeUndefined();
    expect(readTaskLifecycle(undefined)).toBeUndefined();
    expect(readTaskLifecycle(null)).toBeUndefined();
    expect(readTaskLifecycle({ lifecycle: "nonsense" })).toBeUndefined();
  });
});

/*
FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the structural ratchet.
`BOARD_FEED_DROPPED_COLUMNS` narrows the board SELECT list (RUFU-902); membership is derived from
what `compactBoardFeedRow` discards. If `deleted_at` were ever added there, a board-shaped forensic
read would keep returning the tombstone while no longer carrying the timestamp that marks it — a
silent regression back to "deleted cards look alive", invisible to every route test because the row
would still be present. This asserts the code construct, not a comment.
*/
describe("board-feed projection cannot un-mark a tombstone", () => {
  it("never drops the deletion timestamp column from the board SELECT list", () => {
    expect(BOARD_FEED_DROPPED_COLUMNS).not.toContain("deleted_at");
    expect(BOARD_FEED_DROPPED_COLUMNS).not.toContain("deletedAt");
    // And the set stays the small, derived-from-compaction set it is today: naming a new column is a
    // deliberate act, and this list is where a reviewer should see it.
    expect([...BOARD_FEED_DROPPED_COLUMNS].sort()).toEqual([
      "comments",
      "recommendations",
      "steeringComments",
      "stepReports",
      "summary",
    ]);
  });
});
