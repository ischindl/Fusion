/**
 * FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716):
 * The ONE shared, browser-safe reader for the fact "this durable lane's heartbeat timer really did
 * fire, and the engine deliberately withheld the delivery" — the `metadata.heartbeatTimerLiveness`
 * row the heartbeat scheduler writes on its fire-and-skip paths.
 *
 * Why this module exists: `lastHeartbeatAt` advances only on a *delivered* heartbeat, so a lane
 * whose ticks are intentionally suppressed (nothing new to say, idle-skip, parallel-execution gate)
 * leaves that field frozen forever. Every health surface reads the same field and had exactly one
 * policy for a frozen value: "the trigger is lost". The scheduler itself already knew better —
 * `auditTimerRegistrations` refuses to re-arm a lane whose interval keeps firing and logs
 * `frozen lastHeartbeatAt reflects skipped/no-op delivery, not a dead timer` — but that knowledge
 * lived only as an in-memory `lastTimerFireAtMs` map, so the two halves of one engine read the same
 * field under opposite policies and a healthy-but-idle lane was reported `**stale**` forever, with
 * the heartbeat prompt ordering managers to "create a follow-up task to investigate".
 *
 * This is the same defect class RUFU-286 closed for provider throttles, and it is closed the same
 * way: the engine records the fire-and-skip fact durably, this leaf is the single reader of it, and
 * each surface hands its classifier the DERIVED verdict instead of re-parsing metadata (RUFU-247's
 * single-projection rule).
 *
 * Threshold policy deliberately does NOT live here. `describeHeartbeatDeliverySkip` takes the
 * caller's own window (`withinMs`) because each surface already owns a staleness threshold it must
 * not change (`REPORTS_STALE_INTERVAL_MULTIPLIER` on the engine prompt, `HEARTBEAT_GRACE_MULTIPLIER`
 * on the dashboard pill). Inventing a window here would be the appeasement RUFU-716 forbids — the
 * relief is only honest while it is bounded by the same window that would otherwise have called the
 * lane stale, so a marker left behind by a dead timer stops relieving as soon as it ages past it.
 *
 * Browser-safety is load-bearing, exactly as in `heartbeat-recovery-state.ts`: the dashboard Vite
 * bundle aliases `@fusion/core` to the types-only leaf, so this module is imported through the
 * `@fusion/core/heartbeat-timer-liveness` subpath and must stay a pure leaf — no imports at all,
 * structural input types only, no `node:*`.
 * `scripts/check-no-node-only-core-imports-in-dashboard.mjs` enforces the boundary.
 *
 * The module only READS and normalizes. Writing stays with the scheduler lane that owns the tick.
 */

/** The `Agent.metadata` key holding the "timer fired, delivery withheld" record. */
export const HEARTBEAT_TIMER_LIVENESS_METADATA_KEY = "heartbeatTimerLiveness";

/**
 * Which fire-and-skip path wrote the row. A closed vocabulary owned by the scheduler:
 * - `wake-suppressed`: the tick reached the wake-discipline gate (`HeartbeatMonitor.decideTimerWake`)
 *   and the gate proved there was nothing new to act on (`no-fresher-signal`) or the agent's own idle
 *   ladder chose to wait (`idle-backoff:<stepMs>`). The lane was last healthy — suppression requires
 *   the newest prior run to be `completed`.
 * - `idle-skip`: `runtimeConfig.skipHeartbeatWhenIdle` with no task assigned.
 * - `parallel-execution`: `runtimeConfig.allowParallelExecution === false` while a session the lane is
 *   bound to (or effectively principals) is executing.
 *
 * Pause, engine/global-pause, an existing active run, and ineligible-state unregistration are NOT
 * in this set: a lane held by a live run can be genuinely wedged, and a lane nobody is scheduling
 * has no liveness to prove. They write nothing, so they can never buy relief.
 */
export type HeartbeatTimerSkipReason = "wake-suppressed" | "idle-skip" | "parallel-execution";

/**
 * The reasons that may relieve a `stale` verdict. Exported as a set (rather than inferred from the
 * type) so an unknown or hand-written reason string can never buy relief: a row whose `reason` is
 * not one of these three reads as "no relief", which is the safe direction — the lane keeps the
 * signal it has today.
 */
export const HEARTBEAT_TIMER_LIVENESS_RELIEF_REASONS: ReadonlySet<string> = new Set<string>([
  "wake-suppressed",
  "idle-skip",
  "parallel-execution",
]);

/** Canonical persisted shape of `metadata.heartbeatTimerLiveness`. */
export interface HeartbeatTimerLivenessMetadata {
  /** ISO instant the timer physically fired (the same instant `lastTimerFireAtMs` was stamped). */
  firedAt: string;
  /** Which skip path wrote it. */
  reason: HeartbeatTimerSkipReason;
  /** Effective interval at fire time — diagnostic only; relief never reads it. */
  intervalMs?: number;
}

/**
 * The structural minimum this reader needs, mirroring `HeartbeatRecoveryAgentRecord`: engine records
 * and dashboard API-record shapes both pass plain fixtures, and the leaf stays import-free.
 */
export interface HeartbeatTimerLivenessAgentRecord {
  metadata?: Record<string, unknown> | null;
}

/** Normalized view of the liveness row; never throws on hostile/legacy shapes. */
export interface HeartbeatTimerLivenessState {
  /** Parsed ISO instant verbatim; unparseable or absent normalizes to null. */
  firedAt: string | null;
  /** Only a known reason survives normalization; anything else reads as no row. */
  reason: HeartbeatTimerSkipReason | null;
  /** Diagnostic interval; non-finite or non-positive normalizes to null. */
  intervalMs: number | null;
  /** True only when BOTH a known reason and a parseable `firedAt` are present. */
  reliefEligible: boolean;
}

function normalizeReason(raw: unknown): HeartbeatTimerSkipReason | null {
  return typeof raw === "string" && HEARTBEAT_TIMER_LIVENESS_RELIEF_REASONS.has(raw)
    ? (raw as HeartbeatTimerSkipReason)
    : null;
}

function normalizeFiredAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function normalizeInterval(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Defensive parse of `metadata.heartbeatTimerLiveness`. A missing row (every agent that predates
 * this change, and every lane that has never had a suppressed tick), a non-object row, an unknown
 * `reason`, and an unparseable `firedAt` all normalize to "no relief" rather than throwing — the
 * dashboard calls this on every render off the shared agents cache, and the engine calls it for
 * every report row in every heartbeat prompt.
 */
export function readHeartbeatTimerLiveness(
  agent: HeartbeatTimerLivenessAgentRecord | null | undefined,
): HeartbeatTimerLivenessState {
  const raw = (agent?.metadata ?? {}) as Record<string, unknown>;
  const row = (raw[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY] && typeof raw[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY] === "object"
    ? raw[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY]
    : {}) as Record<string, unknown>;
  const firedAt = normalizeFiredAt(row.firedAt);
  const reason = normalizeReason(row.reason);
  return {
    firedAt,
    reason,
    intervalMs: normalizeInterval(row.intervalMs),
    reliefEligible: firedAt !== null && reason !== null,
  };
}

/**
 * Milliseconds since the recorded fire, measured against a caller-supplied reference clock.
 *
 * The reference is a parameter, not `Date.now()`, for the same reason `elapsedSinceMs` makes
 * `dataAsOfMs` required: a mobile tab discard hydrates an SWR snapshot that can be hours old, and a
 * verdict that ages the heartbeat against the snapshot while aging the fire against wall-clock would
 * disagree with itself. Pass the SAME reference used for the heartbeat age.
 *
 * Absent or unparseable → `Infinity` (absence of proof of liveness is not proof of liveness).
 * A future `firedAt` (clock skew) clamps to `0`, which relieves rather than alarms — but it cannot
 * relieve beyond the caller's window, because the window is what bounds the claim.
 */
export function heartbeatTimerFireAgeMs(
  agent: HeartbeatTimerLivenessAgentRecord | null | undefined,
  nowMs: number | Date = Date.now(),
): number {
  const { firedAt } = readHeartbeatTimerLiveness(agent);
  if (!firedAt) return Number.POSITIVE_INFINITY;
  const firedMs = Date.parse(firedAt);
  if (Number.isNaN(firedMs)) return Number.POSITIVE_INFINITY;
  const reference = nowMs instanceof Date ? nowMs.getTime() : nowMs;
  if (!Number.isFinite(reference)) return Number.POSITIVE_INFINITY;
  return Math.max(0, reference - firedMs);
}

/**
 * Fixed-kind descriptor for health surfaces (codes, not copy — UI text stays in each surface).
 * Returned ONLY when the row is relief-eligible AND its fire age is within the caller's own
 * `withinMs`. A non-finite or non-positive `withinMs` refuses relief outright: a surface that cannot
 * name its staleness window must not be handed an unbounded exemption.
 */
export type HeartbeatDeliverySkipDisplay =
  | {
      kind: "delivery-skip";
      reason: HeartbeatTimerSkipReason;
      firedAt: string;
      fireAgeMs: number;
      withinMs: number;
    }
  | null;

export function describeHeartbeatDeliverySkip(
  agent: HeartbeatTimerLivenessAgentRecord | null | undefined,
  options: { nowMs?: number | Date; withinMs: number },
): HeartbeatDeliverySkipDisplay {
  const withinMs = options?.withinMs;
  if (!Number.isFinite(withinMs) || withinMs <= 0) return null;
  const state = readHeartbeatTimerLiveness(agent);
  if (!state.reliefEligible || !state.firedAt || !state.reason) return null;
  const fireAgeMs = heartbeatTimerFireAgeMs(agent, options?.nowMs ?? Date.now());
  // Inclusive at the boundary: this is the exact complement of the `age > threshold` test every
  // caller already runs, so relief never widens a window and never narrows one either.
  if (fireAgeMs > withinMs) return null;
  return {
    kind: "delivery-skip",
    reason: state.reason,
    firedAt: state.firedAt,
    fireAgeMs,
    withinMs,
  };
}
