/*
FNXC:ProjectRootResolution 2026-10-06-22:13:
CDP sampling of the live dashboard attributed 22.8 % of process CPU to child_process spawn
machinery, and for every ORDINARY repository (a `.git` directory) the linked-worktree resolver fell
through to two synchronous `git rev-parse` spawns on EVERY call. These tests pin the invariant that
makes the fix real rather than merely fast: one resolution per path for the process lifetime, a
bounded window after which a negative answer is re-probed (so a worktree created later is still
discovered), and no cross-path contamination between cache entries.
*/
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getProjectRootFromWorktree,
  resolvePiExtensionProjectRoot,
  resetProjectRootResolutionCachesForTests,
  setProjectRootSpawnObserverForTests,
} from "../plugins/pi-extensions.js";

describe("project root resolution caching", () => {
  let dirA: string;
  let dirB: string;
  let spawns: number;

  beforeEach(() => {
    // An ordinary repo layout (`.git` DIRECTORY) is the case that used to reach the subprocess
    // layer on every call: the on-disk worktree parser returns null for it by design.
    dirA = mkdtempSync(join(tmpdir(), "rootcache-a-"));
    dirB = mkdtempSync(join(tmpdir(), "rootcache-b-"));
    mkdirSync(join(dirA, ".git"));
    mkdirSync(join(dirB, ".git"));
    spawns = 0;
    setProjectRootSpawnObserverForTests(() => {
      spawns += 1;
    });
    resetProjectRootResolutionCachesForTests();
  });

  afterEach(() => {
    setProjectRootSpawnObserverForTests(undefined);
    resetProjectRootResolutionCachesForTests();
    vi.useRealTimers();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("reaches the subprocess layer at most once per path", () => {
    getProjectRootFromWorktree(dirA);
    const afterFirst = spawns;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 25; i += 1) {
      getProjectRootFromWorktree(dirA);
    }
    expect(spawns).toBe(afterFirst);
  });

  it("does not share cache entries between distinct paths", () => {
    getProjectRootFromWorktree(dirA);
    const afterA = spawns;
    getProjectRootFromWorktree(dirB);
    expect(spawns).toBeGreaterThan(afterA);

    const afterB = spawns;
    getProjectRootFromWorktree(dirA);
    getProjectRootFromWorktree(dirB);
    expect(spawns).toBe(afterB);
  });

  it("re-probes a negative answer only after the bounded window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T22:13:00Z"));
    getProjectRootFromWorktree(dirA);
    const settled = spawns;

    getProjectRootFromWorktree(dirA);
    expect(spawns).toBe(settled);

    vi.advanceTimersByTime(61_000);
    getProjectRootFromWorktree(dirA);
    expect(spawns).toBeGreaterThan(settled);
  });

  it("picks up a project that gains a .fusion directory once its entry expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T22:13:00Z"));
    const nested = join(dirA, "sub");
    mkdirSync(nested);

    // No `.fusion` anywhere yet: the documented fallback is the cwd itself.
    expect(resolvePiExtensionProjectRoot(nested)).toBe(nested);

    // Ancestor gains project identity. Inside the TTL the cached answer is intentionally stale —
    // the point of the test is that the staleness is BOUNDED, not that it never happens.
    mkdirSync(join(dirA, ".fusion"));
    expect(resolvePiExtensionProjectRoot(nested)).toBe(nested);

    vi.advanceTimersByTime(61_000);
    expect(resolvePiExtensionProjectRoot(nested)).toBe(dirA);
  });

  it("keeps resolving a real worktree path through the pattern fast path", () => {
    const worktreeCwd = join(dirA, ".fusion", "worktrees", "task-1", "src");
    writeFileSync(join(dirA, ".fusion-placeholder"), "");
    mkdirSync(join(dirA, ".fusion"), { recursive: true });
    expect(getProjectRootFromWorktree(worktreeCwd)).toBe(dirA);
  });
});
