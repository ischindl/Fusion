import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinTraits } from "@fusion/core";

import type { AbortInFlightSummary } from "../await-abort-in-flight.js";
import type { WireExecutorLifecycleDeps } from "../wire-executor-lifecycle.js";
import { wireExecutorLifecycle } from "../wire-executor-lifecycle.js";
import {
  awaitTaskDisposalBarrier,
  hasTaskDisposalBarrier,
  registerTaskDisposal,
  resetTaskDisposalBarrierForTests,
} from "../task-disposal-barrier.js";

/*
FNXC:AssigneeTransferAtomicity 2026-09-21-20:36 (RUFU-260):
Behavioral contract of the assignee-transfer listener (incident: transferred card kept its old
owner's live session writing while the new owner woke — two writers on one worktree):
  - transfer with a previous owner aborts through the single abort seam, engine-abort provenance
    (reason "assignee-transfer", NO userCanceled), and publishes the teardown to the disposal
    barrier so a new-owner wake cannot acquire until the abort settles (repro 1/4);
  - the audit row records the honest outcome (`aborted` / `no-live-surface`), queryable by task
    and previous owner;
  - a session staffed by a column-agent principal equal to the previous owner DEFERS the abort
    (the binding governs, not the stale assignee field) and records `column-binding-deferred`;
  - first assignment (no previous owner) tears nothing down;
  - a hostile audit sink cannot block the teardown or its barrier release;
  - FNXC:AssigneeTransferAtomicity 2026-09-22-16:10: while the card sits in a REVIEW lane (resolved
    from workflow traits, not a column literal), the transfer must NOT abort the live prompt-lane
    (workflow-step) session — destroying an in-flight Code/Plan Review is the unrecoverable
    no-verdict wedge — while the previous owner's write surfaces are still torn down. In a WIP lane
    the prompt-lane session is the previous owner's own surface and is aborted.
*/

type AuditRow = {
  taskId?: string;
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata?: Record<string, unknown>;
};

type LaneFixture = {
  /** Column the store reports for the task (drives the review-lane question). */
  taskColumn?: string;
  /** Task workflow selection, so a renamed review lane can be resolved from traits. */
  selection?: { workflowId: string; stepIds: string[] };
  /** Custom workflow definition returned for that selection (object IR: the resolver trusts it). */
  definition?: { ir: unknown };
};

function buildDeps(laneFixture: LaneFixture = {}) {
  const store = new EventEmitter() as EventEmitter & {
    recordRunAuditEvent?: (row: AuditRow) => Promise<void>;
    getSettings?: () => Promise<Record<string, unknown>>;
    getTask?: (taskId: string) => Promise<{ id: string; column: string }>;
    getTaskWorkflowSelection?: (taskId: string) => { workflowId: string; stepIds: string[] } | undefined;
    getWorkflowDefinition?: (id: string) => Promise<{ ir: unknown } | undefined>;
    laneCache?: Map<string, never>;
  };
  const auditRows: AuditRow[] = [];
  store.recordRunAuditEvent = async (row: AuditRow) => { auditRows.push(row); };
  // Lane resolution inputs: no selection + no definition resolves to the default builtin IR, whose
  // review lane is `in-review`; a fixture selection resolves the custom IR instead.
  store.getTask = async (taskId: string) => ({ id: taskId, column: laneFixture.taskColumn ?? "in-progress" });
  store.getTaskWorkflowSelection = () => laneFixture.selection;
  store.getWorkflowDefinition = async () => laneFixture.definition;

  const awaitAbortInFlightTaskWork = vi.fn(
    async (
      _taskId: string,
      _reason: string,
      _options?: Record<string, unknown>,
    ): Promise<AbortInFlightSummary> => ({
      hadActiveSurface: true,
      abortedSurfaces: ["agent-session"],
      preservedSurfaces: [],
    }),
  );
  const pendingTaskDisposals = new Map<string, Promise<void>>();
  const trackTaskDisposal = vi.fn((taskId: string, disposal: Promise<void>) => {
    const wrapped = disposal.catch(() => {});
    pendingTaskDisposals.set(taskId, wrapped);
    void wrapped.then(() => { if (pendingTaskDisposals.get(taskId) === wrapped) pendingTaskDisposals.delete(taskId); });
    // Mirror into the barrier exactly like the real trackTaskDisposal.
    registerTaskDisposal(taskId, wrapped);
  });
  const activeSessions = new Map<string, { lastEffectiveColumnAgentId?: string | null }>();
  const activeWorkflowStepSessions = new Map<string, { abort: () => Promise<void>; dispose: () => void }>();

  const deps = {
    store,
    rootDir: "/tmp/assignee-transfer-test",
    options: {},
    activeConfiguredCommandControllers: new Map(),
    activeSessions,
    activeStepExecutorSeenSteeringIds: new Map(),
    activeStepExecutors: new Map(),
    activeSubagentSessions: new Map(),
    activeWorkflowGraphAbortControllers: new Map(),
    activeWorkflowStepSessionSeenSteeringIds: new Map(),
    activeWorkflowStepSessions,
    approvalResumeAfterUnwind: new Set(),
    approvalSuspended: new Set(),
    effectiveColumnAgentByTask: new Map(),
    executing: new Set(),
    graphColumnAgentResolver: new Map(),
    graphRouting: new Set(),
    graphSeamGoverningNodeId: new Map(),
    loopRecoveryState: new Map(),
    pendingTaskDisposals,
    recoveringCompleted: new Set(),
    spawnedAgents: new Map(),
    stuckAborted: new Map(),
    userCanceledTaskIds: new Set(),
    workflowLifecycleMovesInFlight: new Set(),
    awaitAbortInFlightTaskWork,
    clearWorkflowRerunWatchdog: vi.fn(),
    deleteActiveWorkflowStepSession: vi.fn(),
    dispatchUnpauseResume: vi.fn(async () => false),
    disposeSubagentsForTask: vi.fn(),
    execute: vi.fn(async () => {}),
    executeReviewHandoff: vi.fn(async () => undefined),
    getAssignedAgentRuntimeConfig: vi.fn(async () => undefined),
    getModelRegistry: vi.fn(async () => ({})),
    getRunContextFor: vi.fn(() => undefined),
    isBackwardMoveOutOfPlanning: vi.fn(() => false),
    markPausedAborted: vi.fn(),
    releasePreExecutionWorktree: vi.fn(async () => undefined),
    resetMergeStateIfNeeded: vi.fn(async (task: unknown) => task),
    resolveResumeLanes: vi.fn(async () => ({})),
    terminateAllChildren: vi.fn(async () => {}),
    trackTaskDisposal,
  } as unknown as WireExecutorLifecycleDeps;

  return {
    deps,
    store,
    auditRows,
    awaitAbortInFlightTaskWork,
    trackTaskDisposal,
    pendingTaskDisposals,
    activeSessions,
    activeWorkflowStepSessions,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/*
FNXC:AssigneeTransferAtomicity 2026-09-22-16:55 (RUFU-260):
"Is this card in a review lane?" is answered from WORKFLOW TRAITS (`resolveReviewColumns`), never a
column literal, so the harness must exercise the same trait authority production registers. Trait
registration is an import side effect of `builtin-traits`; a bare fake-store harness does not pull it
in, and without it every trait lookup resolves to no flags — which would silently test the fallback
branch instead of the renamed-lane contract.
*/
registerBuiltinTraits();

describe("assignee-transfer lifecycle listener", () => {
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    resetTaskDisposalBarrierForTests();
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    resetTaskDisposalBarrierForTests();
  });

  it("aborts the previous owner's session through the single seam and gates the barrier until settle", async () => {
    const { deps, store, auditRows, awaitAbortInFlightTaskWork, activeSessions } = buildDeps();
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    // A live session owned by the previous owner (no column-agent binding governs it).
    activeSessions.set("fn-1", { lastEffectiveColumnAgentId: null });
    // Controllable abort: the barrier must hold until the abort itself settles, not just until
    // the listener starts.
    let settleAbort: () => void = () => {};
    awaitAbortInFlightTaskWork.mockImplementationOnce(
      () => new Promise((resolve) => {
        settleAbort = () =>
          resolve({ hadActiveSurface: true, abortedSurfaces: ["agent-session"], preservedSurfaces: [] });
      }),
    );

    store.emit("task:assignee-changed", { taskId: "fn-1", previousOwnerId: "agent-a", newOwnerId: "agent-b" });

    // Teardown published: a new-owner wake must now block.
    expect(hasTaskDisposalBarrier("fn-1")).toBe(true);
    let acquired = false;
    const wake = awaitTaskDisposalBarrier("fn-1").then(() => { acquired = true; });
    await flush();
    expect(acquired).toBe(false);

    // Single seam, engine-abort provenance: reason "assignee-transfer", no userCanceled flag.
    // No prompt-lane session is live, so nothing is preserved.
    expect(awaitAbortInFlightTaskWork).toHaveBeenCalledWith("fn-1", "assignee-transfer", {
      preserveWorkflowStepSession: false,
    });
    expect([...(deps.userCanceledTaskIds as Set<string>)]).toEqual([]);

    settleAbort();
    await wake;
    expect(acquired).toBe(true);
    expect(hasTaskDisposalBarrier("fn-1")).toBe(false);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      taskId: "fn-1",
      agentId: "agent-a",
      domain: "database",
      mutationType: "task:assignee-transfer-abort",
      target: "fn-1",
    });
    expect(auditRows[0].metadata).toEqual({
      outcome: "aborted",
      previousOwnerId: "agent-a",
      newOwnerId: "agent-b",
      reviewLaneSessionPreserved: false,
    });
    expect(auditRows[0].runId).toContain("assignee-transfer-abort");
  });

  it("records no-live-surface when the abort found nothing running, and still gates+releases", async () => {
    const { deps, store, auditRows, awaitAbortInFlightTaskWork } = buildDeps();
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;
    awaitAbortInFlightTaskWork.mockResolvedValueOnce({ hadActiveSurface: false, abortedSurfaces: [], preservedSurfaces: [] });

    store.emit("task:assignee-changed", { taskId: "fn-2", previousOwnerId: "agent-a", newOwnerId: undefined });
    await awaitTaskDisposalBarrier("fn-2");

    expect(auditRows[0].metadata).toEqual({
      outcome: "no-live-surface",
      previousOwnerId: "agent-a",
      newOwnerId: null,
      reviewLaneSessionPreserved: false,
    });
  });

  it("defers when a column-agent principal binding equal to the previous owner governs the live session", async () => {
    const { deps, store, auditRows, awaitAbortInFlightTaskWork, activeSessions } = buildDeps();
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    activeSessions.set("fn-3", { lastEffectiveColumnAgentId: "agent-a" });

    store.emit("task:assignee-changed", { taskId: "fn-3", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await flush();

    expect(awaitAbortInFlightTaskWork).not.toHaveBeenCalled();
    expect(hasTaskDisposalBarrier("fn-3")).toBe(false);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toEqual({
      outcome: "column-binding-deferred",
      previousOwnerId: "agent-a",
      newOwnerId: "agent-b",
      reviewLaneSessionPreserved: false,
    });
  });

  it("aborts normally when a DIFFERENT column-agent principal governs: the stale assignee is not the boss", async () => {
    const { deps, store, awaitAbortInFlightTaskWork, activeSessions } = buildDeps();
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    activeSessions.set("fn-3b", { lastEffectiveColumnAgentId: "agent-column-x" });

    store.emit("task:assignee-changed", { taskId: "fn-3b", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await new Promise((r) => setTimeout(r, 10));

    expect(awaitAbortInFlightTaskWork).toHaveBeenCalledWith("fn-3b", "assignee-transfer", {
      preserveWorkflowStepSession: false,
    });
  });

  /*
  FNXC:AssigneeTransferAtomicity 2026-09-22-16:10 (RUFU-260):
  The review-gate half of the blast-radius invariant. These two cases are a non-vacuous pair over the
  SAME live prompt-lane fixture: only the card's lane differs, and the review-lane case must leave the
  prompt session standing (a killed review gate has no verdict to recover and needs an operator
  bypass) while the WIP case must tear it down (there it IS the previous owner's own surface).
  */
  it("preserves a live prompt-lane session when the card sits in a review lane, and reports it", async () => {
    const { deps, store, auditRows, awaitAbortInFlightTaskWork, activeWorkflowStepSessions } = buildDeps({ taskColumn: "in-review" });
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    const promptSession = { abort: vi.fn(async () => {}), dispose: vi.fn() };
    activeWorkflowStepSessions.set("fn-6", promptSession);
    awaitAbortInFlightTaskWork.mockImplementationOnce(
      async (_taskId: string, _reason: string, options?: Record<string, unknown>) => ({
        hadActiveSurface: true,
        abortedSurfaces: ["agent-session"],
        preservedSurfaces: options?.preserveWorkflowStepSession ? ["workflow-step-session"] : [],
      }),
    );

    store.emit("task:assignee-changed", { taskId: "fn-6", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await awaitTaskDisposalBarrier("fn-6");

    expect(awaitAbortInFlightTaskWork).toHaveBeenCalledWith("fn-6", "assignee-transfer", {
      preserveWorkflowStepSession: true,
    });
    expect(auditRows[0].metadata).toEqual({
      outcome: "aborted",
      previousOwnerId: "agent-a",
      newOwnerId: "agent-b",
      reviewLaneSessionPreserved: true,
    });
  });

  it("resolves a RENAMED review lane from workflow traits, not from the `in-review` literal", async () => {
    const { deps, store, awaitAbortInFlightTaskWork, activeWorkflowStepSessions } = buildDeps({
      taskColumn: "awaiting-human",
      selection: { workflowId: "WF-REVIEW-ALIAS", stepIds: [] },
      definition: {
        ir: {
          nodes: [],
          edges: [],
          columns: [{ id: "awaiting-human", traits: [{ trait: "human-review" }] }],
        },
      },
    });
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;
    activeWorkflowStepSessions.set("fn-7", { abort: vi.fn(async () => {}), dispose: vi.fn() });

    store.emit("task:assignee-changed", { taskId: "fn-7", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await awaitTaskDisposalBarrier("fn-7");

    expect(awaitAbortInFlightTaskWork).toHaveBeenCalledWith("fn-7", "assignee-transfer", {
      preserveWorkflowStepSession: true,
    });
  });

  it("WIP-lane control: the same live prompt session IS aborted when no review lane holds it", async () => {
    const { deps, store, awaitAbortInFlightTaskWork, activeWorkflowStepSessions } = buildDeps({ taskColumn: "in-progress" });
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;
    activeWorkflowStepSessions.set("fn-8", { abort: vi.fn(async () => {}), dispose: vi.fn() });

    store.emit("task:assignee-changed", { taskId: "fn-8", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await awaitTaskDisposalBarrier("fn-8");

    expect(awaitAbortInFlightTaskWork).toHaveBeenCalledWith("fn-8", "assignee-transfer", {
      preserveWorkflowStepSession: false,
    });
  });

  it("tears nothing down for a first assignment (previous owner absent)", async () => {
    const { deps, store, auditRows, awaitAbortInFlightTaskWork } = buildDeps();
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    store.emit("task:assignee-changed", { taskId: "fn-4", newOwnerId: "agent-a" });
    await flush();

    expect(awaitAbortInFlightTaskWork).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
    expect(hasTaskDisposalBarrier("fn-4")).toBe(false);
  });

  it("a hostile audit sink cannot block the teardown or its barrier release", async () => {
    const { deps, store } = buildDeps();
    (store as unknown as { recordRunAuditEvent: (row: AuditRow) => Promise<void> }).recordRunAuditEvent = async () => {
      throw new Error("audit sink on fire");
    };
    unregister = wireExecutorLifecycle(deps).unregisterTaskMoveDisposer;

    store.emit("task:assignee-changed", { taskId: "fn-5", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await expect(awaitTaskDisposalBarrier("fn-5")).resolves.toBeUndefined();
  });
});
