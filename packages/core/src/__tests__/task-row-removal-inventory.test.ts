import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dbImpl } from "../task-store/task-id-integrity.js";

/**
 * Inventory of every code path that can physically remove a `tasks` row.
 *
 * A test may never assert that a comment exists; this scans code constructs (DELETE statements and
 * their guards), which is what the invariant is actually made of.
 */
const CORE_SRC = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "../../../..");

/** Physical row-removal constructs, matched on code shape rather than prose. */
const HARD_DELETE_PATTERNS = [
  /\bdelete\(\s*schema\.project\.tasks\s*\)/,
  /DELETE\s+FROM\s+tasks\b/i,
];

/** A stamping write: soft delete sets `deletedAt`, archiving sets `archivedAt`. */
const STAMP_PATTERN = /deletedAt|archivedAt/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("__")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function hardDeleteSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of sourceFiles(CORE_SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const hits = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => HARD_DELETE_PATTERNS.some((p) => p.test(line)))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
    if (hits.length) sites.set(relative(REPO_ROOT, file).replaceAll("\\", "/"), hits);
  }
  return sites;
}

/*
FNXC:NoSilentRowLoss 2026-09-24-01:20 (RUFU-283):
RUFU-225 left `.fusion/tasks/RUFU-225/task.json` on disk with `column: in-review`, an
`APPROVE_WITH_NOTES` code-review verdict and 3 unmerged commits while resolving on no board read, and
no run-audit row or notice explained it. The class is only closed if a `tasks` row can never become
invisible without either a stamp (`deletedAt`/`archivedAt`) or an audit row. So the census of physical
removals is pinned here: today exactly two sites exist, each with a named precondition, and a new one
without a stamp requirement is a silent-loss path by construction.
*/
describe("tasks-row physical removal inventory", () => {
  const sites = hardDeleteSites();

  it("has exactly the two known physical-removal sites and no new one", () => {
    expect([...sites.keys()].sort()).toEqual([
      "packages/core/src/task-store/task-id-integrity.ts",
      "packages/core/src/task-store/task-store-helpers.ts",
    ]);
  });

  it("purges a tombstone only when a deletedAt stamp is proven, and audits before deleting", () => {
    const src = readFileSync(join(CORE_SRC, "task-store/task-id-integrity.ts"), "utf8");
    const purge = src.slice(src.indexOf("async function maybeResolveTombstonedTaskIdImpl"));
    expect(purge.length).toBeGreaterThan(0);
    // Precondition: the row must already carry a deletedAt stamp to be purge-eligible.
    expect(purge).toMatch(/deletedAt/);
    // The audit row is written inside the same transaction as the parent DELETE, before it.
    const auditAt = purge.indexOf("recordRunAuditEventWithinTransaction");
    const deleteAt = purge.indexOf("delete(schema.project.tasks)");
    expect(auditAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(auditAt);
    // Failure to audit is fatal: the tombstone survives rather than disappearing unaudited.
    expect(purge).toMatch(/TombstonePurgeUnauditedError/);
  });

  it("keeps the sync-handle delete unreachable by construction, with one create-rollback caller", () => {
    const helpers = readFileSync(join(CORE_SRC, "task-store/task-store-helpers.ts"), "utf8");
    expect(helpers).toMatch(/DELETE FROM tasks WHERE id = \?/);
    /*
    The reachability guarantee is behavioral, not prose: `store.db` is the sync SQLite handle and
    `dbImpl` throws unconditionally in backend mode, so this DELETE cannot execute against the
    PostgreSQL store that RUFU-225's disappearance happened on.
    */
    expect(() => dbImpl({} as never)).toThrow(/not available in backend mode/);
    // Plugins cannot reach it either.
    const gate = readFileSync(join(CORE_SRC, "plugin-task-store-gate.ts"), "utf8");
    expect(gate).toMatch(/"deleteTaskById"/);
    const callers = sourceFiles(CORE_SRC)
      .filter((file) => !file.includes("task-store-helpers"))
      .filter((file) => !file.includes("plugin-task-store-gate"))
      .filter((file) => !file.includes("store.ts"))
      .filter((file) => /deleteTaskById\b/.test(readFileSync(file, "utf8")));
    expect(callers.map((f) => relative(REPO_ROOT, f).replaceAll("\\", "/")).sort()).toEqual([
      "packages/core/src/task-store/task-creation.ts",
    ]);
  });

  it("requires every other board-invisible path to stamp deletedAt or archivedAt", () => {
    // The soft-delete and archive seams are the only other ways off the board, and both must stamp.
    const lifecycle = readFileSync(join(CORE_SRC, "task-store/archive-lifecycle-2.ts"), "utf8");
    expect(lifecycle).toMatch(/softDeleteTaskRowInTransaction/);
    expect(lifecycle).toMatch(STAMP_PATTERN);
    const persistence = readFileSync(join(CORE_SRC, "task-store/async/async-persistence.ts"), "utf8");
    expect(persistence.slice(persistence.indexOf("export async function softDeleteTaskRow")))
      .toMatch(/deletedAt/);
  });
});
