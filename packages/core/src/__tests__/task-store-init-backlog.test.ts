/*
FNXC:TaskStoreLightBoot 2026-09-26-19:31 (RUFU-275):
The store-open backlog (legacy adoption → archive reintegration → forced patchnode reconcile)
is correct for long-lived hosts but fatal for transient agent-tool opens on large boards (the
saneca >30 s extension boot). initImpl's skip flags must be individually controllable and
default-off, so a light boot removes exactly the deferrable passes and every host-path boot
keeps the complete backlog. These pin the option matrix at the seam itself.
*/
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initImpl } from "../task-store/lifecycle-ops.js";
import type { TaskStore } from "../store.js";

function makeInitStore() {
  const tasksDir = mkdtempSync(join(tmpdir(), "rufu275-init-"));
  const archiveSpy = vi.fn(async () => {});
  const patchnodeSpy = vi.fn(async () => {});
  const store = {
    tasksDir,
    closing: false,
    asyncLayer: undefined,
    // Empty active census → adoption sweep completes with nothing to adopt (SQLite-shaped:
    // no asyncLayer bookkeeping → no drained marker involved).
    listTasks: async () => [],
    updateTask: async () => {
      throw new Error("unexpected updateTask");
    },
    reconcileArchivedTasksIntoDone: archiveSpy,
    reconcilePatchnodeLedger: patchnodeSpy,
    setupActivityLogListeners: () => {},
  } as unknown as TaskStore;
  return { store, tasksDir, archiveSpy, patchnodeSpy };
}

describe("TaskStore.init backlog skips (RUFU-275 light boot)", () => {
  it("runs the full backlog by default (host-path boot unchanged)", async () => {
    const { store, tasksDir, archiveSpy, patchnodeSpy } = makeInitStore();
    try {
      await initImpl(store);
      expect(archiveSpy).toHaveBeenCalledTimes(1);
      expect(patchnodeSpy).toHaveBeenCalledTimes(1);
      expect(patchnodeSpy).toHaveBeenCalledWith({ force: true });
    } finally {
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  it("skips only archive reintegration when that flag alone is set", async () => {
    const { store, tasksDir, archiveSpy, patchnodeSpy } = makeInitStore();
    try {
      await initImpl(store, { skipArchiveReintegration: true });
      expect(archiveSpy).not.toHaveBeenCalled();
      expect(patchnodeSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  it("skips only the forced patchnode reconcile when that flag alone is set", async () => {
    const { store, tasksDir, archiveSpy, patchnodeSpy } = makeInitStore();
    try {
      await initImpl(store, { skipPatchnodeReconcile: true });
      expect(archiveSpy).toHaveBeenCalledTimes(1);
      expect(patchnodeSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  it("light boot skips both deferrable passes while the store still opens", async () => {
    const { store, tasksDir, archiveSpy, patchnodeSpy } = makeInitStore();
    try {
      await initImpl(store, { skipArchiveReintegration: true, skipPatchnodeReconcile: true });
      expect(archiveSpy).not.toHaveBeenCalled();
      expect(patchnodeSpy).not.toHaveBeenCalled();
      expect(store.closing).toBe(false);
    } finally {
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });
});
