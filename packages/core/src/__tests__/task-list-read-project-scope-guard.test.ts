/*
FNXC:TaskListReadProjectScope 2026-11-07-05:20 (RUFU-871 slice 2, staged):
Slice 1 made `project_id` a property of every task-table LIST query. Slice 2 makes the illegal
shape — a shared-PostgreSQL layer with no bound project performing a LIST read — VISIBLE. It is
recorded, not refused, and that staging is part of the contract: the violating call-site set is
not yet enumerated (slice 1 fixed three reads by hand), the PostgreSQL suite's own harness is a
legitimate own-database reader this environment cannot run, and a throw with an unmeasurable
blast radius on a watchdog-killed process is a new outage class rather than a diagnostic.
`TASK_LIST_READ_SCOPE_ENFORCEMENT` is the single flip point.

Four things are pinned here, all database-free:

  1. shared-PostgreSQL + unbound → one violation row AND the read still returns its results
     (the guard may never become a lifecycle dependency);
  2. one row per read SITE per window — never per call and never per row;
  3. a layer without a backend descriptor (legacy SQLite / own-database) and a BOUND shared
     layer both emit nothing: the regression guard against the naive version that reported
     every unbound read, including the legal ones;
  4. a structural ratchet so the watch call, the flip seam, and `taskProjectScope`'s legal
     no-op cannot be quietly edited away.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AsyncDataLayer } from "../postgres/data-layer.js";
import type { ResolvedBackend } from "../postgres/backend-resolver.js";
import {
  TASK_LIST_READ_SCOPE_ENFORCEMENT,
  UNBOUND_TASK_LIST_READ_MUTATION,
  resetTaskListScopeNoticesForTests,
} from "../postgres/task-list-read-scope.js";
import {
  countLiveTasks,
  readCompletedTaskPage,
  readLiveTaskRows,
  readTaskRowsBySourceLineage,
} from "../task-store/async/async-persistence.js";
import {
  countActiveInCapacitySlotAsyncImpl,
  listStrandedRefinementsImpl,
} from "../task-store/project-store-ops.js";
import { recoverStaleTransitionPendingImpl } from "../task-store/lifecycle-ops.js";
import type { TaskStore } from "../store.js";

/** A PostgreSQL boot descriptor — its PRESENCE is what marks a layer as shared-PostgreSQL. */
const SHARED_PG_BACKEND: ResolvedBackend = {
  mode: "external",
  runtimeUrl: "postgresql://user@localhost:5432/fusion",
  migrationUrl: null,
  migrationUrlOverridden: false,
};

const BOUND_PROJECT_ID = "guard-proj-A";

/** One shaped run-audit row as the sink received it. */
interface EmittedRow {
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Awaiting-safe recording clone of the Drizzle query surface. Two counters matter:
 * `executed()` proves the guarded read still reached the database (a guard that refuses has
 * changed behavior, which slice 2 explicitly does not do), and `auditRows` is the observable
 * half of the emit — `recordRunAuditEvent` writes through `transactionImmediate(tx =>
 * tx.insert(runAuditEvents).values(row))`, and that call lands synchronously inside the
 * bounded seam's pre-await sink invocation, so no polling is needed to assert it.
 */
function createQueryRecorder() {
  const auditRows: EmittedRow[] = [];
  let queries = 0;
  const surface: Record<string, unknown> = {
    select: () => surface,
    from: () => surface,
    update: () => surface,
    set: () => surface,
    innerJoin: () => surface,
    leftJoin: () => surface,
    where: () => surface,
    orderBy: () => surface,
    groupBy: () => surface,
    limit: () => surface,
    offset: () => surface,
    $dynamic: () => surface,
    insert: () => ({
      values: (row: EmittedRow | EmittedRow[]) => {
        for (const entry of Array.isArray(row) ? row : [row]) auditRows.push(entry);
        return Promise.resolve();
      },
    }),
    then: (resolveRows: (rows: never[]) => void) => {
      queries += 1;
      resolveRows([]);
    },
  };
  return {
    surface,
    auditRows,
    executed: () => queries,
  };
}

interface LayerOptions {
  /** The value under test. Blank/undefined is the unbound case. */
  projectId: string | undefined;
  /** Present → the shared-PostgreSQL backend; absent → legacy SQLite / own-database. */
  sharedPostgres: boolean;
}

function buildLayer(options: LayerOptions, recorder: ReturnType<typeof createQueryRecorder>) {
  return {
    projectId: options.projectId,
    db: recorder.surface,
    ...(options.sharedPostgres ? { backend: SHARED_PG_BACKEND } : {}),
    // `readCompletedTaskPage` runs page + counts in one transaction; the audit row takes the
    // `transactionImmediate` route. Both hand back the same recording surface.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(recorder.surface),
    transactionImmediate: async (fn: (tx: unknown) => Promise<unknown>) => fn(recorder.surface),
  } as unknown as AsyncDataLayer;
}

function fakeLayer(options: LayerOptions) {
  const recorder = createQueryRecorder();
  return { layer: buildLayer(options, recorder), recorder };
}

/** A store view over the same fake: `asyncLayer: null` is the legacy SQLite backend. */
function fakeStore(options: LayerOptions & { asyncLayerPresent?: boolean }) {
  const recorder = createQueryRecorder();
  const asyncLayerPresent = options.asyncLayerPresent ?? true;
  const store = {
    asyncLayer: asyncLayerPresent ? buildLayer(options, recorder) : null,
    backendMode: asyncLayerPresent,
    db: { prepare: () => ({ all: () => [] }) },
    pgRowToTaskRow: (row: Record<string, unknown>) => row,
    rowToTask: (row: Record<string, unknown>) => row,
  } as unknown as TaskStore;
  return { store, recorder };
}

/** One list read, expressed so every half of the contract can drive it identically. */
interface ListReadCase {
  name: string;
  reader: string;
  run: (input: { layer: AsyncDataLayer; store: TaskStore; surface: unknown }) => Promise<unknown>;
}

const LIST_READS: ListReadCase[] = [
  { name: "readLiveTaskRows", reader: "readLiveTaskRows", run: ({ layer }) => readLiveTaskRows(layer, {}) },
  { name: "countLiveTasks", reader: "countLiveTasks", run: ({ layer }) => countLiveTasks(layer, {}) },
  {
    name: "readCompletedTaskPage",
    reader: "readCompletedTaskPage",
    run: ({ layer }) =>
      readCompletedTaskPage(layer, { columns: ["done"], limit: 20, defaultWorkflowId: "builtin:coding" }),
  },
  {
    name: "readTaskRowsBySourceLineage",
    reader: "readTaskRowsBySourceLineage",
    run: ({ layer }) => readTaskRowsBySourceLineage(layer, { sourceParentTaskId: "FN-1" }),
  },
  {
    name: "listStrandedRefinements",
    reader: "listStrandedRefinements",
    run: ({ store }) => listStrandedRefinementsImpl(store, {}),
  },
  {
    name: "countActiveInCapacitySlotAsync",
    reader: "countActiveInCapacitySlotAsync",
    run: ({ store, surface }) =>
      countActiveInCapacitySlotAsyncImpl(store, {
        tx: surface as never,
        targetColumn: "in-progress",
        workflowId: "__default-workflow__",
        countPending: true,
        excludeTaskId: "FN-EXCLUDED",
      }),
  },
  {
    name: "listTransitionPendingTaskIds",
    reader: "listTransitionPendingTaskIds",
    run: ({ store }) => recoverStaleTransitionPendingImpl(store),
  },
];

function drive(caseItem: ListReadCase, options: LayerOptions) {
  const layer = fakeLayer(options);
  const store = fakeStore(options);
  return {
    caseItem,
    invoke: () => caseItem.run({ layer: layer.layer, store: store.store, surface: layer.recorder.surface }),
    emitted: () => [...layer.recorder.auditRows, ...store.recorder.auditRows],
    violations: () =>
      [...layer.recorder.auditRows, ...store.recorder.auditRows].filter(
        (row) => row.mutationType === UNBOUND_TASK_LIST_READ_MUTATION,
      ),
    queryCount: () => layer.recorder.executed() + store.recorder.executed(),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetTaskListScopeNoticesForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("an unbound task list read on shared PostgreSQL is recorded, not refused", () => {
  for (const caseItem of LIST_READS) {
    it(`${caseItem.name} reports the violation and still performs its read`, async () => {
      const read = drive(caseItem, { projectId: undefined, sharedPostgres: true });
      await expect(read.invoke()).resolves.not.toThrow();

      const violations = read.violations();
      expect(violations, `${caseItem.name} must record one violation row`).toHaveLength(1);
      const [row] = violations;
      expect(row!.metadata?.reader).toBe(caseItem.reader);
      expect(row!.metadata?.backendMode).toBe("external");
      expect(row!.metadata?.enforcement).toBe(TASK_LIST_READ_SCOPE_ENFORCEMENT);
      expect(row!.target).toBe("unscoped");

      // The read itself is untouched: recording may not become a lifecycle dependency.
      expect(read.queryCount(), `${caseItem.name} must still reach the database`).toBeGreaterThan(0);

      // And the remedy reaches an operator who never queries the audit store.
      const notice = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(notice).toContain("createTaskStoreForBackend({ rootDir, projectId })");
      expect(notice).toContain(caseItem.reader);
    });
  }

  it("a blank project id counts as unbound", async () => {
    const read = drive(LIST_READS[0]!, { projectId: "   ", sharedPostgres: true });
    await read.invoke();
    expect(read.violations()).toHaveLength(1);
  });

  it("one row per read site, not per call and not per row", async () => {
    // One layer, one read site, three successive reads: the 15-minute window is the bound, so
    // a hot board path stays one row instead of one row per poll (RUFU-393's failure shape).
    const recorder = createQueryRecorder();
    const layer = buildLayer({ projectId: undefined, sharedPostgres: true }, recorder);
    await readLiveTaskRows(layer, {});
    await readLiveTaskRows(layer, {});
    await readLiveTaskRows(layer, {});
    const violations = recorder.auditRows.filter((row) => row.mutationType === UNBOUND_TASK_LIST_READ_MUTATION);
    expect(violations).toHaveLength(1);
    expect(recorder.executed()).toBe(3);

    // A different site is a different bindable call, so it gets its own row.
    const second = drive(LIST_READS[1]!, { projectId: undefined, sharedPostgres: true });
    await second.invoke();
    expect(second.violations()).toHaveLength(1);
  });

  it("the row carries no row content, only the site and its enums", async () => {
    const read = drive(LIST_READS[0]!, { projectId: undefined, sharedPostgres: true });
    await read.invoke();
    const [row] = read.violations();
    // The defect is that this read pulls other projects' content; the diagnostic may not copy it.
    expect(Object.keys(row!.metadata ?? {}).sort()).toEqual(["backendMode", "enforcement", "reader"]);
    expect(row!.agentId).toBe("task-list-read-scope");
    expect(row!.runId).toBe(`task-list-read-scope:${LIST_READS[0]!.reader}`);
  });
});

describe("a read that is legal records nothing", () => {
  for (const caseItem of LIST_READS) {
    it(`${caseItem.name} on a backend that is not the shared task table stays silent and unfiltered`, async () => {
      // No `backend` descriptor: the legacy SQLite / own-database reader `taskProjectScope`
      // documents as a legitimate cross-project consumer.
      const read = drive(caseItem, { projectId: undefined, sharedPostgres: false });
      await expect(read.invoke()).resolves.not.toThrow();
      expect(read.queryCount(), `${caseItem.name} must actually perform its read`).toBeGreaterThan(0);
      expect(read.violations(), `${caseItem.name} must not report a legal unbound read`).toHaveLength(0);
      expect(warn.mock.calls).toHaveLength(0);
    });
  }

  for (const caseItem of LIST_READS) {
    it(`${caseItem.name} on a bound shared layer stays silent`, async () => {
      const read = drive(caseItem, { projectId: BOUND_PROJECT_ID, sharedPostgres: true });
      await expect(read.invoke()).resolves.not.toThrow();
      expect(read.queryCount(), `${caseItem.name} must still reach the database`).toBeGreaterThan(0);
      expect(read.violations()).toHaveLength(0);
      expect(warn.mock.calls).toHaveLength(0);
    });
  }

  it("the SQLite marker sweep needs no project id and reports nothing", async () => {
    const store = fakeStore({ projectId: undefined, sharedPostgres: false, asyncLayerPresent: false });
    await expect(recoverStaleTransitionPendingImpl(store.store)).resolves.toEqual({
      scanned: 0,
      recovered: 0,
      degradedHooks: 0,
    });
    expect(store.recorder.auditRows).toHaveLength(0);
  });
});

/*
FNXC:TaskListReadProjectScope 2026-11-07-05:20 (RUFU-871 slice 2, staged):
The structural half. It reads function bodies (comments stripped first, so it never asserts that
a comment exists) and protects the three things a later refactor could lose: the watch call on
each registered list read, the single flip point, and the no-op the LEGAL readers depend on.
*/
describe("the guard cannot be quietly removed", () => {
  const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
  const SCOPE_MODULE = "packages/core/src/postgres/task-list-read-scope.ts";

  function executableSource(file: string): string {
    return readFileSync(resolve(REPO_ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  /** The body of a top-level function, located by its header line. */
  function functionBody(file: string, name: string): string {
    const source = executableSource(file);
    const header = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, "m");
    const match = header.exec(source);
    expect(match, `${name} is no longer a top-level function in ${file}`).not.toBeNull();
    const next = source.slice((match?.index ?? 0) + 1).search(/^(?:export\s+)?(?:async\s+)?function\s+\w+/m);
    const end = next === -1 ? source.length : (match?.index ?? 0) + 1 + next;
    return source.slice(match?.index ?? 0, end);
  }

  it("every registered task list read still watches itself", () => {
    const registered: Array<{ file: string; fn: string }> = [
      { file: "packages/core/src/task-store/async/async-persistence.ts", fn: "readLiveTaskRows" },
      { file: "packages/core/src/task-store/async/async-persistence.ts", fn: "countLiveTasks" },
      { file: "packages/core/src/task-store/async/async-persistence.ts", fn: "readCompletedTaskPage" },
      { file: "packages/core/src/task-store/async/async-persistence.ts", fn: "readTaskRowsBySourceLineage" },
      { file: "packages/core/src/task-store/project-store-ops.ts", fn: "listStrandedRefinementsImpl" },
      { file: "packages/core/src/task-store/project-store-ops.ts", fn: "countActiveInCapacitySlotAsyncImpl" },
      { file: "packages/core/src/task-store/lifecycle-ops.ts", fn: "recoverStaleTransitionPendingImpl" },
    ];
    for (const { file, fn } of registered) {
      expect(
        /\b(?:taskListProjectScope|noteTaskListProjectScope)\s*\(/.test(functionBody(file, fn)),
        `${fn} no longer watches its list read, so an unbound shared-PostgreSQL layer goes unreported again`,
      ).toBe(true);
    }
  });

  it("the flip point is one named constant at record-only", () => {
    expect(TASK_LIST_READ_SCOPE_ENFORCEMENT).toBe("record-only");
    const source = executableSource(SCOPE_MODULE);
    // One enforcement decision, read once, in the emitter — not one branch per call site.
    expect(source.match(/\bTASK_LIST_READ_SCOPE_ENFORCEMENT\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(functionBody(SCOPE_MODULE, "noteTaskListProjectScope")).toContain("emitBoundedRunAudit");
  });

  it("taskProjectScope itself stays a no-op for an unbound layer", () => {
    const body = functionBody("packages/core/src/postgres/data-layer.ts", "taskProjectScope");
    // The legal cases depend on this helper never refusing and never reporting; the watch lives
    // in the list-read accessor only.
    expect(body).not.toContain("throw");
    expect(body).toContain("undefined");
  });

  it("the discriminator reads the backend descriptor, not a new config flag", () => {
    const body = functionBody(SCOPE_MODULE, "usesSharedPostgresTaskTable");
    expect(body).toContain("backend");
    expect(body).not.toContain("process.env");
  });
});
