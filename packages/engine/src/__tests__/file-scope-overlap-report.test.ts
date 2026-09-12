import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import {
  describeFileScopeOverlapBlocker,
  findFileScopeOverlaps,
  type FileScopeOverlapBlockerStore,
} from "../index.js";
import { pathsOverlap } from "../scheduler.js";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  column: "todo",
  description: id,
  dependencies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
} as Task);

function storeFor(tasks: Task[], scopes: Record<string, string[]>, settings = {}) {
  return {
    getTask: async (id: string) => tasks.find((candidate) => candidate.id === id),
    getSettings: async () => settings,
    parseFileScopeFromPrompt: async (id: string) => scopes[id] ?? [],
  } as FileScopeOverlapBlockerStore;
}

describe("file scope overlap reporting", () => {
  it("keeps the scheduler predicate equivalent to collected matches", () => {
    for (const [left, right, expected] of [
      [["src/a.ts"], ["src/a.ts"], true],
      [["src/*"], ["src/deep/a.ts"], true],
      [["src/deep/*"], ["src/*"], true],
      [["src/a.ts"], ["test/a.ts"], false],
      // A shared canonical barrel alone never overlaps (RUFU-226).
      [["packages/core/src/index.ts"], ["packages/core/src/index.ts"], false],
      // The exemption must not leak into non-barrel pairs sharing the same scopes.
      [["packages/core/src/index.ts", "src/a.ts"], ["packages/core/src/index.ts", "src/a.ts"], true],
    ] as Array<[string[], string[], boolean]>) {
      expect(pathsOverlap(left, right)).toBe(findFileScopeOverlaps(left, right).length > 0);
      expect(pathsOverlap(left, right)).toBe(expected);
    }
  });

  it("waives a shared barrel entry but keeps every genuine collision matched", () => {
    // Barrel-only intersection between otherwise disjoint scopes → no overlap pairs at all.
    expect(findFileScopeOverlaps(
      ["packages/core/src/index.ts", "packages/core/src/chat.ts"],
      ["packages/core/src/index.ts", "packages/core/src/store.ts"],
    )).toEqual([]);
    // Barrel plus a genuinely shared real file → the real pair is listed; the barrel pair is not.
    expect(findFileScopeOverlaps(
      ["packages/core/src/index.ts", "packages/core/src/store.ts"],
      ["packages/core/src/index.ts", "packages/core/src/store.ts", "packages/core/src/repair.ts"],
    )).toEqual([{ path: "packages/core/src/store.ts", blockerPath: "packages/core/src/store.ts" }]);
    // A directory glob covering the barrel still serializes — the exemption never applies to a pattern side.
    expect(findFileScopeOverlaps(["packages/core/*"], ["packages/core/src/index.ts"])).toEqual([
      { path: "packages/core/*", blockerPath: "packages/core/src/index.ts" },
    ]);
    // Two different barrels overlap neither way.
    expect(findFileScopeOverlaps(["packages/core/src/index.ts"], ["packages/engine/src/index.ts"])).toEqual([]);
    // Both canonical barrels shared simultaneously → still no overlap.
    expect(findFileScopeOverlaps(
      ["packages/core/src/index.ts", "packages/core/src/index.gate.ts"],
      ["packages/core/src/index.ts", "packages/core/src/index.gate.ts"],
    )).toEqual([]);
  });

  it("collects sorted, deduplicated matching pairs", () => {
    expect(findFileScopeOverlaps(["src/a.ts", "src/a.ts"], ["src/*", "src/*", "src/a.ts"])).toEqual([
      { path: "src/a.ts", blockerPath: "src/*" },
      { path: "src/a.ts", blockerPath: "src/a.ts" },
    ]);
  });

  it("matches unprefixed workspace scope with a peer's repository-qualified scope only in workspace mode", async () => {
    const workspaceTasks = [
      task("FN-1", { overlapBlockedBy: "FN-2", workspaceWorktrees: { "repo-a": {}, "repo-b": {} } as Task["workspaceWorktrees"] }),
      task("FN-2", { workspaceWorktrees: { "repo-a": {}, "repo-b": {} } as Task["workspaceWorktrees"] }),
    ];
    const scopes = { "FN-1": ["src/index.ts"], "FN-2": ["repo-a/src/index.ts"] };

    await expect(describeFileScopeOverlapBlocker(storeFor(workspaceTasks, scopes), "FN-1"))
      .resolves.toMatchObject({ reason: "ok" });
    await expect(describeFileScopeOverlapBlocker(
      storeFor([task("FN-1", { overlapBlockedBy: "FN-2" }), task("FN-2")], scopes),
      "FN-1",
    )).resolves.toMatchObject({ reason: "no-overlap" });
  });

  it("reports a barrel-only overlap marker as no-overlap", async () => {
    // The RUFU-204/RUFU-217 shape: a parked review card whose scope shares only the core barrel.
    const store = storeFor(
      [task("FN-217", { overlapBlockedBy: "FN-204" }), task("FN-204", { column: "in-review", worktree: "/wt/fn-204", autoMerge: false })],
      { "FN-217": ["packages/core/src/index.ts", "packages/engine/src/scheduler.ts"], "FN-204": ["packages/core/src/index.ts", "packages/core/src/store.ts"] },
    );

    const report = await describeFileScopeOverlapBlocker(store, "FN-217");

    expect(report).toMatchObject({ reason: "no-overlap", blockerId: "FN-204", overlaps: [] });
  });

  it("reports absent blockers, missing blocker rows, filtered scopes, and matches", async () => {
    const clear = await describeFileScopeOverlapBlocker(storeFor([task("FN-1")], {}), "FN-1");
    expect(clear).toMatchObject({ reason: "no-overlap-blocker", overlaps: [] });

    const missing = await describeFileScopeOverlapBlocker(storeFor([task("FN-1", { overlapBlockedBy: "FN-2" })], {}), "FN-1");
    expect(missing).toMatchObject({ reason: "blocker-not-found", blockerId: "FN-2" });

    const noOverlap = await describeFileScopeOverlapBlocker(
      storeFor([task("FN-1", { overlapBlockedBy: "FN-2" }), task("FN-2")], { "FN-1": [".fusion/a", "src/a.ts"], "FN-2": ["src/b.ts"] }),
      "FN-1",
    );
    expect(noOverlap).toMatchObject({ reason: "no-overlap", taskScopeCount: 1, blockerScopeCount: 1 });

    const matched = await describeFileScopeOverlapBlocker(
      storeFor([task("FN-1", { overlapBlockedBy: "FN-2" }), task("FN-2", { column: "in-progress" })], { "FN-1": ["src/a.ts", "ignored/a.ts"], "FN-2": ["src/*", "ignored/*"] }, { overlapIgnorePaths: ["ignored"] }),
      "FN-1",
    );
    expect(matched).toMatchObject({ reason: "ok", taskScopeCount: 1, blockerScopeCount: 1, blockerColumn: "in-progress" });
    expect(matched.overlaps).toEqual([{ path: "src/a.ts", blockerPath: "src/*" }]);
  });
});
