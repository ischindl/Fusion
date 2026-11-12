import { describe, expect, it, vi } from "vitest";
import { AWAITING_APPROVAL_PAUSE_REASON, PLANNER_RECOVERY_MAX_ATTEMPTS } from "@fusion/core";
import type { Task } from "@fusion/core";
import {
  PlannerRecoveryController,
  type PlannerRecoveryControllerOptions,
  type PlannerRecoveryHandlers,
} from "../overseer/planner-recovery-controller.js";
import type { Logger } from "../logger.js";
import type { PlannerSteeringGate, PlannerSteeringRequest } from "../overseer/planner-steering-ledger.js";
import type { OverseerStageObservation, OverseerWatchedStage } from "../overseer/planner-overseer.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "in-progress",
    ...overrides,
  } as Task;
}

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "FN-1",
    stage: "executor" as OverseerWatchedStage,
    signal: "failed",
    oversightLevel: "autonomous",
    observedAt: Date.now(),
    reason: "test",
    sources: [],
    ...overrides,
  };
}

function makeController(
  obs: OverseerStageObservation | null,
  handlers: PlannerRecoveryHandlers = {},
): PlannerRecoveryController {
  return new PlannerRecoveryController({
    snapshotProvider: { getSnapshot: () => obs },
    handlers,
  });
}

/*
FNXC:PlannerOversight 2026-11-12-15:24 (RUFU-586 review F-3):
A degraded steering budget is a fail-open path, so its ONLY trace is the warn the controller writes - a
suppressed console.warn would make these cases assert nothing about the degraded direction they exist for.
These tests therefore inject a spy logger rather than read the controller's real one.
*/
function loggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const noop = () => {};
  return { logger: { log: noop, debug: noop, warn, error: noop } as Logger, warn };
}

describe("PlannerRecoveryController.tick", () => {
  it("dispatches retryStep for a failed executor stage with no error source and increments the attempt count", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("retry_step");
    expect(retryStep).toHaveBeenCalledTimes(1);
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
  });

  it("dispatches injectGuidance for a reviewer-stage decision", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation({ stage: "reviewer", signal: "blocked" }), { injectGuidance });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("inject_guidance");
    expect(injectGuidance).toHaveBeenCalledTimes(1);
  });

  it("never steers an open review that reports progressing, however many ticks run", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation({ stage: "reviewer", signal: "progressing" }), { injectGuidance });

    for (let tick = 0; tick < 5; tick += 1) {
      const decision = await controller.tick(task());
      expect(decision?.action).toBe("none");
    }
    expect(injectGuidance).not.toHaveBeenCalled();
  });

  it("dispatches requestTargetedFix when the failed observation carries an error source link", async () => {
    const requestTargetedFix = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(
      observation({ sources: [{ kind: "failed-check", ref: "chk-1" }] }),
      { requestTargetedFix },
    );

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("request_targeted_fix");
    expect(requestTargetedFix).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching once the per-stage attempt budget is exhausted", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });

    for (let i = 0; i < PLANNER_RECOVERY_MAX_ATTEMPTS; i++) {
      await controller.tick(task());
    }
    expect(retryStep).toHaveBeenCalledTimes(PLANNER_RECOVERY_MAX_ATTEMPTS);

    const exhaustedDecision = await controller.tick(task());
    expect(exhaustedDecision?.action).toBe("none");
    expect(exhaustedDecision?.exhausted).toBe(true);
    expect(retryStep).toHaveBeenCalledTimes(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  // FN-7577: a stale recovery attempt must not keep a recovered task badged
  // "recovering" — a healthy/human-wait signal on the next tick clears the
  // per-(taskId, stage) attempt + last-action records, restoring a fresh budget.
  it("clears stale attempt records once the stage reports a healthy signal", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    let current: OverseerStageObservation = observation({ signal: "failed" });
    const controller = new PlannerRecoveryController({
      snapshotProvider: { getSnapshot: () => current },
      handlers: { retryStep },
    });

    await controller.tick(task());
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    expect(controller.getLastAction("FN-1", "executor")).toBe("retry_step");

    // Task recovers → healthy signal on the next tick clears the registry.
    current = observation({ signal: "progressing" });
    const healthy = await controller.tick(task());
    expect(healthy?.action).toBe("none");
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    expect(controller.getLastAction("FN-1", "executor")).toBeUndefined();

    // A later genuine failure starts from a fresh budget and dispatches again.
    current = observation({ signal: "failed" });
    await controller.tick(task());
    expect(retryStep).toHaveBeenCalledTimes(2);
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
  });

  it("is inert when effectiveLevel/oversightLevel is off/observe/steer", async () => {
    for (const level of ["off", "observe", "steer"] as const) {
      const retryStep = vi.fn().mockResolvedValue(undefined);
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ oversightLevel: level }), { retryStep, injectGuidance });
      const decision = await controller.tick(task());
      expect(decision?.action, `level=${level}`).toBe("none");
      expect(retryStep).not.toHaveBeenCalled();
      expect(injectGuidance).not.toHaveBeenCalled();
    }
  });

  it("is skipped entirely when task.userPaused is true", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    const decision = await controller.tick(task({ userPaused: true }));
    expect(decision).toBeNull();
    expect(retryStep).not.toHaveBeenCalled();
  });

  it("exposes only the three bounded handlers — no merge/PR/destructive action is invocable", () => {
    const handlers: PlannerRecoveryHandlers = {};
    const allowed = new Set(["injectGuidance", "retryStep", "requestTargetedFix"]);
    // Structural assertion: the handlers interface accepts exactly these three optional members.
    const keys = Object.keys({ injectGuidance: undefined, retryStep: undefined, requestTargetedFix: undefined } satisfies Required<PlannerRecoveryHandlers>);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
    void handlers;
  });

  it("clear(taskId) resets attempt state for that task", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    await controller.tick(task());
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    controller.clear("FN-1");
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
  });

  it("never throws when a handler rejects", async () => {
    const retryStep = vi.fn().mockRejectedValue(new Error("boom"));
    const controller = makeController(observation(), { retryStep });
    await expect(controller.tick(task())).resolves.not.toThrow();
    // Attempt count should not increment on a failed dispatch.
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
  });

  it("never throws when the snapshot is absent, and returns null", async () => {
    const controller = makeController(null, {});
    await expect(controller.tick(task())).resolves.toBeNull();
  });

  it("never throws when the snapshot provider itself throws", async () => {
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getSnapshot: () => {
          throw new Error("provider exploded");
        },
      },
    });
    await expect(controller.tick(task())).resolves.toBeNull();
  });

  it("adapts a getObservations()-style source (PlannerOverseerMonitor shape) via its latest observation", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getObservations: () => [observation({ signal: "progressing" }), observation({ signal: "failed" })],
      },
      handlers: { retryStep },
    });
    const decision = await controller.tick(task());
    expect(decision?.action).toBe("retry_step");
    expect(retryStep).toHaveBeenCalledTimes(1);
  });

  // FN-7743: a `stuck` executor observation (a genuinely hung/idle in-progress
  // task, the FN-7732 symptom) must reach bounded recovery exactly like a
  // `failed`/`blocked` one — `inject_guidance`, dispatched once per tick, with
  // the attempt budget incrementing — and a withheld (user-paused) task must
  // still dispatch nothing even though its stage is `stuck`.
  describe("FN-7743 stuck executor observation", () => {
    it("dispatches inject_guidance exactly once and increments the attempt budget for a stuck executor stage", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck", reason: "Executor stage inactive for over 3h with no execution activity" }), {
        injectGuidance,
      });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("inject_guidance");
      expect(injectGuidance).toHaveBeenCalledTimes(1);
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    });

    it("dispatches nothing for a stuck executor stage when the task is user-paused (human-control withhold wins)", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck" }), { injectGuidance });

      const decision = await controller.tick(task({ userPaused: true }));
      expect(decision).toBeNull();
      expect(injectGuidance).not.toHaveBeenCalled();
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    });

    it("dispatches nothing for a stuck executor stage when the task is approval-blocked (human-control withhold wins)", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck" }), { injectGuidance });

      const decision = await controller.tick(task({ paused: true, pausedReason: AWAITING_APPROVAL_PAUSE_REASON }));
      expect(decision).toBeNull();
      expect(injectGuidance).not.toHaveBeenCalled();
    });

    it("is inert for a stuck executor stage when effectiveLevel is off/observe/steer (no autonomous dispatch)", async () => {
      for (const level of ["off", "observe", "steer"] as const) {
        const injectGuidance = vi.fn().mockResolvedValue(undefined);
        const controller = makeController(observation({ stage: "executor", signal: "stuck", oversightLevel: level }), {
          injectGuidance,
        });
        const decision = await controller.tick(task());
        expect(decision?.action, `level=${level}`).toBe("none");
        expect(injectGuidance).not.toHaveBeenCalled();
      }
    });
  });

  /*
  FNXC:PlannerOversight 2026-11-11-10:55:
  RUFU-586 Step 1 - the three budget-reset paths, isolated. These pin the MECHANISM measured on the
  RUFU-286 exemplar (77 identical `[planner-oversight]` comments in ~20 h against a documented cap of 3)
  and they must stay true after the durable gate lands: the in-memory `attempts` registry is the card's
  overseer BADGE budget (FN-7577 derives "recovering" from `attemptCount > 0`), NOT the anti-spam
  authority, and with no ledger wired the controller's behaviour is byte-identical to today's. The
  durable anti-spam bound itself is asserted in `planner-overseer-intervention-wiring.test.ts` against a
  real store, because only the store can prove a comment was or was not delivered.
  */
  describe("RUFU-586 budget-reset paths (mechanism, measured on main)", () => {
    /** Past RUFU-871's in-memory 30-min guidance window, so a repeat is a real dispatch and not a suppression. */
    const PAST_WINDOW_MS = 31 * 60 * 1000;

    /** Controller whose signal is rebuilt per tick from `signalFor`, sharing one clock with the test. */
    function tickingController(
      signalFor: (tickIndex: number) => OverseerStageObservation["signal"],
      handlers: PlannerRecoveryHandlers,
      stage: OverseerWatchedStage = "executor",
    ) {
      const clock = { ms: 1_700_000_000_000, n: 0 };
      const controller = new PlannerRecoveryController({
        snapshotProvider: {
          getSnapshot: (): OverseerStageObservation => ({
            taskId: "FN-1",
            stage,
            signal: signalFor(clock.n),
            oversightLevel: "autonomous",
            observedAt: clock.ms,
            reason: "observed",
            sources: [],
          }),
        },
        handlers,
      });
      const advance = async () => {
        clock.n += 1;
        clock.ms += PAST_WINDOW_MS;
        await controller.tick(task(), { now: () => clock.ms });
      };
      return { controller, advance };
    }

    it("path (b) healthy-signal flap: the attempt budget never fills, so the documented cap of 3 cannot be reached", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const { controller, advance } = tickingController((n) => (n % 2 === 0 ? "stuck" : "progressing"), {
        injectGuidance,
      });

      let maxAttemptsSeen = 0;
      for (let i = 0; i < 12; i += 1) {
        await advance();
        maxAttemptsSeen = Math.max(maxAttemptsSeen, controller.getAttemptCount("FN-1", "executor"));
      }

      // Six problem signals, six dispatches: FN-7577's healthy-tick clear runs between every pair, so the
      // exhaustion rule never fires. Measured identically against a real store (document `root-cause`).
      expect(injectGuidance).toHaveBeenCalledTimes(6);
      expect(maxAttemptsSeen).toBe(1);
    });

    it("path (a) process restart: a fresh controller re-dispatches identical guidance, because the registry is in-memory", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const handlers: PlannerRecoveryHandlers = { injectGuidance };
      const stuck = observation({ stage: "executor", signal: "stuck" });

      const first = new PlannerRecoveryController({ snapshotProvider: { getSnapshot: () => stuck }, handlers });
      await first.tick(task());
      const second = new PlannerRecoveryController({ snapshotProvider: { getSnapshot: () => stuck }, handlers });
      await second.tick(task());
      const third = new PlannerRecoveryController({ snapshotProvider: { getSnapshot: () => stuck }, handlers });
      await third.tick(task());

      // Three "processes", three posts: nothing survives the restart, so neither the cap nor RUFU-871's
      // window does (the RUFU-547 lesson - an in-memory set is dead after a restart).
      expect(injectGuidance).toHaveBeenCalledTimes(3);
      expect(first.getAttemptCount("FN-1", "executor")).toBe(1);
      expect(second.getAttemptCount("FN-1", "executor")).toBe(1);
    });

    it("path (c) stage flip: each watched stage carries its own budget", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const executor = tickingController(() => "stuck", { injectGuidance }, "executor");
      await executor.advance();
      expect(executor.controller.getAttemptCount("FN-1", "executor")).toBe(1);

      const gate = tickingController(() => "stuck", { injectGuidance }, "workflow-gate");
      await gate.advance();

      // `attemptKey` is (taskId, stage), so a stage change is a fresh budget. This is legitimate - a
      // different watched stage IS a different reason - and it is excluded as the RUFU-286 explanation
      // because that stream was homogeneously `Stage "executor"`.
      expect(injectGuidance).toHaveBeenCalledTimes(2);
      expect(gate.controller.getAttemptCount("FN-1", "workflow-gate")).toBe(1);
      expect(executor.controller.getAttemptCount("FN-1", "executor")).toBe(1);
    });
  });

  /*
  FNXC:PlannerOversight 2026-11-11-13:05 (RUFU-586):
  Where the durable budget sits in the tick, and what a refusal may touch. The gate POSITION is the fix:
  RUFU-533 showed that a cap enforced inside an atomic write is skipped exactly when that write fails, so the
  controller asks BEFORE `dispatch()` and books only AFTER a handler really resolved. The real-store behaviour
  (comment counts, restarts, budget arithmetic) is asserted against a TaskStore in
  `planner-overseer-intervention-wiring.test.ts`; these cases pin the call ordering, which is what a
  `Map`-shaped bug cannot reproduce.
  */
  describe("RUFU-586 durable steering gate", () => {
    function fakeLedger(gate: Partial<PlannerSteeringGate> = {}) {
      return {
        evaluate: vi.fn().mockResolvedValue({
          allowed: true,
          basis: "fresh" as const,
          deliveredCount: 0,
          cap: PLANNER_RECOVERY_MAX_ATTEMPTS,
          noticeRecorded: false,
          ...gate,
        }),
        recordDelivery: vi.fn().mockResolvedValue(undefined),
        recordSuppression: vi.fn().mockResolvedValue(true),
      };
    }

    function steered(
      ledger: ReturnType<typeof fakeLedger>,
      handlers: PlannerRecoveryHandlers,
      logger?: PlannerRecoveryControllerOptions["logger"],
    ) {
      return new PlannerRecoveryController({
        snapshotProvider: { getSnapshot: () => observation({ stage: "executor", signal: "stuck" }) },
        handlers,
        steeringLedger: ledger,
        ...(logger ? { logger } : {}),
      });
    }

    it("asks the ledger BEFORE dispatching, and posts nothing when the budget refuses", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger({ allowed: false, basis: "cap-reached", deliveredCount: 3 });
      const controller = steered(ledger, { injectGuidance });

      const decision = await controller.tick(task());

      expect(ledger.evaluate).toHaveBeenCalledTimes(1);
      expect(injectGuidance).not.toHaveBeenCalled();
      expect(ledger.recordDelivery).not.toHaveBeenCalled();
      expect(ledger.recordSuppression).toHaveBeenCalledTimes(1);
      expect(decision?.action).toBe("inject_guidance");
      expect(decision?.steeringDeduped).toBe(true);
      // A refusal is not evidence the card got better and it is not a dispatch either: the badge budget
      // (and the card's status, which this class cannot write) stay exactly as they were.
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
      // And it is decided on the instruction, not on the card alone.
      const request = ledger.evaluate.mock.calls[0][0] as PlannerSteeringRequest;
      expect(request).toMatchObject({ taskId: "FN-1", action: "inject_guidance", stage: "executor" });
      expect(typeof request.now).toBe("number");
      expect(request.reason).toBe(decision?.reason);
    });

    it("books the delivery only after the handler resolved", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger();
      const controller = steered(ledger, { injectGuidance });

      const decision = await controller.tick(task());

      expect(injectGuidance).toHaveBeenCalledTimes(1);
      expect(ledger.recordDelivery).toHaveBeenCalledTimes(1);
      expect(ledger.recordSuppression).not.toHaveBeenCalled();
      expect(decision?.steeringDeduped).toBeUndefined();
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    });

    it("books nothing when the handler throws, so a failed post cannot spend the budget", async () => {
      const injectGuidance = vi.fn().mockRejectedValue(new Error("steering write failed"));
      const ledger = fakeLedger();
      const controller = steered(ledger, { injectGuidance });

      await expect(controller.tick(task())).resolves.not.toThrow();
      expect(ledger.recordDelivery).not.toHaveBeenCalled();
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    });

    it("never consults the budget for retry_step, which posts no instruction", async () => {
      const retryStep = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger({ allowed: false });
      const controller = new PlannerRecoveryController({
        snapshotProvider: { getSnapshot: () => observation({ stage: "executor", signal: "failed" }) },
        handlers: { retryStep },
        steeringLedger: ledger,
      });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("retry_step");
      expect(ledger.evaluate).not.toHaveBeenCalled();
      expect(retryStep).toHaveBeenCalledTimes(1);
    });

    it("never consults the budget for the merger lane, which posts no instruction", async () => {
      // FN-7840 makes `await_confirmation` unreachable through `tick()` in real wiring (a merger stage under
      // auto-merge returns "none", and without auto-merge the human-control guard withholds first), so this
      // asserts the reachable production shape of the same ordering fact: neither branch reaches the gate.
      const ledger = fakeLedger({ allowed: false });
      const controller = new PlannerRecoveryController({
        snapshotProvider: {
          getSnapshot: () => observation({ stage: "merger", signal: "blocked", reason: "Merge needs a checkpoint" }),
        },
        handlers: {},
        steeringLedger: ledger,
      });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("none");
      expect(decision?.requiresConfirmation).toBe(false);
      expect(ledger.evaluate).not.toHaveBeenCalled();
      expect(ledger.recordSuppression).not.toHaveBeenCalled();
    });

    it("never consults the budget when the decision is `none`", async () => {
      const ledger = fakeLedger({ allowed: false });
      const controller = new PlannerRecoveryController({
        snapshotProvider: { getSnapshot: () => observation({ stage: "executor", signal: "stuck", oversightLevel: "observe" }) },
        handlers: { injectGuidance: vi.fn() },
        steeringLedger: ledger,
      });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("none");
      expect(ledger.evaluate).not.toHaveBeenCalled();
    });

    it("without a ledger wired, the tick behaves exactly as it did before", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck" }), { injectGuidance });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("inject_guidance");
      expect(decision?.steeringDeduped).toBeUndefined();
      expect(injectGuidance).toHaveBeenCalledTimes(1);
    });

    /*
    FNXC:PlannerOversight 2026-11-12-15:24 (RUFU-586 review F-1):
    The invariant covers BOTH steering producers, because BOTH post a comment through
    `store.addSteeringComment`. `request_targeted_fix` is the second one and it is reached from a DIFFERENT
    observation shape than guidance (a `failed` signal carrying a `failed-check` source link), so a gate
    condition narrowed back to `inject_guidance` alone would keep this suite green and re-open the flood for
    targeted fixes. This case therefore drives that other shape end-to-end and asserts the handler is NOT
    called - the shape `dispatch()` would otherwise take.
    */
    it("refuses the SECOND steering producer too: a spent targeted-fix budget posts no comment", async () => {
      const requestTargetedFix = vi.fn().mockResolvedValue(undefined);
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger({ allowed: false, basis: "cap-reached", deliveredCount: PLANNER_RECOVERY_MAX_ATTEMPTS });
      const controller = new PlannerRecoveryController({
        snapshotProvider: {
          getSnapshot: () => observation({ stage: "executor", signal: "failed", sources: [{ kind: "failed-check", ref: "chk-1" }] }),
        },
        handlers: { requestTargetedFix, injectGuidance },
        steeringLedger: ledger,
      });

      const decision = await controller.tick(task());

      expect(decision?.action).toBe("request_targeted_fix");
      expect(requestTargetedFix).not.toHaveBeenCalled();
      expect(injectGuidance).not.toHaveBeenCalled();
      expect(decision?.steeringDeduped).toBe(true);
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
      expect(ledger.recordDelivery).not.toHaveBeenCalled();
      // The refusal is announced for the action that was refused, so the timeline row says "request-fix".
      const request = ledger.evaluate.mock.calls[0][0] as PlannerSteeringRequest;
      expect(request.action).toBe("request_targeted_fix");
      expect(ledger.recordSuppression.mock.calls[0][0]).toMatchObject({ action: "request_targeted_fix" });
    });

    /*
    FNXC:PlannerOversight 2026-11-12-15:24 (RUFU-586 review F-3):
    The budget fails OPEN. An unreadable budget must not withhold steering - withholding silences a card that
    may be genuinely stuck, which is worse than one more comment - so the gate call is wrapped at the
    controller seam (see `evaluateSteeringGate`) and the tick still returns its decision and dispatches. The
    prior shape of this test asserted the opposite (a null tick) only because `tick`'s single outer catch
    happened to swallow the ledger throw, which the spec's fail-open requirement does not allow: a null
    return reads as "no decision was computed", not as "the budget was unavailable".
    */
    it("a ledger that cannot answer delivers anyway: the gate fails open, warns, and is never mistaken for a suppression", async () => {
      const { logger, warn } = loggerSpy();
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger({ allowed: false });
      ledger.evaluate.mockRejectedValue(new Error("store unreachable"));
      const controller = steered(ledger, { injectGuidance }, logger);

      const decision = await controller.tick(task());

      expect(decision?.action).toBe("inject_guidance");
      expect(decision?.steeringDeduped).toBeUndefined();
      expect(injectGuidance).toHaveBeenCalledTimes(1);
      // The refusal never happened, so no "already delivered" notice may exist either.
      expect(ledger.recordSuppression).not.toHaveBeenCalled();
      expect(ledger.recordDelivery).toHaveBeenCalledTimes(1);
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("steering budget unavailable");
    });

    it("ledger bookkeeping that throws costs the NEXT episode its cadence, never this delivery", async () => {
      // The comment is already durable by the time bookkeeping runs. Losing the budget write must not undo
      // the dispatch, drop the badge count, or turn the tick into a failure - the degraded write is logged
      // and the tick still answers with its decision.
      const { logger, warn } = loggerSpy();
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger();
      ledger.recordDelivery.mockRejectedValue(new Error("write conflict"));
      const controller = steered(ledger, { injectGuidance }, logger);

      const decision = await controller.tick(task());

      expect(decision?.action).toBe("inject_guidance");
      expect(injectGuidance).toHaveBeenCalledTimes(1);
      expect(ledger.recordDelivery).toHaveBeenCalledTimes(1);
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("delivery bookkeeping failed");
    });

    it("a suppression the ledger cannot record is still a refusal, not a tick failure", async () => {
      const { logger, warn } = loggerSpy();
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const ledger = fakeLedger({ allowed: false, basis: "cap-reached", deliveredCount: PLANNER_RECOVERY_MAX_ATTEMPTS });
      ledger.recordSuppression.mockRejectedValue(new Error("advisory lock timeout"));
      const controller = steered(ledger, { injectGuidance }, logger);

      const decision = await controller.tick(task());

      expect(decision?.action).toBe("inject_guidance");
      expect(decision?.steeringDeduped).toBe(true);
      expect(injectGuidance).not.toHaveBeenCalled();
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("suppression bookkeeping failed");
    });
  });
});
