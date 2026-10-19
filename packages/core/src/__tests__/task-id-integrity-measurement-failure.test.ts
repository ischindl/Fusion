/**
 * RUFU-333: the SYNCHRONOUS task-ID integrity canary may never answer "clean" about a measurement
 * it did not finish, and no store surface may mint `status: "ok"` for work that never happened.
 *
 * FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
 * RUFU-301 gave the async PostgreSQL arm exactly three distinguishable outcomes — `ok`, `anomaly`, and a
 * raised `TaskIdIntegrityMeasurementError` — and pinned them with a proof test. The sync arm shipped
 * every one of the appeasements RUFU-301 rejected and could not raise at all: `detectTaskIdIntegrityAnomalies`
 * ended in `catch { return buildReport(checkedAt, []) }`; `hasTable` ended in `catch { return false }`, so a
 * FAILED presence probe read as "table absent" and every downstream reader then short-circuited to a clean
 * empty scan; and the store hardened the lie in four more places — the cache field initialized to
 * `{ status: "ok", anomalies: [] }`, `buildTaskIdIntegrityFallbackReport` returning a hard-coded ok,
 * `refreshTaskIdIntegrityReport` catching the detector's throw and caching that fallback while logging a
 * warning that it was degrading to healthy, and a merge that dropped a failure sibling and still returned ok.
 * Because `dbImpl` throws outright in backend mode, the fail-open path was the ONLY path a real deployment
 * could reach: the canary answered "zero anomalies, all prefixes consistent" from a database it had not read.
 *
 * This file pins the replacement contract across every surface that consumes the state — not just the
 * reported repro — plus the controls that keep the failure assertions non-vacuous: a consistent corpus
 * still reports ok, a corrupt corpus still reports anomaly, and a legitimately absent table is still a
 * completed measurement (the FN-5105 boundary, deliberately unchanged).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectTaskIdIntegrityAnomalies,
  TASK_ID_INTEGRITY_NOT_MEASURED,
  TaskIdIntegrityMeasurementError,
  type TaskIdIntegrityState,
} from "../tasks/task-id-integrity.js";
import { TaskIdIntegrityMeasurementError as AsyncPathMeasurementError } from "../postgres/async-task-id-integrity.js";
import { TaskIdIntegrityMeasurementError as PostgresBarrelMeasurementError } from "../postgres/index.js";
import { Database } from "../db/db.js";
import { TaskStore, coreLog } from "../store.js";
import * as rootBarrel from "../index.js";
import * as gateBarrel from "../index.gate.js";

type Row = Record<string, unknown>;

interface Corpus {
  /** Tables a SUCCESSFUL presence probe reports as existing. */
  tables?: string[];
  tasks?: Row[];
  archived?: Row[];
  state?: Row[];
  duplicates?: Row[];
  /** When the SQL matches, that read raises instead of answering — the measurement did not finish. */
  failOn?: RegExp;
}

const PRESENCE_SQL = /sqlite_master/;
const TASK_IDS_SQL = /^SELECT id FROM tasks$/;
const ARCHIVED_IDS_SQL = /^SELECT id FROM archivedTasks$/;
const DUPLICATES_SQL = /GROUP BY id HAVING COUNT\(\*\) > 1/;
const STATE_ROWS_SQL = /^SELECT prefix, nextSequence FROM distributed_task_id_state$/;
const KNOWN_PREFIXES_SQL = /^SELECT prefix FROM distributed_task_id_state$/;
const CONFIG_SQL = /FROM config WHERE id = 1/;
const NEXT_SEQUENCE_SQL = /^SELECT nextSequence FROM distributed_task_id_state WHERE prefix = \?$/;

/**
 * A read-path double for the synchronous detector and the store seam.
 *
 * Only the statements the integrity detector and `reconcileTaskIdState` actually issue are scripted; any
 * other read answers empty, which is what a real empty corpus answers. `failOn` is the knob that makes a
 * measurement incomplete, and it is the only way this fake ever raises — so a green failure assertion
 * cannot come from a broken fake.
 */
function fakeDb(corpus: Corpus = {}): any {
  const tables = new Set(corpus.tables ?? ["tasks", "archivedTasks", "distributed_task_id_state"]);
  const config: Row = { nextId: 1, settings: "{}" };

  const raiseIfConfigured = (sql: string): void => {
    if (corpus.failOn?.test(sql)) {
      throw new Error(`driver refused the statement: ${sql.split("\n")[0].slice(0, 48)}`);
    }
  };

  const answerAll = (sql: string, args: unknown[]): Row[] => {
    raiseIfConfigured(sql);
    if (PRESENCE_SQL.test(sql)) {
      const name = String(args[0] ?? "");
      return tables.has(name) ? [{ name }] : [];
    }
    if (TASK_IDS_SQL.test(sql)) return corpus.tasks ?? [];
    if (ARCHIVED_IDS_SQL.test(sql)) return corpus.archived ?? [];
    if (DUPLICATES_SQL.test(sql)) return corpus.duplicates ?? [];
    if (STATE_ROWS_SQL.test(sql)) return corpus.state ?? [];
    if (KNOWN_PREFIXES_SQL.test(sql)) return (corpus.state ?? []).map((row) => ({ prefix: row.prefix }));
    if (CONFIG_SQL.test(sql)) return [config];
    return [];
  };

  return {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => answerAll(sql, args),
        get: (...args: unknown[]) => {
          raiseIfConfigured(sql);
          if (CONFIG_SQL.test(sql)) return config;
          if (NEXT_SEQUENCE_SQL.test(sql)) return { nextSequence: 1 };
          return undefined;
        },
        run: (..._args: unknown[]) => {
          raiseIfConfigured(sql);
          return { changes: 0 };
        },
      };
    },
    transaction: (fn: () => unknown) => fn(),
    bumpLastModified: () => undefined,
  };
}

const createdDirs: string[] = [];

function freshStore(): TaskStore {
  const rootDir = mkdtempSync(join(tmpdir(), "rufu333-integrity-"));
  createdDirs.push(rootDir);
  return new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe("RUFU-333: the synchronous detector raises rather than answering ok", () => {
  it("raises when the presence probe fails, instead of treating a failed probe as an absent table", () => {
    // The widest single lie on the old path: `catch { return false }` made a broken probe read as
    // "no tables", which short-circuited every reader into a clean empty scan.
    expect(() => detectTaskIdIntegrityAnomalies(fakeDb({ failOn: PRESENCE_SQL }))).toThrow(
      TaskIdIntegrityMeasurementError,
    );
  });

  it("raises when the active-id read fails, instead of reporting 'no ids exist'", () => {
    expect(() => detectTaskIdIntegrityAnomalies(fakeDb({ failOn: TASK_IDS_SQL }))).toThrow(
      TaskIdIntegrityMeasurementError,
    );
  });

  it("raises when the archived-id read fails, instead of reporting 'no archived ids exist'", () => {
    expect(() => detectTaskIdIntegrityAnomalies(fakeDb({ failOn: ARCHIVED_IDS_SQL }))).toThrow(
      TaskIdIntegrityMeasurementError,
    );
  });

  it("raises when the duplicate GROUP BY fails, instead of inventing 'no duplicates'", () => {
    // The one answer a corruption canary must never fabricate is the absence of corruption.
    expect(() => detectTaskIdIntegrityAnomalies(fakeDb({ failOn: DUPLICATES_SQL }))).toThrow(
      TaskIdIntegrityMeasurementError,
    );
  });

  it("raises when the allocator-state read fails mid-scan, instead of returning a clean partial result", () => {
    // This is the mid-measurement case: earlier reads succeeded, so a swallow-to-empty here produced a
    // report that looked complete and had skipped the allocator comparison entirely.
    expect(() => detectTaskIdIntegrityAnomalies(fakeDb({ failOn: STATE_ROWS_SQL }))).toThrow(
      TaskIdIntegrityMeasurementError,
    );
  });

  it("carries the driver's reason as `cause`, so an operator can tell why the canary is silent", () => {
    const cause = new Error("database is locked");
    const db = {
      prepare: () => ({
        all: () => {
          throw cause;
        },
      }),
    } as any;

    const caught = (() => {
      try {
        detectTaskIdIntegrityAnomalies(db);
        return null;
      } catch (error) {
        return error as TaskIdIntegrityMeasurementError;
      }
    })();

    expect(caught).toBeInstanceOf(TaskIdIntegrityMeasurementError);
    expect(caught?.cause).toBe(cause);
    expect(caught?.message).toContain("database is locked");
  });

  it("still reports ok for a consistent corpus (control: the failure assertions are not vacuous)", () => {
    const report = detectTaskIdIntegrityAnomalies(
      fakeDb({
        tasks: [{ id: "RUFU-1" }, { id: "RUFU-2" }],
        archived: [],
        state: [{ prefix: "RUFU", nextSequence: 3 }],
      }),
    );
    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
  });

  it("still reports anomaly for a corrupt corpus (control: anomaly detection is not dead code)", () => {
    const report = detectTaskIdIntegrityAnomalies(
      fakeDb({
        tasks: [{ id: "RUFU-1" }, { id: "RUFU-1" }],
        duplicates: [{ id: "RUFU-1", duplicateCount: 2 }],
        state: [{ prefix: "RUFU", nextSequence: 2 }],
      }),
    );
    expect(report.status).toBe("anomaly");
    expect(report.anomalies.map((anomaly) => anomaly.kind)).toContain("duplicate_active_id");
  });

  it("reports ok — not a failure — when the tables are legitimately absent (FN-5105 boundary)", () => {
    // A probe that SUCCEEDS and says "absent" is a measurement that ran. Only an unfinished measurement
    // is a failure, so the empty-database case must not be laundered into the error arm.
    const report = detectTaskIdIntegrityAnomalies(fakeDb({ tables: [] }));
    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
  });

  it("raises against the production `Database` stub — the exact object a real deployment holds", () => {
    // The reported repro, run verbatim: the stub's constructor is a no-op and `prepare()` throws outright
    // (VAL-REMOVAL-005), so this is the shape every backend-mode measurement takes. Before this card it
    // RETURNED `{ status: "ok", anomalies: [] }` here; that return value was the whole defect.
    const db = new Database(":memory:");
    expect(() => detectTaskIdIntegrityAnomalies(db as any)).toThrow(TaskIdIntegrityMeasurementError);
    expect(() => detectTaskIdIntegrityAnomalies(db as any)).toThrow(/SQLite Database class body has been removed/);
  });
});

describe("RUFU-333: both arms share one error class object", () => {
  it("resolves the same class from the sync, async-module, and postgres-barrel import paths", () => {
    // Each surface catches by identity, so a second class of the same name would type-check and make
    // every `instanceof` guard on the other arm's error silently false.
    expect(AsyncPathMeasurementError).toBe(TaskIdIntegrityMeasurementError);
    expect(PostgresBarrelMeasurementError).toBe(TaskIdIntegrityMeasurementError);
  });

  it("lets an async-side catch recognize an error the sync detector raised", () => {
    // Identity is only claimed, not proven, by the `toBe` above: what a consumer actually writes is
    // `instanceof`, and that is the guard a second definition would have silently defeated.
    let raised: unknown = null;
    try {
      detectTaskIdIntegrityAnomalies(new Database(":memory:") as any);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(AsyncPathMeasurementError);
  });

  it("exports the shared vocabulary from BOTH core barrels (index + index.gate stay in sync)", () => {
    // The engine-core merge gate aliases `@fusion/core` to the gate bundle, so an index.ts-only export is
    // invisible to the suite that guards this canary.
    for (const barrel of [rootBarrel as Record<string, unknown>, gateBarrel as Record<string, unknown>]) {
      expect(barrel.TaskIdIntegrityMeasurementError).toBe(TaskIdIntegrityMeasurementError);
      expect(barrel.TASK_ID_INTEGRITY_NOT_MEASURED).toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
      expect(typeof barrel.detectTaskIdIntegrityAnomalies).toBe("function");
    }
  });

  it("keeps the not-measured sentinel frozen, because its object identity is the contract", () => {
    // One writer stamping a real checkedAt into the shared object would erase the ok / failed /
    // never-measured distinction for every reader at once, silently.
    expect(Object.isFrozen(TASK_ID_INTEGRITY_NOT_MEASURED)).toBe(true);
  });
});

describe("RUFU-333: no store surface can mint ok", () => {
  it("starts a fresh store at unmeasured rather than 'measured and clean'", () => {
    const store = freshStore();
    expect(store.getTaskIdIntegrityReport()).toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
    expect(store.taskIdIntegrityReport.status).toBe("error");
    expect(store.buildTaskIdIntegrityFallbackReport()).toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
  });

  it("caches an honest failure when the measurement cannot run, and logs it as failed", () => {
    const store = freshStore();
    const logged = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);

    const state = store.refreshTaskIdIntegrityReport();

    expect(state.status).toBe("error");
    expect(store.getTaskIdIntegrityReport().status).toBe("error");
    // The cached state names its cause rather than reusing the never-measured sentinel, so a surface can
    // still tell "nothing has run yet" from "we tried and the driver refused".
    expect(store.getTaskIdIntegrityReport()).not.toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
    expect((store.getTaskIdIntegrityReport() as { error?: string }).error).toContain("SQLite");
    expect(logged.mock.calls.some(([message]) => String(message).includes("NOT healthy"))).toBe(true);
    logged.mockRestore();
  });

  it("never returns ok from a refresh, whatever the database does", () => {
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);
    const states: TaskIdIntegrityState[] = [
      store.refreshTaskIdIntegrityReport(),
      store.detectAndCacheTaskIdIntegrityReport(),
    ];
    for (const state of states) {
      expect(state.status).not.toBe("ok");
      expect(state.status).toBe("error");
    }
    spy.mockRestore();
  });

  it("publishes no ok on ANY consumer surface of a store whose db is unusable", () => {
    // The full consumer matrix in one assertion, per ## Symptom Verification: the cache field, the refresh
    // entry point, the getter, the fallback, and both merge orders. A single missed surface would leave the
    // whole card fail-open again, which is exactly how the original three-site defect stayed hidden.
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);

    const refreshed = store.refreshTaskIdIntegrityReport();
    const okState: TaskIdIntegrityState = {
      status: "ok",
      checkedAt: new Date().toISOString(),
      anomalies: [],
    };

    expect(refreshed.status).not.toBe("ok");
    expect(store.taskIdIntegrityReport.status).not.toBe("ok");
    expect(store.getTaskIdIntegrityReport().status).not.toBe("ok");
    expect(store.buildTaskIdIntegrityFallbackReport().status).not.toBe("ok");
    expect(store.mergeTaskIdIntegrityReports(okState, refreshed).status).not.toBe("ok");
    expect(store.mergeTaskIdIntegrityReports(refreshed, okState).status).not.toBe("ok");
    spy.mockRestore();
  });

  it("logs one identical measurement failure once, so a permanently unusable handle cannot flood the log", () => {
    // Backend mode makes the sync handle unmeasurable forever, so without a dedupe signature every
    // store-open refresh would append the same error line. The state is still re-cached each time —
    // silence is a logging decision, never a claim about the corpus.
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);

    store.refreshTaskIdIntegrityReport();
    store.refreshTaskIdIntegrityReport();
    store.detectAndCacheTaskIdIntegrityReport();

    const failureLines = spy.mock.calls.filter(([message]) => String(message).includes("NOT healthy"));
    expect(failureLines).toHaveLength(1);
    expect(store.getTaskIdIntegrityReport().status).toBe("error");
    spy.mockRestore();
  });

  it("merges an error and an ok to the error, in either argument order", () => {
    const store = freshStore();
    const failure = store.refreshTaskIdIntegrityReport();
    const clean: TaskIdIntegrityState = { status: "ok", checkedAt: new Date().toISOString(), anomalies: [] };

    expect(store.mergeTaskIdIntegrityReports(failure, clean).status).toBe("error");
    expect(store.mergeTaskIdIntegrityReports(clean, failure).status).toBe("error");
    expect(store.mergeTaskIdIntegrityReports(clean, TASK_ID_INTEGRITY_NOT_MEASURED).status).toBe("error");
    expect(store.mergeTaskIdIntegrityReports(TASK_ID_INTEGRITY_NOT_MEASURED, clean).status).toBe("error");
  });

  it("prefers a genuine measurement failure over the never-measured sentinel, in either order", () => {
    const store = freshStore();
    const failure = store.refreshTaskIdIntegrityReport();

    for (const merged of [
      store.mergeTaskIdIntegrityReports(failure, TASK_ID_INTEGRITY_NOT_MEASURED),
      store.mergeTaskIdIntegrityReports(TASK_ID_INTEGRITY_NOT_MEASURED, failure),
    ]) {
      expect(merged).not.toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
      expect((merged as { error?: string }).error).toContain("SQLite");
    }
  });

  it("still merges completed scans honestly: two ok stay ok, an anomaly survives", () => {
    const store = freshStore();
    const checkedAt = new Date().toISOString();
    const ok: TaskIdIntegrityState = { status: "ok", checkedAt, anomalies: [] };
    const anomaly: TaskIdIntegrityState = {
      status: "anomaly",
      checkedAt,
      anomalies: [
        { kind: "duplicate_active_id", prefix: "RUFU", affectedIds: ["RUFU-1"], details: "2 rows for RUFU-1." },
      ],
    };

    expect(store.mergeTaskIdIntegrityReports(ok, { ...ok }).status).toBe("ok");
    expect(store.mergeTaskIdIntegrityReports(ok, anomaly).status).toBe("anomaly");
    expect(store.mergeTaskIdIntegrityReports(anomaly, ok).anomalies).toHaveLength(1);
  });

  it("does not mark auto-reconcile-on-open complete when the measurement did not finish", () => {
    // The old code reached `taskIdStateReconciled = true` on a fallback it had just fabricated, so the
    // flag itself became evidence of a reconciliation that never ran.
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);

    expect(store.taskIdStateReconciled).toBe(false);
    // `store.db` throws outright in backend mode, which is the production shape of an unfinished scan.
    expect(() => store.reconcileDistributedTaskIdStateOnOpen()).toThrow();
    expect(store.taskIdStateReconciled).toBe(false);
    spy.mockRestore();
  });

  it("marks auto-reconcile complete only over a completed measurement", () => {
    // Also the proof that the never-measured sentinel is NOT merged forward: a fresh store's previous
    // state IS the sentinel, and carrying it in would leave this card unmeasured forever, because
    // unmeasured deliberately outranks a completed scan. The sentinel is initial absence, not a claim
    // about the corpus, so reconcile is allowed to leave it behind the first time a real scan lands.
    const store = freshStore();
    Object.defineProperty(store, "db", {
      configurable: true,
      get: () => fakeDb({ state: [{ prefix: "RUFU", nextSequence: 1 }] }),
    });

    store.reconcileDistributedTaskIdStateOnOpen();

    expect(store.taskIdStateReconciled).toBe(true);
    expect(store.getTaskIdIntegrityReport().status).toBe("ok");
    expect(store.getTaskIdIntegrityReport()).not.toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
  });

  it("does not let a later clean reconcile launder a failure already on record", () => {
    // A failure carried by reconcile is seconds old — it says an attempt at open time could not run — and
    // a completed scan must not silently erase the sibling that failed. The canary still recovers: a later
    // refresh writes the cache directly instead of merging, so the sticky precedence is bounded to this pass.
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);
    store.refreshTaskIdIntegrityReport();
    expect(store.getTaskIdIntegrityReport()).not.toBe(TASK_ID_INTEGRITY_NOT_MEASURED);

    Object.defineProperty(store, "db", {
      configurable: true,
      get: () => fakeDb({ state: [{ prefix: "RUFU", nextSequence: 1 }] }),
    });

    store.reconcileDistributedTaskIdStateOnOpen();
    expect(store.getTaskIdIntegrityReport().status).toBe("error");
    expect(store.taskIdStateReconciled).toBe(false);

    // Recovery path: the next measurement overwrites rather than merges.
    expect(store.refreshTaskIdIntegrityReport().status).toBe("ok");
    spy.mockRestore();
  });
});

/*
FNXC:TaskIdIntegrityCanary 2026-10-18-23:40 (RUFU-333):
Structural anti-appeasement guard. Behavior tests prove today's contract; this scan forbids the specific
regression of re-introducing a swallow, which is the shape that hid this defect for a whole release cycle.
It reads CODE, never comments — documentation prose about the old bug must not satisfy or trip it, so the
comments are stripped first (AGENTS.md: tests assert behavior or code constructs, never comment text).
*/
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stripTypeScript(pathFromSrc: string): string {
  return stripComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", pathFromSrc), "utf8"));
}

describe("RUFU-333: the appeasement shapes cannot come back", () => {
  it("has no catch that answers a failed measurement with an empty report", () => {
    const body = stripTypeScript("tasks/task-id-integrity.ts");
    expect(body).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,240}?return\s+buildReport\(\s*checkedAt\s*,\s*\[\s*\]\s*\)/);
  });

  it("has no reader that converts a failed read into 'table absent' or an empty row set", () => {
    const body = stripTypeScript("tasks/task-id-integrity.ts");
    expect(body).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{[^}]*\breturn\s+(false|\[\])\s*;/);
  });

  it("hard-codes no healthy status anywhere on the store seam", () => {
    // The merge may DERIVE ok from completed scans; it may never ASSERT ok as a literal. That literal was
    // the fallback's whole implementation and the field initializer's, and either one re-opened the card.
    const body = stripTypeScript("task-store/task-id-integrity.ts");
    expect(body).not.toMatch(/status:\s*"ok"/);
  });
});

describe("RUFU-333: the test-harness reset asserts 'nothing has been measured'", () => {
  it("resets an already-failed cache back to unmeasured, not to a healthy report", () => {
    const store = freshStore();
    const spy = vi.spyOn(coreLog, "error").mockImplementation(() => undefined);
    store.refreshTaskIdIntegrityReport();
    spy.mockRestore();
    expect(store.getTaskIdIntegrityReport()).not.toBe(TASK_ID_INTEGRITY_NOT_MEASURED);

    // Reusing the row is what `resetTaskStorePrivateState` does between tests; seeding it from a
    // fallback that claimed ok would hand the next test a canary that had already lied.
    store.taskIdIntegrityReport = TASK_ID_INTEGRITY_NOT_MEASURED;
    expect(store.getTaskIdIntegrityReport()).toBe(TASK_ID_INTEGRITY_NOT_MEASURED);
  });
});
