/*
FNXC:ReviewEscalationNotice 2026-09-28-07:34 (RUFU-371):
RUFU-180 made a refused review-lane card announce itself, but the class that matters most stayed silent:
a card the review-convergence protocol escalated to a human. Measured for RUFU-281 — `in-review`,
`status=awaiting-approval`, `reviewConvergenceStage=3`, `reviewConvergenceEscalationCount=1`, a Code Review
row `status=failed` with no verdict, parked since 2026-09-24T19:40Z — the sweep fired six times in one day
(11:24, 12:01, 12:37, 13:25, 14:22, 15:33Z) and every row was
`task:reconcile-review-stall-notification` with `outcome:"unavailable"`. No mailbox message, no push, and the
operator found the card only by asking.

`NotificationService` owns wedge episodes, and an escalated review is not one: the convergence protocol
finished its own retries and deliberately parked the card for a person, so there is no episode row, no pending
mark, and no cooldown to hang delivery off — every service call resolves to `unavailable` by construction.
This module is the RUFU-283 answer for that shape: one idempotent mailbox notice per
(task, stage, cooldown window), written by the sweep itself, with `NotificationService` left as the sole
validation and dispatch authority for everything it can actually own.

It changes no lifecycle, no verdict, and no column. A missing, throwing, or stalled mailbox cannot alter the
sweep: `deliverMailboxMessageOnce` bounds it and reports `unavailable`, which is recorded rather than raised.
*/
import { DASHBOARD_USER_ID, type MessageStore, type Task } from "@fusion/core";
import { deliverMailboxMessageOnce } from "./mailbox-delivery.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import type { TaskStore } from "@fusion/core";

/** Converge-escalated parks reach stage 3 and stay there; the count is the durable proof of the escalation. */
export const REVIEW_CONVERGENCE_HUMAN_STAGE = 3;

const REVIEW_ESCALATION_NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** True when the review-convergence protocol handed this card to a human and will not retry itself. */
export function isConvergenceEscalatedTask(task: Pick<Task, "reviewConvergenceStage" | "reviewConvergenceEscalationCount">): boolean {
  const escalated = typeof task.reviewConvergenceEscalationCount === "number" && task.reviewConvergenceEscalationCount > 0;
  const atHumanStage = typeof task.reviewConvergenceStage === "number"
    && task.reviewConvergenceStage >= REVIEW_CONVERGENCE_HUMAN_STAGE;
  return escalated && atHumanStage;
}

/**
 * Bucketed key: an unaddressed escalation re-announces once per window instead of once forever, while
 * repeats inside the window collapse to one row through `sendMessageOnce`'s conflict-ignored insert.
 */
export function reviewEscalationNoticeKey(taskId: string, stage: number, now: number): string {
  const bucket = Math.floor(now / REVIEW_ESCALATION_NOTICE_COOLDOWN_MS);
  return `system:review-convergence-escalation:${taskId}:${stage}:${bucket}`;
}

/**
 * Age of a review-lane park in ms, from the most durable evidence available.
 *
 * `stallReason.observedAt` is re-stamped on every observation, so it reports ~0 for a multi-day park — the
 * bug that made RUFU-281's three-day stall rank as brand new. Prefer the lane-entry timestamp, then any
 * durable update, then the observation. Inputs are TEXT ISO strings; parse rather than compare in SQL.
 */
export function resolveStallParkAgeMs(input: {
  columnMovedAt?: string | null;
  updatedAt?: string | null;
  observedAt?: string | null;
  now: number;
}): number | undefined {
  for (const candidate of [input.columnMovedAt, input.updatedAt, input.observedAt]) {
    const parsed = Date.parse(candidate ?? "");
    if (Number.isFinite(parsed)) return Math.max(0, input.now - parsed);
  }
  return undefined;
}

/**
 * Deliver one operator notice for a convergence-escalated card that the wedge-notification service could
 * not represent, and record the attempt. Metadata is ids/counts/fixed enums only — the reviewer prose that
 * produced the escalation never enters run-audit.
 */
export async function notifyReviewEscalationUnreachable(input: {
  store: TaskStore;
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
  task: Task;
  stallCode: string;
  stallAgeMs?: number;
  now?: number;
  timeoutMs?: number;
}): Promise<"delivered" | "unavailable"> {
  const now = input.now ?? Date.now();
  const stage = input.task.reviewConvergenceStage ?? REVIEW_CONVERGENCE_HUMAN_STAGE;
  const ageHours = typeof input.stallAgeMs === "number" ? Math.floor(input.stallAgeMs / (60 * 60 * 1000)) : undefined;
  const notice = await deliverMailboxMessageOnce(
    input.messageStore ?? undefined,
    {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: `Review needs a human decision on ${input.task.id}: the review-convergence protocol escalated it `
        + `to stage ${stage} and will not retry itself${ageHours !== undefined ? ` (waiting ${ageHours} h)` : ""}. `
        + `The stalled review has not produced a verdict — approve, request changes, or bypass the gate.`,
      metadata: {
        kind: "review-convergence-escalation",
        taskId: input.task.id,
        reviewConvergenceStage: stage,
        reviewConvergenceEscalationCount: input.task.reviewConvergenceEscalationCount ?? 0,
        stallCode: input.stallCode,
      },
    },
    reviewEscalationNoticeKey(input.task.id, stage, now),
    input.timeoutMs,
  );
  await emitBoundedRunAudit(input.store, {
    taskId: input.task.id,
    agentId: "self-healing",
    runId: `review-convergence-escalation-notice:${input.task.id}`,
    domain: "database",
    mutationType: "task:review-convergence-escalation-notice" as never,
    target: input.task.id,
    metadata: {
      taskId: input.task.id,
      reviewConvergenceStage: stage,
      stallCode: input.stallCode,
      notice,
      ...(typeof input.stallAgeMs === "number" ? { stallAgeMs: input.stallAgeMs } : {}),
    },
  });
  return notice;
}
