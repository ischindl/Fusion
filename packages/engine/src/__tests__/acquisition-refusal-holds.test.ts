import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import { OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { __resetOverlapAcquisitionParkDedup } from "../executor/overlap-acquisition-park.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import * as piModule from "../pi.js";

/*
FNXC:OverlapAcquisitionPark 2026-11-14-11:52 (RUFU-896):
One file, both known shapes of the same terminalization, because the two shapes were separately reported and
a suite that fixes only the reported one is how this class came back before. RUFU-476 arrived as the typed
`OverlapResumeSynchronizationError`; RUFU-342 arrived as a bare Error whose sentence the heartbeat retry cap
then wrapped into `Worktree acquisition failed after 3 heartbeat attempts for branch "…": …`. Both were
`status:"failed"` + prose, both re-admitted, both rebuilt a worktree, and the composed sentence was invisible
to every recovery sweep.

The negative control at the end is what keeps this honest: a real broken checkout must still be terminally
failed at the cap. If the hold were applied to everything, these tests would pass while the board lost its
only signal for a dead checkout.
*/

describe("a refused file-scope acquisition is a hold, on every arm", () => {
  let store: any;
  let taskStore: any;
  let heldRow: Record<string, unknown>;
  const agent: Agent = {
    id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {},
  } as any;

  function taskRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [],
      worktree: null, branch: "fusion/fn-1",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetOverlapAcquisitionParkDedup();
    heldRow = {};
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const run: AgentHeartbeatRun = { id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null } as any;
    store = {
      startHeartbeatRun: vi.fn().mockResolvedValue(run),
      saveRun: vi.fn(),
      getRunDetail: vi.fn().mockResolvedValue(run),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn(),
      updateAgent: vi.fn(),
      endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn(),
      clearLastBlockedState: vi.fn(),
      appendRunLog: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      recordHeartbeat: vi.fn(),
    };
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      // Stateful on purpose: the hold's whole effect is what the next heartbeat reads off this row.
      getTask: vi.fn(async () => taskRow(heldRow)),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      /* The cap arm asks the episode table who holds the file, because a bare Error sentence names nobody.
         This fake answers, so the test asserts the hold carries a name rather than a null. */
      listTaskOverlapWaits: vi.fn(async () => [{ id: "ep-cap", blockerTaskId: "FN-B", state: "delivered", phase: "ready" }]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      recordRunAuditEvent: vi.fn(async () => undefined),
      transitionQueuedEpisode: vi.fn(async (_id: string, transition: Record<string, unknown>) => {
        heldRow.status = "queued";
        heldRow.blockedBy = transition.blockedBy ?? null;
        heldRow.overlapBlockedBy = transition.overlapBlockedBy ?? null;
        return { appended: true, task: taskRow(heldRow) };
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every `error` string any write tried to put on the card, from any writer. */
  function writtenErrors(): string[] {
    const fromUpdate = taskStore.updateTask.mock.calls
      .map((call: any[]) => (call[1] as Record<string, unknown>)?.error)
      .filter((value: unknown): value is string => typeof value === "string");
    const fromTransition = taskStore.transitionQueuedEpisode.mock.calls
      .map((call: any[]) => (call[1] as Record<string, unknown>)?.error)
      .filter((value: unknown): value is string => typeof value === "string");
    return [...fromUpdate, ...fromTransition];
  }

  function assertHeldNotTerminal() {
    expect(taskStore.transitionQueuedEpisode).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      overlapBlockedBy: "FN-A",
      signature: expect.stringMatching(/^overlap-acquisition:(typed-refusal|cap-composed):/),
    }));
    // The card is waiting, so it must not read as finished-with-error anywhere, and no prose may exist.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "failed" }));
    expect(taskStore.transitionQueuedEpisode).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({
      error: expect.anything(),
    }));
    expect(writtenErrors()).toEqual([]);
    // A deterministic wait is not a broken checkout: FN-7721's CentralCore channel must stay silent, and the
    // three-strike budget must survive untouched for the defect it was built to bound.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
  }

  it("holds the typed overlap refusal instead of failing the card", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(
      new OverlapResumeSynchronizationError("delivery-unavailable", OVERLAP_DELIVERY_UNAVAILABLE_ERROR, {
        episodeIds: ["ep-1"], blockerTaskIds: ["FN-A"], repositories: ["repo-a"], missingEvidence: "delivery-evidence-unavailable",
      }),
    );
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root", onTaskAcquisitionExhausted });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    assertHeldNotTerminal();
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
    expect(heldRow.overlapBlockedBy).toBe("FN-A");
    expect(heldRow.status).toBe("queued");
  });

  it("holds the cap-composed refusal, the second shape, without terminalizing", async () => {
    /*
     * RUFU-342's shape: the refusal reaches the cap arm as a bare Error, so the only thing distinguishing it
     * from a broken checkout is the inner sentence — and once the cap composes its wrapper, that sentence is
     * unreadable to every recovery sweep. The cap must therefore ask BEFORE it composes.
     *
     * The row deliberately starts with no `overlapBlockedBy`: a card that already carries one is skipped
     * before acquisition (that is criterion 4), so this arm can only be reached by a card that does not.
     * The honest consequence is asserted below rather than papered over — this arm has no predecessor
     * identity to name, because a bare Error sentence carries none. It holds the card and leaves attribution
     * to `reconcileTaskOverlapWaits`, which reads the episode table. Naming a predecessor is the TYPED arm's
     * advantage, which is why the refusal stays typed wherever it can be.
     */
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error(OVERLAP_DELIVERY_UNAVAILABLE_ERROR));
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root", onTaskAcquisitionExhausted });
    // Arrive at the cap edge: one attempt short of MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES.
    heldRow.recoveryRetryCount = 2;

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.transitionQueuedEpisode).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      signature: expect.stringMatching(/^overlap-acquisition:cap-composed:/),
      // Criterion 2 in its honest form: the hold must NAME who blocks it, or the planning-lane skip never
      // fires and the loop simply continues through this arm.
      overlapBlockedBy: "FN-B",
    }));
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "failed" }));
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
    expect(writtenErrors()).toEqual([]);
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
    expect(heldRow.status).toBe("queued");
    expect(heldRow.overlapBlockedBy).toBe("FN-B");
  });

  it("still terminally fails an ordinary broken checkout at the cap (negative control)", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("fatal: not a git repository"));
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root", onTaskAcquisitionExhausted });
    heldRow.recoveryRetryCount = 2;

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.transitionQueuedEpisode).not.toHaveBeenCalled();
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("Worktree acquisition failed after 3 heartbeat attempts"),
    }));
    expect(onTaskAcquisitionExhausted).toHaveBeenCalledTimes(1);
  });
});
