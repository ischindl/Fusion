/*
FNXC:TriageStuckKill 2026-11-11-01:55 (RUFU-562):
Bounded in-process re-admission cooldown for a planning card the stuck watchdog just killed.

WHY THIS EXISTS. `maxConcurrent` is the planning admission cap, and the production measurement behind
RUFU-562 was `[plan] Plan throttled by running-agent cap: eligible=1 [AIWO-148], maxConcurrent=2,
claimed=2, processing=2 [AIWO-150, AIWO-148]` — a card that was about to be killed a sixth time held one of
two planning slots for its whole ~53-minute inactivity window while a sibling card waited unplanned behind
it. Releasing the slot is only real if the killed card cannot instantly re-take it, so the kill path records
a deadline here and planning admission refuses the card until that deadline passes.

WHY IN-PROCESS, AND NOT A DURABLE `nextRecoveryAt` WRITE (this was the deliberate design decision, not an
oversight). A future `nextRecoveryAt` is not a neutral "wait" field — three other lanes read it as
"the recovery lane owns this card":
- `packages/engine/src/planning-admission-stall.ts` derives `recoveryBackoffActive` from a future
  `nextRecoveryAt` and its ladder then SKIPS the card (`skip.reason: "recovery-backoff"`), so a
  planning-scoped throttle would silence the very stall report that tells an operator why the card is not
  being planned.
- Two guards in `packages/engine/src/self-healing.ts` (`isRecoveryRetryDue` and the planning-lane stall
  probe at `recoveryBackoffActive`) decline repairs while the field is set, so a planning throttle would
  suppress unrelated recovery work for as long as it stood.
- Nothing clears it when planning SUCCEEDS — `buildManualRetryResetPatch` zeroes it on an operator Retry
  only, so the write would leak past the episode it was meant to bound and into every later one.
An in-process record cannot leak across those seams, costs no write on the hottest loop in the engine, and
expires by arithmetic. Its worst-case cost is a lost cooldown after an engine restart, which is one bounded
re-kill at most; the durable cost of the alternative is a planning-scoped flag that other lanes honor.

This mirrors the existing precedent in the same admission path: the principal-hold cooldown
(`recordPrincipalHoldBackoff` / `getActivePrincipalHoldCooldown` in
`packages/engine/src/executor/execute-workflow-graph.ts`) is likewise in-process, likewise consulted inside
`couldBeCandidate`, and likewise cleared by nothing but the clock.

CONTRACT: one writer (the stuck-kill requeue path), one probe (planning admission). No timers are created
and nothing is persisted; the expiry is an absolute epoch-ms stamp compared against an injectable clock.
*/

/** First cooldown after one kill. */
export const STUCK_REQUEUE_BACKOFF_BASE_MS = 60_000;

/** Ceiling for one cooldown, however many kills have accumulated. */
export const STUCK_REQUEUE_BACKOFF_CAP_MS = 600_000;

export interface StuckRequeueCooldown {
  /** Absolute epoch-ms instant at which the card becomes admissible again. */
  untilAtMs: number;
  /** The kill count this cooldown was armed from (post-increment). */
  killCount: number;
  /** The backoff window that produced `untilAtMs`. */
  backoffMs: number;
}

const cooldowns = new Map<string, StuckRequeueCooldown>();

/** Injectable clock so a test can drive the boundary deterministically instead of waiting on real time. */
let clock: () => number = () => Date.now();

/**
 * Pure backoff ladder: 60s after the first kill, doubling per kill, capped at 10 minutes.
 *
 * `killCount` is the POST-increment count the requeue persists, so count 1 is the first kill. A count
 * below 1 (or a non-integer) is clamped to the base window rather than throwing: the caller is a
 * best-effort requeue path and a mis-clamped cooldown is strictly milder than a missing one.
 */
export function stuckRequeueBackoffMs(killCount: number): number {
  const exponent = Number.isFinite(killCount) ? Math.max(0, Math.floor(killCount) - 1) : 0;
  return Math.min(STUCK_REQUEUE_BACKOFF_CAP_MS, STUCK_REQUEUE_BACKOFF_BASE_MS * 2 ** exponent);
}

/** Records the cooldown for one killed card and returns exactly what was recorded. */
export function recordStuckRequeueCooldown(taskId: string, killCount: number): StuckRequeueCooldown {
  const backoffMs = stuckRequeueBackoffMs(killCount);
  const record: StuckRequeueCooldown = {
    untilAtMs: clock() + backoffMs,
    killCount,
    backoffMs,
  };
  cooldowns.set(taskId, record);
  return record;
}

/** The live cooldown for a card, or null when none was recorded or its window has elapsed. */
export function getActiveStuckRequeueCooldown(taskId: string): StuckRequeueCooldown | null {
  const record = cooldowns.get(taskId);
  if (!record) return null;
  if (clock() >= record.untilAtMs) {
    // Expired records are dropped on read so the map cannot grow with every card the watchdog ever killed.
    cooldowns.delete(taskId);
    return null;
  }
  return record;
}

/**
 * True while a killed card may not be re-admitted to planning.
 *
 * @param currentStuckKillCount the card's kill count as it reads on the caller's FRESH row. Zero is positive
 * proof that an operator reset the budget — `buildManualRetryResetPatch` zeroes `stuckKillCount` on every Retry
 * surface — so the cooldown is forgotten and the card is admitted. This gate bounds AUTOMATIC re-admission only;
 * without the reset a dashboard Retry would zero the budget and then be refused by a cooldown its own patch had
 * just made meaningless, looking like a no-op for up to a minute. Reading the count off the row the caller
 * already fetched is also what makes this work across processes: a Retry issued by the `fn` CLI has no way to
 * reach this engine's in-process map, but it does write the zero the engine reads on its next poll.
 */
export function isStuckRequeueCoolingDown(taskId: string, currentStuckKillCount?: number | null): boolean {
  if (currentStuckKillCount === 0) {
    cooldowns.delete(taskId);
    return false;
  }
  return getActiveStuckRequeueCooldown(taskId) !== null;
}

/** Drops a card's cooldown. Exported for tests; production release is the clock, not a hook. */
export function clearStuckRequeueCooldown(taskId: string): void {
  cooldowns.delete(taskId);
}

/** Replaces the clock (pass nothing to restore `Date.now`). Test seam only. */
export function setStuckRequeueClockForTests(next?: () => number): void {
  clock = next ?? (() => Date.now());
}

/** Drops every recorded cooldown. Test seam only. */
export function clearAllStuckRequeueCooldownsForTests(): void {
  cooldowns.clear();
}
