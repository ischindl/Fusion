/*
FNXC:CheckoutEmptinessInvalidation 2026-10-02-05:47 (RUFU-487 step 1):
`invalidatePath`/`invalidateAll` existed with no production caller, so the 10s TTL was the ONLY freshness
mechanism for a verdict that gates whether a dormant lease may be downgraded. These tests pin the invariant
that made the TTL safe to keep: a lifecycle mutation drops the verdicts of the checkouts it can dirty, a
workspace card drops EVERY member repository (not just the singular `worktree`), and an unattributable
mutation drops everything — because a missing verdict keeps a blocker blocking while a stale "empty" can
release live work.

The scheduler case is the one with teeth: it fails if the wiring is missing, because then the handler is
the only thing that would have invalidated and the cached verdict answers with no git call at all.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import {
  checkoutEmptinessProverFor,
  invalidateEmptinessProofsForTask,
  resetCheckoutEmptinessProversForTesting,
  type CheckoutEmptinessExec,
} from "../worktree/checkout-emptiness.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

const ROOT = "/test/project";

function makeExec() {
  const calls: string[] = [];
  const exec: CheckoutEmptinessExec = async (command, options) => {
    calls.push(`${command}@@${options.cwd}`);
    return { stdout: "" };
  };
  return { calls, exec };
}

function proverWith(exec: CheckoutEmptinessExec) {
  return checkoutEmptinessProverFor(ROOT, {
    execImpl: exec,
    integrationBranch: "main",
    settings: {},
  });
}

const singularTask = {
  id: "RUFU-1",
  worktree: "/wt/rufu-1",
  branch: "fusion/RUFU-1",
  baseCommitSha: null,
};

const workspaceTask = {
  id: "RUFU-2",
  worktree: null,
  branch: "fusion/RUFU-2",
  baseCommitSha: null,
  workspaceWorktrees: {
    "apps/api": { worktreePath: "/wt/rufu-2/apps-api", branch: "fusion/RUFU-2" },
    "packages/core": { worktreePath: "/wt/rufu-2/packages-core", branch: "fusion/RUFU-2" },
  },
};

afterEach(() => {
  resetCheckoutEmptinessProversForTesting();
});

describe("invalidateEmptinessProofsForTask", () => {
  it("drops a singular checkout so the next proof re-runs git instead of serving a stale verdict", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);

    await prover.proveTask(singularTask);
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await prover.proveTask(singularTask);
    expect(calls.length).toBe(afterFirst); // served from cache

    invalidateEmptinessProofsForTask(ROOT, singularTask);
    await prover.proveTask(singularTask);
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("drops every workspace member repository, not only the singular worktree", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);

    await prover.proveTask(workspaceTask);
    const afterFirst = calls.length;
    const touchedPaths = new Set(calls.map((c) => c.split("@@")[1]));
    expect(touchedPaths).toEqual(new Set(["/wt/rufu-2/apps-api", "/wt/rufu-2/packages-core"]));

    invalidateEmptinessProofsForTask(ROOT, workspaceTask);
    await prover.proveTask(workspaceTask);
    const reProved = new Set(calls.slice(afterFirst).map((c) => c.split("@@")[1]));
    expect(reProved).toEqual(new Set(["/wt/rufu-2/apps-api", "/wt/rufu-2/packages-core"]));
  });

  it("leaves another task's verdicts standing when the mutated task names a path", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);
    const other = { ...singularTask, id: "RUFU-9", worktree: "/wt/rufu-9" };

    await prover.proveTasks([singularTask, other]);
    const afterFirst = calls.length;

    invalidateEmptinessProofsForTask(ROOT, singularTask);
    await prover.proveTasks([singularTask, other]);
    const reProvedPaths = new Set(calls.slice(afterFirst).map((c) => c.split("@@")[1]));
    expect(reProvedPaths).toEqual(new Set(["/wt/rufu-1"]));
  });

  it("invalidates everything for a mutation that names no checkout, so nothing stale survives", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);
    const other = { ...singularTask, id: "RUFU-9", worktree: "/wt/rufu-9" };

    await prover.proveTasks([singularTask, other]);
    const afterFirst = calls.length;

    invalidateEmptinessProofsForTask(ROOT, { id: "RUFU-UNATTRIBUTED", worktree: null });
    await prover.proveTasks([singularTask, other]);
    const reProvedPaths = new Set(calls.slice(afterFirst).map((c) => c.split("@@")[1]));
    expect([...reProvedPaths].sort()).toEqual(["/wt/rufu-1", "/wt/rufu-9"]);
  });
});

describe("scheduler wiring", () => {
  function createStore(tasks: Record<string, unknown>[]) {
    const listeners = new Map<string, ((payload: unknown) => void)[]>();
    const store = {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      }),
      off: vi.fn(),
      getRootDir: vi.fn().mockReturnValue(ROOT),
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    return {
      store,
      emit: async (event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) await listener(payload);
      },
    };
  }

  const movedTask = {
    ...singularTask,
    column: "in-progress",
    status: null,
    deletedAt: null,
    dependencies: [],
  };

  it("drops the moved card's proof, so the next scheduling pass re-proves it", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);
    await prover.proveTask(singularTask);
    const afterFirst = calls.length;

    const { store, emit } = createStore([movedTask]);
    const scheduler = new Scheduler(store, {} as never);
    vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
    (scheduler as unknown as { running: boolean }).running = true;

    await emit("task:moved", {
      task: movedTask,
      from: "in-progress",
      to: "in-review",
      source: "engine",
      lanes: {},
    });
    await flushAsyncHandlers();

    await prover.proveTask(singularTask);
    expect(calls.length).toBeGreaterThan(afterFirst);
    vi.restoreAllMocks();
  });

  it("drops the proof of a deleted card's checkout too", async () => {
    const { calls, exec } = makeExec();
    const prover = proverWith(exec);
    await prover.proveTask(singularTask);
    const afterFirst = calls.length;

    const { store, emit } = createStore([movedTask]);
    const scheduler = new Scheduler(store, {} as never);
    vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
    (scheduler as unknown as { running: boolean }).running = true;

    await emit("task:deleted", movedTask);
    await flushAsyncHandlers();

    await prover.proveTask(singularTask);
    expect(calls.length).toBeGreaterThan(afterFirst);
    vi.restoreAllMocks();
  });
});
