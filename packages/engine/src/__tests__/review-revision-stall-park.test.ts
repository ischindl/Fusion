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
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { SelfHealingManager } from "../self-healing.js";

/** The one explanatory sentence this sweep writes; pinned by literal so a reword breaks the test. */
const PARK_CLEAR_LOG_PREFIX = "[pre-merge] Cleared the engine's in-review stall park:";

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

/**
 * A board, not just a card: the per-card isolation cases need several rows so one card's refusing
 * write can be proven unable to abort its siblings. A single card stays the common call shape.
 */
function createStore(tasks: Task | Task[], settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const board = Array.isArray(tasks) ? tasks : [tasks];
  const boardById = new Map(board.map((card) => [card.id, card]));
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
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => board);
  (emitter as any).getTask = vi.fn().mockImplementation(async (taskId: string) => boardById.get(taskId) ?? null);
  (emitter as any).peekMergeQueue = vi.fn().mockResolvedValue([]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (taskId: string, action: string) => {
    const target = boardById.get(taskId);
    if (!target) return;
    target.log = target.log ?? [];
    target.log.push({ timestamp: new Date().toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (taskId: string, updates: Partial<Task>) => {
    const target = boardById.get(taskId);
    if (target) Object.assign(target, updates);
  });
  (emitter as any).updateTaskAtomic = vi.fn().mockImplementation(async (taskId: string, compute: (live: Task) => Partial<Task> | null) => {
    const target = boardById.get(taskId);
    if (!target) return { applied: false };
    const patch = compute(target);
    if (!patch) return { applied: false };
    Object.assign(target, patch);
    return { applied: true, task: target };
  });
  (emitter as any).applyInReviewStallObservationFenced = vi.fn().mockImplementation(async (taskId: string, compute: (live: Task) => any) => {
    const target = boardById.get(taskId);
    if (!target) return { applied: false, reason: "refused" };
    const patch = compute(target);
    if (!patch) return { applied: false, reason: "refused" };
    await (emitter as any).logEntry(taskId, patch.logEntry.action);
    const { logEntry: _logEntry, ...fields } = patch;
    Object.assign(target, fields);
    return { applied: true, task: target };
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
    /*
    FNXC:ReviewRevisionParkLogOrder 2026-11-05-01:24 (RUFU-448): the ACCEPTED COST of log-before-clear.
    The explanatory line is now attempted before the guarded write, so a pass that drift-refuses can
    leave that line on a card that is still parked. That direction is deliberate and pinned here rather
    than discovered later: a line on a still-parked card is recoverable noise (the predicate still
    matches, so the next pass retries and lands the clear beside a second line), while a clear whose
    line was lost can never be retried at all — `isEngineAuthoredInReviewStallPark` requires
    `paused === true`, which the clear itself drops.
    */
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining(PARK_CLEAR_LOG_PREFIX));
    manager.stop();
  });

  /*
  FNXC:ReviewRevisionParkLogOrder 2026-11-05-01:24 (RUFU-448, finding 2):
  THE EXPLANATORY LINE IS WRITTEN BEFORE THE STATE CHANGE, so `cleared ⇒ logged` is an invariant of the
  sweep rather than a hope. The live failure class is a store whose log writer is unreachable (RUFU-275:
  `fn extension TaskStore boot timed out after 30000ms`). Under the old order that rejection arrived
  AFTER the park was already lifted, and because a cleared card stops matching the sweep predicate the
  line was unrecoverable — the card sat unfrozen with its only record in the audit store. Under the new
  order a failed line leaves the card parked, predicate-matchable, and retryable.
  */
  it("leaves the card parked and retryable when the explanatory log write fails", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    const logEntry = store.logEntry as unknown as ReturnType<typeof vi.fn>;
    const healthyLog = logEntry.getMockImplementation();
    logEntry.mockImplementation(async () => {
      throw new Error("fn extension TaskStore boot timed out after 30000ms");
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    // The line was attempted first, and the guarded clear was never attempted behind its back.
    expect(await manager.reconcileReviewRevisionStallParks()).toBe(0);
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining(PARK_CLEAR_LOG_PREFIX));
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe(IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON);
    // A refused pass burns nothing, exactly like a drift refusal: no retry budget, no audit row.
    expect(task.mergeRetries).toBe(3);
    expect(auditOfType(store, "task:merge-review-revision-park-cleared")).toHaveLength(0);

    // The retry is the point: once the log writer recovers, the SAME card still matches the predicate
    // and one pass lands the line and the clear together.
    logEntry.mockImplementation(healthyLog as (...args: unknown[]) => Promise<void>);
    expect(await manager.reconcileReviewRevisionStallParks()).toBe(1);
    expect(task.paused).toBe(false);
    expect(task.status).toBeNull();
    expect(task.mergeRetries).toBe(0);
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith(PARK_CLEAR_LOG_PREFIX))).toHaveLength(1);
    manager.stop();
  });

  it("orders the explanatory line before the guarded clear on a healthy pass", async () => {
    const task = parkedForRevision();
    const store = createStore(task);
    const order: string[] = [];
    const logEntry = store.logEntry as unknown as ReturnType<typeof vi.fn>;
    const updateTaskAtomic = store.updateTaskAtomic as unknown as ReturnType<typeof vi.fn>;
    const healthyLog = logEntry.getMockImplementation();
    const healthyWrite = updateTaskAtomic.getMockImplementation();
    logEntry.mockImplementation(async (...args: unknown[]) => {
      order.push("log");
      return (healthyLog as (...a: unknown[]) => unknown)(...args);
    });
    updateTaskAtomic.mockImplementation(async (...args: unknown[]) => {
      order.push("clear");
      return (healthyWrite as (...a: unknown[]) => unknown)(...args);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.reconcileReviewRevisionStallParks()).toBe(1);
    expect(order).toEqual(["log", "clear"]);
    manager.stop();
  });

  /*
  FNXC:ReviewRevisionParkPerCardIsolation 2026-11-05-01:24 (RUFU-448, AC2):
  One card's refusing store write used to abort the whole page loop from the pass-level catch, and that
  catch returned 0 — erasing the count of cards already repaired and stranding every later card on the
  page. Each card's block is therefore contained on its own: a healthy sibling must still clear.
  */
  it("isolates a failing per-card log write so a healthy sibling still clears", async () => {
    const broken = parkedForRevision({ id: "RUFU-448-A" });
    const healthy = parkedForRevision({ id: "RUFU-448-B" });
    const store = createStore([broken, healthy]);
    const logEntry = store.logEntry as unknown as ReturnType<typeof vi.fn>;
    const healthyLog = logEntry.getMockImplementation();
    logEntry.mockImplementation(async (taskId: string, ...rest: unknown[]) => {
      if (taskId === broken.id) throw new Error("fn extension TaskStore boot timed out after 30000ms");
      return (healthyLog as (...a: unknown[]) => unknown)(taskId, ...rest);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await expect(manager.reconcileReviewRevisionStallParks()).resolves.toBe(1);
    expect(broken.paused).toBe(true);
    expect(broken.mergeRetries).toBe(3);
    expect(healthy.paused).toBe(false);
    expect(healthy.status).toBeNull();
    expect(healthy.mergeRetries).toBe(0);
    expect(healthy.log.filter((entry: { action: string }) => entry.action.startsWith(PARK_CLEAR_LOG_PREFIX))).toHaveLength(1);
    // The failing card is not credited; only the applied clear is.
    expect(auditOfType(store, "task:merge-review-revision-park-cleared").map((row: any) => row.taskId)).toEqual([healthy.id]);
    manager.stop();
  });

  it("isolates a throwing per-card write so a healthy sibling still clears", async () => {
    const broken = parkedForRevision({ id: "RUFU-448-C" });
    const healthy = parkedForRevision({ id: "RUFU-448-D" });
    const store = createStore([broken, healthy]);
    const updateTaskAtomic = store.updateTaskAtomic as unknown as ReturnType<typeof vi.fn>;
    const healthyWrite = updateTaskAtomic.getMockImplementation();
    updateTaskAtomic.mockImplementation(async (taskId: string, ...rest: unknown[]) => {
      if (taskId === broken.id) throw new Error("deadlock_detected");
      return (healthyWrite as (...a: unknown[]) => unknown)(taskId, ...rest);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await expect(manager.reconcileReviewRevisionStallParks()).resolves.toBe(1);
    expect(broken.paused).toBe(true);
    expect(healthy.paused).toBe(false);
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

  /*
  FNXC:RunAudit 2026-11-05-01:24 (RUFU-448, FN-9175 behavioural coverage):
  The park repair is a LIFECYCLE repair that happens to emit telemetry, so FN-9175 demands proof that a
  hostile audit sink cannot put the repair at risk — convention alone was the P2 this card closes. The
  four shapes a real sink takes (absent, rejecting, synchronously throwing, never-settling) are each run
  against the real emit site: the pass must still clear the park and still owe the operator its
  explanatory line. These cases need NO production change — `emitBoundedRunAudit` already absorbs all
  four — so a red run here means the emit placement, not the test, is the defect.

  The hanging case is bounded by `RUN_AUDIT_EMIT_TIMEOUT_MS` and needs the fake clock, so it lives apart
  from the `it.each` trio, which must stay on the real clock to prove the other three need no waiting.
  */
  /**
   * Replace the healthy capturing sink with one of the hostile shapes, returning the spy where the
   * shape still has one, so the case can prove the emit site was REACHED rather than skipped.
   */
  function sabotageAuditSink(store: TaskStore, shape: "absent" | "rejecting" | "throwing"): ((...args: unknown[]) => unknown) | undefined {
    const host = store as { recordRunAuditEvent?: unknown };
    if (shape === "absent") {
      delete host.recordRunAuditEvent;
      return undefined;
    }
    const sink = shape === "rejecting"
      ? vi.fn().mockRejectedValue(new Error("audit store unreachable"))
      : vi.fn(() => {
        throw new Error("audit store down");
      });
    host.recordRunAuditEvent = sink;
    return sink as (...args: unknown[]) => unknown;
  }

  it.each(["absent", "rejecting", "throwing"] as const)("%s audit sink: the park clear stands and the sink error never escapes", async (shape) => {
    const task = parkedForRevision();
    const store = createStore(task);
    const sink = sabotageAuditSink(store, shape);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    // The sink's own failure must never surface as a pass failure or a swallowed (0) result.
    await expect(manager.reconcileReviewRevisionStallParks()).resolves.toBe(1);

    expect(task.paused).toBe(false);
    expect(task.pausedReason).toBeNull();
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.mergeRetries).toBe(0);
    // Non-vacuity: the pass reached this emit site (the sink being hostile is the premise, not a skip).
    expect(sink?.mock.calls.length ?? 1).toBe(1);
    // Telemetry may be lost; the operator's explanation may not.
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith(PARK_CLEAR_LOG_PREFIX))).toBe(true);
    manager.stop();
  });

  it("lifts the park when the audit sink never settles, bounded by the emit timeout", async () => {
    vi.useFakeTimers();
    try {
      const task = parkedForRevision();
      const store = createStore(task);
      const sink = vi.fn(() => new Promise<void>(() => undefined));
      (store as { recordRunAuditEvent?: unknown }).recordRunAuditEvent = sink;
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

      const pass = manager.reconcileReviewRevisionStallParks();
      let settled = false;
      void pass.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);

      await expect(pass).resolves.toBe(1);
      expect(sink.mock.calls.length).toBe(1);
      expect(task.paused).toBe(false);
      expect(task.status).toBeNull();
      expect(task.mergeRetries).toBe(0);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
