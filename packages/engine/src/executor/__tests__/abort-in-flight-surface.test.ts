/*
FNXC:AssigneeTransferAtomicity 2026-09-22-17:15 (RUFU-260):
The abort seam's surface inventory is the blast radius of every card-level stop, so it is pinned
here at the REAL seam (`prepareAbortInFlightTaskWork`/`awaitAbortInFlightTaskWork`), not through a
mocked facade. The pair below differs by ONE option:

  - default: an ownership transfer (or any card-level stop) tears down every live surface for the
    task, including its prompt-lane (workflow-step) session, and reports each surface it killed;
  - `preserveWorkflowStepSession: true`: the previous owner's write surfaces still die, but the
    prompt-lane session is left standing — not aborted, not disposed, not unregistered — because
    killing an in-flight Code/Plan Review leaves a required pre-merge gate with no verdict at all
    (the "failed before producing a verdict" wedge that only an operator bypass can clear). An
    assignee change is an ownership event, not a card-level stop.

`preservedSurfaces` is reported only when a prompt-lane session was actually live, so the
assignee-transfer audit row can never claim a preservation that preserved nothing.
*/
import { describe, expect, it, vi } from "vitest";
import {
  awaitAbortInFlightTaskWork,
  type AwaitAbortInFlightTaskWorkDeps,
} from "../await-abort-in-flight.js";

type FakeSession = { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

function fakeSession(): FakeSession {
  return { abort: vi.fn(async () => {}), dispose: vi.fn() };
}

function makeDeps() {
  const agentSession = fakeSession();
  const workflowStepSession = fakeSession();
  const activeSessions = new Map<string, { session: FakeSession }>([["task-1", { session: agentSession }]]);
  const activeWorkflowStepSessions = new Map<string, FakeSession>([["task-1", workflowStepSession]]);
  const deps = {
    userCanceledTaskIds: new Set<string>(),
    markPausedAborted: vi.fn(),
    untrackStuckTask: vi.fn(),
    clearWorkflowRerunWatchdog: vi.fn(),
    clearCompletedTaskWatchdog: vi.fn(),
    processWideGraphRouting: new Set<string>(["task-1"]),
    activeSessions,
    // The real deleters drop the map entry (and unregister the session-registry path), so map
    // membership below measures whether the seam claimed the surface at all.
    deleteActiveSession: vi.fn(() => { activeSessions.delete("task-1"); }),
    activeStepExecutors: new Map(),
    deleteActiveStepExecutor: vi.fn(),
    activeWorkflowStepSessions,
    deleteActiveWorkflowStepSession: vi.fn(() => { activeWorkflowStepSessions.delete("task-1"); }),
    activeConfiguredCommandControllers: new Map<string, Set<AbortController>>(),
    activeWorkflowGraphAbortControllers: new Map<string, AbortController>(),
    activeSubagentSessions: { has: () => false },
    disposeSubagentsForTask: vi.fn(),
    activeCliTaskSessions: new Map(),
    loopRecoveryState: new Map(),
    stuckAborted: new Map(),
    safeLogEntry: vi.fn(),
  } as unknown as AwaitAbortInFlightTaskWorkDeps;
  return { deps, agentSession, workflowStepSession };
}

describe("awaitAbortInFlightTaskWork surface inventory", () => {
  it("default: a card-level stop aborts every live surface including the prompt-lane session", async () => {
    const { deps, agentSession, workflowStepSession } = makeDeps();

    const summary = await awaitAbortInFlightTaskWork(deps, "task-1", "assignee-transfer");

    expect(agentSession.abort).toHaveBeenCalledTimes(1);
    expect(agentSession.dispose).toHaveBeenCalledTimes(1);
    expect(deps.deleteActiveSession).toHaveBeenCalledWith("task-1");
    expect(workflowStepSession.abort).toHaveBeenCalledTimes(1);
    expect(workflowStepSession.dispose).toHaveBeenCalledTimes(1);
    expect(deps.deleteActiveWorkflowStepSession).toHaveBeenCalledWith("task-1");
    expect(deps.activeWorkflowStepSessions.has("task-1")).toBe(false);
    expect(summary).toEqual({
      hadActiveSurface: true,
      abortedSurfaces: ["agent-session", "workflow-step-session"],
      preservedSurfaces: [],
    });
  });

  it("preserveWorkflowStepSession: write surfaces die, the review gate's session survives untouched", async () => {
    const { deps, agentSession, workflowStepSession } = makeDeps();

    const summary = await awaitAbortInFlightTaskWork(deps, "task-1", "assignee-transfer", {
      preserveWorkflowStepSession: true,
    });

    // The previous owner's implementation surface is gone...
    expect(agentSession.abort).toHaveBeenCalledTimes(1);
    expect(agentSession.dispose).toHaveBeenCalledTimes(1);
    expect(deps.deleteActiveSession).toHaveBeenCalledWith("task-1");
    // ...and the live prompt-lane session is left exactly as it was: no abort, no dispose, and it
    // stays registered so the review lane keeps owning it.
    expect(workflowStepSession.abort).not.toHaveBeenCalled();
    expect(workflowStepSession.dispose).not.toHaveBeenCalled();
    expect(deps.deleteActiveWorkflowStepSession).not.toHaveBeenCalled();
    expect(deps.activeWorkflowStepSessions.has("task-1")).toBe(true);
    expect(summary).toEqual({
      hadActiveSurface: true,
      abortedSurfaces: ["agent-session"],
      preservedSurfaces: ["workflow-step-session"],
    });
  });

  it("reports no preservation when no prompt-lane session was live (honest audit row)", async () => {
    const { deps } = makeDeps();
    deps.activeWorkflowStepSessions.delete("task-1");

    const summary = await awaitAbortInFlightTaskWork(deps, "task-1", "assignee-transfer", {
      preserveWorkflowStepSession: true,
    });

    expect(summary).toEqual({
      hadActiveSurface: true,
      abortedSurfaces: ["agent-session"],
      preservedSurfaces: [],
    });
  });

  it("reports no active surface at all when nothing was running", async () => {
    const { deps } = makeDeps();
    deps.activeSessions.clear();
    deps.activeWorkflowStepSessions.clear();

    const summary = await awaitAbortInFlightTaskWork(deps, "task-1", "assignee-transfer");

    expect(summary).toEqual({ hadActiveSurface: false, abortedSurfaces: [], preservedSurfaces: [] });
    expect(deps.safeLogEntry).not.toHaveBeenCalled();
  });
});
