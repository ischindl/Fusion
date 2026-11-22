/**
 * RUFU-834 Step 2 — the bounded ladder: four grants, one terminalization, and the writes that must NOT
 * be able to reset it.
 *
 * The two failures this file exists to prevent are both measured, not hypothetical:
 *  - RUFU-1027: the budget lived where a legitimate cleanup could null it, so the ceiling was unreachable
 *    and 327 re-arms in 24 h each reported `attempt: 1`.
 *  - RUFU-1028: the park proved itself from `status`/`error`, which every writer on the board owns, so a
 *    card declared exhausted earned a fresh ladder and looped 44 times between 14:10 and 16:04.
 * Both are asserted here as behavior, not as comments: a real cleanup call runs between two grants, and a
 * badge-clearing write runs between a park and the next pass.
 */
import { describe, expect, it, vi } from "vitest";
import { MERGE_REARM_EPISODE_METADATA_KEY } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { cleanupMergeStateForReverification } from "../executor/cleanup-merge-state.js";
import { applyTaskPatch } from "./fixtures/task-patch-store.js";
import {
  MAX_MERGE_REARM_ATTEMPTS,
  MERGE_REARM_EXHAUSTED_PREFIX,
  MERGE_REARM_GRACE_MS,
  attemptMergeRearm,
  mergeRarmSignature,
  readMergeRarmMarker,
} from "../executor/merge-rearm.js";

const REVIEW = "in-review";
const STALE = "2026-10-16T00:00:00.000Z";
const NOW = Date.parse("2026-10-30T00:00:00.000Z");

const MERGE_IR = {
  version: "v2",
  columns: [
    { id: "todo", name: "Todo", role: "todo", traits: [{ trait: "intake" }] },
    { id: REVIEW, name: "Review", role: "review", traits: [{ trait: "merge-blocker" }] },
    { id: "done", name: "Done", role: "done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan-review", kind: "optional-group", column: REVIEW, config: { name: "Plan Review", defaultOn: true } },
    { id: "code-review", kind: "optional-group", column: REVIEW, config: { name: "Code Review", defaultOn: true } },
    { id: "merge", kind: "prompt", column: REVIEW, config: { seam: "merge" } },
    { id: "cleanup", kind: "end", column: "done" },
  ],
  edges: [],
} as any;

function inertTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-834",
    title: "inert failed merge node",
    column: REVIEW,
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

const FAILED_MERGE_ITEM = {
  id: "row-1", runId: "run-1", taskId: "RUFU-834", nodeId: "merge", kind: "task",
  state: "failed", attempt: 1, retryAfter: null, leaseOwner: null, leaseExpiresAt: null,
  lastError: "merge refused", blockedReason: null, createdAt: STALE, updatedAt: STALE,
} as any;

/**
 * Store double faithful to the three semantics the ladder depends on: `updateTaskAtomic` runs a REDUCER
 * over the live row, `sourceMetadataPatch` merges INTO `sourceMetadata` at key level, and
 * `listWorkflowWorkItemsForTask` answers with the rows the classifier reads.
 */
function makeStore(task: any, workItems: any[] = [FAILED_MERGE_ITEM]) {
  let current = task;
  let active: any[] = [];
  const seenDedupeKeys = new Set<string>();
  const state = {
    get current() { return current; },
    set current(value: any) { current = value; },
    get seeded() { return active; },
    patches: [] as Array<Record<string, unknown>>,
  };
  const store = {
    getTask: vi.fn(async () => current),
    getRootDir: () => "/repo",
    getSettings: vi.fn(async () => ({ autoMerge: true, integrationBranch: "main" })),
    getTaskWorkflowSelection: () => ({ workflowId: "custom:mergeflow", stepIds: ["plan-review", "code-review"] }),
    getWorkflowDefinition: async () => ({ ir: MERGE_IR }),
    listWorkflowWorkItemsForTask: vi.fn(async () => (active.length ? active : workItems)),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: any) => {
      // Mirrors the store's fence: refuse when an active task continuation already exists.
      if (input.onlyIfNoActiveTaskContinuation && active.length > 0) {
        const error = new Error("an active task continuation already exists");
        error.name = "ActiveTaskContinuationError";
        throw error;
      }
      active = [{ ...input, id: `seeded-${active.length}` }];
      return active[0];
    }),
    logEntry: vi.fn(async () => undefined),
    logEntryOnce: vi.fn(async (_id: string, opts: { dedupeKey: string }) => {
      if (seenDedupeKeys.has(opts.dedupeKey)) return false;
      seenDedupeKeys.add(opts.dedupeKey);
      return true;
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      state.patches.push(patch);
      current = applyTaskPatch(current, patch);
      return current;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (!patch) return null;
      state.patches.push(patch);
      current = applyTaskPatch(current, patch);
      return current;
    }),
  };
  return { store, state, takeSeededRow: () => { active = []; }, raceIn: (row: any) => { active = [row]; } };
}

function makeDeps(store: any, verdict: string, extra: Record<string, unknown> = {}) {
  return {
    store,
    getRunContextFor: () => undefined,
    now: () => NOW,
    emptinessProver: { proveTask: vi.fn(async () => new Map([["", verdict]])) },
    hasLiveExecutionSurface: () => false,
    ...extra,
  } as any;
}

function auditRows(store: any) {
  return store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
}

describe("RUFU-834 Step 2: the grant", () => {
  it("installs a CLAIMABLE continuation at the dead merge node and moves no lifecycle field", async () => {
    const { store, state } = makeStore(inertTask());
    const result = await attemptMergeRearm(makeDeps(store, "occupied"), { taskId: "RUFU-834" });

    expect(result.outcome).toBe("rearmed");
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    const seed = store.replaceActiveTaskWorkflowContinuation.mock.calls[0][0];
    expect(seed).toMatchObject({
      taskId: "RUFU-834",
      nodeId: "merge",
      kind: "task",
      // The Step 0 contract: `retrying` is in the drain's state filter and `retryAfter` only gates WHEN,
      // so this row is claimable while a merge that re-fails instantly cannot burn the ladder in one tick.
      state: "retrying",
      onlyIfNoActiveTaskContinuation: true,
    });
    expect(Date.parse(seed.retryAfter)).toBeGreaterThan(NOW);
    expect(Date.parse(seed.retryAfter) - NOW).toBe(MERGE_REARM_GRACE_MS);

    // No lifecycle move, and no move at all: containment keeps sole authority over lanes.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(state.current.column).toBe(REVIEW);

    const granted = auditRows(store).filter((row) => row.mutationType === "task:merge-rearmed");
    expect(granted).toHaveLength(1);
    expect(granted[0].metadata).toMatchObject({
      taskId: "RUFU-834", nodeId: "merge", attempt: 1, attemptLimit: MAX_MERGE_REARM_ATTEMPTS,
      evidence: "occupied", outcome: "rearmed",
    });
    // Ids/counts/fixed enums only — no path, no diff, no SHA, no error prose.
    expect(JSON.stringify(granted[0].metadata)).not.toContain(".fusion/worktrees");
  });

  it("names a fresh run id per grant so the failed row survives as evidence", async () => {
    const { store, takeSeededRow } = makeStore(inertTask());
    const deps = makeDeps(store, "occupied");
    await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    takeSeededRow();
    await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    const runIds = store.replaceActiveTaskWorkflowContinuation.mock.calls.map((call: any[]) => call[0].runId);
    expect(new Set(runIds).size).toBe(2);
    // The failed row's own run id is never reused: reusing it would make the seed delete the evidence.
    expect(runIds.every((runId: string) => runId !== FAILED_MERGE_ITEM.runId)).toBe(true);
  });

  it("burns nothing for a transient refusal, so a progressing card cannot be terminalized by waiting", async () => {
    // The row is one second old, so the in-graph merge retry still owns it for all thirty passes.
    const fresh = { ...FAILED_MERGE_ITEM, updatedAt: new Date(NOW - 1_000).toISOString() };
    const { store, state } = makeStore(inertTask(), [fresh]);
    const deps = makeDeps(store, "occupied");
    for (let pass = 0; pass < 30; pass += 1) {
      expect((await attemptMergeRearm(deps, { taskId: "RUFU-834" })).verdict).toBe("too-young");
    }
    expect(state.patches.some((patch) => patch.status === "failed")).toBe(false);
    expect(readMergeRarmMarker(state.current)).toBeUndefined();
    expect(store.logEntryOnce).not.toHaveBeenCalled();
    expect(auditRows(store).map((row) => row.mutationType)).not.toContain("task:merge-rearm-exhausted");
  });

  it("reports a race without mutating anything when an active continuation takes the card first", async () => {
    const { store, state } = makeStore(inertTask());
    // Classification passes, THEN another owner installs a row: the fence must refuse the seed.
    store.replaceActiveTaskWorkflowContinuation.mockImplementation(async (input: any) => {
      const error = new Error("an active task continuation already exists");
      error.name = "ActiveTaskContinuationError";
      throw error;
    });
    const result = await attemptMergeRearm(makeDeps(store, "occupied"), { taskId: "RUFU-834" });

    expect(result.outcome).toBe("raced");
    expect(state.current.column).toBe(REVIEW);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows(store).map((row) => row.mutationType)).not.toContain("task:merge-rearm-exhausted");
  });

  it("refuses on a checkout that proves no unlanded delivery, and counts that as a refusal, not a grant", async () => {
    for (const verdict of ["empty", "unknown"]) {
      const { store, state } = makeStore(inertTask());
      const result = await attemptMergeRearm(makeDeps(store, verdict), { taskId: "RUFU-834" });
      expect(result.outcome).toBe("refused");
      expect(result.verdict).toBe("no-own-work");
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
      expect(readMergeRarmMarker(state.current)?.refusal).toBe(1);
      expect(readMergeRarmMarker(state.current)?.attempt ?? 0).toBe(0);
    }
  });
});

describe("RUFU-834 Step 2: the ceiling is reachable and survives the writers that bound it", () => {
  it("reaches the ceiling across four grants even when the stale-merge cleanup runs between them", async () => {
    const { store, state, takeSeededRow } = makeStore(inertTask());
    const deps = makeDeps(store, "occupied");
    const cleanupDeps = { store: deps.store, getRunContextFor: () => undefined };
    let signatureAcrossCleanup = "";

    for (let pass = 1; pass <= MAX_MERGE_REARM_ATTEMPTS; pass += 1) {
      // The drain took the previous grant's row and the merge failed again: the card is back to one
      // terminal `failed` merge row, which is the shape the next pass must re-enter.
      takeSeededRow();
      const result = await attemptMergeRearm(deps, { taskId: "RUFU-834" });
      expect(result.outcome, `pass ${pass}`).toBe("rearmed");
      expect(result.attempt, `pass ${pass}`).toBe(pass);
      const identity = mergeRarmSignature({
        taskId: "RUFU-834", workflowId: "custom:mergeflow", mergeFrontierNodeIds: ["merge"], nodeId: "merge", task: state.current,
      });
      if (pass === 1) signatureAcrossCleanup = identity;

      // The exact write RUFU-1027 measured in front of every one of RUFU-278's 327 re-arms.
      await cleanupMergeStateForReverification(cleanupDeps, state.current, "Executor detected stale merge state", {
        resetSource: "execute-preflight",
      });
      expect(state.current.mergeDetails).toBeNull();
      expect(state.current.status).toBeNull();
      expect(state.current.error).toBeNull();
      // The budget's own proof of RUFU-1027: the episode key this cleanup cannot name, at key level.
      expect(readMergeRarmMarker(state.current)?.attempt).toBe(pass);
      // And the identity it must not move over: `mergeDetails` is gone and the post-execution ledger rows
      // this cleanup drops are absent, yet the question is the same question.
      expect(mergeRarmSignature({
        taskId: "RUFU-834", workflowId: "custom:mergeflow", mergeFrontierNodeIds: ["merge"], nodeId: "merge", task: state.current,
      })).toBe(signatureAcrossCleanup);

      // The cleanup also retires the code-review row, which is the ADMISSION check doing its job — a card
      // bounced back through execution owes a fresh review before it may merge again. Model the re-review
      // so the ladder, not the gate, is what this test measures.
      state.current = applyTaskPatch(state.current, {
        workflowStepResults: [
          { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
          { workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
        ],
      });
    }

    expect(readMergeRarmMarker(state.current)?.attempt).toBe(MAX_MERGE_REARM_ATTEMPTS);
  });

  it("terminalizes exactly once on the fifth grant and stays idempotent for every pass after it", async () => {
    const { store, state, takeSeededRow } = makeStore(inertTask());
    const deps = makeDeps(store, "occupied");
    for (let pass = 1; pass <= MAX_MERGE_REARM_ATTEMPTS; pass += 1) {
      await attemptMergeRearm(deps, { taskId: "RUFU-834" });
      takeSeededRow();
    }

    const fifth = await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    expect(fifth.outcome).toBe("parked");
    expect(state.current.status).toBe("failed");
    expect(String(state.current.error)).toMatch(new RegExp(`^${MERGE_REARM_EXHAUSTED_PREFIX}:`));
    expect(readMergeRarmMarker(state.current)?.terminalAt).toBeTruthy();
    // A re-entry is NOT owed to a card that has run out: no fifth seed.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(MAX_MERGE_REARM_ATTEMPTS);

    // Idempotent: the pass after the park writes no badge, no History line, no audit row.
    const noticesBefore = store.logEntryOnce.mock.calls.length;
    const auditsBefore = auditRows(store).length;
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await attemptMergeRearm(deps, { taskId: "RUFU-834" })).outcome).toBe("parked");
    }
    expect(store.logEntryOnce.mock.calls).toHaveLength(noticesBefore);
    expect(auditRows(store)).toHaveLength(auditsBefore);
    const exhausted = auditRows(store).filter((row) => row.mutationType === "task:merge-rearm-exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].metadata).toMatchObject({ attemptLimit: MAX_MERGE_REARM_ATTEMPTS, outcome: "exhausted", column: REVIEW });
  });

  it("keeps the park standing when a legitimate cleanup clears the badge it was announced in", async () => {
    const { store, state, takeSeededRow } = makeStore(inertTask());
    const deps = makeDeps(store, "occupied");
    for (let pass = 1; pass <= MAX_MERGE_REARM_ATTEMPTS; pass += 1) {
      await attemptMergeRearm(deps, { taskId: "RUFU-834" });
      takeSeededRow();
    }
    await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    expect(state.current.status).toBe("failed");

    // RUFU-1028's exact disturbance: the row-level announcement is nulled by an unrelated cleanup.
    await cleanupMergeStateForReverification({ store: deps.store, getRunContextFor: () => undefined }, state.current, "Executor detected stale merge state", {
      resetSource: "lane-return",
    });
    expect(state.current.status).toBeNull();
    expect(state.current.mergeDetails).toBeNull();

    const auditsBefore = auditRows(store).length;
    expect((await attemptMergeRearm(deps, { taskId: "RUFU-834" })).outcome).toBe("parked");
    // The park's proof is the durable episode, so a cleared badge earns no fresh ladder.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(MAX_MERGE_REARM_ATTEMPTS);
    expect(auditRows(store)).toHaveLength(auditsBefore);
  });

  it("gives the operator one Retry that buys the whole budget again", async () => {
    const { store, state, takeSeededRow } = makeStore(inertTask());
    const deps = makeDeps(store, "occupied");
    for (let pass = 1; pass <= MAX_MERGE_REARM_ATTEMPTS; pass += 1) {
      await attemptMergeRearm(deps, { taskId: "RUFU-834" });
      takeSeededRow();
    }
    await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(MAX_MERGE_REARM_ATTEMPTS);

    // Operator Retry: the shared reset patch, applied by the store.
    const { buildManualRetryResetPatch } = await import("@fusion/core");
    state.current = applyTaskPatch(state.current, {
      ...buildManualRetryResetPatch(),
      status: null, error: null,
    } as Record<string, unknown>);
    // The reset nulls the episode key at key level, so the register is genuinely gone.
    expect(readMergeRarmMarker(state.current)).toBeUndefined();
    takeSeededRow();

    const afterRetry = await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    expect(afterRetry.outcome).toBe("rearmed");
    expect(afterRetry.attempt).toBe(1);
  });

  it("bounds refusals too, so a card with no delivery to merge cannot be examined forever", async () => {
    const { store, state } = makeStore(inertTask());
    const deps = makeDeps(store, "empty");
    let result = await attemptMergeRearm(deps, { taskId: "RUFU-834" });
    let passes = 1;
    while (result.outcome === "refused" && passes < 40) {
      result = await attemptMergeRearm(deps, { taskId: "RUFU-834" });
      passes += 1;
    }
    expect(result.outcome).toBe("parked");
    expect(readMergeRarmMarker(state.current)?.refusal).toBeGreaterThan(12);
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });
});

describe("RUFU-834 Step 2: the episode key is this seam's alone", () => {
  it("writes only its own sourceMetadata key", async () => {
    const { store, state } = makeStore(inertTask({
      sourceMetadata: { "duplicate-of": "RUFU-281", "handoff-from": "agent-x", executionRearmEpisode: { signature: "keep-me", attempt: 2, refusal: 0, firstAt: STALE, at: STALE, heldAt: null } },
    }));
    await attemptMergeRearm(makeDeps(store, "occupied"), { taskId: "RUFU-834" });

    const metadata = state.current.sourceMetadata as Record<string, unknown>;
    expect(metadata["duplicate-of"]).toBe("RUFU-281");
    expect(metadata["handoff-from"]).toBe("agent-x");
    // The neighbour ladder is untouched: a merge re-arm must not spend RUFU-308's budget.
    expect((metadata.executionRearmEpisode as any).attempt).toBe(2);
    expect(metadata[MERGE_REARM_EPISODE_METADATA_KEY]).toBeDefined();
    // And a whole-column `sourceMetadata` write is the thing this family forbids.
    expect(state.patches.every((patch) => !("sourceMetadata" in patch))).toBe(true);
  });
});

/*
FNXC:MergeNodeReArm 2026-11-21-11:05 (RUFU-834):
FN-9175's rule, applied to this seam by behavior rather than by an import inspection: an absent,
throwing, rejecting, stalled, or late-settling audit sink may not change a merge re-entry decision, the
episode write it makes, or how many rows got seeded. Telemetry that can veto a re-arm is a second owner
of delivery, and the exhaustion row is the ONLY durable proof a ceiling was reached — so both halves
(mutation and evidence) have to be exercised against a hostile store.
*/
describe("RUFU-834 Step 3: a hostile audit sink cannot change the decision", () => {
  type SinkMode = "absent" | "throw" | "reject" | "pending" | "late-resolve" | "late-reject";
  const hostileModes: SinkMode[] = ["absent", "throw", "reject", "pending", "late-resolve", "late-reject"];

  function hostileSink(mode: SinkMode) {
    let settle: (() => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const recordRunAuditEvent = mode === "absent" ? undefined : vi.fn(() => {
      if (mode === "throw") throw new Error("sync audit failure");
      if (mode === "reject") return Promise.reject(new Error("rejected audit failure"));
      if (mode === "pending") return new Promise<void>(() => undefined);
      return new Promise<void>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
    });
    return {
      host: recordRunAuditEvent ? { recordRunAuditEvent } : {},
      recordRunAuditEvent,
      settle: () => settle?.(),
      rejectLate: () => reject?.(new Error("late audit failure")),
    };
  }

  it.each(hostileModes)("grants the same re-entry with a %s sink", async (mode) => {
    const sink = hostileSink(mode);
    const { store, state } = makeStore(inertTask());
    if (sink.recordRunAuditEvent) store.recordRunAuditEvent = sink.recordRunAuditEvent;
    else delete (store as Record<string, unknown>).recordRunAuditEvent;
    const deps = makeDeps(store, "occupied");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      // The bounded seam owns its own wall-clock bound, so advance past it rather than waiting on it.
      const pending = Promise.resolve().then(() => attemptMergeRearm(deps, { taskId: "RUFU-834" }));
      for (let turn = 0; turn < 4; turn += 1) {
        await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
      }
      const result = await pending;
      if (mode === "late-resolve") sink.settle();
      if (mode === "late-reject") sink.rejectLate();
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
      // The decision, the ladder write, and the seed are IDENTICAL for every sink mode.
      expect(result.outcome).toBe("rearmed");
      expect(result.attempt).toBe(1);
      expect(readMergeRarmMarker(state.current)?.attempt).toBe(1);
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      expect(state.current.column).toBe(REVIEW);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it.each(["absent", "throw", "reject", "pending"] as SinkMode[])("still terminalizes once with a %s sink", async (mode) => {
    const sink = hostileSink(mode);
    const { store, state, takeSeededRow } = makeStore(inertTask());
    if (sink.recordRunAuditEvent) store.recordRunAuditEvent = sink.recordRunAuditEvent;
    else delete (store as Record<string, unknown>).recordRunAuditEvent;
    const deps = makeDeps(store, "occupied");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      for (let pass = 0; pass <= MAX_MERGE_REARM_ATTEMPTS; pass += 1) {
        const pending = Promise.resolve().then(() => attemptMergeRearm(deps, { taskId: "RUFU-834" }));
        for (let turn = 0; turn < 4; turn += 1) {
          await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
        }
        const result = await pending;
        if (pass < MAX_MERGE_REARM_ATTEMPTS) takeSeededRow();
        else expect(result.outcome).toBe("parked");
      }
      // One operator notice, whatever the sink did.
      expect(store.logEntryOnce).toHaveBeenCalledTimes(1);
      expect(state.current.status).toBe("failed");
      expect(String(state.current.error).startsWith(MERGE_REARM_EXHAUSTED_PREFIX)).toBe(true);
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });
});
