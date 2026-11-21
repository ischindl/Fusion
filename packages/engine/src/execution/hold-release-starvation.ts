/*
FNXC:HoldReleaseArmedPriority 2026-11-21-06:20 (RUFU-807 Step 3):
Turns "this pass reached its deadline with THIS card still unevaluated" into something the card can say.

`hold-release.ts` has measured budget truncation since RUFU-209 and printed it since RUFU-698 —
`budget-truncated unevaluated=700` on every pass of a 873-card project for over 14 hours, with the oldest
deferred card at 2.0 days. That number answers "how many" and nothing answers "which", so the one actor
that could act — the operator looking at the board — saw a card with an approved plan and no explanation.
Every existing announcer for a planning-lane card belongs to triage (`plan-admission-throttled`,
`planning-admission-stalled`) and none of them observes the release sweep, so a card the RELEASE sweep
starves is invisible to all of them.

Why the writer is the sweep and not a read-side derivation: the fact only exists inside the pass that
truncates. RUFU-393's rule applies verbatim — a read-time inference about elapsed time would be a second
authority competing with the observer, and the two disagreeing is how a badge outlives its cause.

Why it is bounded the way it is:
- **Only armed cards are named.** A card with no live continuation work is waiting on an ordinary queue,
  and RUFU-698's rotation is the honest answer for it. This badge claims a mechanism, so it is written
  only for the cards whose wait has a deadline (an approved Plan Review that released a continuation).
- **The refresh floor** (`holdReleaseStarvationWrite`) collapses a sustained episode to at most four
  writes an hour per card; without it a ~3 s poll interval writes ~1 200 rows/hour/card — the exact
  16 536-row storm RUFU-393 measured.
- **A per-pass write cap** bounds the FIRST truncating pass. An armed population larger than one pass's
  budget would otherwise spend the sweep's remaining budget on diagnostics for every one of them, which
  is the RUFU-871 defect (diagnostics charged to the phase they describe) re-authored at a different
  boundary.

Best-effort by contract, like every other episode writer here: a rejected update is logged and dropped.
A diagnostic that can fail a release is worse than no diagnostic, and the release decision was already
made and recorded before this module is reached.
*/
import {
  HOLD_RELEASE_STARVATION_METADATA_KEY,
  holdReleaseStarvationWrite,
  clearHoldReleaseStarvationPatch,
  type TaskHoldReleaseStarvationEpisode,
} from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { schedulerLog } from "../logger.js";

/** Episode code carried by every observation this module writes. */
const RELEASE_SWEEP_BUDGET_STARVED = "release-sweep-budget-starved" as const;

/*
FNXC:HoldReleaseArmedPriority 2026-11-21-06:20 (RUFU-807 Step 3):
How many cards one truncating pass may name. Half of MAX_ARMED_PRIORITY_IDS, so a pass cannot spend more
than half its front-partition budget on the diagnostics that describe why the other half went unreached.
Cards past the cap are simply not named this pass; the episode is a per-card episode, so the next pass
that truncates names the ones it had to skip — the count is lossy per pass and convergent over passes,
which is the right trade for a diagnostic.
*/
export const MAX_STARVATION_WRITES_PER_PASS = 100;

/** One deferred card as the truncating pass saw it. */
export interface StarvedCardObservation {
  taskId: string;
  column: string;
  /** The card's persisted episode, taken from the candidate row this pass already read (no new read). */
  existing?: TaskHoldReleaseStarvationEpisode;
}

/** What one naming pass did, for the summary line and the tests. */
export interface StarvationPassResult {
  /** Episodes accepted this pass (a write landed). */
  namedCount: number;
  /** Cards inside the refresh floor that needed no write. */
  alreadyNamedCount: number;
  /** Accepted writes that the store refused — diagnostics degraded, the sweep did not. */
  writeFailedCount: number;
  /** Cards skipped because the per-pass cap was reached. */
  cappedCount: number;
}

/**
 * Name every armed card this pass left unevaluated. `starvedIds` is the truncated tail intersected with
 * the armed set, each carrying the persisted episode read off the candidate row this pass already held —
 * so naming costs no read, only writes. Both directions run through the key-level `sourceMetadataPatch`
 * channel so `duplicateOfTaskIds`, `handoffFrom`, `planAdmissionStall` and `wipAdmissionStall` survive.
 */
export async function recordHoldReleaseStarvation(
  store: TaskStore,
  starvedIds: readonly StarvedCardObservation[],
  observedAt: number,
  pass: { unevaluatedCount: number; oldestDeferredAgeMs?: number },
): Promise<StarvationPassResult> {
  const result: StarvationPassResult = { namedCount: 0, alreadyNamedCount: 0, writeFailedCount: 0, cappedCount: 0 };

  for (const card of starvedIds) {
    if (result.namedCount >= MAX_STARVATION_WRITES_PER_PASS) {
      result.cappedCount += 1;
      continue;
    }
    const episode = holdReleaseStarvationWrite(
      card.existing,
      {
        code: RELEASE_SWEEP_BUDGET_STARVED,
        unevaluatedCount: pass.unevaluatedCount,
        ...(pass.oldestDeferredAgeMs !== undefined ? { oldestDeferredAgeMs: pass.oldestDeferredAgeMs } : {}),
      },
      observedAt,
    );
    // Inside the refresh floor of a sustained same-code episode: the badge already says this.
    if (!episode) {
      result.alreadyNamedCount += 1;
      continue;
    }
    try {
      await store.updateTask(card.taskId, {
        sourceMetadataPatch: { [HOLD_RELEASE_STARVATION_METADATA_KEY]: episode },
      });
      result.namedCount += 1;
      /*
      FNXC:HoldReleaseArmedPriority 2026-11-21-06:20 (RUFU-807 Step 3):
      The row is emitted only for an ACCEPTED write, so the refresh floor above — not a second counter —
      bounds the row rate at ≤ 4/hour/card. Through the bounded seam, so an absent, throwing, rejecting, or
      hanging sink cannot alter the naming it reports (FN-9175). Ids/counts/fixed enums only: which OTHER
      cards were deferred is a count here, never a list.
      */
      void emitBoundedRunAudit(store, {
        mutationType: "task:hold-release-starved",
        taskId: card.taskId,
        /*
        FNXC:HoldReleaseArmedPriority 2026-11-21-07:40 (RUFU-807 Step 3):
        `agentId`/`runId`/`domain` are set explicitly because every other emit in this sweep does, and
        their absence is not cosmetic: `run_audit_events` has no CHECK on `domain` and its NOT NULL
        `target` plus the attribution columns are what make a row findable at all (RUFU-430 lost 13 926
        rows to exactly this). The synthetic run id is per-card so an operator can resolve the row for one
        starved card without a run that spans the whole sweep.
        */
        agentId: "scheduler",
        runId: `hold-release:starved:${card.taskId}`,
        domain: "database",
        target: card.taskId,
        metadata: {
          taskId: card.taskId,
          column: card.column,
          code: RELEASE_SWEEP_BUDGET_STARVED,
          stallCount: episode.stallCount,
          unevaluatedCount: pass.unevaluatedCount,
          ...(pass.oldestDeferredAgeMs !== undefined ? { oldestDeferredAgeMs: pass.oldestDeferredAgeMs } : {}),
        },
      });
    } catch (err) {
      result.writeFailedCount += 1;
      schedulerLog.warn(
        `Hold-release starvation marker write failed for ${card.taskId} (degraded): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

/**
 * Clear the starvation badge off every card this pass DID reach.
 *
 * A starvation episode claims "the sweep never got to this card", and an evaluated card falsifies that
 * claim whether it released, stayed held for a named reason, or turned out not to be held at all — so the
 * pass's own `evaluatedTaskIds` set is the exact authority and no second rule is needed. Key-level and
 * best-effort: a stale badge ages out on the lane guard in `derivePlanningAdmissionStall` if this clear
 * is dropped, so it must never be able to fail the sweep that is performing it.
 */
export async function clearHoldReleaseStarvationBadges(
  store: TaskStore,
  starvedTaskIds: readonly string[],
): Promise<number> {
  let cleared = 0;
  for (const taskId of starvedTaskIds) {
    try {
      await store.updateTask(taskId, { sourceMetadataPatch: clearHoldReleaseStarvationPatch() });
      cleared += 1;
    } catch (err) {
      schedulerLog.warn(
        `Hold-release starvation marker clear failed for ${taskId} (degraded): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return cleared;
}

/*
FNXC:HoldReleaseArmedPriority 2026-11-21-06:20 (RUFU-807 Step 3):
Age of the OLDEST card the pass never reached, which is the measurement that separates "a long lane" from
"a starved lane": a truncating pass over a lane whose tail is 30 s old is scheduling normally, while one
whose tail is 2 days old has a card that has been behind the break on every pass for two days — RUFU-698's
rotation cannot produce that unless the tail is larger than the rotation window. Computed from the
candidate rows already in hand; `createdAt` is the field `sortTasksByQueueOrder` itself orders on, so the
age and the ordering can never disagree about who is oldest.
*/
export function measureOldestDeferredAge(
  deferredTasks: readonly { createdAt: string }[],
  nowMs: number,
): number | undefined {
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const task of deferredTasks) {
    const createdMs = Date.parse(task.createdAt);
    if (Number.isFinite(createdMs)) oldestMs = Math.min(oldestMs, createdMs);
  }
  return Number.isFinite(oldestMs) ? Math.max(0, nowMs - oldestMs) : undefined;
}
