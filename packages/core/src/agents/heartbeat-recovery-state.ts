/**
 * FNXC:ProviderThrottleIsTransient 2026-09-30-13:20 (RUFU-286):
 * The ONE shared, browser-safe reader for a durable agent's heartbeat error-recovery
 * state — the `metadata.heartbeatErrorRecovery` row an engine lane writes. RUFU-286
 * extended that metadata with a bounded provider-throttle cooldown (`throttleStreak`
 * + `cooldownUntilAt`): a 429 `rate_limit_error` is a time-bounded throttle, so the
 * heartbeat arms a wait-and-re-probe instead of parking `error-unrecoverable`, and
 * every operator surface (dashboard badge, fleet liveness, `fn agent show`) must
 * render the SAME "waiting for the provider to clear the throttle" fact from THIS
 * module rather than re-parsing the row per surface — the same single-reader rule
 * RUFU-247 established for pause reasons ("do not fork a second projection").
 *
 * Reader API note: the task spec sketched this as one `readThrottleCooldown(metadata, now)`
 * accessor. It shipped split by the question each surface asks — `readHeartbeatRecoveryState`
 * (normalized row + budget counts), `heartbeatThrottleCooldownRemainingMs` /
 * `isHeartbeatThrottleCooldownActive` (the time predicate), and `describeHeartbeatThrottle`
 * (the fixed-kind display verdict, which also classifies the exhaustion park) — because the
 * dashboard pill, the fleet verdict, and `fn agent show` project the same fact differently.
 * One row parser, three readers: no surface re-parses the metadata itself.
 *
 * Browser-safety is load-bearing: the dashboard Vite bundle aliases `@fusion/core`
 * to the types-only leaf, so this module is imported via the
 * `@fusion/core/heartbeat-recovery-state` subpath and must stay a pure leaf —
 * no runtime imports at all, structural input types only, no `node:*`.
 * `scripts/check-no-node-only-core-imports-in-dashboard.mjs` enforces the boundary.
 *
 * The module only READS and normalizes. Writing (arming, incrementing, clearing)
 * stays with the engine lanes that own the agent row.
 */

/** The `Agent.metadata` key holding the shared heartbeat error-recovery budget. */
export const HEARTBEAT_ERROR_RECOVERY_METADATA_KEY = "heartbeatErrorRecovery";

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-13:25 (RUFU-286):
Throttle backoff bounds, owned by this shared leaf so every writer and every surface agrees
on the wait a throttled agent is being told to take. Both are justified constants, not new
settings: the FLOOR (60 s) is roughly the shortest account window that plausibly refills, so
probing sooner only burns shared budget units; the CAP (15 min) keeps worst-case self-healing
latency below the point where an operator would have intervened anyway, and bounds the streak
at four doublings (60s -> 120s -> 240s -> 480s -> 900s). The ATTEMPT BUDGET deliberately lives
elsewhere — the existing `heartbeatErrorRecoveryAttempts` project setting (default 5) — because
RUFU-286 adds a WAIT, not a second retry pool: the throttle class shares the one
`heartbeatErrorRecovery` budget every recoverable class already shares.
*/
export const THROTTLE_BACKOFF_FLOOR_MS = 60_000;
export const THROTTLE_BACKOFF_CAP_MS = 900_000;

/**
 * Exponential backoff for the Nth consecutive throttle of one episode. The streak is 1-based
 * (the first throttle waits the floor) and streaks <= 1 clamp to the floor, so a missing or
 * legacy field can never yield a zero-length cooldown that would hot-loop the heartbeat.
 */
export function throttleBackoffMs(throttleStreak: number): number {
  const exponent = Math.max(1, Math.floor(throttleStreak)) - 1;
  return Math.min(THROTTLE_BACKOFF_FLOOR_MS * 2 ** exponent, THROTTLE_BACKOFF_CAP_MS);
}

/**
 * Shared-budget exhaustion park (FN-7844/FN-7859). Owned here so this reader can
 * distinguish "retries exhausted WHILE provider-throttled" from a plain exhausted
 * park without importing engine code; the engine re-exports this constant.
 */
export const HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON = "error-retry-exhausted";

/** Canonical persisted shape of `metadata.heartbeatErrorRecovery` (RUFU-286 fields optional for rows written before the change). */
export interface HeartbeatErrorRecoveryMetadata {
  /** Consecutive failed recovery dispatches against the shared bounded budget. */
  consecutiveAttempts: number;
  updatedAt?: string;
  /**
   * RUFU-286: consecutive provider-throttle cooldowns armed for the current
   * throttle episode (0/absent = never throttled since the last success reset).
   */
  throttleStreak?: number;
  /**
   * RUFU-286: ISO horizon before which the heartbeat timer must NOT re-dispatch;
   * absent/parseable-past = no cooldown armed. A cooldown deferral itself burns
   * no budget unit — only a failed re-probe at/after the horizon does.
   */
  cooldownUntilAt?: string;
}

/**
 * The structural minimum this reader needs. Deliberately NOT the full `Agent`
 * type so dashboard surfaces (which only have API-record shapes) and engine
 * records both pass plain fixtures, and so the leaf stays import-free.
 */
export interface HeartbeatRecoveryAgentRecord {
  state?: string | null;
  pauseReason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Normalized view of the recovery metadata; never throws on hostile/legacy shapes. */
export interface HeartbeatRecoveryState {
  consecutiveAttempts: number;
  updatedAt: string | null;
  /** 0 when the row never carried the field (pre-RUFU-286 rows). */
  throttleStreak: number;
  /** Parsed-future or parsed-past horizons are kept verbatim; unparseable values normalize to null. */
  cooldownUntilAt: string | null;
}

function normalizeCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function normalizeIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * Defensive parse of `metadata.heartbeatErrorRecovery`. Missing rows, non-object
 * rows, and malformed fields all normalize to zeros/null rather than throwing —
 * surfaces call this on every render with data from the shared agents cache.
 */
export function readHeartbeatRecoveryState(
  agent: HeartbeatRecoveryAgentRecord | null | undefined,
): HeartbeatRecoveryState {
  const raw = (agent?.metadata ?? {}) as Record<string, unknown>;
  const row = raw[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY];
  const fields = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  return {
    consecutiveAttempts: normalizeCount(fields.consecutiveAttempts),
    updatedAt: normalizeIsoDate(fields.updatedAt),
    throttleStreak: normalizeCount(fields.throttleStreak),
    cooldownUntilAt: normalizeIsoDate(fields.cooldownUntilAt),
  };
}

/** Milliseconds remaining on the throttle cooldown; 0 when no cooldown is armed or it has elapsed. */
export function heartbeatThrottleCooldownRemainingMs(
  agent: HeartbeatRecoveryAgentRecord | null | undefined,
  now: number | Date = Date.now(),
): number {
  const iso = readHeartbeatRecoveryState(agent).cooldownUntilAt;
  if (!iso) return 0;
  const remaining = Date.parse(iso) - (now instanceof Date ? now.getTime() : now);
  return remaining > 0 ? remaining : 0;
}

/** True while an unexpired provider-throttle cooldown is armed, regardless of agent state. */
export function isHeartbeatThrottleCooldownActive(
  agent: HeartbeatRecoveryAgentRecord | null | undefined,
  now: number | Date = Date.now(),
): boolean {
  return heartbeatThrottleCooldownRemainingMs(agent, now) > 0;
}

/**
 * Fixed-kind descriptor for operator surfaces (codes, not copy — UI text lives in
 * each surface's i18n/formatting layer):
 * - `throttle-cooldown`: the agent is waiting out a provider throttle and the
 *   heartbeat timer WILL re-probe at `retryingAt`. Never reported for a `paused`
 *   agent — a pause is operator/exhaustion-owned and no timer re-probe is promised.
 * - `throttle-exhausted`: the retries ran out while the provider kept throttling
 *   (paused + `error-retry-exhausted` + a live `throttleStreak`), so the exhausted
 *   label can honestly say the wait was provider-throttling, not a credentials bug.
 * - `null`: no throttle state applies (healthy, durable-class park, plain
 *   exhausted park, or an operator pause).
 */
export type HeartbeatThrottleDisplay =
  | {
      kind: "throttle-cooldown";
      retryingAt: string;
      remainingMs: number;
      throttleStreak: number;
      consecutiveAttempts: number;
    }
  | {
      kind: "throttle-exhausted";
      throttleStreak: number;
      consecutiveAttempts: number;
    }
  | null;

export function describeHeartbeatThrottle(
  agent: HeartbeatRecoveryAgentRecord | null | undefined,
  now: number | Date = Date.now(),
): HeartbeatThrottleDisplay {
  if (!agent) return null;
  const state = readHeartbeatRecoveryState(agent);
  if (agent.state === "paused") {
    // Exhaustion-park classification wins over any residual cooldown row: a paused
    // card must never promise a re-probe the timer will not run.
    if (
      agent.pauseReason === HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON
      && state.throttleStreak > 0
    ) {
      return {
        kind: "throttle-exhausted",
        throttleStreak: state.throttleStreak,
        consecutiveAttempts: state.consecutiveAttempts,
      };
    }
    return null;
  }
  const remainingMs = heartbeatThrottleCooldownRemainingMs(agent, now);
  if (remainingMs > 0 && state.cooldownUntilAt) {
    return {
      kind: "throttle-cooldown",
      retryingAt: state.cooldownUntilAt,
      remainingMs,
      throttleStreak: state.throttleStreak,
      consecutiveAttempts: state.consecutiveAttempts,
    };
  }
  return null;
}
