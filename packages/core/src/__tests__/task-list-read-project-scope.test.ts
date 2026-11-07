/*
FNXC:TaskListReadProjectScope 2026-11-07-01:34 (RUFU-871):
`project.tasks` is ONE table shared by every project and partitioned by `project_id`;
task identity is project-local, so the same id exists in several partitions. A store
bound to project A therefore must never hydrate project B's rows: every measured
board/engine read that omitted the predicate materialized foreign cards (and their
payload strings) in a process that serves one project.

This file holds the two halves of the fix's contract, both without a database:

  1. THE BINDING REACHES THE SQL. A fake query surface records the WHERE operand each
     list read actually builds, and `PgDialect.sqlToQuery` renders it. A bound layer
     must put `"project"."tasks"."project_id"` and the bound id into the statement; an
     unbound layer must add nothing, which is the documented project-agnostic
     (analytics / migration) behaviour and not an accident of these tests.
  2. THE PREDICATE IS A PROPERTY OF THE QUERY, NOT OF THE CALLER. A source ratchet
     fails when a new task-table LIST scan (a tasks-table read with no `tasks.id`
     equality) is added without naming the project partition. The two task-id
     allocator scans are allowlisted because id-sequence advancement must see every
     project's ids — see the reason recorded beside each entry.
*/
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { AsyncDataLayer } from "../postgres/data-layer.js";
import {
  countLiveTasks,
  readLiveTaskRows,
} from "../task-store/async/async-persistence.js";
import {
  clearTransitionPendingAsync,
  listTransitionPendingTaskIdsAsync,
  readTransitionPendingAsync,
  writeTransitionPendingAsync,
} from "../task-store/async/async-transition-pending.js";
import { makeTransitionPending } from "../tasks/transition-types.js";
import { countActiveInCapacitySlotAsyncImpl } from "../task-store/project-store-ops.js";
import { listStrandedRefinementsImpl } from "../task-store/project-store-ops.js";
import type { TaskStore } from "../store.js";

const BOUND_PROJECT_ID = "scope-proj-A";

/** One rendered statement: the SQL text the driver would receive, plus its params. */
interface Rendered {
  sql: string;
  params: unknown[];
}

/**
 * Awaiting-safe recording clone of the Drizzle query surface. Every builder method
 * returns the same object; `where(...)` operands are kept so they can be rendered
 * after the call, and awaiting the surface resolves to an empty row set.
 */
function createQueryRecorder() {
  const whereOperands: unknown[] = [];
  const joinOperands: unknown[] = [];
  const surface: Record<string, unknown> = {
    select: () => surface,
    from: () => surface,
    update: () => surface,
    set: () => surface,
    innerJoin: (_table: unknown, on: unknown) => {
      joinOperands.push(on);
      return surface;
    },
    leftJoin: (_table: unknown, on: unknown) => {
      joinOperands.push(on);
      return surface;
    },
    where: (condition: unknown) => {
      whereOperands.push(condition);
      return surface;
    },
    orderBy: () => surface,
    limit: () => surface,
    offset: () => surface,
    $dynamic: () => surface,
    then: (resolveRows: (rows: never[]) => void) => resolveRows([]),
  };
  const render = (operands: unknown[]): Rendered => {
    const dialect = new PgDialect();
    const queries = operands
      .filter((operand): operand is SQL => operand instanceof SQL)
      .map((operand) => dialect.sqlToQuery(operand));
    return {
      sql: queries.map((query) => query.sql).join(" "),
      params: queries.flatMap((query) => [...query.params]),
    };
  };
  return {
    surface,
    where: () => render(whereOperands),
    joins: () => render(joinOperands),
  };
}

/** A layer whose only behaviour is recording; `projectId` is the value under test. */
function fakeLayer(projectId: string | undefined) {
  const recorder = createQueryRecorder();
  const layer = { projectId, db: recorder.surface } as unknown as AsyncDataLayer;
  return { layer, recorder };
}

/** A store whose only behaviour is exposing the bound layer (plus the two row mappers). */
function fakeStore(projectId: string | undefined) {
  const recorder = createQueryRecorder();
  const layer = { projectId, db: recorder.surface } as unknown as AsyncDataLayer;
  const store = {
    asyncLayer: layer,
    pgRowToTaskRow: (row: Record<string, unknown>) => row,
    rowToTask: (row: Record<string, unknown>) => row,
  } as unknown as TaskStore;
  return { store, recorder };
}

describe("task list reads carry the store's project binding", () => {
  it("every scoped task read puts the bound project_id into its SQL", async () => {
    const cases: Array<{ name: string; run: () => Promise<void>; recorder: ReturnType<typeof createQueryRecorder> }> = [];

    const liveRows = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "readLiveTaskRows",
      recorder: liveRows.recorder,
      run: () => readLiveTaskRows(liveRows.layer, {}),
    });

    const liveRowsFiltered = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "readLiveTaskRows(column)",
      recorder: liveRowsFiltered.recorder,
      run: () => readLiveTaskRows(liveRowsFiltered.layer, { column: "todo", excludeLog: true, fields: [] }),
    });

    const counted = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "countLiveTasks",
      recorder: counted.recorder,
      run: () => countLiveTasks(counted.layer, {}),
    });

    const stranded = fakeStore(BOUND_PROJECT_ID);
    cases.push({
      name: "listStrandedRefinements",
      recorder: stranded.recorder,
      run: () => listStrandedRefinementsImpl(stranded.store, {}),
    });

    const capacity = fakeStore(BOUND_PROJECT_ID);
    cases.push({
      name: "countActiveInCapacitySlotAsync",
      recorder: capacity.recorder,
      run: async () => {
        await countActiveInCapacitySlotAsyncImpl(capacity.store, {
          tx: capacity.recorder.surface as never,
          targetColumn: "in-progress",
          workflowId: "__default-workflow__",
          countPending: true,
          excludeTaskId: "FN-EXCLUDED",
        });
      },
    });

    const markerList = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "listTransitionPendingTaskIdsAsync",
      recorder: markerList.recorder,
      run: () => listTransitionPendingTaskIdsAsync(markerList.recorder.surface as never, BOUND_PROJECT_ID),
    });

    const markerRead = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "readTransitionPendingAsync",
      recorder: markerRead.recorder,
      run: () => readTransitionPendingAsync(markerRead.recorder.surface as never, "FN-1", BOUND_PROJECT_ID),
    });

    const markerWrite = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "writeTransitionPendingAsync",
      recorder: markerWrite.recorder,
      run: () => writeTransitionPendingAsync(
        markerWrite.recorder.surface as never,
        "FN-1",
        makeTransitionPending("in-progress", ["default-workflow:postCommit"], Date.now()),
        BOUND_PROJECT_ID,
      ),
    });

    const markerClear = fakeLayer(BOUND_PROJECT_ID);
    cases.push({
      name: "clearTransitionPendingAsync",
      recorder: markerClear.recorder,
      run: () => clearTransitionPendingAsync(markerClear.recorder.surface as never, "FN-1", BOUND_PROJECT_ID),
    });

    for (const testCase of cases) {
      await testCase.run();
      const rendered = testCase.recorder.where();
      expect(rendered.sql, `${testCase.name} must name the project partition`).toContain(
        '"project"."tasks"."project_id"',
      );
      expect(rendered.params, `${testCase.name} must bind the store's project id`).toContain(
        BOUND_PROJECT_ID,
      );
    }
  });

  it("the capacity join is correlated on project_id as well as task_id", async () => {
    const capacity = fakeStore(BOUND_PROJECT_ID);
    await countActiveInCapacitySlotAsyncImpl(capacity.store, {
      tx: capacity.recorder.surface as never,
      targetColumn: "in-progress",
      workflowId: "__default-workflow__",
      countPending: true,
      excludeTaskId: "FN-EXCLUDED",
    });
    const rendered = capacity.recorder.joins();
    expect(rendered.sql).toContain('"task_workflow_selection"."project_id"');
    expect(rendered.sql).toContain('"tasks"."project_id"');
  });

  it("an unbound layer keeps the project-agnostic read: no project predicate at all", async () => {
    const unboundRows = fakeLayer(undefined);
    await readLiveTaskRows(unboundRows.layer, {});
    expect(unboundRows.recorder.where().sql).not.toContain("project_id");

    const unboundCount = fakeLayer(undefined);
    await countLiveTasks(unboundCount.layer, {});
    expect(unboundCount.recorder.where().sql).not.toContain("project_id");

    const unboundStranded = fakeStore(undefined);
    await listStrandedRefinementsImpl(unboundStranded.store, {});
    expect(unboundStranded.recorder.where().sql).not.toContain("project_id");

    const unboundCapacity = fakeStore(undefined);
    await countActiveInCapacitySlotAsyncImpl(unboundCapacity.store, {
      tx: unboundCapacity.recorder.surface as never,
      targetColumn: "in-progress",
      workflowId: "__default-workflow__",
      countPending: true,
      excludeTaskId: "FN-EXCLUDED",
    });
    expect(unboundCapacity.recorder.where().sql).not.toContain("project_id");

    const unboundMarkers = fakeLayer(undefined);
    await listTransitionPendingTaskIdsAsync(unboundMarkers.recorder.surface as never, undefined);
    expect(unboundMarkers.recorder.where().sql).not.toContain("project_id");
  });
});

/*
FNXC:TaskListReadProjectScope 2026-11-07-01:34 (RUFU-871):
The ratchet half. It reads source structure, not comments (comments are stripped first),
and classifies each `.from(schema.project.tasks)` site inside the function that owns it:
a site is a LIST scan unless the same query path also constrains `tasks.id` with `eq(...)`
— a by-id lookup is a different (later) slice's subject. A list scan passes only when its
own function builds a project predicate.
*/
describe("task-table list scans are registered project-scoped", () => {
  const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
  const SCAN_ROOTS = ["packages/core/src/task-store", "packages/core/src/async-stores"];

  /** Task-table read sites that intentionally read across projects, with the reason. */
  const UNSCOPED_LIST_SCAN_ALLOWLIST: Record<string, string> = {
    // Task-id allocation advances a shared sequence: it must observe every project's ids or
    // it mints an id a sibling project already owns. See the FNXC:ProjectTaskIdentity note
    // above `getMaxTaskSequenceFromTable`.
    "packages/core/src/task-store/async/async-allocator.ts:getMaxTaskSequenceFromTable":
      "task-id sequence advancement is cross-project by design",
    // Same rule for prefix discovery: a prefix only another project uses must stay reserved.
    "packages/core/src/task-store/async/async-allocator.ts:getKnownPrefixes":
      "task-id prefix reservation is cross-project by design",
  };

  /*
   * Shared task-read predicate builders. A read site may compose its WHERE through one of
   * these instead of spelling the predicate inline; that is still the query carrying the
   * partition, provided the builder itself keeps it. `registeredBuildersStillScope` below
   * is what makes that proviso enforced rather than assumed.
   */
  const SHARED_SCOPED_TASK_PREDICATE_BUILDERS = [
    // Search paths (full-text and LIKE) — `liveSearchPredicate` folds in `tasks.project_id`.
    "liveSearchPredicate",
    // Live-lineage scans — `liveLineageChildFilter` opens with the project partition.
    "liveLineageChildFilter",
  ] as const;

  const LIST_SCAN = /\.from\(schema\.project\.tasks\)/g;
  /*
  FNXC:TaskListReadProjectScope 2026-11-07-03:55 (RUFU-871 slice 2):
  The watched list-read accessor counts as naming the partition because it IS
  `taskProjectScope` behind the watcher. Widening the accepted spelling adds no leniency: the
  operand still has to come from somewhere, and the watcher (`noteTaskListProjectScope`) is
  deliberately NOT accepted here because it records a read without building a predicate.
  */
  const PROJECT_PREDICATE = /tasks\.projectId\b|taskProjectScope\s*\(|taskListProjectScope\s*\(|projectOwnershipPartition\s*\(|projectPartition\s*\(/;
  const BY_ID_EQUALITY = /eq\(\s*schema\.project\.tasks\.id\b/;
  const FUNCTION_HEADER = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
        sourceFiles(full, acc);
      } else if (/\.ts$/.test(entry) && !entry.endsWith(".d.ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  function executableSource(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  /** The `[functionName, functionSource]` pair owning `index`, by nearest top-level header. */
  function enclosingFunction(source: string, index: number): [string, string] {
    let name = "(module)";
    let start = 0;
    for (const match of source.matchAll(FUNCTION_HEADER)) {
      if ((match.index ?? 0) > index) break;
      name = match[1]!;
      start = match.index ?? 0;
    }
    const nextHeader = source.slice(start + 1).search(/^(?:export\s+)?(?:async\s+)?function\s+\w+/m);
    const end = nextHeader === -1 ? source.length : start + 1 + nextHeader;
    return [name, source.slice(start, end)];
  }

  it("each list scan names the project partition or registers a reason", () => {
    const violations: string[] = [];
    let reviewedListScanCount = 0;

    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(resolve(REPO_ROOT, root))) {
        const source = executableSource(readFileSync(file, "utf8"));
        const relativeFile = relative(REPO_ROOT, file).replace(/\\/g, "/");
        for (const match of source.matchAll(LIST_SCAN)) {
          const index = match.index ?? 0;
          const [fnName, fnSource] = enclosingFunction(source, index);
          if (BY_ID_EQUALITY.test(fnSource)) continue;
          reviewedListScanCount += 1;
          if (PROJECT_PREDICATE.test(fnSource)) continue;
          if (SHARED_SCOPED_TASK_PREDICATE_BUILDERS.some((builder) => new RegExp(`${builder}\\s*\\(`).test(fnSource))) continue;
          const key = `${relativeFile}:${fnName}`;
          if (UNSCOPED_LIST_SCAN_ALLOWLIST[key]) continue;
          violations.push(key);
        }
      }
    }

    expect(violations, `task-table list reads without a project predicate: ${violations.join(", ")}`).toEqual([]);
    // Guard the guard: the ratchet must actually be examining sites.
    expect(reviewedListScanCount).toBeGreaterThan(10);
  });

  it("each registered shared predicate builder still carries the partition", () => {
    for (const builder of SHARED_SCOPED_TASK_PREDICATE_BUILDERS) {
      const definition = new RegExp(`^(?:export\\s+)?function\\s+${builder}\\b[\\s\\S]*?\\n}`, "m");
      let found = false;
      for (const root of SCAN_ROOTS) {
        for (const file of sourceFiles(resolve(REPO_ROOT, root))) {
          const source = executableSource(readFileSync(file, "utf8"));
          const match = source.match(definition);
          if (!match) continue;
          found = true;
          expect(
            PROJECT_PREDICATE.test(match[0]),
            `${builder} no longer builds a task project predicate, so its callers are unscoped`,
          ).toBe(true);
        }
      }
      expect(found, `predicate builder ${builder} is no longer present in the scanned sources`).toBe(true);
    }
  });

  it("the allowlist only registers sites that still exist", () => {
    const seen = new Set<string>();
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(resolve(REPO_ROOT, root))) {
        const source = executableSource(readFileSync(file, "utf8"));
        const relativeFile = relative(REPO_ROOT, file).replace(/\\/g, "/");
        for (const match of source.matchAll(LIST_SCAN)) {
          const [fnName] = enclosingFunction(source, match.index ?? 0);
          seen.add(`${relativeFile}:${fnName}`);
        }
      }
    }
    const stale = Object.keys(UNSCOPED_LIST_SCAN_ALLOWLIST).filter((key) => !seen.has(key));
    expect(stale, `allowlist entries no longer match a task-table read site: ${stale.join(", ")}`).toEqual([]);
  });
});
