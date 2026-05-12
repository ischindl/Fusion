import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database, DatabaseSync } from "@fusion/core";
import { hydrateWorktreeDb } from "../worktree-db-hydrate.js";

function makeProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".fusion"), { recursive: true });
  const db = new Database(join(dir, ".fusion"));
  db.init();
  db.close();
  return dir;
}

function insertTask(projectDir: string, id: string): void {
  const db = new DatabaseSync(join(projectDir, ".fusion", "fusion.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO tasks (id, description, \"column\", createdAt, updatedAt, dependencies) VALUES (?, ?, 'todo', ?, ?, '[]')")
    .run(id, id, now, now);
  db.close();
}

function insertDoc(projectDir: string, taskId: string): void {
  const db = new DatabaseSync(join(projectDir, ".fusion", "fusion.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO task_documents (id, taskId, key, content, revision, author, metadata, createdAt, updatedAt) VALUES (?, ?, 'notes', 'hello', 1, 'test', NULL, ?, ?)")
    .run(`doc-${taskId}`, taskId, now, now);
  db.close();
}

function sha(file: string): string {
  if (!existsSync(file)) return "";
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("hydrateWorktreeDb", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
    cleanup.length = 0;
  });

  it("hydrates transitive dependencies and is idempotent", async () => {
    const root = makeProject("h-root-");
    const worktree = makeProject("h-dst-");
    cleanup.push(root, worktree);

    insertTask(root, "FN-A");
    insertTask(root, "FN-B");
    insertTask(root, "FN-C");
    insertDoc(root, "FN-B");

    const depMap: Record<string, string[]> = { "FN-A": ["FN-B"], "FN-B": ["FN-C"], "FN-C": [] };
    const store = { getTask: vi.fn(async (id: string) => ({ id, dependencies: depMap[id] ?? [] })) };

    const first = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-A", store: store as any, logger: { warn: vi.fn() } });
    const second = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-A", store: store as any, logger: { warn: vi.fn() } });
    expect(first.degraded).toBe(false);
    expect(second.degraded).toBe(false);

    const db = new DatabaseSync(join(worktree, ".fusion", "fusion.db"));
    const tasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE id IN ('FN-A','FN-B','FN-C')").get() as any).c;
    const docs = (db.prepare("SELECT COUNT(*) as c FROM task_documents WHERE taskId='FN-B'").get() as any).c;
    db.close();
    expect(tasks).toBe(3);
    expect(docs).toBe(1);
  });

  it("no-op when rootDir === worktreePath", async () => {
    const root = makeProject("h-same-");
    cleanup.push(root);
    const result = await hydrateWorktreeDb({ rootDir: root, worktreePath: root, taskId: "FN-A", store: { getTask: vi.fn() } as any, logger: { warn: vi.fn() } });
    expect(result.reason).toBe("root_worktree");
  });

  it("handles cycle and 50-id cap", async () => {
    const root = makeProject("h-cycle-");
    const worktree = makeProject("h-cycle-dst-");
    cleanup.push(root, worktree);
    for (let i = 0; i < 60; i++) insertTask(root, `FN-${i}`);

    const map: Record<string, string[]> = { "FN-A": ["FN-B"], "FN-B": ["FN-A"] };
    for (let i = 0; i < 60; i++) map[`FN-${i}`] = i < 59 ? [`FN-${i + 1}`] : [];
    const store = { getTask: vi.fn(async (id: string) => ({ id, dependencies: map[id] ?? [] })) };

    insertTask(root, "FN-A");
    insertTask(root, "FN-B");
    const cyc = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-A", store: store as any, logger: { warn: vi.fn() } });
    const capped = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-0", store: store as any, logger: { warn: vi.fn() } });
    expect(cyc.degraded).toBe(false);
    expect(capped.tasksCopied).toBeLessThanOrEqual(50);
  });

  it("handles schema drift by dropping missing destination columns", async () => {
    const root = makeProject("h-drift-");
    const worktree = makeProject("h-drift-dst-");
    cleanup.push(root, worktree);
    insertTask(root, "FN-1");
    const driftDb = new DatabaseSync(join(worktree, ".fusion", "fusion.db"));
    driftDb.exec("DROP TRIGGER IF EXISTS tasks_fts_ai");
    driftDb.exec("DROP TRIGGER IF EXISTS tasks_fts_au");
    driftDb.exec("DROP TRIGGER IF EXISTS tasks_fts_ad");
    driftDb.exec("ALTER TABLE tasks DROP COLUMN title");
    driftDb.close();

    const warn = vi.fn();
    const store = { getTask: vi.fn(async () => ({ id: "FN-1", dependencies: [] })) };
    const result = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-1", store: store as any, logger: { warn } });

    expect(result.degraded).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tasks.title"));
  });

  it("does not mutate source db file bytes", async () => {
    const root = makeProject("h-src-");
    const worktree = makeProject("h-dst2-");
    cleanup.push(root, worktree);
    insertTask(root, "FN-1");
    const store = { getTask: vi.fn(async () => ({ id: "FN-1", dependencies: [] })) };

    const dbPath = join(root, ".fusion", "fusion.db");
    const before = [sha(dbPath), sha(`${dbPath}-wal`), sha(`${dbPath}-shm`)];
    await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-1", store: store as any, logger: { warn: vi.fn() } });
    const after = [sha(dbPath), sha(`${dbPath}-wal`), sha(`${dbPath}-shm`)];
    expect(after).toEqual(before);
  });

  it("bootstraps worktree db when .fusion scratch dir is missing", async () => {
    const root = makeProject("h-open-root-");
    const worktree = mkdtempSync(join(tmpdir(), "h-open-dst-"));
    cleanup.push(root, worktree);
    insertTask(root, "FN-1");

    const warn = vi.fn();
    const store = { getTask: vi.fn(async () => ({ id: "FN-1", dependencies: [] })) };
    const result = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-1", store: store as any, logger: { warn } });

    expect(result.degraded).toBe(false);
    expect(result.tasksCopied).toBe(1);
    expect(existsSync(join(worktree, ".fusion", "fusion.db"))).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("unable to open database file"));
  });

  it("degrades on write failure", async () => {
    const root = makeProject("h-denied-");
    const worktree = makeProject("h-denied-dst-");
    cleanup.push(root, worktree);
    insertTask(root, "FN-1");
    const store = { getTask: vi.fn(async () => ({ id: "FN-1", dependencies: [] })) };

    chmodSync(join(worktree, ".fusion"), 0o500);
    const warn = vi.fn();
    const result = await hydrateWorktreeDb({ rootDir: root, worktreePath: worktree, taskId: "FN-1", store: store as any, logger: { warn } });
    chmodSync(join(worktree, ".fusion"), 0o700);
    expect(result.degraded).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
