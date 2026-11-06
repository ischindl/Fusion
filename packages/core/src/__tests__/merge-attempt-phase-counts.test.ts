import { describe, expect, it } from "vitest";

import { getMergeAttemptPhaseCounts } from "../task-store/async/async-audit.js";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/**
 * FNXC:ReliabilityAggregate 2026-11-06-15:18 (RUFU-871):
 * `getMergeAttemptPhaseCounts` exists because the Reliability headline used to hydrate up to 50,000 complete
 * run-audit rows — each carrying its `metadata` jsonb — into the dashboard process on every poll. That read is
 * the retained string mass the heap census named (233k `action`/`timestamp`/`source` field groups while zero
 * lanes executed). These tests pin what makes the replacement a fix rather than a rewrite: the grouping and the
 * `merge-attempt-` filter are handed to PostgreSQL, the projection carries no `metadata` payload, and the rows
 * that come back are used verbatim instead of being re-folded in JavaScript.
 */

interface Built {
  selectProjection?: unknown;
  whereCalled: boolean;
  groupByCalled: boolean;
  groupedBy?: unknown;
}

function fakeDb(rows: Array<{ taskId: string | null; phaseCount: number | string }>, built: Built) {
  const chain: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    if (name === "select") built.selectProjection = args[0];
    if (name === "where") built.whereCalled = true;
    if (name === "groupBy") {
      built.groupByCalled = true;
      built.groupedBy = args[0];
    }
    return chain;
  };
  for (const name of ["select", "from", "where", "groupBy"]) chain[name] = record(name);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain as unknown as AsyncDataLayer["db"];
}

const window = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-06T00:00:00.000Z" };

describe("getMergeAttemptPhaseCounts", () => {
  it("hands PostgreSQL the grouping and projects no metadata payload", async () => {
    const built: Built = { whereCalled: false, groupByCalled: false };
    const db = fakeDb([{ taskId: "RUFU-1", phaseCount: "3" }], built);

    const counts = await getMergeAttemptPhaseCounts(db, window, "proj_x");

    expect(built.whereCalled).toBe(true);
    expect(built.groupByCalled).toBe(true);
    expect(built.groupedBy).toBe(schema.project.runAuditEvents.taskId);
    // Two projected fields, neither of them `metadata`: the aggregate returns a count, never the fat jsonb.
    expect(Object.keys(built.selectProjection as Record<string, unknown>)).toEqual(["taskId", "phaseCount"]);
    expect(counts).toEqual([{ taskId: "RUFU-1", phaseCount: 3 }]);
  });

  it("trusts the database's rows, coerces the driver's text count, and drops rows without a task id", async () => {
    const built: Built = { whereCalled: false, groupByCalled: false };
    const db = fakeDb(
      [
        { taskId: "RUFU-2", phaseCount: 1 },
        // A zero count is a legitimate aggregate result. Re-filtering it in JS would mean the caller, not the
        // database, still applies the phase rule — which is the shape of the leak this function removes.
        { taskId: "RUFU-3", phaseCount: 0 },
        { taskId: null, phaseCount: 7 },
        { taskId: "", phaseCount: 9 },
      ],
      built,
    );

    expect(await getMergeAttemptPhaseCounts(db, window)).toEqual([
      { taskId: "RUFU-2", phaseCount: 1 },
      { taskId: "RUFU-3", phaseCount: 0 },
    ]);
  });
});
