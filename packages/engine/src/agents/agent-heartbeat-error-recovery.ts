/**
 * FNXC:CodeOrganization 2026-07-15-14:30:
 * Heartbeat error-recovery budget helpers peeled from agent-heartbeat.ts.
 */
import type { Agent, HeartbeatErrorRecoveryMetadata, Settings } from "@fusion/core";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  isEphemeralAgent,
  readHeartbeatRecoveryState,
  throttleBackoffMs,
} from "@fusion/core";
import {
  isStaleWorktreeModuleResolutionError,
  isOperatorActionableAgentError,
} from "../errors/transient-error-detector.js";

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-13:20 (RUFU-286):
`heartbeatErrorRecovery` metadata (key + shape, incl. the new throttle-cooldown
fields) is now canonically owned by `@fusion/core`'s `agents/heartbeat-recovery-state.ts`
— the one browser-safe reader every operator surface goes through. The two row-vocabulary
constants are re-exported here so every existing engine/CLI import site stays stable.
*/
export { HEARTBEAT_ERROR_RECOVERY_METADATA_KEY, HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON } from "@fusion/core";
export { isHeartbeatThrottleCooldownActive } from "@fusion/core";
export type { HeartbeatErrorRecoveryMetadata } from "@fusion/core";

export const MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS = 5;
export const HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON = "error-unrecoverable";
export const HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON = "heartbeat-model-unavailable";

/**
 * FNXC:AgentHeartbeat 2026-07-15-13:25:
 * Ephemeral task workers are driven directly by TaskExecutor and must never
 * acquire scheduler timers, which are reserved for durable agents.
 */
export function isHeartbeatManaged(agent: Agent): boolean {
  return !isEphemeralAgent(agent);
}

export function resolveErrorRecoveryLimit(settings: Settings | null | undefined): number {
  const raw = (settings as { heartbeatErrorRecoveryAttempts?: unknown } | null | undefined)?.heartbeatErrorRecoveryAttempts;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS;
  }
  return Math.max(1, Math.floor(raw));
}

export function readHeartbeatErrorRetryCount(agent: { metadata?: Record<string, unknown> | null }): number {
  /*
  FNXC:AgentHeartbeat 2026-07-11-22:42:
  FN-7844 requires the heartbeat timer and self-healing sweep to honor one durable-agent error-recovery budget. Read the legacy durableErrorRecovery attempt count as part of the shared budget so agents recovered by either entry path cannot receive separate retry pools.
  */
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY];
  const heartbeatCount = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).consecutiveAttempts
    : 0;
  const legacyRaw = metadata.durableErrorRecovery;
  const legacyCount = legacyRaw && typeof legacyRaw === "object"
    ? (legacyRaw as Record<string, unknown>).attempts
    : 0;
  const normalizedHeartbeatCount = typeof heartbeatCount === "number" && Number.isFinite(heartbeatCount) && heartbeatCount > 0
    ? Math.floor(heartbeatCount)
    : 0;
  const normalizedLegacyCount = typeof legacyCount === "number" && Number.isFinite(legacyCount) && legacyCount > 0
    ? Math.floor(legacyCount)
    : 0;
  return Math.max(normalizedHeartbeatCount, normalizedLegacyCount);
}

/**
 * Clearing budget write: builds the `heartbeatErrorRecovery` row from scratch, so a live
 * throttle episode (RUFU-286 `throttleStreak`/`cooldownUntilAt`) is dropped unless the caller
 * goes through `buildHeartbeatErrorRecoveryMetadataPreservingThrottle`. Used by the
 * success/reset path, where dropping the episode is exactly the point.
 */
export function buildHeartbeatErrorRecoveryMetadata(agent: { metadata?: Record<string, unknown> | null }, consecutiveAttempts: number): Record<string, unknown> {
  return {
    ...(agent.metadata ?? {}),
    [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: {
      consecutiveAttempts: Math.max(0, Math.floor(consecutiveAttempts)),
      updatedAt: new Date().toISOString(),
    } satisfies HeartbeatErrorRecoveryMetadata,
  };
}

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-13:20 (RUFU-286):
RUFU-286 arm helpers. A throttle arm PRESERVES `consecutiveAttempts` (a cooldown
deferral burns no budget unit — only a failed re-probe at the horizon does) and
monotonically raises `throttleStreak`, the exponential-backoff exponent the run-entry
gate reads.

FNXC:ProviderThrottleIsTransient 2026-09-30-16:26 (RUFU-286 code review P0):
`throttleStreak` (how many consecutive throttles this episode has seen, i.e. the backoff
exponent) and `cooldownUntilAt` (the promise of a re-probe at a specific instant) are TWO
different facts and only the second one expires. Clearing both whenever the horizon is
unreadable is what made the ladder dead in production: the horizon is crossed exactly once,
at the run-entry budget increment, and that write used to drop the streak too, so every
re-arm recomputed streak 1 and the wait was forever the 60 s floor (never 120 → 240 → 480 →
900), which also burned the 5-attempt budget in ~5 min of sustained throttling. The rule is
now: a budget write may DROP AN EXPIRED HORIZON but never END THE EPISODE. The streak ends
only where the episode genuinely ends — a successful run (`resetHeartbeatErrorRecoveryMetadata`),
a failure that is NOT a throttle envelope (a different problem took over), or the startup
operator-reset.

ONE writer owns the row shape: every `heartbeatErrorRecovery` write goes through
`buildHeartbeatErrorRecoveryMetadata` (clearing — success/reset, or a non-throttle failure that
ends the episode), `buildHeartbeatErrorRecoveryMetadataPreservingThrottle` (budget write that
must not cancel a scheduled re-probe and must not reset the backoff exponent),
`buildHeartbeatThrottleExhaustionMetadata` (exhaustion park: keeps attribution, withdraws the
re-probe promise), or `armHeartbeatThrottleCooldown` (arms the episode).
Call sites must NOT hand-construct the nested row: the pre-RUFU-286 helpers rebuilt it from
scratch, so any extra nested key was silently dropped by the next increment — that is why the
helpers, not the call sites, decide whether the throttle episode survives a write.
*/
export function buildHeartbeatThrottleArmMetadata(
  agent: { metadata?: Record<string, unknown> | null },
  opts: { nextThrottleStreak: number; cooldownUntilAt: string },
): Record<string, unknown> {
  // Shared-budget read (heartbeat row ∪ legacy `durableErrorRecovery.attempts`): arming a
  // cooldown must never shrink the budget the OTHER entry path has already burned.
  return buildHeartbeatErrorRecoveryMetadataWithThrottle(
    agent,
    readHeartbeatErrorRetryCount(agent),
    opts.nextThrottleStreak,
    opts.cooldownUntilAt,
  );
}

function buildHeartbeatErrorRecoveryMetadataWithThrottle(
  agent: { metadata?: Record<string, unknown> | null },
  consecutiveAttempts: number,
  throttleStreak: number,
  cooldownUntilAt: string | null,
): Record<string, unknown> {
  const streak = Number.isFinite(throttleStreak) && throttleStreak > 0 ? Math.floor(throttleStreak) : 0;
  return {
    ...(agent.metadata ?? {}),
    [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: {
      consecutiveAttempts: Math.max(0, Math.floor(consecutiveAttempts)),
      updatedAt: new Date().toISOString(),
      // Absent fields are the zero state for the shared reader, so a row with no episode
      // stays exactly the legacy two-field shape instead of carrying `0`/`null` noise.
      ...(streak > 0 ? { throttleStreak: streak } : {}),
      ...(cooldownUntilAt ? { cooldownUntilAt } : {}),
    } satisfies HeartbeatErrorRecoveryMetadata,
  };
}

/**
 * FN-7884 restart-preserving budget write: unlike `buildHeartbeatErrorRecoveryMetadata`
 * (success/reset shape, throttle episode cleared), this keeps the throttle episode alive —
 * `throttleStreak` always survives when the row carries one, and `cooldownUntilAt` survives
 * while it is still in the future so an engine restart does not lose the pending re-probe plan.
 *
 * FNXC:ProviderThrottleIsTransient 2026-09-30-16:26 (RUFU-286 code review P0):
 * An already-elapsed horizon is the ONLY thing this write drops. It is called at the exact
 * instant the horizon is crossed (the run-entry budget increment), so dropping the streak here
 * would reset the backoff exponent on every probe and pin the wait at the floor forever.
 */
export function buildHeartbeatErrorRecoveryMetadataPreservingThrottle(
  agent: { metadata?: Record<string, unknown> | null },
  consecutiveAttempts: number,
  now: number | Date = Date.now(),
): Record<string, unknown> {
  const state = readHeartbeatRecoveryState(agent);
  if (state.throttleStreak <= 0) {
    return buildHeartbeatErrorRecoveryMetadata(agent, consecutiveAttempts);
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const horizonMs = state.cooldownUntilAt ? Date.parse(state.cooldownUntilAt) : Number.NaN;
  const keepCooldown = Number.isFinite(horizonMs) && horizonMs > nowMs;
  return buildHeartbeatErrorRecoveryMetadataWithThrottle(
    agent,
    consecutiveAttempts,
    state.throttleStreak,
    keepCooldown ? state.cooldownUntilAt : null,
  );
}

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-16:26 (RUFU-286 code review P0):
The exhaustion park needs its own write because the two throttle facts point opposite ways
there. `cooldownUntilAt` MUST go: a `paused` card advertises no re-probe (the timer stops
dispatching paused agents), and a live horizon on a parked row would have surfaces promise a
retry nothing owns. `throttleStreak` MUST stay: it is the only record of WHAT consumed the
budget, and the shared reader's `throttle-exhausted` classification (paused +
`error-retry-exhausted` + streak > 0) is what lets an operator/agent read "the provider kept
rate-limiting us" instead of guessing credentials. Clearing the streak here would make that
classification unreachable from the run-failure exhaustion route.
*/
export function buildHeartbeatThrottleExhaustionMetadata(
  agent: { metadata?: Record<string, unknown> | null },
  consecutiveAttempts: number,
): Record<string, unknown> {
  const state = readHeartbeatRecoveryState(agent);
  return buildHeartbeatErrorRecoveryMetadataWithThrottle(agent, consecutiveAttempts, state.throttleStreak, null);
}

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-13:25 (RUFU-286):
The rebuild-preservation trap: every recovery increment historically rebuilt this row from
scratch, which would silently erase a pending throttle cooldown the moment another lane wrote
a budget unit mid-cooldown (the self-healing backstop and the run-entry gate both do). The
increment therefore goes through the preserving builder — a budget write must never cancel a
scheduled re-probe, only a success (reset) or an exhaustion park may.
*/
export function incrementHeartbeatErrorRecoveryMetadata(
  agent: { metadata?: Record<string, unknown> | null },
  now: number | Date = Date.now(),
): Record<string, unknown> {
  return buildHeartbeatErrorRecoveryMetadataPreservingThrottle(agent, readHeartbeatErrorRetryCount(agent) + 1, now);
}

/**
 * Arm the next provider-throttle cooldown for one agent: raises the streak, derives the
 * exponential wait from the shared `throttleBackoffMs` bounds, and returns both the metadata
 * patch to persist and the numbers an audit row needs. Consumes NO budget unit — the failed
 * re-probe at the horizon does, via the normal increment path.
 */
export function armHeartbeatThrottleCooldown(
  agent: { metadata?: Record<string, unknown> | null },
  now: number | Date = Date.now(),
): { metadata: Record<string, unknown>; throttleStreak: number; backoffMs: number; cooldownUntilAt: string } {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const throttleStreak = readHeartbeatRecoveryState(agent).throttleStreak + 1;
  const backoffMs = throttleBackoffMs(throttleStreak);
  const cooldownUntilAt = new Date(nowMs + backoffMs).toISOString();
  return {
    metadata: buildHeartbeatThrottleArmMetadata(agent, { nextThrottleStreak: throttleStreak, cooldownUntilAt }),
    throttleStreak,
    backoffMs,
    cooldownUntilAt,
  };
}

export function resetHeartbeatErrorRecoveryMetadata(agent: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  const { durableErrorRecovery: _legacyDurableErrorRecovery, ...metadata } = (agent.metadata ?? {}) as Record<string, unknown>;
  return buildHeartbeatErrorRecoveryMetadata({ metadata }, 0);
}

export function isHeartbeatErrorRecoverable(agent: Pick<Agent, "lastError">): boolean {
  const lastError = agent.lastError ?? "";
  /*
  FNXC:Reliability-ErrorClassification 2026-07-12-16:09:
  FN-7878: a generic durable-agent heartbeat failure that manual Retry immediately fixes is recoverable by policy, even when it does not match curated transient patterns. Give unknown/session/spawn/stream blips the bounded heartbeat retry budget and re-park persistent failures as `error-retry-exhausted`; only operator-actionable auth/model/billing errors park immediately as `error-unrecoverable`. Stale worktree module-resolution errors stay out of naive retry recovery because self-healing has a dedicated stale-host/worktree suppression path.

  FNXC:ProviderThrottleIsTransient 2026-09-30-13:20 (RUFU-286):
  A time-boxed provider throttle (429 rate_limit_error / rate_limit_exceeded envelope) now classifies
  RECOVERABLE here via the shared `isProviderThrottleEnvelopeError` gate inside
  `isOperatorActionableAgentError`. Before that gate, pi's fallback wrapper (`Unable to select a usable
  model after N attempt(s)` — which embeds the literal `unknown model` whenever Fusion resolved no
  model) matched the operator-actionable pattern list, so a throttle self-clearing in minutes parked
  durable agents paused/"error-unrecoverable" with no scheduled re-probe and no budget burn, and the
  FN-7884 startup sweep refuses to clear that class. The wait is now owned: the run-failure branch arms
  a bounded exponential cooldown (throttleStreak/cooldownUntilAt in heartbeatErrorRecovery metadata)
  and the heartbeat timer's next tick re-probes at the horizon; the cooldown deferral itself consumes
  no budget unit. Exhaustion parks through the existing shared `error-retry-exhausted` path — no new
  `pauseReason` enum value and no second retry budget. Hard usage caps (insufficient_quota, billing,
  plan-access) remain operator-actionable and park `error-unrecoverable` immediately, unchanged.
  */
  return !isStaleWorktreeModuleResolutionError(lastError) && !isOperatorActionableAgentError(lastError);
}

export function isModelUnavailablePark(agent: Pick<Agent, "state" | "pauseReason">): boolean {
  /*
   * FNXC:AgentHeartbeat 2026-07-15-13:25:
   * Key on pauseReason across state transitions: startRun can flip an agent to
   * running before the recovery gate reads it, so state=paused alone would miss
   * the budgeted retry for a failed preload.
   */
  return agent.pauseReason === HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON
    && agent.state !== "active"
    && agent.state !== "idle";
}

/*
FNXC:HeartbeatRecovery 2026-07-15-08:50:
False-positive heartbeat-model-unavailable parks must stay on the timer path with a bounded budget. Operator-actionable lastError text (no API key / registry miss) would otherwise exclude them from isHeartbeatErrorRecoverable forever, so this park reason is an explicit second recovery admission path independent of lastError classification.
*/
export function isModelUnavailableParkRecoveryEligible(agent: Agent, limit: number): boolean {
  return isModelUnavailablePark(agent)
    && isHeartbeatManaged(agent)
    && agent.runtimeConfig?.enabled !== false
    && readHeartbeatErrorRetryCount(agent) < Math.max(1, Math.floor(limit));
}

export function isErrorRecoveryEligible(agent: Agent, limit: number): boolean {
  if (isModelUnavailableParkRecoveryEligible(agent, limit)) {
    return true;
  }
  return agent.state === "error"
    && isHeartbeatManaged(agent)
    && agent.runtimeConfig?.enabled !== false
    && isHeartbeatErrorRecoverable(agent)
    && readHeartbeatErrorRetryCount(agent) < Math.max(1, Math.floor(limit));
}
