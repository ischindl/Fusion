/**
 * Recovery Policy — bounded exponential-backoff retry for recoverable executor/triage failures.
 *
 * This module provides a **pure decision function** that computes whether a transient
 * failure should be retried, and if so, what the updated recovery state should be.
 *
 * **Design boundary:**
 * - `recovery-policy.ts` handles **inter-poll** recoverable retries — tasks moved back
 *   to todo/triage with backoff, gated by `nextRecoveryAt` in the scheduler/triage poller.
 * - `withRateLimitRetry()` in `rate-limit-retry.ts` handles **intra-session** rate-limit
 *   retries — immediate retry within the same agent session with exponential backoff.
 * - `transient-error-detector.ts` provides the low-level error classifier (`isTransientError`,
 *   `classifyError`). This module consumes those classifiers but does not replace them.
 *
 * **Retry semantics:**
 * - Up to `MAX_RECOVERY_RETRIES` attempts with exponential backoff.
 * - Base delay: 60 seconds, multiplied by 2^attempt, capped at 300 seconds.
 * - ±10% jitter to avoid thundering-herd effects.
 * - Recovery metadata (`recoveryRetryCount`, `nextRecoveryAt`) is persisted on the task
 *   so retries survive engine restarts.
 * - An exhausted budget produces an explicit escalation (`disposition: "escalate"`, `exhausted: true`)
 *   and clears `recoveryRetryCount`/`nextRecoveryAt`. This policy never terminalizes the task itself;
 *   the owning recovery lane decides the landing (see `FNXC:RecoveryOwnership` below).
 *
 * **Not retried via this policy:**
 * - FNXC:ProviderRateLimitIsolation 2026-07-21-18:00: usage-limit errors
 *   (handled by `UsageLimitPauser` with a provider-scoped task park)
 * - User pauses (handled by pause flow)
 * - Stuck-task-detector kills (handled by stuck flow)
 * - Dependency-abort cleanups (handled by dep-abort flow)
 * - Merge-conflict retries (handled by `mergeRetries` separately)
 */

/*
FNXC:RecoveryOwnership 2026-11-15-03:14:
RUFU-624 retired the last two written encodings of the pre-FN-9512 rule that an exhausted
retry budget terminalized the card ("escalate to a real failure (task marked failed or error
set)", wording introduced by cb57093d03). Two facts a future reader must not re-drift:
(1) Budget exhaustion ESCALATES. `computeRecoveryDecision` answers `disposition: "escalate"`
with `exhausted: true` and clears both recovery fields so the card is not left indistinguishable,
and the OWNER chooses the landing: `escalatePlanningReseed` in `triage.ts` hands a planning card
back to the replan owner with `recoveryDisposition: "escalated-reseed"` (9e086e8e02), while
`reseedExhaustedBranchConflict` owns the branch/worktree landing. The discriminating `exhausted`
field exists precisely so a caller cannot collapse that hand-off into a no-op pause.
(2) `pause` stays correct for its OWN reasons only: `mode: "off"` and destructive ambiguity, both
decided by `AutoRecoveryDispatcher.classify` BEFORE it consults this budget. Do not widen them.
Drift history: Full Suite shard 2/4 was red on run 38050589218 because two engine tests still
asserted the retired `pause` for an exhausted budget; FN-9533 (5ba1ee45a0) landed the assertion
repair and RUFU-527 (001cc3ab93) moved the planning-transport fixture onto the throw path.
Disposition record: docs/solutions/test-failures/rufu-624-full-suite-shard-2-disposition.md.
*/

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default per-owner budget of recovery retry attempts. Exhausting it yields an explicit
 * escalation that the owning lane turns into a hand-off, never a terminal failure here.
 * Owners may pass a smaller `maxRetries` through {@link RecoveryPolicyOptions}.
 */
export const MAX_RECOVERY_RETRIES = 3;

/** Base delay in milliseconds for the first retry (60 seconds). */
export const BASE_DELAY_MS = 60_000;

/** Maximum delay cap in milliseconds (300 seconds = 5 minutes). */
export const MAX_DELAY_MS = 300_000;

/** Backoff multiplier (2x exponential). */
export const BACKOFF_MULTIPLIER = 2;

// ── Types ────────────────────────────────────────────────────────────

export interface RecoveryState {
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
}

export type RecoveryDisposition = "retry" | "escalate";

interface RecoveryDecisionBase {
  /** Updated recovery state to persist on the task. */
  nextState: RecoveryState;
  /** Computed delay in milliseconds (for logging). Zero when exhausted. */
  delayMs: number;
}

export interface RecoveryRetryDecision extends RecoveryDecisionBase {
  disposition: "retry";
  /** Whether the task should be retried (moved back to todo/triage). */
  shouldRetry: true;
  exhausted: false;
}

export interface RecoveryEscalationDecision extends RecoveryDecisionBase {
  disposition: "escalate";
  shouldRetry: false;
  /** The bounded retry owner must hand this failure to an operator-visible escalation. */
  exhausted: true;
}

/**
 * A discriminated recovery outcome prevents callers from treating an exhausted
 * budget as an ordinary no-op pause.
 */
export type RecoveryDecision = RecoveryRetryDecision | RecoveryEscalationDecision;

export interface RecoveryPolicyOptions {
  /** Override the default budget for a recovery owner. */
  maxRetries?: number;
}

// ── Decision function ────────────────────────────────────────────────

/**
 * Compute whether a recoverable failure should be retried and what the
 * updated recovery state should be.
 *
 * This is a **pure function** — it does not call TaskStore or perform I/O.
 * The caller is responsible for persisting `nextState` via `store.updateTask()`.
 *
 * @param currentState - Current recovery metadata from the task
 * @returns A decision describing whether to retry or escalate
 */
export function computeRecoveryDecision(
  currentState: RecoveryState,
  options: RecoveryPolicyOptions = {},
): RecoveryDecision {
  const maxRetries = options.maxRetries ?? MAX_RECOVERY_RETRIES;
  const currentCount = currentState.recoveryRetryCount ?? 0;
  const nextCount = currentCount + 1;

  if (nextCount > maxRetries) {
    /*
    FNXC:RecoveryOwnership 2026-10-06-15:14:
    FN-9512 requires every bounded recovery owner to surface exhaustion as an
    explicit escalation, rather than leaving a card in an indistinguishable pause.
    */
    return {
      disposition: "escalate",
      shouldRetry: false,
      exhausted: true,
      nextState: { recoveryRetryCount: undefined, nextRecoveryAt: undefined },
      delayMs: 0,
    };
  }

  // Exponential backoff: base × 2^(attempt-1), capped at max
  const rawDelay = Math.min(
    BASE_DELAY_MS * BACKOFF_MULTIPLIER ** (nextCount - 1),
    MAX_DELAY_MS,
  );

  // ±10% jitter to avoid thundering herd
  const jitter = rawDelay * 0.1 * (2 * Math.random() - 1);
  const delayMs = Math.max(0, Math.round(rawDelay + jitter));

  const nextRecoveryAt = new Date(Date.now() + delayMs).toISOString();

  return {
    disposition: "retry",
    shouldRetry: true,
    exhausted: false,
    nextState: {
      recoveryRetryCount: nextCount,
      nextRecoveryAt,
    },
    delayMs,
  };
}

/**
 * Format a retry delay for human-readable logging.
 *
 * @param delayMs - Delay in milliseconds
 * @returns Human-readable string like "60s" or "120s"
 */
export function formatDelay(delayMs: number): string {
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${seconds}s`;
}
