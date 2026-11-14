import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskDetail } from "@fusion/core";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import { OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import {
  __resetOverlapAcquisitionParkDedup,
  holdRefusedAcquisition,
  recordOverlapAcquisitionPark,
} from "../executor/overlap-acquisition-park.js";
import * as worktreeBackend from "../worktree/worktree-backend.js";

/*
FNXC:OverlapAcquisitionPark 2026-11-14-15:50 (RUFU-1040):
RUFU-896 taught the HEARTBEAT lane to hold instead of fail. This file pins the executor lane's half: the same
refusal must cost a checkout nothing and a budget nothing.

The retain decision is the part a reader will be tempted to "clean up" later, so it is pinned explicitly:
`classifyFileScopeLease` answers `kind:"active"` for a WIP column unconditionally, so releasing the refused
checkout there buys zero wedge relief and converts the next attempt into a fresh `worktree:create` — the churn
this card exists to delete. The heartbeat's release stays the default, unchanged, and this file proves it.

Scope note, stated rather than hidden: this exercises the shared seams (the park helper, the hold writer, the
classifier and the graph-failure router in `overlap-wait-graph-routing.test.ts`) rather than driving all of
`runImplementation`, whose dependency bag is a fixture farm rather than a test. The refusal's full walk is
covered at every seam it changes.
*/

const CHECKOUT = "/repo/.fusion/worktrees/fn-1";

function taskShape(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1", title: "t", description: "d", column: "in-progress", dependencies: [], steps: [], log: [],
    worktree: CHECKOUT, branch: "fusion/fn-1", baseCommitSha: "aaaa1111",
    ...overrides,
  } as Task;
}

function refusal(overrides: Partial<{ episodeIds: string[]; blockerTaskIds: string[] }> = {}) {
  return new OverlapResumeSynchronizationError("delivery-unavailable", OVERLAP_DELIVERY_UNAVAILABLE_ERROR, {
    episodeIds: overrides.episodeIds ?? ["ep-1"],
    blockerTaskIds: overrides.blockerTaskIds ?? ["FN-A"],
    repositories: ["repo-a"],
    missingEvidence: "delivery-evidence-unavailable",
  });
}

function storeShape(task: Task) {
  const row = { ...task } as Record<string, unknown>;
  return {
    row,
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async () => row as TaskDetail),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(row, patch);
    }),
    logEntry: vi.fn(async () => undefined),
    transitionQueuedEpisode: vi.fn(async (_id: string, transition: Record<string, unknown>) => {
      row.status = "queued";
      row.overlapBlockedBy = transition.overlapBlockedBy ?? null;
      return { appended: true, task: row as TaskDetail };
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  };
}

describe("an executor-lane overlap refusal retains its checkout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetOverlapAcquisitionParkDedup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports `retained-wip-lease` and removes nothing when the caller declines the release", async () => {
    const remove = vi.spyOn(worktreeBackend, "removeWorktree").mockResolvedValue({
      removed: true, classification: "removed",
    } as any);
    const store = storeShape(taskShape());

    const outcome = await recordOverlapAcquisitionPark({
      store: store as never,
      rootDir: "/repo",
      task: store.row as Task,
      agentId: "executor",
      error: refusal(),
      releaseRegistration: false,
    });

    expect(outcome.registrationRelease).toBe("retained-wip-lease");
    // The churn itself: a WIP-lane refusal must not reach removal at all.
    expect(remove).not.toHaveBeenCalled();
    // Pointers survive, so the next attempt is a reuse rather than a rebuild.
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ worktree: null }));
    expect(store.row.worktree).toBe(CHECKOUT);
    expect(store.row.branch).toBe("fusion/fn-1");
  });

  it("keeps the heartbeat's release as the unchanged default so that lane stays byte-identical", async () => {
    const remove = vi.spyOn(worktreeBackend, "removeWorktree").mockResolvedValue({
      removed: true, classification: "removed",
    } as any);
    const store = storeShape(taskShape());

    const outcome = await recordOverlapAcquisitionPark({
      store: store as never,
      rootDir: "/repo",
      task: store.row as Task,
      agentId: "agent-1",
      error: refusal(),
    });

    expect(outcome.registrationRelease).toBe("removed");
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: CHECKOUT, taskId: "FN-1" }));
    expect(store.row.worktree).toBeNull();
  });

  it("records one bounded row per episode naming the executor as the producing agent", async () => {
    vi.spyOn(worktreeBackend, "removeWorktree").mockResolvedValue({ removed: true, classification: "removed" } as any);
    const store = storeShape(taskShape());
    const input = {
      store: store as never,
      rootDir: "/repo",
      task: store.row as Task,
      agentId: "executor",
      error: refusal(),
      releaseRegistration: false,
    } as const;

    await recordOverlapAcquisitionPark(input);
    await recordOverlapAcquisitionPark(input);

    const rows = store.recordRunAuditEvent.mock.calls
      .map((call: any[]) => call[0])
      .filter((entry: any) => entry.mutationType === "task:overlap-acquisition-parked");
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe("executor");
    expect(rows[0].metadata).toMatchObject({
      reason: "delivery-unavailable",
      blockerTaskIds: ["FN-A"],
      strikeBudgetConsumed: 0,
      registrationRelease: "retained-wip-lease",
    });
  });

  it("writes the wait as a hold naming exactly one sorted predecessor and no error prose", async () => {
    const store = storeShape(taskShape());

    const write = await holdRefusedAcquisition({
      store: store as never,
      task: store.row as Task,
      blockers: ["FN-B", "FN-A"],
      episodeIds: ["ep-9"],
      reason: "typed-refusal",
    });

    expect(write).toBe("held");
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      // Every live value is a single id, so the deterministic first (sorted) is the name that must not
      // oscillate between two predecessors across retries.
      overlapBlockedBy: "FN-A",
      signature: "overlap-acquisition:typed-refusal:ep-9",
    }));
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({
      error: expect.anything(),
    }));
    expect(store.row.status).toBe("queued");
    expect(store.row.error).toBeUndefined();
    // No strike, no terminal write, no column move anywhere on this path.
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "failed" }));
  });
});
