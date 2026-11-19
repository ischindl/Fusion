import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
RUFU-552: the executor lane's dependency writes refuse in-band, they do not throw.

Every case drives the real tool against a store whose `updateTask` throws the real core error, because the
defect was that a durable board rule (`assertNoDependencyCycleImpl`, which refuses BEFORE the write) escaped
as an exception out of the tool boundary. The store's verdict is not mocked and not re-implemented here.

Three shapes are asserted on every surface: the tool RESOLVES with a refusal, the refused half did not
half-apply, and the refused edge is recorded on the card - the agent log keeps tool names, never arguments,
so without the card log line the proposed edge is unrecoverable after the fact.
*/
import { describe, expect, it, vi } from "vitest";
import { DependencyCycleError, type Task, type TaskStore } from "@fusion/core";
import { createTaskUpdateTool } from "../executor/create-task-update-tool.js";
import { createTaskAddDepTool } from "../executor/task-add-dep-tool.js";
import { STORE_RETRY_GUIDANCE } from "../tool-store-errors.js";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const TASK_ID = "SANE-480";
const BLOCKER = "SANE-479";
const OUTAGE = "connection terminated unexpectedly";
/** The refused loop as the card's History line renders it (ASCII arrows, so any log reader survives). */
const SANE_EDGE = "SANE-480 -> SANE-479 -> SANE-480";

/** A refusal the store produces before it writes: `SANE-480 -> SANE-479 -> SANE-480`. */
function cycleError(taskId = TASK_ID, dep = BLOCKER): DependencyCycleError {
  return new DependencyCycleError(taskId, [taskId, dep, taskId]);
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Reconcile the plugin sync queue",
    column: "in-progress",
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "pending" },
    ],
    dependencies: [BLOCKER],
    log: [],
    ...overrides,
  } as unknown as Task;
}

function store(opts: {
  updateTask?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  updateStep?: ReturnType<typeof vi.fn>;
  logEntry?: ReturnType<typeof vi.fn>;
} = {}) {
  const getTask = vi.fn(async () => task());
  const updateStep = opts.updateStep ?? vi.fn(async () => task({ steps: [
    { name: "Preflight", status: "done" },
    { name: "Implement", status: "done" },
  ] }));
  const logEntry = opts.logEntry ?? vi.fn(async () => undefined);
  const updateTask = vi.fn(opts.updateTask ?? (async () => task()));
  const instance = {
    isBackendMode: () => false,
    getTask,
    updateTask,
    updateStep,
    logEntry,
  } as unknown as TaskStore;
  return { instance, getTask, updateTask, updateStep, logEntry };
}

function updateTool(storeInstance: TaskStore) {
  return createTaskUpdateTool(
    { store: storeInstance, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() },
    TASK_ID,
    new Map(),
    { current: null },
  );
}

const run = (tool: { execute: (...args: any[]) => Promise<any> }, params: Record<string, unknown>) =>
  tool.execute("call-1", params);

describe("executor fn_task_update - dependencies-only write (RUFU-552 Step 2)", () => {
  it("resolves with a refusal naming the cycle instead of rejecting", async () => {
    const s = store({ updateTask: vi.fn(async () => { throw cycleError(); }) });

    const result = await run(updateTool(s.instance), { dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    // The loop has to be readable, not just counted.
    expect(result.content[0].text).toMatch(/SANE-480.*SANE-479.*SANE-480/);
    expect(result.content[0].text).not.toContain(STORE_RETRY_GUIDANCE);
    expect(s.updateTask).toHaveBeenCalledTimes(1);
    // No success row: the store refused, so nothing may claim the edge was written.
    expect(result.content[0].text).not.toContain("Dependencies updated");
  });

  it("records the refused edge on the card, which the agent log cannot carry", async () => {
    const s = store({ updateTask: vi.fn(async () => { throw cycleError(); }) });

    await run(updateTool(s.instance), { dependencies: [BLOCKER] });

    expect(s.logEntry).toHaveBeenCalledTimes(1);
    const [taskId, message] = s.logEntry.mock.calls[0] as [string, string];
    expect(taskId).toBe(TASK_ID);
    expect(message).toContain(SANE_EDGE);
    expect(message).toContain("refused");
  });

  it("keeps the retry-guidance shape for a transient rejection", async () => {
    const s = store({ updateTask: vi.fn(async () => { throw new Error(OUTAGE); }) });

    const result = await run(updateTool(s.instance), { dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("STORE_UNAVAILABLE");
    expect(result.content[0].text).toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0].text).not.toContain("DEPENDENCY_CYCLE");
    expect(s.logEntry).not.toHaveBeenCalled();
  });

  it("says the title persisted when a rename in the same call already landed", async () => {
    const s = store({ updateTask: vi.fn(async (id, patch) => (patch.title !== undefined ? task({ title: "Renamed card" }) : (() => { throw cycleError(); })())) });

    const result = await run(updateTool(s.instance), { title: "Renamed card", dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    expect(result.content[0].text).toContain("Renamed card");
  });
});

describe("executor fn_task_update - combined step + dependencies write (RUFU-552 Step 2)", () => {
  it("refuses before the step write, so nothing half-applies", async () => {
    const s = store({ updateTask: vi.fn(async () => { throw cycleError(); }) });

    const result = await run(updateTool(s.instance), { step: 1, status: "done", dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    expect(s.updateStep).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/SANE-480.*SANE-479.*SANE-480/);
    expect(result.content[0].text).toContain("was NOT applied");
  });

  it("still writes the step when the dependency half succeeds", async () => {
    const s = store();

    const result = await run(updateTool(s.instance), { step: 1, status: "done", dependencies: ["SANE-100"] });

    expect(s.updateTask).toHaveBeenCalledTimes(1);
    expect(s.updateStep).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
  });
});

/*
 * fn_task_add_dep owns side effects the other two sites do not: below its write sit the success History
 * line, `depAborted`, and `session.dispose()`. The store refusal threw out having aborted nothing, killing
 * the agent turn while leaving the run nominally alive - the worst of both.
 */
function addDepStore(opts: { updateTask?: (id: string, patch: Record<string, unknown>) => Promise<unknown> } = {}) {
  const depAborted = new Set<string>();
  const dispose = vi.fn();
  const terminateAllSessions = vi.fn(async () => undefined);
  const logEntry = vi.fn(async () => undefined);
  const updateTask = vi.fn(opts.updateTask ?? (async () => task()));
  const getTask = vi.fn(async (id: string) => {
    if (id === BLOCKER) return { id: BLOCKER, dependencies: [TASK_ID], sourceParentTaskId: null } as unknown as Task;
    return task({ dependencies: [] });
  });
  const instance = {
    isBackendMode: () => false,
    getTask,
    updateTask,
    logEntry,
  } as unknown as TaskStore;
  const tool = createTaskAddDepTool(
    {
      store: instance,
      depAborted,
      getActiveSession: () => ({ session: { dispose } }),
      getActiveStepExecutor: () => ({ terminateAllSessions }),
    },
    TASK_ID,
  );
  return { tool, depAborted, dispose, terminateAllSessions, logEntry, updateTask };
}

describe("executor fn_task_add_dep - refusal comes before the abort side effects (RUFU-552 Step 3)", () => {
  it("resolves with a refusal and leaves the run and its dependency list untouched", async () => {
    const h = addDepStore({ updateTask: vi.fn(async () => { throw cycleError(); }) });

    const result = await run(h.tool, { task_id: BLOCKER, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    expect(result.content[0].text).toMatch(/SANE-480.*SANE-479.*SANE-480/);
    expect(result.content[0].text).not.toContain(STORE_RETRY_GUIDANCE);
    // Nothing below the write may run: no abort, no disposal, no success row.
    expect(h.depAborted.has(TASK_ID)).toBe(false);
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.terminateAllSessions).not.toHaveBeenCalled();
    const logged = h.logEntry.mock.calls.map((c) => String(c[1])).join("\n");
    expect(logged).not.toContain("Added dependency on");
    expect(logged).toContain(SANE_EDGE);
    expect(logged).toContain("was not aborted");
  });

  it("keeps the existing abort flow for a dependency the board accepts", async () => {
    const accepted = "SANE-100";
    const h = addDepStore();

    const result = await run(h.tool, { task_id: accepted, confirm: true });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Added dependency on ${accepted}`);
    expect(h.depAborted.has(TASK_ID)).toBe(true);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the transient shape for an outage rather than calling it a rule", async () => {
    const h = addDepStore({ updateTask: vi.fn(async () => { throw new Error(OUTAGE); }) });

    const result = await run(h.tool, { task_id: BLOCKER, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("STORE_UNAVAILABLE");
    expect(result.content[0].text).toContain(STORE_RETRY_GUIDANCE);
    expect(h.depAborted.has(TASK_ID)).toBe(false);
  });

  it("keeps the existing guard refusals for self-spawn and duplicates", async () => {
    const spawned = "SANE-480-CHILD";
    const h = addDepStore();
    const selfSpawnedTool = createTaskAddDepTool(
      {
        store: {
          isBackendMode: () => false,
          getTask: vi.fn(async (id: string) =>
            id === spawned
              ? ({ id: spawned, dependencies: [], sourceParentTaskId: TASK_ID } as unknown as Task)
              : task({ dependencies: [] })),
          updateTask: vi.fn(async () => task()),
          logEntry: vi.fn(async () => undefined),
        } as unknown as TaskStore,
        depAborted: new Set<string>(),
        getActiveSession: () => undefined,
        getActiveStepExecutor: () => undefined,
      },
      TASK_ID,
    );

    const spawnedResult = await run(selfSpawnedTool, { task_id: spawned, confirm: true });
    expect(spawnedResult.details).toEqual({ code: "SELF_SPAWNED_DEPENDENCY", dependencyId: spawned });
    expect(spawnedResult.content[0].text).toContain("self-spawned");

    const duplicateTool = createTaskAddDepTool(
      {
        store: {
          isBackendMode: () => false,
          getTask: vi.fn(async (id: string) =>
            id === BLOCKER
              ? ({ id: BLOCKER, dependencies: [], sourceParentTaskId: null } as unknown as Task)
              : task({ dependencies: [BLOCKER] })),
          updateTask: vi.fn(async () => task()),
          logEntry: vi.fn(async () => undefined),
        } as unknown as TaskStore,
        depAborted: new Set<string>(),
        getActiveSession: () => undefined,
        getActiveStepExecutor: () => undefined,
      },
      TASK_ID,
    );

    const duplicateResult = await run(duplicateTool, { task_id: BLOCKER, confirm: true });
    expect(duplicateResult.content[0].text).toContain("already a dependency");
  });
});

/*
 * fn_task_done owns the opposite risk: here the refused half is `dependencies` but the patch also carries
 * the honest `BLOCKED:` park. A throw used to lose the report itself, so the card that was genuinely
 * blocked on another card reported nothing at all. The park survives; the edge is what degrades.
 */
function doneCard(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: "Reconcile the plugin sync queue",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/sync-queue",
    branch: "fusion/sane-480",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    steps: [{ name: "Implement", status: "in-progress" as const }, { name: "Testing", status: "pending" as const }],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
async function doneSetup(opts: {
  /** Model the store's own guard: a patch that would set dependencies is refused as a cycle. */
  refuseDependencies?: boolean;
  /** Every write fails, which is an unreachable store rather than a board rule. */
  outage?: boolean;
} = {}) {
  const store = createMockStore();
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  store.getAgentLogCount = vi.fn().mockResolvedValue(0);
  let card: any = doneCard();

  store.getTask.mockImplementation(async (id: string) => {
    if (id === TASK_ID) return { ...card, steps: card.steps.map((s: any) => ({ ...s })) };
    // The blocker really does depend on this card, which is what makes the proposed edge a cycle.
    return { id, dependencies: id === BLOCKER ? [TASK_ID] : [], sourceParentTaskId: null };
  });
  store.updateTask.mockImplementation(async (id: string, patch: any) => {
    if (opts.outage) throw new Error(OUTAGE);
    if (opts.refuseDependencies && Array.isArray(patch.dependencies)) throw cycleError();
    card = { ...card, ...patch };
    return card;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  const tool = (executor as any).createTaskDoneTool(card.id, card.worktree, "", new Map(), vi.fn());
  return { store, tool, getTask: () => card };
}

describe("fn_task_done keeps the honest blocked park when blockedBy closes a cycle (RUFU-552 Step 4)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/sync-queue\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/sane-480\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still parks the card blocked and drops only the cyclic edge", async () => {
    const h = await doneSetup({ refuseDependencies: true });

    const result = await h.tool.execute("id", {
      outcome: "blocked",
      obstacle: "inside-worktree",
      reason: `The sync queue contract lives in ${BLOCKER}, which must land first.`,
      blockedBy: [BLOCKER],
    });

    const parked = h.getTask();
    expect(parked.status).toBe("failed");
    expect(String(parked.error)).toMatch(/^BLOCKED:/);
    // The refusal happens before the write, so the list must be exactly what it was.
    expect(parked.dependencies).toEqual([]);
    // Steps keep their true statuses - a blocked exit is not a completion claim.
    expect(parked.steps.map((s: any) => s.status)).toEqual(["in-progress", "pending"]);
    expect(result.content[0].text).toContain(BLOCKER);
    expect(result.content[0].text).toContain("cycle");
    expect(result.content[0].text).toContain("manual retry");

    const messages = h.store.logEntry.mock.calls.map((c: any[]) => String(c[1])).join("\n");
    expect(messages).toContain(BLOCKER);
    expect(messages).toContain("NOT recorded");

    /*
    FNXC:DependencyRefusal 2026-11-19-03:05 (RUFU-552):
    `blockedBy` on this row reads as the durable edges the park recorded. After a degradation the store
    refused them, so the honest value is empty - naming the requested id here would claim an edge the row
    does not hold, which is the invisible-state shape this card exists to remove.
    */
    const parkedRow = h.store.recordRunAuditEvent.mock.calls
      .map((c: any[]) => c[0])
      .find((call: any) => call?.mutationType === "task:execution-blocked-parked");
    expect(parkedRow?.metadata?.blockedBy).toEqual([]);
  });

  it("records the edge and parks in one write when nothing closes a loop", async () => {
    const h = await doneSetup();

    const result = await h.tool.execute("id", {
      outcome: "blocked",
      obstacle: "inside-worktree",
      reason: "Waiting on two independent upstream contracts.",
      blockedBy: ["SANE-100", "SANE-200"],
    });

    const parked = h.getTask();
    expect(parked.status).toBe("failed");
    expect(parked.dependencies).toEqual(["SANE-100", "SANE-200"]);
    expect(result.content[0].text).toContain("Recorded 2");
    const dependencyWrites = h.store.updateTask.mock.calls.filter((c: any[]) => Array.isArray(c[1]?.dependencies));
    expect(dependencyWrites).toHaveLength(1);
    // The counter-direction positive: when the edges persisted, the row must name them.
    const parkedRow = h.store.recordRunAuditEvent.mock.calls
      .map((c: any[]) => c[0])
      .find((call: any) => call?.mutationType === "task:execution-blocked-parked");
    expect(parkedRow?.metadata?.blockedBy).toEqual(["SANE-100", "SANE-200"]);
  });

  it("keeps the existing outage behavior rather than the degradation path", async () => {
    const h = await doneSetup({ outage: true });

    await expect(h.tool.execute("id", {
      outcome: "blocked",
      obstacle: "inside-worktree",
      reason: `Blocked on ${BLOCKER}, which is still open.`,
      blockedBy: [BLOCKER],
    })).rejects.toThrow(OUTAGE);

    // Exactly one attempt: the degraded retry is reserved for a board rule, not for an unreachable store.
    expect(h.store.updateTask.mock.calls).toHaveLength(1);
    expect(h.getTask().dependencies).toEqual([]);
    expect(String(h.getTask().error ?? "")).not.toMatch(/^BLOCKED:/);
  });
});
