/**
 * FNXC:PlannerOversight 2026-07-04-19:45:
 * FN-7551 engine-level end-to-end test: proves real overseer decision points
 * — observation, retry, targeted-fix, steering (reviewer), advisory
 * confirmation suppression, and bounded-recovery escalation — populate the
 * `overseer:intervention` run-audit timeline via the ACTUAL
 * production wiring in `project-engine.ts` (`PlannerOverseerMonitor#onObservation`
 * → the private `emitOverseerObservationDeduped`, the private
 * `buildPlannerRecoveryHandlers`, the private `emitOverseerEscalationDeduped`),
 * against a REAL in-memory `TaskStore` — never by calling
 * `emitOverseer*`/`recordPlannerIntervention` directly.
 *
 * Constructing a full `ProjectEngine` (via `start()`) pulls in cron/
 * notification/research/tunnel/automation subsystems that are impractical to
 * boot in a unit test. Instead this file extracts the engine's REAL
 * prototype methods via `Object.create(ProjectEngine.prototype)`, seeding
 * only the two dedup-map instance fields those methods read/write (normally
 * initialized by class-field initializers the constructor never runs here)
 * — this exercises the exact same code that runs inside
 * `pollPlannerOverseer`/`start()` in production, not a reimplementation.
 *
 * FNXC:PlannerOversight 2026-07-11-00:00:
 * FN-7840 removes the only real-tick producer of advisory merger awaiting-confirmation interventions, so this live-wiring harness now proves suppression at the source rather than request/resolution emission for an unreachable advisory pending-confirmation path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PLANNER_RECOVERY_MAX_ATTEMPTS, TaskStore, getPlannerInterventionTimeline, type Task } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { ProjectEngine } from "../project-engine.js";
import { PlannerOverseerMonitor, type OverseerStageObservation } from "../overseer/planner-overseer.js";
import { PlannerRecoveryController, type PlannerRecoveryHandlers, type PlannerRecoverySnapshotProvider } from "../overseer/planner-recovery-controller.js";
import { TaskStorePlannerSteeringLedger, type PlannerSteeringLedger } from "../overseer/planner-steering-ledger.js";

interface EngineOverseerInternals {
  plannerObservationEmitDedup: Map<string, string>;
  plannerEscalationEmitDedup: Set<string>;
  buildPlannerRecoveryHandlers(store: TaskStore): PlannerRecoveryHandlers;
  emitOverseerObservationDeduped(store: TaskStore, observation: OverseerStageObservation): Promise<void>;
  emitOverseerEscalationDeduped(
    store: TaskStore,
    taskId: string,
    decision: { watchedStage: string | null; reason: string; attemptCount: number; attemptLimit: number; sourceLinks: unknown[] },
  ): Promise<void>;
}

/** Extracts the real `ProjectEngine` prototype methods FN-7551 wired without running its heavy constructor/`start()`. */
function makeEngineInternals(opts?: {
  isTaskLiveForOverseerRetry?: (taskId: string) => boolean;
}): EngineOverseerInternals & { runtime: { getExecutor: () => { isTaskLiveForOverseerRetry?: (id: string) => boolean } | undefined } } {
  const engineLike = Object.create(ProjectEngine.prototype) as unknown as EngineOverseerInternals & {
    runtime: { getExecutor: () => { isTaskLiveForOverseerRetry?: (id: string) => boolean } | undefined };
  };
  engineLike.plannerObservationEmitDedup = new Map();
  engineLike.plannerEscalationEmitDedup = new Set();
  (engineLike as { plannerLiveRetrySkipLogDedup: Set<string> }).plannerLiveRetrySkipLogDedup = new Set();
  // FNXC:PlannerOversight 2026-07-21-22:56: retry_step reads runtime.getExecutor for the live-session gate.
  engineLike.runtime = {
    getExecutor: () =>
      opts?.isTaskLiveForOverseerRetry
        ? { isTaskLiveForOverseerRetry: opts.isTaskLiveForOverseerRetry }
        : { isTaskLiveForOverseerRetry: () => false },
  };
  return engineLike;
}

/** Builds the real production wiring (monitor + recovery-controller handlers) against a concrete `store`, mirroring `ProjectEngine.start()`. */
function wireRealEngineOverseer(
  store: TaskStore,
  opts?: { steeringLedger?: PlannerSteeringLedger; isTaskLiveForOverseerRetry?: (taskId: string) => boolean },
) {
  const internals = makeEngineInternals({ isTaskLiveForOverseerRetry: opts?.isTaskLiveForOverseerRetry });
  const monitor = new PlannerOverseerMonitor({
    store,
    onObservation: async (observation) => internals.emitOverseerObservationDeduped(store, observation),
  });
  const handlers = internals.buildPlannerRecoveryHandlers(store);
  const controllerFromMonitor = new PlannerRecoveryController({
    snapshotProvider: monitor,
    handlers,
    steeringLedger: opts?.steeringLedger,
  });

  return {
    monitor,
    handlers,
    controllerFromMonitor,
    /** A controller wired with the SAME real handlers but a synthetic snapshot, for exercising decision branches the monitor's own signal-derivation cannot produce (e.g. a failed executor signal). */
    controllerWithSnapshot: (observation: OverseerStageObservation) => {
      const provider: PlannerRecoverySnapshotProvider = { getSnapshot: () => observation };
      return new PlannerRecoveryController({
        snapshotProvider: provider,
        handlers,
        steeringLedger: opts?.steeringLedger,
      });
    },
    emitEscalation: (
      taskId: string,
      decision: { watchedStage: string | null; reason: string; attemptCount: number; attemptLimit: number; sourceLinks: unknown[] },
    ) => internals.emitOverseerEscalationDeduped(store, taskId, decision),
  };
}

/*
FNXC:RunAuditSink 2026-11-11-10:30:
RUFU-453 moved every best-effort audit emit into a per-store buffered drain (a 25 ms coalescing window in
`packages/core/src/run-audit/audit-sink-writer.ts`), so an accepted emit is NOT yet a durable row. This
harness's producers emit through `recordPlannerIntervention` -> `emitBoundedRunAudit`, and every timeline
read below happens inside that window, so the read could race the drain: four cases in this file failed at
HEAD with `expected [] to have a length of 1` on a PG-capable host while the harness's own `afterEach`
drain had not run yet. RUFU-453 documents the remedy for exactly this reader class - take
`TaskStore.flushRunAuditSink()` first. Reading through ONE helper keeps the drain honest for positive
assertions and makes the negative assertions stronger (a buffered row would land and be seen).
*/
async function readTimeline(store: TaskStore, taskId: string) {
  await store.flushRunAuditSink();
  return getPlannerInterventionTimeline(store, taskId);
}

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "T",
    stage: "executor",
    signal: "progressing",
    oversightLevel: "autonomous",
    observedAt: Date.now(),
    reason: "test",
    sources: [],
    ...overrides,
  };
}

pgDescribe("FN-7551 — overseer decision points populate the intervention timeline via the live wiring", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_overseer_wiring" });
  let store: TaskStore;

  beforeAll(harness.beforeAll);
  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  async function seedTask(column: "in-progress" | "in-review" = "in-progress"): Promise<Task> {
    const task = await store.createTask({ title: "T", description: "d" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    if (column === "in-review") {
      await store.moveTask(task.id, "in-review", { preserveProgress: true } as never);
    }
    return (await store.getTask(task.id))!;
  }

  it("observation: emits exactly one entry per (stage, signal), dedupes an unchanged repeat, and appends on a changed signal", async () => {
    const task = await seedTask("in-progress");
    const { monitor } = wireRealEngineOverseer(store);

    await monitor.observeTask(task, "autonomous");
    await monitor.observeTask(task, "autonomous");
    await monitor.observeTask(task, "autonomous");

    let timeline = await readTimeline(store, task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].action).toBe("observe");
    expect(timeline[0].stage).toBe("executor");

    // Change the signal (progressing -> "blocked" via paused) and observe again — must append.
    const pausedTask = { ...task, paused: true, pausedReason: "manual test pause" } as Task;
    await monitor.observeTask(pausedTask, "autonomous");

    timeline = await readTimeline(store, task.id);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].action).toBe("observe"); // newest-first
  });

  it("level 'off' never records an observation entry", async () => {
    const task = await seedTask("in-progress");
    const { monitor } = wireRealEngineOverseer(store);
    const result = await monitor.observeTask(task, "off");
    expect(result).toBeNull();
    expect(await readTimeline(store, task.id)).toHaveLength(0);
  });

  /*
  FNXC:PlannerOversight 2026-09-15-19:20:
  FN-429 updates this case to the current contract. `retry_step` used to be reported as a dispatched retry
  unconditionally, but its recovery reason has no backward-move authority under lifecycle containment, so the
  move is refused in place. Claiming a retry anyway is what produced FN-428's ~45s "retry" loop with nothing
  moving, so the handler now records ONE durable diagnostic and emits no retry intervention. The retry-emission
  branch itself is covered in `planner-retry-step-contained-recovery.test.ts` with the lifecycle seam moved.

  FNXC:PlannerOversight 2026-10-04-15:00:
  origin/main converged on the same contract from the opposite side (the base assertion failed there with
  `expected undefined to be truthy`, recorded in FN-9475): a refused retry dispatch is not an admitted
  recovery, so this case also pins that the refusal burned no attempt budget.
  */
  it("failed executor with no error source records a contained-recovery diagnostic instead of a retry entry and burns no attempt", async () => {
    const task = await seedTask("in-progress");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(observation({ taskId: task.id, stage: "executor", signal: "failed", sources: [] }));

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("retry_step");

    const timeline = await readTimeline(store, task.id);
    expect(timeline.find((e) => e.action === "retry")).toBeUndefined();
    const log = (await store.getTask(task.id)).log ?? [];
    expect(log.filter((entry) => entry.action?.includes("retry-not-dispatched"))).toHaveLength(1);
    expect(controller.getAttemptCount(task.id, "executor")).toBe(0);
  });

  /*
  FNXC:PlannerOversight 2026-07-21-22:56:
  FN-8471: when a live coding/step session still owns the task, retry_step must
  not moveTask→todo (hard-cancel thrash) and must not burn the recovery budget.
  */
  it("failed executor with a live session skips retry_step bounce and does not burn attempt budget", async () => {
    const task = await seedTask("in-progress");
    const internals = makeEngineInternals({
      isTaskLiveForOverseerRetry: (id) => id === task.id,
    });
    const handlers = internals.buildPlannerRecoveryHandlers(store);
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getSnapshot: () =>
          observation({ taskId: task.id, stage: "executor", signal: "failed", sources: [] }),
      },
      handlers,
    });

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("retry_step");

    const refreshed = await store.getTask(task.id);
    expect(refreshed?.column).toBe("in-progress");

    const timeline = await readTimeline(store, task.id);
    expect(timeline.find((e) => e.action === "retry")).toBeUndefined();
    // Exact budget invariant — two burns would still leave room under limit 3.
    expect(controller.getAttemptCount(task.id, "executor")).toBe(0);
    const second = await controller.tick(task);
    expect(second?.action).toBe("retry_step");
    expect(second?.exhausted).not.toBe(true);
    expect(controller.getAttemptCount(task.id, "executor")).toBe(0);
  });

  it("failed executor WITH an error source (failed-check) dispatches request_targeted_fix and emits a request-fix entry", async () => {
    const task = await seedTask("in-progress");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(
      observation({
        taskId: task.id,
        stage: "executor",
        signal: "failed",
        sources: [{ kind: "failed-check", ref: "lint" }],
      }),
    );

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("request_targeted_fix");

    const timeline = await readTimeline(store, task.id);
    const fixEntry = timeline.find((e) => e.action === "request-fix");
    expect(fixEntry).toBeTruthy();
    expect(fixEntry?.attemptCount).toBe(1);
    expect(fixEntry?.attemptLimit).toBe(3);
    expect(fixEntry?.sourceLinks?.[0]?.target).toBe("lint");
  });

  it("reviewer stage dispatches inject_guidance and emits an inject-guidance steering entry", async () => {
    const task = await seedTask("in-review");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(observation({ taskId: task.id, stage: "reviewer", signal: "blocked" }));

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("inject_guidance");

    const timeline = await readTimeline(store, task.id);
    const steeringEntry = timeline.find((e) => e.action === "inject-guidance");
    expect(steeringEntry).toBeTruthy();
    expect(steeringEntry?.stage).toBe("reviewer");
  });

  // FNXC:PlannerOversight 2026-07-11-00:00:
  // FN-7840 regression coverage: real tick() wiring reaches merger/pull-request oversight only when the same `allowsAutoMergeProcessing` predicate says auto-merge will proceed unattended. That advisory state must be silent — no pending confirmation, no request-confirmation intervention, and no merge-checkpoint steering comment/badge source.
  it("suppresses advisory merger confirmations under active auto-merge policy", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller } = wireRealEngineOverseer(store);
    await monitor.observeTask(task, "autonomous"); // merger stage (plain in-review, no PR/reviewState)

    const firstDecision = await controller.tick(task, { settings: { autoMerge: true } });
    expect(firstDecision?.action).toBe("none");
    expect(firstDecision?.requiresConfirmation).toBe(false);
    expect(firstDecision?.reason).toMatch(/automatically/i);

    const secondDecision = await controller.tick(task, { settings: { autoMerge: true } });
    expect(secondDecision?.action).toBe("none");
    expect(secondDecision?.requiresConfirmation).toBe(false);

    const timeline = await readTimeline(store, task.id);
    expect(timeline.filter((e) => e.action === "request-confirmation")).toHaveLength(0);
    expect(controller.getPendingConfirmations(task.id)).toHaveLength(0);

    const refreshedTask = await store.getTask(task.id);
    const allCommentText = [
      ...(refreshedTask?.comments ?? []).map((comment) => comment.text),
      ...(refreshedTask?.steeringComments ?? []).map((comment) => comment.text),
    ];
    expect(allCommentText.some((text) => text.includes("[planner-oversight] merge checkpoint"))).toBe(false);
  });

  // FNXC:PlannerOversight 2026-07-11-00:00:
  // FN-7840 makes the old request/approve/deny confirmation-resolution tests unreachable through the public real tick() seam: auto-merge true returns `none`, while auto-merge false is withheld by `evaluateOverseerHumanControl` before `decidePlannerRecovery`. The pure false/undefined safety-valve contract remains covered in @fusion/core; this engine harness documents the production reachability instead of injecting private pending-confirmation state.

  it("bounded-recovery exhaustion emits exactly one escalate entry across repeated polls of the same exhausted stage", async () => {
    const task = await seedTask("in-progress");
    const { emitEscalation } = wireRealEngineOverseer(store);
    const exhaustedDecision = {
      watchedStage: "executor",
      reason: 'Bounded recovery attempt budget (3) exhausted for stage "executor"',
      attemptCount: 3,
      attemptLimit: 3,
      sourceLinks: [],
    };

    await emitEscalation(task.id, exhaustedDecision);
    await emitEscalation(task.id, exhaustedDecision);
    await emitEscalation(task.id, exhaustedDecision);

    const timeline = await readTimeline(store, task.id);
    const escalations = timeline.filter((e) => e.action === "escalate");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].outcome).toBe("failed");
  });

  it("oversight level 'off' and a human-control-withheld (userPaused) task never emit any steering/retry/fix/confirmation/escalation entry", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller } = wireRealEngineOverseer(store);

    // Level "off": monitor records nothing (mirrors the poll's `continue` before ever calling tick()).
    const result = await monitor.observeTask(task, "off");
    expect(result).toBeNull();
    expect(await readTimeline(store, task.id)).toHaveLength(0);

    // Human-control withheld (userPaused) — tick() must short-circuit before
    // any confirmation classification/dispatch, so no intervention entry is
    // ever recorded (the withhold itself is a separate no-action event this
    // task does not touch).
    const pausedTask = { ...task, userPaused: true } as Task;
    const decision = await controller.tick(pausedTask);
    expect(decision).toBeNull();
    expect(await readTimeline(store, task.id)).toHaveLength(0);
  });

  it("a store/façade failure during observation emission never throws out of observeTask (best-effort contract)", async () => {
    const task = await seedTask("in-progress");
    const throwingStore = {
      ...store,
      recordRunAuditEvent: () => {
        throw new Error("boom");
      },
    } as unknown as TaskStore;

    const { monitor } = wireRealEngineOverseer(throwingStore);
    await expect(monitor.observeTask(task, "autonomous")).resolves.not.toThrow();
  });
});

/*
FNXC:PlannerOversight 2026-11-11-14:05 (RUFU-586):
The flood, measured against the real writer.

One card received 77 `[planner-oversight]` steering comments in ~20 h against a documented cap of 3. Each one
is a durable row in `comments` AND `steering_comments` (every append rewrites both arrays plus the
`search_vector` GIN entries), an inbox delivery that wakes the assignee, a timeline entry and a History line.

Every case here drives the REAL `buildPlannerRecoveryHandlers` against a REAL PG `TaskStore`, so the comment
count is read back off the card rather than from a mock. Two guards landed after the flood was first reported
and each absorbs one shape of it, so a case only counts as evidence for THIS fix if it defeats both:
`PLANNER_OVERSEER_GUIDANCE_DEDUPE_MS` is a 30-minute in-memory window, so the cadence below is 31 minutes;
and `addSteeringCommentImpl` refuses a write identical to the newest entry, so the signal alternates between
`stuck` and `blocked`, which changes the reason text. The third ingredient is the measured primary cause: a
`progressing` tick deletes the attempt key (FN-7577), so the cap of 3 is never reached and the budget that was
supposed to stop the flood stays empty forever.
*/
pgDescribe("RUFU-586 - the overseer's own steering is bounded per reason on the card", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_overseer_flood" });
  let store: TaskStore;

  beforeAll(harness.beforeAll);
  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /** Just outside RUFU-871's 30-minute in-memory window, so every tick is a genuine chance to post. */
  const TICK_MS = 31 * 60 * 1000;
  const START_MS = Date.parse("2026-11-10T00:00:00.000Z");

  /** The measured RUFU-286 shape: a healthy tick between two problem ticks, with the problem signal alternating. */
  function flapping(tick: number): OverseerStageObservation["signal"] {
    return tick % 3 === 0 ? "progressing" : tick % 3 === 1 ? "stuck" : "blocked";
  }
  const alwaysStuck = (): OverseerStageObservation["signal"] => "stuck";

  async function seedTask(): Promise<Task> {
    const task = await store.createTask({ title: "T", description: "d" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    return (await store.getTask(task.id))!;
  }

  /** The steering rows an operator actually sees, read back off the card. */
  async function steeringRows(taskId: string): Promise<string[]> {
    const task = await store.getTask(taskId);
    return (task?.steeringComments ?? [])
      .filter((entry) => entry.text.startsWith("[planner-oversight]"))
      .map((entry) => entry.text);
  }

  /*
  FNXC:PlannerOversight 2026-11-11-20:10 (RUFU-586):
  `addSteeringCommentImpl` writes the unified `comments` array AND the `steeringComments` array, and the
  second one is what the executor's real-time injection listener watches - the path by which a duplicate
  instruction re-entered the executor's prompt, which is the harm this task exists to stop. A bound that
  held only one of the two arrays would leave that path open, so both are measured.
  */
  async function commentRows(taskId: string): Promise<string[]> {
    const task = await store.getTask(taskId);
    return (task?.comments ?? [])
      .filter((entry) => String(entry.text ?? "").startsWith("[planner-oversight]"))
      .map((entry) => String(entry.text));
  }

  /** RUFU-259's inbox-delivery rows for this card, drained first (RUFU-453: an accepted emit is not yet a row). */
  async function deliveryRows(taskId: string): Promise<string[]> {
    await store.flushRunAuditSink();
    const events = await store.getRunAuditEventsAsync({ taskId });
    return events
      .filter((event) => event.mutationType === "task:comment-delivery" || event.mutationType === "task:comment-delivery-unowned")
      .map((event) => event.mutationType);
  }

  /**
   * Drives `ticks` overseer polls on one card from `startMs`, advancing a virtual clock one tick per poll.
   * `handlerCalls` counts how many times a decision reached the steering writer - the number the documented
   * cap of 3 is supposed to bound - and `comments` counts what survived into the card's durable arrays.
   */
  async function driveTicks(opts: {
    task: Task;
    steeringLedger?: PlannerSteeringLedger;
    ticks: number;
    stepMs?: number;
    signalFor: (tick: number) => OverseerStageObservation["signal"];
    stage?: OverseerStageObservation["stage"];
    startMs?: number;
  }) {
    const stepMs = opts.stepMs ?? TICK_MS;
    const startMs = opts.startMs ?? START_MS;
    const wiring = wireRealEngineOverseer(store, { steeringLedger: opts.steeringLedger });
    const baseGuidance = wiring.handlers.injectGuidance!;
    const handlerSpy = vi.fn((...args: Parameters<NonNullable<PlannerRecoveryHandlers["injectGuidance"]>>) =>
      baseGuidance(...args),
    );
    let tickIndex = 0;
    let nowMs = startMs;
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getSnapshot: (): OverseerStageObservation =>
          observation({ taskId: opts.task.id, stage: opts.stage ?? "executor", signal: opts.signalFor(tickIndex) }),
      },
      handlers: { ...wiring.handlers, injectGuidance: handlerSpy },
      steeringLedger: opts.steeringLedger,
    });

    let lastDecision: Awaited<ReturnType<typeof controller.tick>> = null;
    for (let i = 0; i < opts.ticks; i += 1) {
      tickIndex = i;
      nowMs = startMs + i * stepMs;
      lastDecision = await controller.tick(opts.task, { now: () => nowMs });
    }
    return {
      controller,
      handlerCalls: handlerSpy.mock.calls.length,
      comments: await steeringRows(opts.task.id),
      feedComments: await commentRows(opts.task.id),
      lastDecision,
    };
  }

  function deliveredPerReason(comments: string[]): number {
    return Math.max(0, ...[...new Set(comments)].map((text) => comments.filter((other) => other === text).length));
  }

  it("reproduction: on a flapping card, 18 ticks reach the steering writer 12 times", async () => {
    const task = await seedTask();
    const { handlerCalls, comments } = await driveTicks({ task, ticks: 18, signalFor: flapping });

    // 12 of the 18 ticks are problem ticks and ALL of them steer. The documented cap of 3 is not merely
    // missed here, it is unreachable: the healthy tick before each problem tick deletes the attempt key.
    expect(handlerCalls).toBe(12);
    expect(comments.length).toBeGreaterThan(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  it("fix: the same 18 ticks reach the writer at most cap-per-reason and never 12", async () => {
    const task = await seedTask();
    const { handlerCalls, comments } = await driveTicks({
      task,
      ticks: 18,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });

    // `stuck` and `blocked` are different instructions, so each keeps its own budget; the bound is per
    // reason per cooldown window and both budgets must hold it.
    expect(handlerCalls).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS * 2);
    expect(deliveredPerReason(comments)).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  it("a spent budget survives an engine restart", async () => {
    const task = await seedTask();
    const first = await driveTicks({
      task,
      ticks: 9,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });
    expect(first.handlerCalls).toBeGreaterThan(0);
    const before = await steeringRows(task.id);

    // A fresh controller AND a fresh ledger instance: the attempt count and RUFU-871's window both start
    // empty, which is exactly the RUFU-547 lesson - an in-memory set is gone after a restart. Only the card
    // remembers, and the card is what stops the second wave (still inside the 6 h cooldown).
    const after = await driveTicks({
      task,
      ticks: 6,
      startMs: START_MS + 9 * TICK_MS,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });
    expect(after.handlerCalls).toBe(0);
    expect((await steeringRows(task.id)).length).toBe(before.length);
  });

  it("a healthy-signal flap cannot refill a spent budget while the cooldown is live", async () => {
    const task = await seedTask();
    const ledger = new TaskStorePlannerSteeringLedger(store);
    await driveTicks({ task, ticks: 9, signalFor: flapping, steeringLedger: ledger });
    const before = await steeringRows(task.id);

    // FN-7577's clear runs on every `progressing` tick and MUST keep running - the card's overseer badge
    // derives from `attemptCount > 0`. It is simply no longer the anti-spam authority.
    const after = await driveTicks({
      task,
      ticks: 7,
      startMs: START_MS + 9 * TICK_MS,
      signalFor: flapping,
      steeringLedger: ledger,
    });
    expect(after.handlerCalls).toBe(0);
    expect((await steeringRows(task.id)).length).toBe(before.length);

    /*
    FNXC:PlannerOversight 2026-11-11-21:05 (RUFU-586):
    This is the assertion that names the root cause rather than the fix. The in-memory attempt count is
    ZERO at the end of a flapping wave - FN-7577's healthy-signal clear runs on every `progressing` tick,
    and a refused post deliberately charges no attempt - and the reproduction case above proves an empty
    in-memory count is precisely what let today's `main` reach the steering writer on all 12 problem ticks.
    Here the count is equally empty and the writer is still not reached, so the thing that stopped the flood
    is the episode on the card and not the badge. The badge is therefore shown to be intact (it never
    claimed a budget the flood ignored) while no longer being the anti-spam authority.
    */
    expect(after.controller.getAttemptCount(task.id, "executor")).toBe(0);
  });

  it("controller.clear() does not refill a spent budget", async () => {
    const task = await seedTask();
    const ledger = new TaskStorePlannerSteeringLedger(store);
    const first = await driveTicks({ task, ticks: 9, signalFor: flapping, steeringLedger: ledger });
    const before = await steeringRows(task.id);

    first.controller.clear(task.id);
    const after = await driveTicks({
      task,
      ticks: 6,
      startMs: START_MS + 9 * TICK_MS,
      signalFor: flapping,
      steeringLedger: ledger,
    });
    expect(after.handlerCalls).toBe(0);
    expect((await steeringRows(task.id)).length).toBe(before.length);
  });

  it("a genuinely different instruction is still delivered, because new information is not a duplicate", async () => {
    const task = await seedTask();
    const ledger = new TaskStorePlannerSteeringLedger(store);
    await driveTicks({ task, ticks: 9, signalFor: flapping, steeringLedger: ledger });
    const before = await steeringRows(task.id);

    const afterGate = await driveTicks({
      task,
      ticks: 1,
      stage: "workflow-gate",
      startMs: START_MS + 9 * TICK_MS,
      signalFor: alwaysStuck,
      steeringLedger: ledger,
    });

    expect(afterGate.handlerCalls).toBe(1);
    expect((await steeringRows(task.id)).length).toBeGreaterThan(before.length);

    /*
    FNXC:PlannerOversight 2026-11-11-21:05 (RUFU-586):
    The spec's reason-change clause asks for more than "a comment appeared": the new instruction must open a
    NEW budget rather than extend the exhausted one, which is what makes a reason change a genuine re-arm and
    not a bypass of the cap. The active budget object is the most recently delivered instruction, so the
    delivered count must read exactly 1 and `firstAt` must be the new wave's instant rather than the old one.
    */
    const episode = (await store.getTask(task.id))?.sourceMetadata?.plannerOversightSteering as
      | { deliveredCount?: number; firstAt?: string }
      | undefined;
    expect(episode?.deliveredCount).toBe(1);
    expect(episode?.firstAt).toBeDefined();
    expect(Date.parse(String(episode?.firstAt))).toBeGreaterThanOrEqual(START_MS + 9 * TICK_MS);
  });

  it("explains itself once: one timeline row and one History line, not one per suppressed tick", async () => {
    const task = await seedTask();
    const { handlerCalls } = await driveTicks({
      task,
      ticks: 18,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });
    expect(handlerCalls).toBeLessThan(12);

    // One announcement per exhausted instruction, never one per suppressed tick. Two instructions are
    // exhausted here (`stuck` and `blocked`), so the honest count is two rows against 12 refused ticks.
    const timeline = await readTimeline(store, task.id);
    const announcements = timeline
      .filter((entry) => entry.action === "inject-guidance" && entry.outcome === "skipped")
      .map((entry) => String(entry.reason));
    expect(announcements.length).toBeGreaterThan(0);
    expect(new Set(announcements).size).toBe(announcements.length);
    expect(announcements.length).toBeLessThanOrEqual(2);
    expect(announcements[0]).toContain("already delivered");

    const detail = await store.getTask(task.id, { activityLogLimit: 200 });
    const notices = (detail?.log ?? [])
      .filter((row) => String(row.action).includes("already delivered"))
      .map((row) => String(row.action));
    expect(new Set(notices).size).toBe(notices.length);
    expect(notices.length).toBe(announcements.length);
  });

  it("a suppressed tick touches no lifecycle state and claims no success", async () => {
    const task = await seedTask();
    const { lastDecision } = await driveTicks({
      task,
      ticks: 12,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });

    expect(lastDecision?.action).toBe("inject_guidance");
    expect(lastDecision?.steeringDeduped).toBe(true);
    const after = (await store.getTask(task.id))!;
    // Refusing to post is not evidence the card recovered: it must not clear a status, write an error, or
    // move the card, or suppressing a duplicate would erase the badge saying a planner is engaged.
    expect(after.error ?? null).toBeNull();
    expect(after.column).toBe("in-progress");
    expect(after.paused).toBeFalsy();
  });

  it("the budget persists as digest, count and instants - never the instruction's prose", async () => {
    const task = await seedTask();
    await driveTicks({ task, ticks: 9, signalFor: flapping, steeringLedger: new TaskStorePlannerSteeringLedger(store) });

    const raw = (await store.getTask(task.id))?.sourceMetadata?.plannerOversightSteering;
    const json = JSON.stringify(raw);
    expect(json).not.toContain("planner-oversight");
    expect(json).not.toContain("injecting steering guidance");
    expect(json).toContain("signature");
  });

  /*
  FNXC:PlannerOversight 2026-11-11-20:10 (RUFU-586):
  The bound must hold on BOTH durable arrays the writer touches, not just the one the operator reads, and it
  must hold when a second engine instance shares the card.
  */
  it("bounds both durable arrays the writer touches - comments and the executor's injection feed", async () => {
    const task = await seedTask();
    const { comments, feedComments } = await driveTicks({
      task,
      ticks: 18,
      signalFor: flapping,
      steeringLedger: new TaskStorePlannerSteeringLedger(store),
    });

    // `steeringComments` is what the executor's real-time injection listener watches, so an unbounded entry
    // there re-injects an instruction the agent already holds; `comments` is the Activity/Feed and CLI view.
    expect(deliveredPerReason(comments)).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(deliveredPerReason(feedComments)).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(feedComments.length).toBe(comments.length);
  });

  /*
  FNXC:PlannerOversight 2026-11-11-20:10 (RUFU-586):
  MEASURED CORRECTION TO THIS TASK'S SPEC. The spec priced each duplicate at an RUFU-259 inbox delivery and a
  wake of the assignee. That is not what the code does: `deliverTaskCommentFromStore` is called from the CLI,
  the dashboard routes, and Planner Chat - the human comment/steering write paths - and never from
  `addSteeringCommentImpl`, which the overseer uses. The real per-duplicate cost is therefore two durable array
  rows (one of them re-entering the executor's prompt), a `task:updated` broadcast, and a History line - not an
  inbox wake. Asserting the absence rather than a delivery/equality ratio, because the honest count here is
  zero for delivered ticks and zero for refused ticks; a vacuous-looking zero is the finding, not an omission.
  */
  it("the steering path costs no inbox delivery row - for a delivered tick or a refused one", async () => {
    const task = await seedTask();
    const ledger = new TaskStorePlannerSteeringLedger(store);
    const delivered = await driveTicks({ task, ticks: 9, signalFor: flapping, steeringLedger: ledger });
    expect(delivered.handlerCalls).toBeGreaterThan(0);
    expect(await deliveryRows(task.id)).toEqual([]);

    const refused = await driveTicks({ task, ticks: 9, startMs: START_MS + 9 * TICK_MS, signalFor: flapping, steeringLedger: ledger });
    expect(refused.handlerCalls).toBe(0);
    expect(refused.lastDecision?.steeringDeduped).toBe(true);
    expect(await deliveryRows(task.id)).toEqual([]);
  });

  /*
  FNXC:PlannerOversight 2026-11-11-20:10 (RUFU-586):
  Two engines on one database. The budget must be a property of the card, so two overseers that never see each
  other's memory still share one allowance - the case an in-memory count can never satisfy, and the reason the
  ledger reads through the store instead of caching what it last read.
  */
  it("two overseers on one store share one budget, because the budget is on the card", async () => {
    const task = await seedTask();
    const wiringA = wireRealEngineOverseer(store);
    const wiringB = wireRealEngineOverseer(store);
    let tickIndex = 0;
    const controllerFor = (handlers: PlannerRecoveryHandlers, ledger: PlannerSteeringLedger) =>
      new PlannerRecoveryController({
        snapshotProvider: { getSnapshot: (): OverseerStageObservation => observation({ taskId: task.id, stage: "executor", signal: flapping(tickIndex) }) },
        handlers,
        steeringLedger: ledger,
      });
    const controllerA = controllerFor(wiringA.handlers, new TaskStorePlannerSteeringLedger(store));
    const controllerB = controllerFor(wiringB.handlers, new TaskStorePlannerSteeringLedger(store));

    for (let i = 0; i < 12; i += 1) {
      tickIndex = i;
      const nowMs = START_MS + i * TICK_MS;
      const controller = i % 2 === 0 ? controllerA : controllerB;
      await controller.tick(task, { now: () => nowMs });
    }

    const comments = await steeringRows(task.id);
    expect(deliveredPerReason(comments)).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
    // 12 interleaved ticks with no durable bound reach the writer on every problem tick (8 here); the card
    // must show far fewer than that, which is only possible if both processes read the same ledger.
    expect(comments.length).toBeLessThan(8);
  });

  /*
  FNXC:PlannerOversight 2026-11-12-15:24 (RUFU-586 review F-1):
  The invariant names BOTH steering producers, and `request_targeted_fix` is the one the reproduction suite
  never drove: it posts its comment through the same `store.addSteeringComment` seam, so a gate narrowed
  back to `inject_guidance` would keep every other case green and re-open the flood for targeted fixes.
  Two of its properties differ from guidance and both are exercised here on purpose:
  1. its `decision.reason` is a FIXED sentence, so the signature never changes while the stall persists -
     the budget must therefore be spent by the gate, and no reason change can rescue the card;
  2. its comment TEXT interpolates the source ref, so each wave below carries a distinct string and neither
     byte-equality guard (RUFU-871's window nor `addSteeringCommentImpl`'s newest-entry refusal) absorbs it.
  Each wave runs on a fresh controller, which is the restart shape where both in-memory guards start empty
  and only the card still remembers - so 12 problem ticks must still land at most `cap` comments.
  */
  it("bounds the SECOND steering producer across restarts, and its notice names request-fix", async () => {
    const task = await seedTask();
    let fixCalls = 0;

    for (let wave = 0; wave < 6; wave += 1) {
      const wiring = wireRealEngineOverseer(store);
      const controller = new PlannerRecoveryController({
        snapshotProvider: {
          getSnapshot: (): OverseerStageObservation =>
            observation({
              taskId: task.id,
              stage: "executor",
              signal: "failed",
              sources: [{ kind: "failed-check", ref: `chk-${wave}` }],
            }),
        },
        handlers: {
          ...wiring.handlers,
          requestTargetedFix: async (...args: Parameters<NonNullable<PlannerRecoveryHandlers["requestTargetedFix"]>>) => {
            fixCalls += 1;
            await wiring.handlers.requestTargetedFix!(...args);
          },
        },
        steeringLedger: new TaskStorePlannerSteeringLedger(store),
      });
      for (let tick = 0; tick < 2; tick += 1) {
        const nowMs = START_MS + (wave * 2 + tick) * TICK_MS;
        await controller.tick(task, { now: () => nowMs });
      }
    }

    expect(fixCalls).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
    const comments = await steeringRows(task.id);
    // Every wave posted a DISTINCT string, so per-reason equality cannot be what bounds this count - the
    // durable per-signature budget is. Six waves posted past the cap would be the pre-fix shape.
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.length).toBeLessThanOrEqual(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(new Set(comments).size).toBe(comments.length);

    const timeline = await readTimeline(store, task.id);
    const notices = timeline.filter((entry) => entry.action === "request-fix" && entry.outcome === "skipped");
    // One announcement for the exhausted targeted-fix instruction, and it is filed under the producer that
    // was refused rather than under guidance - the timeline must say which of the two producers ran dry.
    expect(notices.length).toBe(1);
    expect(String(notices[0].reason)).toContain("already delivered");
    expect(notices[0].attemptCount).toBe(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(notices[0].attemptLimit).toBe(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(timeline.filter((entry) => entry.action === "inject-guidance" && entry.outcome === "skipped")).toEqual([]);
  });
});
