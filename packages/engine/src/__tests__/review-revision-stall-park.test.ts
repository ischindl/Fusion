/**
 * FNXC:ReviewRevisionWait 2026-09-29-15:40 (RUFU-280):
 * The in-review stall ladder must COUNT an authored review revision and refuse to PARK it, and the
 * bounded sweep must lift the park this same code wrote in an earlier build.
 *
 * The two halves share one fixture shape on purpose: the park is what the deferral replaces, so the
 * repair test proves the same card is frozen by the pre-fix build and un-frozen by this one.
 * The contrast for the verdict-less class lives in
 * `__tests__/verdictless-pre-merge-gate-rerun.test.ts` (case (e)) and is deliberately NOT restated here.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  AWAITING_REVIEW_REVISION_STALL_REASON,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  IN_REVIEW_STALL_LOG_PREFIX,
} from "@fusion/core";
import { IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX } from "../merge/pre-merge-gate-reseed.js";
import { SelfHealingManager } from "../self-healing.js";

const REVISION_OBSERVATION = `${IN_REVIEW_STALL_LOG_PREFIX}awaiting-review-revision]: ${AWAITING_REVIEW_REVISION_STALL_REASON}`;

function at(iso: string): string {
  return iso;
}

/** A card mid-remediation on an authored `REVISE`: the shape the ladder used to terminalize. */
function revisingCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-280",
    column: "in-review",
    paused: false,
    userPaused: false,
    status: undefined,
    branch: "fusion/rufu-280",
    worktree: "/tmp/rufu-280",
    mergeDetails: {},
    mergeRetries: 0,
    steps: [
      { name: "implement", status: "done" },
      { name: "remediate findings", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review" } },
    ],
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewInputFingerprint: "sha256:revision-fixture",
      startedAt: at("2026-01-01T00:00:00.000Z"),
      completedAt: at("2026-01-01T00:01:00.000Z"),
    }],
    updatedAt: at("2026-01-01T00:01:00.000Z"),
    log: [],
    ...overrides,
  } as unknown as Task;
}

function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).__auditEvents = [] as any[];

  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).getTask = vi.fn().mockImplementation(async () => task);
  (emitter as any).peekMergeQueue = vi.fn().mockResolvedValue([]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date().toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).updateTaskAtomic = vi.fn().mockImplementation(async (_taskId: string, compute: (live: Task) => Partial<Task> | null) => {
    const patch = compute(task);
    if (!patch) return { applied: false };
    Object.assign(task, patch);
    return { applied: true, task };
  });
  (emitter as any).applyInReviewStallObservationFenced = vi.fn().mockImplementation(async (_taskId: string, compute: (live: Task) => any) => {
    const patch = compute(task);
    if (!patch) return { applied: false, reason: "refused" };
    await (emitter as any).logEntry(task.id, patch.logEntry.action);
    const { logEntry: _logEntry, ...fields } = patch;
    Object.assign(task, fields);
    return { applied: true, task };
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    (emitter as any).__auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).enqueueMergeQueue = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

function auditOfType(store: TaskStore, mutationType: string): any[] {
  return ((store as any).__auditEvents as any[]).filter((event) => event.mutationType === mutationType);
}

describe("in-review stall ladder defers the park for an authored review revision", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps recording observations but never pauses the card while remediation is pending", async () => {
    const task = revisingCard({
      log: [
        { timestamp: at("2026-01-01T00:02:00.000Z"), action: REVISION_OBSERVATION },
        { timestamp: at("2026-01-01T00:03:00.000Z"), action: REVISION_OBSERVATION },
      ],
    });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    // Third identical observation: the threshold the merge-blocker class parks on (3) is reached here.
    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.log.filter((entry: { action: string }) => entry.action === REVISION_OBSERVATION)).toHaveLength(3);
    expect(task.paused).toBe(false);
    expect(task.pausedReason).toBeUndefined();
    expect(task.status).toBeUndefined();
    expect(auditOfType(store, "task:in-review-stall-deadlock-disposed")).toHaveLength(0);
    manager.stop();
  });

  /*
  Not-a-blindfold control on an independent shape: the ladder still terminalizes a genuinely stuck
  review-lane card at the threshold after this change. It is an independent fixture rather than the same
  card minus its pending remediation step, because finishing remediation changes the classification code
  as well (`completed-review-status-none` once an in-review card has no merge owner or status), and the
  episode re-keys with it — the pre-existing progress-reset behaviour this change deliberately leaves
  alone, since finishing remediation IS progress.
  */
  it("still parks a genuinely stuck review card, so the deferral is not a blindfold", async () => {
    const task = revisingCard({
      id: "RUFU-280-CONTROL",
      status: "failed",
      error: "unchanged merge failure",
      workflowStepResults: [],
      steps: [{ name: "implementation", status: "done" }],
      log: [
        { timestamp: at("2026-01-01T00:02:00.000Z"), action: `${IN_REVIEW_STALL_LOG_PREFIX}merge-blocker]: task is marked 'failed': unchanged merge failure` },
        { timestamp: at("2026-01-01T00:03:00.000Z"), action: `${IN_REVIEW_STALL_LOG_PREFIX}merge-blocker]: task is marked 'failed': unchanged merge failure` },
      ],
    });
    const store = createStore(task, { inReviewStallDeadlockThreshold: 3 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe(IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON);
    expect(task.error).toContain(IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX);
    manager.stop();
  });
});

describe("bounded repair of an authored-revision card frozen by the earlier build", () => {
  function parkedForRevision(overrides: Partial<Task> = {}): Task {
    return revisingCard({
      paused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
      status: "failed",
      error: `${IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX}merge-blocker repeated 10× without progress. ${AWAITING_REVIEW_REVISION_STALL_REASON}`,
      // A budget the mis-park era had already spent: the clear must hand it back, not inherit it.
      mergeRetries: 3,
      ...overrides,
    });
  }

  it("lifts the engine's park in place and records the gate that owes the revision", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(1);

    expect(task.paused).toBe(false);
    expect(task.pausedReason).toBeNull();
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    // The retry budget a mis-read stall consumed comes back with the park (the convention both
    // sibling lifts of this park follow), so the card re-queues with a live merge admission.
    expect(task.mergeRetries).toBe(0);
    // No lifecycle move: clearing a park is not a column change.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("in-review");

    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toMatchObject([{
      taskId: "RUFU-280",
      target: "RUFU-280",
      agentId: "self-healing",
      metadata: {
        taskId: "RUFU-280",
        workflowStepId: "code-review",
        source: "self-healing",
        outcome: "cleared",
      },
    }]);
    manager.stop();
  });

  it("never reaches through an operator hold", async () => {
    const task = parkedForRevision({ userPaused: true });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    expect(task.userPaused).toBe(true);
    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toHaveLength(0);
    manager.stop();
  });

  it("leaves a verdict-less park to the recovery lanes that re-run the gate", async () => {
    // The same park sentence, but the review row authored no verdict: RUFU-204/217/234 own that card.
    const task = parkedForRevision({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        startedAt: at("2026-01-01T00:00:00.000Z"),
        completedAt: at("2026-01-01T00:01:00.000Z"),
      }],
    });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toHaveLength(0);
    manager.stop();
  });

  it("keeps the park when the card drifts between the page read and the write", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    // Simulate the drift: the last remediation step finishes after the read but before the write.
    (store.updateTaskAtomic as any).mockImplementation(async (_taskId: string, compute: (live: Task) => any) => {
      const drifted = { ...task, steps: [{ name: "remediate findings", status: "done" }] };
      const patch = compute(drifted as unknown as Task);
      if (!patch) return { applied: false };
      Object.assign(task, patch);
      return { applied: true, task };
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    // The retry reset rides the same guarded write as the park clear — a refused write burns nothing.
    expect(task.mergeRetries).toBe(3);
    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toHaveLength(0);
    manager.stop();
  });

  /*
  FNXC:ReviewRevisionParkAdmission 2026-09-30-07:19 (RUFU-280 code-review remediation, P1):
  The repair ACTS — it drops `status` and hands back a merge budget — so it carries the admission its
  two sibling park repairs already required: auto-merge consent and no live executor/merger owner.
  Every case below has its contrast elsewhere in this describe: the same fixture with the conjunct
  absent clears in "lifts the engine's park in place", so a green run here cannot come from a repair
  that simply never fires.
  */
  it("leaves a consent-withheld card parked: the engine cannot manufacture motion it was switched off from", async () => {
    const task = parkedForRevision();
    const store = createStore(task, { autoMerge: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    expect(task.status).toBe("failed");
    // Withheld consent burns nothing: the retry budget the card already had stays as its operator left it.
    expect(task.mergeRetries).toBe(3);
    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toHaveLength(0);
    manager.stop();
  });

  it("honours a per-task auto-merge opt-in over the project's withheld consent", async () => {
    // The conjunct is `allowsAutoMergeProcessing`, not a raw settings read: this card asked for the
    // engine's help itself, which is exactly the override that rule grants.
    const task = parkedForRevision({ autoMerge: true });
    const store = createStore(task, { autoMerge: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(1);
    expect(task.paused).toBe(false);
    expect(task.mergeRetries).toBe(0);
    manager.stop();
  });

  it("waits while an executor owns the card, because the clear would drop its status mid-run", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getExecutingTaskIds: () => new Set([task.id]),
    });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    // Vetoed before the write, not refused by it: the guarded update is never attempted.
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    manager.stop();
  });

  it("waits while a durable agent reports the card active", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", isTaskActive: () => true });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    manager.stop();
  });

  it("leaves a card the merge queue already owns to the merger", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    (store.peekMergeQueue as any).mockResolvedValue([{ taskId: task.id }]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(task.paused).toBe(true);
    expect(task.mergeRetries).toBe(3);
    manager.stop();
  });

  it("does not read the board at all under a global pause", async () => {
    const task = parkedForRevision();
    const store = createStore(task, { globalPause: true });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(task.paused).toBe(true);
    manager.stop();
  });
});
