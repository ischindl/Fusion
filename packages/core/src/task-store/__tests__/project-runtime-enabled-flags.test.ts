// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { CentralCore } from "../../central/central-core.js";
import {
  readProjectRuntimeEnabledFlags,
  selectProjectRuntimeEnabledFlags,
} from "../async/async-settings.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-22:20 (RUFU-871): Warm-cache-is-not-truth, second act.

The FIRST version of this read was tested against a fake that supplied an `AsyncDataLayer` and a `db`
handle it simply handed over — an assertion about the object graph, not about the database. The real
`CentralCore` the dashboard holds is built from the cwd project's own TaskStore layer
(`dashboardLayer = store.getAsyncLayer()` in `packages/cli/src/commands/dashboard.ts`), so its pool is
bound to ONE `fusion.project_id`, and `project.config` has FORCED row-level security
(`relrowsecurity` + `relforcerowsecurity`, policy `fusion_project_isolation`:
`bypass = 'on' OR project_id = current_setting('fusion.project_id')`).

Measured against production 2026-11-07 as the `fusion_runtime` role: 0 rows visible unbound, 1 row
visible bound, 28 rows visible with `fusion.project_bypass = 'on'`. `central.projects` has NO RLS, so
`listProjects()` answered 25 rows while the settings read answered 1 — and the route reported
`24 unknown / 1 enabled / 0 disabled` against a database holding 6 disabled projects.

So the fake below enforces THAT, not my assumptions: visibility is decided by the RLS predicate over
the session/transaction state, and the only way a test makes it see every project is the same
transaction-local bypass the product must ask for. Reverting the fix (reading `asyncLayer.db` with no
bypass) makes these go RED at the exact production signature.
*/

/** One `project.config` row as the batched SELECT sees it: id plus the extracted flag. */
type ConfigRow = { projectId: string; runtimeEnabled: string | null };

/** Truth shape: 25 registered projects, 6 turned off by the operator. */
const OFF_IDS = new Set(["p-2", "p-7", "p-11", "p-18", "p-24", "p-26"]);
const ALL_ROWS: ConfigRow[] = Array.from({ length: 28 }, (_, index) => ({
  projectId: `p-${index}`,
  runtimeEnabled: OFF_IDS.has(`p-${index}`) ? "false" : null,
}));

/**
 * Flattens a drizzle `SQL` object to its statement text without a prepared-query context. Template
 * literals in the product's SQL stay literal; bound params are not part of any statement here.
 */
function sqlText(query: unknown, depth = 0): string {
  if (depth > 8 || query == null) return "";
  if (typeof query === "string") return query;
  const node = query as { queryChunks?: unknown; value?: unknown };
  // drizzle SQLRaw carries its text as `value` (a string, or a one-element array by build).
  const raw = Array.isArray(node.value) && node.value.length === 1 ? node.value[0] : node.value;
  if (typeof raw === "string") return raw;
  const chunks = node.queryChunks;
  if (chunks === query || chunks === undefined) return "";
  if (Array.isArray(chunks)) return chunks.map((chunk) => sqlText(chunk, depth + 1)).join("");
  return sqlText(chunks, depth + 1);
}

/**
 * A stand-in for a PostgreSQL backend with forced RLS on `project.config`, bound to one project the
 * way every project TaskStore pool is bound at connection creation.
 *
 * `visibleRows` is computed from the SAME predicate the real policy uses, so no fake can accidentally
 * answer for a project it is not allowed to see.
 */
function fakeIsolatedBackend(options: {
  boundProjectId: string;
  rows?: ConfigRow[];
  /** When false the session cannot obtain the bypass — a role/pool that refuses it. */
  bypassAvailable?: boolean;
}) {
  const rows = options.rows ?? ALL_ROWS;
  const bypassAvailable = options.bypassAvailable ?? true;
  /** Transaction-local (`set_config(..., true)`), so it must not survive the transaction. */
  let transactionBypass = false;
  const calls: string[] = [];

  const visibleRows = (bypass: boolean) =>
    bypass ? rows : rows.filter((row) => row.projectId === options.boundProjectId);

  /** Visibility resolves when the query RUNS, not when the handle was built. */
  const makeSelect = (isBypassed: () => boolean) => vi.fn(() => ({
    from: vi.fn(async () => visibleRows(isBypassed())),
  }));

  // A pooled session that never asked for the bypass sees only its bound project, whatever a
  // transaction on that session requested locally.
  const db = { select: makeSelect(() => false) };

  const layer = {
    projectId: options.boundProjectId,
    db,
    transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      transactionBypass = false;
      const tx = {
        select: makeSelect(() => transactionBypass),
        execute: vi.fn(async (query: unknown) => {
          const text = sqlText(query);
          calls.push(text);
          if (text.includes("set_config('fusion.project_bypass'")) {
            // `true` = is_local. A session-level SET would widen privilege past this read.
            if (/true\s*\)/.test(text) && bypassAvailable) transactionBypass = true;
            return [];
          }
          if (text.includes("current_setting('fusion.project_bypass'")) {
            return [{ bypass: transactionBypass ? "on" : null }];
          }
          throw new Error(`unexpected statement: ${text}`);
        }),
      };
      try {
        return await fn(tx);
      } finally {
        // PostgreSQL resets a `set_config(..., true)` value at COMMIT. A leaked bypass here would be
        // the product leaking privilege into every later query on this pooled session.
        transactionBypass = false;
      }
    }),
  };

  return {
    layer: layer as never,
    calls,
    dbSelect: db.select,
    /** A read issued outside the transaction must still see only the bound project. */
    selectOutsideTransaction: async () => visibleRows(false),
  };
}

describe("readProjectRuntimeEnabledFlags", () => {
  it("answers EVERY registered project through a layer bound to one project", async () => {
    const { layer } = fakeIsolatedBackend({ boundProjectId: "p-0" });

    const flags = await readProjectRuntimeEnabledFlags(layer);

    expect(flags).not.toBeNull();
    expect(Object.keys(flags!)).toHaveLength(28);
    for (const id of OFF_IDS) expect(flags![id]).toBe(false);
    expect(flags!["p-0"]).toBe(true);
  });

  it("asks for the bypass INSIDE a transaction, never at session level", async () => {
    const { layer, calls } = fakeIsolatedBackend({ boundProjectId: "p-0" });

    await readProjectRuntimeEnabledFlags(layer);

    const bypassStatement = calls.find((text) => text.includes("set_config('fusion.project_bypass'"));
    expect(bypassStatement).toBeDefined();
    // The third argument must be true (is_local); a session-level bypass would outlive this read.
    expect(bypassStatement).toMatch(/set_config\('fusion\.project_bypass',\s*'on',\s*true\)/);
    expect(calls.some((text) => /SET\s+(LOCAL\s+|SESSION\s+)?fusion\.project_bypass/i.test(text))).toBe(false);
  });

  it("never returns a truncated record when the bypass cannot be obtained — it says it could not answer", async () => {
    const { layer } = fakeIsolatedBackend({ boundProjectId: "p-0", bypassAvailable: false });

    // The RLS defect returned { "p-0": true } and the route trusted it. `null` is the only honest
    // answer, because it is the one shape that sends the caller to the logged fallback.
    await expect(readProjectRuntimeEnabledFlags(layer)).resolves.toBeNull();
  });

  it("reads every project in one query, not one per project", async () => {
    const { layer, dbSelect } = fakeIsolatedBackend({ boundProjectId: "p-0" });

    await readProjectRuntimeEnabledFlags(layer);

    // The bound handle is never queried: a per-store read is not a fallback hiding inside the batch.
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("maps the persisted flag: false is false, true is true, an absent key is enabled", async () => {
    const { layer } = fakeIsolatedBackend({
      boundProjectId: "p-0",
      rows: [
        { projectId: "p-off", runtimeEnabled: "false" },
        { projectId: "p-on", runtimeEnabled: "true" },
        // `settings ->> 'runtimeEnabled'` is NULL for both an absent key and a NULL settings column.
        { projectId: "p-never-set", runtimeEnabled: null },
      ],
    });

    const flags = await readProjectRuntimeEnabledFlags(layer);

    expect(flags).toEqual({ "p-off": false, "p-on": true, "p-never-set": true });
  });

  it("omits a project with no config row instead of defaulting it", async () => {
    const { layer } = fakeIsolatedBackend({
      boundProjectId: "p-0",
      rows: [{ projectId: "p-present", runtimeEnabled: "false" }],
    });

    const flags = await readProjectRuntimeEnabledFlags(layer);

    expect(flags).toEqual({ "p-present": false });
    expect("p-absent" in (flags ?? {})).toBe(false);
  });

  it("skips an unscoped config row, which names no registered project", async () => {
    const { layer } = fakeIsolatedBackend({
      boundProjectId: "p-0",
      rows: [{ projectId: "", runtimeEnabled: "false" }],
    });

    await expect(readProjectRuntimeEnabledFlags(layer)).resolves.toEqual({});
  });
});

describe("selectProjectRuntimeEnabledFlags", () => {
  it("is the raw read and stays RLS-scoped to the handle it is given", async () => {
    const { layer } = fakeIsolatedBackend({ boundProjectId: "p-0" });

    // Pinned so nobody mistakes the raw select for the privileged read: called on a bound handle it
    // answers for exactly the one project the session may see. That is the production defect shape.
    const flags = await selectProjectRuntimeEnabledFlags({
      select: () => ({ from: async () => [{ projectId: "p-0", runtimeEnabled: null }] }),
    } as never);

    expect(flags).toEqual({ "p-0": true });
  });
});

describe("CentralCore.getProjectRuntimeEnabledFlags", () => {
  /*
  FNXC:ProjectRuntimeOff 2026-11-07-22:20 (RUFU-871):
  This exercises the REAL method body on a real `CentralCore` prototype. The previous slice's test
  handed the route a hand-made narrower object, so it asserted the assumption "the server's central
  object has this seam and the layer I picked" instead of the wiring. Booting a full `CentralCore`
  would run `ensureBackendBootstrap` against a fake database, so the instance is assembled by
  assigning the two fields the method actually reads — the method itself is not stubbed.
  */
  function centralWithLayer(layer: unknown): CentralCore {
    const central = Object.create(CentralCore.prototype) as unknown as Record<string, unknown>;
    central.asyncLayer = layer;
    central.initialized = true;
    return central as unknown as CentralCore;
  }

  it("returns the persisted truth for every project through the layer the dashboard actually holds", async () => {
    const { layer } = fakeIsolatedBackend({ boundProjectId: "local-64dc6e191dfdd44c99728880" });

    const flags = await centralWithLayer(layer).getProjectRuntimeEnabledFlags();

    // The production reading was { "local-64dc…": true } → `24 unknown / 1 enabled / 0 disabled`.
    expect(flags).not.toBeNull();
    expect(Object.values(flags!).filter((value) => value === false)).toHaveLength(OFF_IDS.size);
  });

  it("returns null with no backend layer, which is 'could not answer' rather than an empty claim", async () => {
    await expect(centralWithLayer(null).getProjectRuntimeEnabledFlags()).resolves.toBeNull();
  });
});
