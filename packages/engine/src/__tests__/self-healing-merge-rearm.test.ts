/**
 * RUFU-834 Step 4 — the `reconcile-inert-merge-node` sweep: discovery, registration, and the suppressions
 * that keep it out of another owner's card.
 *
 * The population this file must not miss is the one RUFU-293 measured: a card in a review lane, both
 * pre-merge gates approved, no status, no error, one `kind:"task"` row `failed` at the merge node, and a
 * file-scope lease holding >100 other cards in `held`. Every suppressed case below is that row plus
 * exactly one changed fact, so a narrowed sweep shows up as a changed verdict and not as a silent hole.
 *
 * Two structural invariants are pinned here rather than in the unit tests:
 *  - discovery is a PAGED board read with ONE batched work-item read per page. An unpaginated `limit`
 *    keeps the OLDEST N cards by `created_at`, which would blind the sweep to its own population; an
 *    unbatched read is the N+1 shape RUFU-767 measured at 3 200 queries per 60 s.
 *  - the seam is registered in BOTH startup recovery and maintenance batch 1, ordered before the revival
 *    lanes, so a card freed here is classified in the same pass.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { SelfHealingManager } from "../self-healing.js";

const MIN = 60_000;
const STALE = new Date(Date.now() - 14 * 24 * 60 * MIN).toISOString();
const FRESH = new Date(Date.now() - 5_000).toISOString();

/** The live-evidence IR shape: a node literally named `merge` that is `{ kind:"prompt", config:{seam:"merge"} }`. */
function mergeIr(reviewColumnId = "in-review") {
  return {
    version: "v2",
    columns: [
      { id: "todo", name: "Todo", role: "todo", traits: [{ trait: "intake" }] },
      { id: reviewColumnId, name: "Review", role: "review", traits: [{ trait: "merge-blocker" }] },
      { id: "done", name: "Done", role: "done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "plan-review", kind: "optional-group", column: reviewColumnId, config: { name: "Plan Review", defaultOn: true } },
      { id: "code-review", kind: "optional-group", column: reviewColumnId, config: { name: "Code Review", defaultOn: true } },
      { id: "merge", kind: "prompt", column: reviewColumnId, config: { seam: "merge" } },
      { id: "cleanup", kind: "end", column: "done" },
    ],
    edges: [],
  } as any;
}

function inertTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-834",
    title: "inert failed merge node",
    column: "in-review",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    worktree: ".fusion/worktrees/rufu-834",
    branch: "fusion/rufu-834",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    steps: [{ id: "0", title: "Preflight", status: "done" }, { id: "1", title: "Implementation", status: "done" }],
    workflowStepResults: [
      { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
    ],
    mergeDetails: { mergeRetries: 0, commitSha: null },
    dependencies: [],
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  } as any;
}

function failedMergeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1", runId: "run-1", taskId: "RUFU-834", nodeId: "merge", kind: "task",
    state: "failed", attempt: 1, retryAfter: null, leaseOwner: null, leaseExpiresAt: null,
    lastError: "workflow-graph-node-failed", blockedReason: null, createdAt: STALE, updatedAt: STALE,
    ...overrides,
  } as any;
}

/**
 * Store double for the sweep: a paged board read, ONE batched work-item read per page, and the per-card
 * reads `attemptMergeRearm` makes. `recordRunAuditEvent` is replaceable so the sink-health case can hand
 * the seam a hostile one.
 */
function makeSweepStore(options: {
  tasks?: any[];
  rows?: any[];
  settings?: Record<string, unknown>;
  audit?: (event: Record<string, unknown>) => unknown;
} = {}) {
  const tasks = options.tasks ?? [inertTask()];
  const rows = options.rows ?? [failedMergeRow()];
  const seeded: any[] = [];
  const auditRows: any[] = [];
  const audit = options.audit ?? (async (event: Record<string, unknown>) => { /* accepted */ });
  function applyPatch(id: string, patch: any) {
    const task = tasks.find((row) => row.id === id);
    if (!task) return null;
    const { sourceMetadataPatch, ...rest } = patch ?? {};
    Object.assign(task, rest);
    if (sourceMetadataPatch) {
      task.sourceMetadata = { ...(task.sourceMetadata ?? {}) };
      for (const [key, value] of Object.entries(sourceMetadataPatch)) {
        if (value === null) delete task.sourceMetadata[key];
        else task.sourceMetadata[key] = value;
      }
    }
    return task;
  }
  const store: any = {
    recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
      auditRows.push(event);
      return audit(event);
    }),
    getRootDir: () => "/repo",
    getSettings: vi.fn(async () => ({ autoMerge: true, integrationBranch: "main", ...(options.settings ?? {}) })),
    listTasks: vi.fn(async (input: any) => {
      // Faithful to the paging contract: a page is a window over the board, not the whole table.
      const start = input?.offset ?? 0;
      return tasks.slice(start, start + (input?.limit ?? tasks.length));
    }),
    listWorkflowWorkItemsForTasks: vi.fn(async (ids: string[]) => {
      const map = new Map<string, any[]>();
      for (const id of ids) map.set(id, rows.map((row) => ({ ...row, taskId: id })));
      return map;
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => rows),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    getTaskWorkflowSelection: () => ({ workflowId: "custom:mergeflow", stepIds: ["plan-review", "code-review"] }),
    getWorkflowDefinition: async () => ({ ir: mergeIr() }),
    updateTask: vi.fn(async (id: string, patch: any) => applyPatch(id, patch)),
    updateTaskAtomic: vi.fn(async (id: string, reducer: any) => {
      const current = tasks.find((task) => task.id === id);
      if (!current) return null;
      const patch = reducer(current);
      return patch ? applyPatch(id, patch) : null;
    }),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: any) => { seeded.push(input); return input; }),
    logEntry: vi.fn(async () => undefined),
    logEntryOnce: vi.fn(async () => true),
    moveTask: vi.fn(async () => undefined),
  };
  return { store, seeded, auditRows, tasks };
}

function managerFor(store: any, options: Record<string, unknown> = {}) {
  return new SelfHealingManager(store, {
    rootDir: "/repo",
    getExecutingTaskIds: () => new Set<string>(),
    isTaskActive: () => false,
    /*
    The evidence gate is the card's own checkout prover. A unit test has no repository at `/repo`, so the
    manager is wired the way a host wires it: a prover that answers `occupied` (unlanded delivery present),
    which is the ONLY granting verdict. A case that needs the refusing verdict overrides this.
    */
    checkoutEmptinessProver: { proveTask: async () => new Map([["", "occupied"]]) },
    ...options,
  } as any);
}

describe("RUFU-834 Step 4: the inert-merge-node sweep re-arms its population", () => {
  it("re-arms the measured RUFU-293 shape and reports exactly one pass", async () => {
    const { store, seeded, auditRows } = makeSweepStore();
    const manager = managerFor(store);
    await expect(manager.reconcileInertMergeNode()).resolves.toBe(1);

    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ taskId: "RUFU-834", nodeId: "merge", kind: "task", state: "retrying" });
    // The paired audit row exists with ids/counts/fixed enums only.
    const pass = auditRows.find((row) => row.mutationType === "task:reconcile-inert-merge-node");
    expect(pass?.metadata).toMatchObject({ taskId: "RUFU-834", column: "in-review", nodeId: "merge", outcome: "rearmed" });
    manager.stop();
  });

  it("discovers a review lane whose column id is NOT the `in-review` literal", async () => {
    // RUFU-272's renamed-board hole: matching the literal would silently blind the sweep on a renamed lane.
    const tasks = [inertTask({ column: "waiting-on-deploy" })];
    const { store, seeded } = makeSweepStore({ tasks });
    store.getWorkflowDefinition = async () => ({ ir: mergeIr("waiting-on-deploy") });
    const manager = managerFor(store);
    await expect(manager.reconcileInertMergeNode()).resolves.toBe(1);
    expect(seeded[0]?.nodeId).toBe("merge");
    manager.stop();
  });

  it("pages the board and reads work items ONCE per page, never once per card", async () => {
    const tasks = [inertTask(), inertTask({ id: "RUFU-835" }), inertTask({ id: "RUFU-836" })];
    const { store } = makeSweepStore({ tasks });
    const manager = managerFor(store);
    await manager.reconcileInertMergeNode();

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.listTasks.mock.calls[0][0]).toMatchObject({ limit: 500, offset: 0, includeArchived: false });
    expect(store.listWorkflowWorkItemsForTasks).toHaveBeenCalledTimes(1);
    expect(store.listWorkflowWorkItemsForTasks.mock.calls[0][0]).toHaveLength(3);
    manager.stop();
  });

  it("never moves a column, on the grant path and on the exhaustion path", async () => {
    // Grant path.
    const grant = makeSweepStore();
    await managerFor(grant.store).reconcileInertMergeNode();
    expect(grant.store.moveTask).not.toHaveBeenCalled();
    expect(grant.tasks[0].column).toBe("in-review");

    // Exhaustion path: spend the whole declared ladder (4 attempts + 12 refusals), and still no move —
    // the card must reach `failed` with the sentinel in the SAME lane.
    const exhausted = makeSweepStore();
    const manager = managerFor(exhausted.store);
    for (let pass = 0; pass < 20; pass += 1) {
      await manager.reconcileInertMergeNode();
      exhausted.store.replaceActiveTaskWorkflowContinuation.mockClear();
    }
    expect(exhausted.store.moveTask).not.toHaveBeenCalled();
    const card = await exhausted.store.getTask("RUFU-834");
    expect(card.column).toBe("in-review");
    // and the card answers `failed` with the sentinel, which is the shape the lease release admits.
    expect(card.status).toBe("failed");
    expect(String(card.error).startsWith("MERGE_REARM_EXHAUSTED:")).toBe(true);
    manager.stop();
  });

  it.each([
    { label: "a global pause", settings: { globalPause: true }, expect: "no-read" },
    { label: "an engine pause", settings: { enginePaused: true }, expect: "no-read" },
    { label: "an operator user-pause", task: { userPaused: true }, expect: "pre-filtered" },
    { label: "a recovery pause", task: { paused: true }, expect: "pre-filtered" },
    { label: "a card with no checkout to hold", task: { worktree: null }, expect: "pre-filtered" },
    { label: "an executing card", executing: true, expect: "pre-filtered" },
    { label: "no failed row at all", rows: [{ ...failedMergeRow(), state: "succeeded" }], expect: "pre-filtered" },
    { label: "a withheld auto-merge (FN-5147)", settings: { autoMerge: false }, task: { autoMerge: undefined }, expect: "refused:auto-merge-withheld" },
    { label: "a live executor session", live: true, expect: "refused:live-session" },
    { label: "a merge row only seconds old", rows: [failedMergeRow({ updatedAt: FRESH })], expect: "refused:too-young" },
    { label: "a failure on the step frontier", rows: [failedMergeRow({ nodeId: "step-execute" })], expect: "refused:failure-belongs-to-gate" },
    { label: "a card in a non-review lane", task: { column: "todo" }, expect: "refused:not-review-lane" },
    { label: "a workspace card", task: { workspaceWorktrees: { "packages/cli": { worktreePath: ".fusion/worktrees/rufu-834/packages/cli" } } }, expect: "refused:workspace-owned-elsewhere" },
  ])("withholds on $label", async (input) => {
    const { store, seeded, auditRows } = makeSweepStore({
      tasks: [inertTask({ ...((input as any).task ?? {}) })],
      rows: (input as any).rows,
      settings: (input as any).settings,
    });
    const manager = managerFor(store, {
      isTaskActive: () => (input as any).live === true,
      getExecutingTaskIds: () => new Set<string>((input as any).executing ? ["RUFU-834"] : []),
    });
    const count = await manager.reconcileInertMergeNode();
    expect(count).toBe(0);
    expect(seeded).toHaveLength(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    // No withheld card gets a column write, and none gets a status write either.
    const writes = [...store.updateTask.mock.calls, ...store.updateTaskAtomic.mock.calls] as any[][];
    expect(writes.filter((call) => call[1] && "column" in call[1])).toHaveLength(0);

    const refusal = auditRows.find((row) => row.mutationType === "task:reconcile-inert-merge-node-no-action");
    if (input.expect === "no-read") {
      expect(store.listTasks).not.toHaveBeenCalled();
    } else if (input.expect === "pre-filtered") {
      // The page-cheap gate answered honestly: the card never reached the classifier, so no refusal row.
      expect(refusal).toBeUndefined();
    } else {
      const [expectedCode] = input.expect.split(":").slice(1);
      expect(refusal, JSON.stringify(auditRows.map((row) => row.mutationType))).toBeDefined();
      expect(refusal.metadata).toMatchObject({ taskId: "RUFU-834", outcome: "no-action", code: expectedCode });
    }
    manager.stop();
  });

  it("records one refusal row per (card, code), so a sustained refusal stays countable without re-announcing", async () => {
    // A withheld auto-merge reaches the classifier and refuses identically on every pass.
    const { store, auditRows } = makeSweepStore({
      tasks: [inertTask({ autoMerge: undefined })],
      settings: { autoMerge: false },
    });
    const manager = managerFor(store);
    await manager.reconcileInertMergeNode();
    await manager.reconcileInertMergeNode();
    await manager.reconcileInertMergeNode();

    const refusals = auditRows.filter((row) => row.mutationType === "task:reconcile-inert-merge-node-no-action");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].metadata).toMatchObject({ code: "auto-merge-withheld", outcome: "no-action" });
    manager.stop();
  });

  it("keeps the same pass count under every hostile audit sink", async () => {
    const modes = ["absent", "throw", "reject", "pending", "late-resolve", "late-reject"] as const;
    const counts: number[] = [];
    for (const mode of modes) {
      const settleFns: Array<() => void> = [];
      const audit = mode === "absent" ? undefined : vi.fn<[], unknown>(() => {
        if (mode === "throw") throw new Error("sync audit failure");
        if (mode === "reject") return Promise.reject(new Error("rejected audit failure"));
        if (mode === "pending") return new Promise<void>(() => undefined);
        return new Promise<void>((resolve) => { settleFns.push(resolve); });
      });
      const { store, seeded } = makeSweepStore({ tasks: [inertTask()], audit: audit as any });
      if (mode === "absent") delete store.recordRunAuditEvent;
      else store.recordRunAuditEvent = vi.fn(async (event: Record<string, unknown>) => (audit as any)(event));
      const manager = managerFor(store);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      vi.useFakeTimers();
      try {
        const pending = Promise.resolve().then(() => manager.reconcileInertMergeNode());
        for (let turn = 0; turn < 6; turn += 1) {
          await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
        }
        counts.push(await pending);
        for (const settle of settleFns) settle();
        await Promise.resolve();
        await Promise.resolve();
        expect(unhandled).toEqual([]);
        expect(seeded).toHaveLength(1);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        vi.useRealTimers();
        manager.stop();
      }
    }
    // Six sink behaviors, one identical verdict: telemetry cannot veto a re-arm.
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("RUFU-834 Step 4: registration", () => {
  it("is registered in startup recovery AND maintenance batch 1, both before the revival lanes", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startupStart = source.indexOf("async runStartupRecovery");
    const startupEnd = source.indexOf("  stop(): void");
    const startup = source.slice(startupStart, startupEnd);
    expect(startup).toContain('name: "reconcile-inert-merge-node"');
    expect(startup).toContain("reconcileInertMergeNode");
    // Ordered before the failed-pre-merge-step revival so a card freed here is classified the same pass.
    expect(startup.indexOf('name: "reconcile-inert-merge-node"')).toBeLessThan(
      startup.indexOf('name: "failed-pre-merge-steps"'),
    );
    // Beside its sibling that un-freezes a review-lane park — together they are the review-lane recovery pair.
    expect(startup.indexOf('name: "reconcile-review-revision-stall-parks"')).toBeLessThan(
      startup.indexOf('name: "reconcile-inert-merge-node"'),
    );

    // The maintenance half is a different array in a different method; it must register the SAME sweep,
    // in the same order relative to the revival lanes, or a card stranded without a restart waits for the
    // next engine boot. The task-recovery array is `batch2Fns` (RUFU-280's comment calls that site
    // "maintenance batch 1"); this seam mirrors RUFU-280's registration exactly.
    const maintenance = source.slice(source.indexOf("const batch2Fns"), source.indexOf("for (const fn of batch2Fns)"));
    expect(maintenance).toContain('name: "reconcile-inert-merge-node"');
    expect(maintenance).toContain("reconcileInertMergeNode");
    expect(maintenance).toContain('name: "recover-failed-pre-merge-steps"');
    expect(maintenance.indexOf('name: "reconcile-inert-merge-node"')).toBeLessThan(
      maintenance.indexOf('name: "recover-failed-pre-merge-steps"'),
    );
    expect(maintenance.indexOf('name: "reconcile-review-revision-stall-parks"')).toBeLessThan(
      maintenance.indexOf('name: "reconcile-inert-merge-node"'),
    );
    // Exactly two registrations — a third would mean the sweep runs twice per maintenance pass.
    const occurrences = source.split('name: "reconcile-inert-merge-node"').length - 1;
    expect(occurrences).toBe(2);
  });
});
