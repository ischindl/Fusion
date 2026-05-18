import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: vi.fn().mockReturnValue([]),
  rmSync: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
}));

import { WorktreePool } from "../worktree-pool.js";

// FN-4954: deterministic repro for the rehydrate collision race.
describe("WorktreePool double-lease reproduction", () => {
  let pool: WorktreePool;

  beforeEach(() => {
    pool = new WorktreePool();
  });

  it("reproduces rehydrate re-adding a path that is already leased", () => {
    pool.release("/tmp/wt-race");

    const firstLease = pool.acquire();
    expect(firstLease).toBe("/tmp/wt-race");

    // Simulates scan/rehydrate colliding with an in-flight lease.
    pool.rehydrate(["/tmp/wt-race"]);

    // Expected invariant: leased paths must never be re-added to idle.
    // Current behavior (pre-fix) returns the same path again here.
    expect(pool.acquire()).toBeNull();
  });
});
