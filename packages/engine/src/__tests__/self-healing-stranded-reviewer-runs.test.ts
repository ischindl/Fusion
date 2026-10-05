import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

/*
FNXC:ReviewLaneDispatch 2026-10-05-00:27 (RUFU-559):
Symptom contract, stated across BOTH directions so this cannot regress into "the sweep runs and changes
nothing". Production measured 275 reviewer-run rows `status='running'` with no live session (oldest 19 days), 20
in-review cards held by one, and each engine restart manufacturing more. The sweep may close a row only when the
canonical liveness triple proves the session is gone, and the close must not spend the card's retry budget —
otherwise reconciling converts "stranded" into "attempts exhausted, parked forever".

The ledger helpers are module-level `@fusion/core` exports, not store methods, so they are partial-mocked here
(the established pattern); everything else — the registry, the lock, `isTaskActive`, the audit sink — is the real
thing, because the veto IS the behaviour under test.
*/
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  listStrandedLiveReviewerRuns: vi.fn(),
  completeReviewerRunForTask: vi.fn(),
}));

import { completeReviewerRunForTask, listStrandedLiveReviewerRuns } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const completeMock = vi.mocked(completeReviewerRunForTask);
const scanMock = vi.mocked(listStrandedLiveReviewerRuns);

function strandedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "revrun_SANE-1_r1_2026-10-04T00:00:00.000Z",
    taskId: "SANE-1",
    reviewerAgentId: "reviewer-1",
    status: "running",
    reworkRound: 1,
    startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    completedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "SANE-1",
    lineageId: "lineage-1",
    column: "in-review",
    userPaused: false,
    deletedAt: null,
    ...overrides,
  };
}

function storeFor(options: { task?: ReturnType<typeof task> | null } = {}) {
  const store: any = Object.assign(new EventEmitter(), {
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    getTask: vi.fn().mockResolvedValue(options.task === undefined ? task() : options.task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  });
  return store;
}

beforeEach(() => {
  scanMock.mockReset();
  completeMock.mockReset();
  completeMock.mockResolvedValue(true);
});

afterEach(() => {
  executingTaskLock._clearForTest();
});

describe("reconcileStrandedReviewerRuns closes attempts whose session is provably gone", () => {
  it("terminalizes a stranded run and records the close with ids-only metadata", async () => {
    scanMock.mockResolvedValue([strandedRun()] as never);
    const store = storeFor();
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcileStrandedReviewerRuns()).resolves.toBe(1);

    expect(completeMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        taskId: "SANE-1",
        status: "failed",
        failureReasons: [expect.stringMatching(/^engine-lost:/)],
      }),
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:reconcile-stranded-reviewer-runs",
        target: "SANE-1",
        domain: "database",
        metadata: expect.objectContaining({ taskId: "SANE-1", outcome: "closed", source: "self-healing" }),
      }),
    );
  });

  it("leaves the row alone while ANY leg of the liveness triple says the session lives", async () => {
    scanMock.mockResolvedValue([strandedRun()] as never);
    const store = storeFor();
    executingTaskLock.tryClaim("SANE-1");
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcileStrandedReviewerRuns()).resolves.toBe(0);

    expect(completeMock).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "live-session" }),
      }),
    );
  });

  it("never acts on an operator hold, and never on a card whose row disappeared", async () => {
    scanMock.mockResolvedValue([strandedRun()] as never);
    const paused = storeFor({ task: task({ userPaused: true }) });
    await new SelfHealingManager(paused, { rootDir: "/repo" }).reconcileStrandedReviewerRuns();
    expect(completeMock).not.toHaveBeenCalled();

    const missing = storeFor({ task: null });
    scanMock.mockResolvedValue([strandedRun()] as never);
    await new SelfHealingManager(missing, { rootDir: "/repo" }).reconcileStrandedReviewerRuns();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("keeps a verdict that landed first: the one-way completion wins over this pass", async () => {
    scanMock.mockResolvedValue([strandedRun()] as never);
    completeMock.mockResolvedValue(false);
    const store = storeFor();

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileStrandedReviewerRuns();

    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: "already-settled" }) }),
    );
  });

  it("refuses to act on a row whose clock is unprovable", async () => {
    scanMock.mockResolvedValue([strandedRun({ startedAt: "nie je cas" })] as never);
    const store = storeFor();

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileStrandedReviewerRuns();

    expect(completeMock).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: "unparseable-start" }) }),
    );
  });

  it("is registered in startup recovery and maintenance batch 2, next to FN-8492's sweep", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startup = source.slice(source.indexOf("async runStartupRecovery"), source.indexOf("  stop(): void"));
    const batch2 = source.slice(source.indexOf("const batch2Fns"));
    expect(startup).toContain('name: "reconcile-stranded-reviewer-runs"');
    expect(batch2).toContain('name: "reconcile-stranded-reviewer-runs"');
    expect(startup).toContain("reconcileStrandedReviewerRuns()");
  });

  it("unregisters registry paths it did not create (guard against a leaked live path)", async () => {
    const path = "/wt/sane-1-review";
    activeSessionRegistry.registerPath(path, { taskId: "SANE-1", kind: "workflow-step", ownerKey: "test" });
    try {
      scanMock.mockResolvedValue([strandedRun()] as never);
      const store = storeFor();
      await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileStrandedReviewerRuns();
      expect(completeMock).not.toHaveBeenCalled();
    } finally {
      activeSessionRegistry.unregisterPath(path);
    }
  });
});
