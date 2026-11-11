/*
FNXC:PlanningLockOperatorSurface 2026-11-11-17:35 (RUFU-600 Step 5, reporter's steps 2-4):
Before this file existed, a planning-lifecycle refusal had exactly one shape on the wire: HTTP 500 with
the raw core sentence (`Planning lifecycle lock acquisition timed out after 5000ms: requirement=...`).
That message named neither the holder nor the wait, and 500 tells an operator "the server broke" when the
truth is "someone else is holding your card's planning key" — a condition with a remedy. This module owns
both halves of that fix:

  GET  /tasks/:id/planning-lock          who holds this card's planning key right now, and how full
                                         the transport is (`{ transport, budgetMs, holders, ... }`)
  POST /tasks/:id/planning-lock          { "confirm": true } — end the session that holds the key

POST is a separate verb on the same path rather than a nested `/release` because it acts on the same
resource the GET describes, and it requires an explicit confirmation body: PostgreSQL offers no way to
release another session's advisory lock (`pg_advisory_unlock` releases only the calling session's keys,
and cancel cannot unhold an idle-in-transaction session), so the ONLY lever is terminating that session.
The store therefore refuses `confirm !== true` outright, and the release surface itself — not only this
route — holds the veto conjunction the code-review P0 demanded: the holder must be a session this product
opened, must sit past `PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS`, must not be mid-statement or registered
live here, and must belong to a card the caller can prove is idle. A route cannot forget those checks, and
cannot lower them from a request body either. The route's job is only to relay each veto with a status that
matches its meaning: 400 for a missing confirmation, 404 for an id that names no card, 409 for a holder that
exists and will not be touched, 503 for a state that could not be read or acted on — and 200 only for the
two answers that state a trustworthy key state (`released`, `not-held`).

`mapPlanningLifecycleLockError` is the reason-mapping shared by every lane that acquires a planning lock
on an operator's behalf: `contention` is a 409 (a conflict the caller can resolve), while a transport that
could not be reached, an unproven key release, and an expired hold are 503s — a service that cannot answer,
not a conflict. Keeping that split in one function is what stops the retry route, the reset route, and any
future lane from each inventing its own status for the same refusal.
*/

import type { PlanningLifecycleHolder, TaskStore } from "@fusion/core";
import { isTaskPlanningOrExecutionLive } from "@fusion/engine";

import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import { isTaskLookupMiss } from "./task-lookup-error.js";
import type { ApiRoutesContext } from "./types.js";

/** A service that could not answer — distinct from a 409 conflict, which has a holder and a remedy. */
function serviceUnavailable(message: string, details?: Record<string, unknown>, cause?: unknown): ApiError {
  return new ApiError(503, message, details, cause);
}

/** Human sentence for a holder. Age is PostgreSQL's own measurement, never a local clock subtraction. */
function describeHolder(holder: PlanningLifecycleHolder): string {
  const ageSeconds = Math.max(0, Math.round(holder.ageMs / 1000));
  const taskSuffix = holder.taskId && holder.taskId !== "unattributed" ? ` for ${holder.taskId}` : "";
  return `${holder.label}${taskSuffix} (pid ${holder.pid}, ${holder.state} ${ageSeconds}s)`;
}

/** Shortest honest hint about where to act, so the refusal carries its own remedy. */
function remedy(taskId: string): string {
  return `Ask GET /api/tasks/${taskId}/planning-lock to see the holder, or POST {"confirm": true} to that path to release it.`;
}

/**
 * Classify a planning-lifecycle refusal into the HTTP answer an operator can act on.
 *
 * Detection is structural (`name` + the `reason` enum) with `instanceof` as a fast path: the error crosses
 * a package boundary, and a bundler that materialises `@fusion/core` twice would make `instanceof` alone
 * an unreliable classifier — which is exactly how a contention refusal ends up back as a 500.
 */
export function mapPlanningLifecycleLockError(error: unknown, taskId: string): unknown {
  const detail = error as Partial<{
    name?: string;
    reason?: "contention" | "transport-unavailable" | "teardown-unproven" | "hold-exceeded";
    phase?: string;
    budgetMs?: number;
    waitedMs?: number;
    heldMs?: number;
    maxHoldMs?: number;
    holder?: PlanningLifecycleHolder;
    message?: string;
  }> | null;
  const isPlanningLockFailure = error instanceof Error
    && (error.name === "PlanningLifecycleLockTransportError" || detail?.reason !== undefined);
  if (!isPlanningLockFailure || !detail?.reason) return error;

  switch (detail.reason) {
    case "contention": {
      const waited = typeof detail.waitedMs === "number" ? detail.waitedMs : undefined;
      const budget = typeof detail.budgetMs === "number" ? detail.budgetMs : undefined;
      const measured = waited !== undefined || budget !== undefined
        ? ` (waited ${waited ?? 0}ms${budget ? ` of a ${budget}ms budget` : ""})`
        : "";
      return conflict(
        detail.holder
          ? `This card's planning key is held by ${describeHolder(detail.holder)}${measured}. ${remedy(taskId)}`
          : `This card's planning key is already taken${measured}, and its holder could not be identified — the direct session used to look it up was not available. ${remedy(taskId)}`,
        {
          taskId,
          reason: "planning-lock-contention",
          ...(detail.holder ? { holder: detail.holder } : {}),
          ...(waited !== undefined ? { waitedMs: waited } : {}),
          ...(budget !== undefined ? { budgetMs: budget } : {}),
        },
        error,
      );
    }
    case "transport-unavailable":
      return serviceUnavailable(
        `The planning-lock transport is unavailable, so no planning key could be checked or taken for this card. ${remedy(taskId)}`,
        { taskId, reason: "planning-lock-transport-unavailable" },
        error,
      );
    case "teardown-unproven":
      return serviceUnavailable(
        `The planning lock for this card was released but its session could not be proven gone. ${remedy(taskId)}`,
        { taskId, reason: "planning-lock-release-unproven" },
        error,
      );
    case "hold-exceeded":
      return serviceUnavailable(
        `The planning hold for this card outlived its ${detail.maxHoldMs ?? "configured"}ms bound and its own session was ended. Re-run the action.`,
        { taskId, reason: "planning-lock-hold-exceeded", ...(detail.heldMs !== undefined ? { heldMs: detail.heldMs } : {}) },
        error,
      );
    default:
      return error;
  }
}

/**
 * Acquire the planning lock on an operator's behalf, refusing with a status that says who holds the key
 * rather than 500. Every lane that answers a human with this lock goes through here.
 */
export async function withOperatorPlanningLock<T>(
  store: TaskStore,
  taskId: string,
  run: () => Promise<T>,
  options: NonNullable<Parameters<TaskStore["withPlanningLifecycleLock"]>[2]> = {},
): Promise<T> {
  try {
    return await store.withPlanningLifecycleLock(taskId, run, options);
  } catch (error) {
    throw mapPlanningLifecycleLockError(error, taskId);
  }
}

/**
 * Resolve the card before acting on its key.
 *
 * FNXC:TaskLookup404 2026-11-11-19:14 (RUFU-600 code-review P2):
 * A planning key is derived from an id, not validated against one, so an id that names no card still
 * derives `fusion:planning-lifecycle:<project>:<that-id>`. Answering a diagnosis — or worse, running a
 * terminate — against a key derived from a typo is how an operator's mistake quietly becomes an action on
 * somebody else's id, and reporting 200 `not-held` for a card that does not exist is the same shape of lie
 * as "no active lock to release" over a locked key. Every per-task route answers 404 this way already
 * (`task-lookup-error.ts`); these two handlers were the ones that skipped the lookup.
 */
async function requireTask(store: TaskStore, taskId: string): Promise<void> {
  try {
    if (!await store.getTask(taskId)) throw notFound(`Task ${taskId} not found`);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isTaskLookupMiss(error)) throw notFound(error instanceof Error && error.message ? error.message : `Task ${taskId} not found`);
    throw error;
  }
}

/**
 * The card-liveness veto the release surface refuses to act without.
 *
 * FNXC:PlanningLifecycleLockRelease 2026-11-11-19:14 (RUFU-600 code-review P0):
 * The reclaim sweep injects `getTaskPlanningOrExecutionLivenessSignal` built from its own options; this is
 * the same authority reached from the HTTP lane. The registries it reads (`activeSessionRegistry`,
 * `executingTaskLock`, `planningLivenessRegistry`) are process-global and the dashboard hosts the engine
 * in-process, so the answer the operator's Release gets is the answer the executor's own session would
 * give. The release primitive treats a missing or throwing probe as "busy", so this call can only ever
 * widen the refusal, never narrow it.
 */
function cardLivenessVeto(taskId: string): boolean {
  try {
    return isTaskPlanningOrExecutionLive(taskId);
  } catch {
    // Fail-closed by contract: an unanswered question is an unprovable card, and an unprovable card keeps its session.
    return true;
  }
}

/** Operator sentence per withheld release. Each reason is a distinct answer, so each gets its own words. */
function refusalSentence(reason: string, holder: PlanningLifecycleHolder | null, taskId: string): string {
  const who = holder ? describeHolder(holder) : "a session this product could not identify";
  switch (reason) {
    case "holder-active":
    case "live-session":
      return `The planning lock is held by a session that is still doing work (${who}); ending it would destroy in-flight work.`;
    case "card-live":
      return `This card is running a planning or execution session right now, so the session holding its key (${who}) belongs to work that is still in progress. Nothing was ended.`;
    case "below-age-floor":
      return `The session holding this card's planning key (${who}) has not yet been idle long enough to be provably dead, so it was not ended. Wait and retry, or check GET /api/tasks/${taskId}/planning-lock.`;
    case "foreign-holder":
      return `The session holding this card's planning key (${who}) was not opened by Fusion, so Fusion will not end a session it does not own.`;
    case "identity-not-derivable":
      return `A session holds this card's planning key but its identity could not be read, and releasing would mean ending a session that cannot be named. ${remedy(taskId)}`;
    case "holder-query-failed":
      return "The holder of this card's planning key could not be read, so the key's state is unknown — unknown is not free, and nothing was ended.";
    case "liveness-unproven":
      return "Whether this card is mid-planning or mid-execution could not be determined, so its holding session was not ended.";
    case "transport-unavailable":
      return "The planning-lock transport is unavailable, so the holding session could not be reached.";
    case "terminate-failed":
      return "PostgreSQL refused to end the holding session, so the key stays held.";
    case "release-unproven":
      return `The holding session was ended but the key was not measured free; check GET /api/tasks/${taskId}/planning-lock.`;
    default:
      return "The planning lock could not be released.";
  }
}

export function registerTaskPlanningLockRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  /*
  A pure read: it takes no lock, changes nothing, and answers the only two questions the operator has —
  is the transport even usable, and which session is holding my card. A refusal here is never a guess:
  `holdersReason` and `transport.available` say when the answer is "could not be read".
  */
  router.get("/tasks/:id/planning-lock", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      await requireTask(store, req.params.id);
      const diagnosis = await store.diagnosePlanningLifecycleLock(req.params.id);
      if (!diagnosis) throw serviceUnavailable(
        "Planning-lock diagnosis needs the PostgreSQL backend; this project's store has no advisory-lock domain to read.",
        { taskId: req.params.id, reason: "planning-lock-backend-unsupported" },
      );
      res.json(diagnosis);
    } catch (error) {
      rethrowAsApiError(error);
    }
  });

  /*
  The write half, and the only lane in the product allowed to end a planning-lifecycle session it did not
  open. The confirmation is required at the STORE layer too, so a client that forgets the body is refused
  by the same rule regardless of which surface called it; the route adds no authority of its own.
  */
  router.post("/tasks/:id/planning-lock", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.confirm !== true) {
        throw badRequest(
          "Releasing a planning lock ends the session that holds it — PostgreSQL offers no other lever over a foreign advisory holder. Send { \"confirm\": true } to proceed.",
        );
      }
      await requireTask(store, req.params.id);
      /*
      Only `confirm` is taken from the request. The age floor in particular is never a client-supplied knob:
      a body field that could lower it would hand back, over HTTP, exactly the guard the P0 remediation put
      in place. `isCardLive` is the veto the store refuses to act without.
      */
      const report = await store.releasePlanningLifecycleLock(req.params.id, {
        confirm: true,
        isCardLive: (taskId: string) => cardLivenessVeto(taskId),
      });
      if (!report) throw serviceUnavailable(
        "Planning-lock release needs the PostgreSQL backend; this project's store has no advisory-lock domain to release.",
        { taskId: req.params.id, reason: "planning-lock-backend-unsupported" },
      );
      /*
      FNXC:PlanningLockOperatorSurface 2026-11-11-19:14 (RUFU-600 code-review P1):
      200 is an ALLOWLIST, not a fall-through. `released` and `not-held` are the only two answers that state a
      key state the caller can rely on, and `not-held` is what makes a repeated or concurrent Release click
      idempotent. Everything else is a refusal and must answer with a refusal status: the previous shape let
      `identity-not-derivable` and `holder-query-failed` fall out to a 200 body, which told a client that
      trusts status that the lock was released while the card stayed locked behind the same holder — the
      "no active lock to release" answer this card exists to remove. An unrecognised reason is a refusal too:
      a status this file has never heard of may not be reported as success.
      */
      if (report.released) {
        res.json(report);
        return;
      }
      const details: Record<string, unknown> = {
        taskId: req.params.id,
        reason: report.reason,
        ...(report.holder ? { holder: report.holder } : {}),
      };
      if (report.reason === "not-held") {
        res.json(report);
        return;
      }
      if (report.reason === "confirmation-required") {
        throw badRequest(
          "Releasing a planning lock ends the session that holds it. Send { \"confirm\": true } to proceed.",
          details,
        );
      }
      const conflictReasons: readonly string[] = ["holder-active", "live-session", "card-live", "below-age-floor", "foreign-holder", "identity-not-derivable"];
      if (conflictReasons.includes(report.reason)) {
        throw conflict(refusalSentence(report.reason, report.holder, req.params.id), details);
      }
      throw serviceUnavailable(refusalSentence(report.reason, report.holder, req.params.id), details);
    } catch (error) {
      rethrowAsApiError(error);
    }
  });
}
