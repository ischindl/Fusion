/**
 * FNXC:PlannerOversight 2026-11-11-12:20:
 * RUFU-586: the durable steering budget, read and written on the card.
 *
 * The planner overseer polls every 45 s and its only bound on repeating ITS OWN instruction was an attempt
 * count in a `Map` inside `PlannerRecoveryController`. An engine restart empties that Map, a healthy signal
 * deletes the key (FN-7577, deliberately - the card's badge derives from `attemptCount > 0`), and a
 * watched-stage change moves to a new key, so the documented cap of 3 was unreachable for a card whose
 * signal oscillates: one card posted 77 identical steering comments in ~20 h, each a durable row in
 * `comments` AND `steering_comments` (both arrays and their `search_vector` GIN entries are rewritten per
 * append), a timeline entry, and a task-log line. The original report also priced each duplicate at an
 * RUFU-259 inbox delivery and a wake of the assignee; measurement disproved that, because
 * `deliverTaskCommentFromStore` is reached only from the CLI, dashboard routes and Planner Chat and never
 * from the `addSteeringCommentImpl` path the overseer uses - so the durable arrays, not an inbox wake, are
 * what this budget is protecting (pinned by the wiring suite's delivery-row assertion).
 *
 * This ledger is the count those three events cannot lower, because it lives on the card
 * (`sourceMetadata[PLANNER_OVERSIGHT_STEERING_METADATA_KEY]`) while the arithmetic lives in `@fusion/core`'s
 * pure `planner-steering-episode` module. This file owns I/O and the timeline notice, nothing else.
 *
 * Three placements are the contract, not implementation detail:
 *
 * 1. `evaluate` runs BEFORE `dispatch()`. The RUFU-533 lesson is that a cap enforced inside an atomic write
 *    is skipped exactly when the write fails; the writer is the wrong place for a budget, because a writer
 *    already handed the instruction is the last party that can still refuse it honestly.
 * 2. `recordDelivery` runs only after a handler really posted. Advancing a budget for a post that never
 *    happened would silence a card whose store write failed - the opposite failure of the one being fixed.
 * 3. A refusal writes no lifecycle field. Refusing to POST is not "nothing is wrong with this card", so it
 *    must not clear a status, write an error, or emit a success row; doing so would erase the recovering
 *    badge that tells an operator a planner is engaged.
 *
 * Every store interaction is wrapped: a ledger that cannot read or write degrades to "allow, do not
 * persist", which is today's behaviour. Suppressing steering on a database fault would silence a card that
 * may be genuinely stuck, and the flood that motivated this work was loud, not silent.
 */

import {
  PLANNER_OVERSIGHT_STEERING_METADATA_KEY,
  PLANNER_RECOVERY_MAX_ATTEMPTS,
  applyPlannerSteeringDelivery,
  asPlannerSteeringEpisode,
  deriveSteeringSignature,
  emitOverseerRecoveryAttempt,
  emitOverseerSteering,
  evaluatePlannerSteeringEpisode,
  withPlannerSteeringNotice,
  type PlannerInterventionOutcome,
  type PlannerOversightStage,
  type PlannerOversightSteeringEpisode,
  type PlannerSteeringEpisodeBasis,
  type Task,
  type TaskStore,
} from "@fusion/core";

const LOG = "[planner-steering-ledger]";

/** The two actions that post an instruction the agent already holds. A retry posts nothing, so it needs no budget. */
export type PlannerSteeringAction = "inject_guidance" | "request_targeted_fix";

export interface PlannerSteeringRequest {
  taskId: string;
  action: PlannerSteeringAction;
  /** The watched stage the decision is about; part of the signature, so a reviewer never spends an executor's budget. */
  stage: string;
  /** The decision's reason text. Digested into the signature, never stored as metadata. */
  reason: string;
  /** Epoch ms - the overseer's `ctx.now()` seam, so no test needs fake timers. */
  now: number;
}

export interface PlannerSteeringGate {
  allowed: boolean;
  basis: PlannerSteeringEpisodeBasis;
  /** Deliveries already recorded for THIS instruction. */
  deliveredCount: number;
  /** How many deliveries this instruction may receive per episode. */
  cap: number;
  /** The exhaustion notice was recorded by this call (or had been recorded earlier in the episode). */
  noticeRecorded: boolean;
}

/**
 * The steering budget, per card and per reason.
 *
 * The three methods map onto one tick: `evaluate` asks permission, `recordDelivery` books a post that
 * happened, and `recordSuppression` books the one timeline row explaining a post that did not.
 */
export interface PlannerSteeringLedger {
  evaluate(request: PlannerSteeringRequest): Promise<PlannerSteeringGate>;
  recordDelivery(request: PlannerSteeringRequest): Promise<void>;
  recordSuppression(request: PlannerSteeringRequest): Promise<boolean>;
}

/**
 * The refusal sentence, once per episode, on the surface the operator already reads. It names the count and
 * the window rather than a countdown, because the countdown would be a second clock nobody maintains.
 */
export function steeringSuppressionNotice(input: {
  deliveredCount: number;
  cap: number;
  stage: string;
  firstAt: string | null;
}): string {
  const since = input.firstAt ? ` since ${input.firstAt}` : "";
  return (
    `[planner-oversight] Steering already delivered ${input.deliveredCount}/${input.cap} times for this reason${since}; ` +
    `nothing new posted (stage "${input.stage}"). The earlier instruction still stands and the card remains under oversight.`
  );
}

function readEpisode(task: Task | null | undefined): PlannerOversightSteeringEpisode | null {
  return asPlannerSteeringEpisode(task?.sourceMetadata?.[PLANNER_OVERSIGHT_STEERING_METADATA_KEY]);
}

/**
 * `sourceMetadataPatch` merges at KEY level, so writing this one key leaves `duplicateOfTaskIds`,
 * `handoffFrom`, `contentFingerprint` and every other provenance entry alone. Returning `null` from the
 * updater makes `updateTaskAtomic` skip the write entirely, which is the right response to "nothing changed".
 */
function steeringPatch(episode: PlannerOversightSteeringEpisode) {
  return { sourceMetadataPatch: { [PLANNER_OVERSIGHT_STEERING_METADATA_KEY]: episode } };
}

export interface TaskStorePlannerSteeringLedgerDeps {
  /** Injected in tests; defaults to `Date.now`, so production reads no clock seam. */
  now?: () => number;
}

export class TaskStorePlannerSteeringLedger implements PlannerSteeringLedger {
  constructor(
    private readonly store: TaskStore,
    private readonly deps: TaskStorePlannerSteeringLedgerDeps = {},
  ) {}

  /**
   * Permission for one instruction, decided over the card's stored budgets. A store that cannot answer
   * degrades to "allow" - the pre-fix behaviour - rather than withholding steering from a card that may be
   * genuinely stuck.
   */
  async evaluate(request: PlannerSteeringRequest): Promise<PlannerSteeringGate> {
    const signature = deriveSteeringSignature({ action: request.action, stage: request.stage, reason: request.reason });
    let task: Task | null = null;
    try {
      task = await this.store.getTask(request.taskId);
    } catch (err) {
      console.warn(`${LOG} getTask failed, allowing delivery taskId=${request.taskId}`, err instanceof Error ? err.message : err);
      return { allowed: true, basis: "fresh", deliveredCount: 0, cap: PLANNER_RECOVERY_MAX_ATTEMPTS, noticeRecorded: false };
    }
    const decision = evaluatePlannerSteeringEpisode(readEpisode(task), { ...request, signature });
    return {
      allowed: decision.allowed,
      basis: decision.basis,
      deliveredCount: decision.deliveredCount,
      cap: decision.cap,
      noticeRecorded: Boolean(decision.entry?.noticeRecordedAt),
    };
  }

  /**
   * Book a delivery that really happened. One atomic key-level write; a failure is logged and swallowed,
   * because a steering comment the agent already received must not be rolled back by its own bookkeeping.
   */
  async recordDelivery(request: PlannerSteeringRequest): Promise<void> {
    const signature = deriveSteeringSignature({ action: request.action, stage: request.stage, reason: request.reason });
    const now = this.deps.now?.() ?? request.now;
    try {
      await this.store.updateTaskAtomic(request.taskId, (current) =>
        steeringPatch(applyPlannerSteeringDelivery(readEpisode(current), { ...request, now, signature })),
      );
    } catch (err) {
      console.warn(`${LOG} recordDelivery failed taskId=${request.taskId}`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Record that a post was refused, announce it ONCE per episode, and report whether THIS call announced.
   *
   * The stamp is written under the task advisory lock before anything is emitted, so two overseers racing
   * cannot both announce, and a notice never exists without the durable evidence behind it (the RUFU-144
   * rule). Announcing is best-effort: a timeline write that fails leaves the stamp in place, which costs one
   * missing row rather than a repeat of the flood this task removes.
   */
  async recordSuppression(request: PlannerSteeringRequest): Promise<boolean> {
    const signature = deriveSteeringSignature({ action: request.action, stage: request.stage, reason: request.reason });
    const now = this.deps.now?.() ?? request.now;
    let announced: { deliveredCount: number; cap: number; firstAt: string | null } | null = null;
    try {
      await this.store.updateTaskAtomic(request.taskId, (current) => {
        const episode = readEpisode(current);
        const decision = evaluatePlannerSteeringEpisode(episode, { ...request, now, signature });
        if (decision.allowed || !decision.budgetExhausted) return null;
        // `decision.entry` is the refused instruction's budget wherever it lives (active slot or `prior`).
        // Only the active slot carries the stamp, so core's notice helper promotes that entry AND re-derives
        // the surviving `prior` budgets: this seam deliberately runs no slot arithmetic of its own, so a
        // notice write and a delivery write cannot disagree about which instructions a card tracks.
        const target = decision.entry;
        if (target?.noticeRecordedAt) return null;
        const withNotice = withPlannerSteeringNotice(episode, now, signature);
        if (!withNotice) return null;
        announced = { deliveredCount: decision.deliveredCount, cap: decision.cap, firstAt: target?.firstAt ?? null };
        return steeringPatch(withNotice);
      });
    } catch (err) {
      console.warn(`${LOG} recordSuppression failed taskId=${request.taskId}`, err instanceof Error ? err.message : err);
      return false;
    }
    if (!announced) return false;
    await this.emitSuppression(request, announced);
    return true;
  }

  /**
   * The suppression's intervention-timeline row plus its card History line.
   *
   * `outcome: "skipped"` is the terminal non-blocking status the timeline already understands for a withheld
   * intervention - it is not a reviewer verdict, and this authors no `workflowStepResults` row, so it cannot
   * be read as a gate result. `emitOverseerSteering` fixes `action: "inject-guidance"` and
   * `emitOverseerRecoveryAttempt` fixes `"request-fix"`, so the emitter follows the refused action instead of
   * forcing one category.
   */
  private async emitSuppression(
    request: PlannerSteeringRequest,
    detail: { deliveredCount: number; cap: number; firstAt: string | null },
  ): Promise<void> {
    const message = steeringSuppressionNotice({ ...detail, stage: request.stage });
    const input = {
      store: this.store,
      taskId: request.taskId,
      stage: request.stage as PlannerOversightStage,
      reason: message,
      outcome: "skipped" as PlannerInterventionOutcome,
      attemptCount: detail.deliveredCount,
      attemptLimit: detail.cap,
      source: "lifecycle" as const,
    };
    try {
      await (request.action === "request_targeted_fix" ? emitOverseerRecoveryAttempt(input) : emitOverseerSteering(input));
    } catch (err) {
      console.warn(`${LOG} timeline notice failed taskId=${request.taskId}`, err instanceof Error ? err.message : err);
    }
    try {
      await this.store.logEntry(request.taskId, message);
    } catch (err) {
      console.warn(`${LOG} history line failed taskId=${request.taskId}`, err instanceof Error ? err.message : err);
    }
  }
}

