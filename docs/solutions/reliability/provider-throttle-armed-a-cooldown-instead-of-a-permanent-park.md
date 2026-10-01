---
title: "A provider 429 throttle parked a durable agent as `error-unrecoverable` with no re-probe — and the first fix's backoff ladder never escalated"
date: 2026-10-01
category: reliability
problem_type: reliability
module: "@fusion/engine / @fusion/core"
component: agent-heartbeat / self-healing / error-classification / heartbeat-recovery-state
tags:
  - provider-throttle
  - rate-limit_error
  - heartbeat
  - error-unrecoverable
  - error-retry-exhausted
  - exponential-backoff
  - metadata-writer
  - run-audit
  - rufu-286
symptoms:
  - "a durable agent sits `paused` with `pauseReason: error-unrecoverable` while other lanes make model calls fine"
  - "`lastError` wraps a `429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\" …}}` envelope in `Unable to select a usable model after 1 attempt (primary unknown model …)`"
  - "`agent:error-parked-unrecoverable` repeats for the same agent across days and no `agent:auto-recover-error-state` row ever follows it"
  - "a throttle episode that lasts hours keeps re-arming the SAME backoff rung instead of the next one"
---

## The class that was conflated

Measured 2026-09-23 21:09Z on this project (read-only `fn agent show`, recorded in the card): the sole
coordinator agent `agent-ce645ede` was `State: paused`, `Pause Reason: error-unrecoverable`,
`Error Recovery: attempts 5`, and its `lastError` was pi's fallback-wrapper sentence wrapping a real
provider envelope:

```
Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured,
trigger: prompt-time): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request
would exceed your account's rate limit. Please try again later."},"request_id":"req_011Cf3ZXBTF3bymyoFWRQy3t"}
```

In the same minute, two other lanes were completing model calls. So the condition had already cleared
and the park — which has **no retry owner at all** — would never notice.

Two genuinely different durable states were being decided by one boolean
(`isHeartbeatErrorRecoverable` → `false` → park `error-unrecoverable` "for human repair"):

| Class | Self-clears? | Correct disposition |
| --- | --- | --- |
| OAuth scope broken, model access not enabled, hard billing / `insufficient_quota` | no — human action required | park `paused` + `error-unrecoverable`, emit `agent:error-parked-unrecoverable`, burn no budget |
| **Provider throttle** — 429 `rate_limit_error` / `rate_limit_exceeded`, AWS `ThrottlingException`, Azure `429`, SDK `RateLimitError` | yes, on the provider's clock | **arm a bounded cooldown and re-probe**; exhaustion parks `error-retry-exhausted`, which restart and `fn_agent_start` clear |

The wrapper made it worse: its own `primary unknown model` text matched
`OPERATOR_ACTIONABLE_AGENT_ERROR_PATTERNS`, so a *transient* condition was routed to the *permanent*
park by an artifact of error formatting, and the FN-7884 startup sweep deliberately refuses to clear
`error-unrecoverable` parks. That is why "recovered after a restart, then re-parked within the hour"
was the observed pattern rather than a permanent outage.

## Predicate: what counts as a throttle, and what deliberately does not

`packages/engine/src/errors/transient-error-patterns.ts` → `isProviderThrottleEnvelopeError` is the
single predicate, consulted by `isOperatorActionableAgentError`, `isHeartbeatErrorRecoverable`, the
heartbeat failure branch, and the self-healing mis-park sweep — one truth, four consumers.

**Matches** (structured tokens a provider puts in a 429 body, never generic prose). The list is the
exact token set, because a token named here that the regex does not carry is a doc that promises a
wait the code will not give:
- Envelope types: `"type":"rate_limit_error"` (Anthropic), `"type":"rate_limit_exceeded"` (OpenAI),
  plus either token appearing bare — pi interpolates the provider body verbatim into its fallback
  wrapper, so a whole-string test covers both the envelope and the wrapper.
- Provider request-rate codes (word-boundary matches, case-insensitive, wherever they appear in the
  string — the match does not require a `name`/`code`/`error_code` key): AWS/Bedrock `Throttling`,
  `ThrottlingException`, `RequestLimitExceeded`, `TooManyRequestsException`, and the JS-SDK camelCase
  `rateLimitExceeded`; Azure OpenAI / AI-Gateway `TooManyRequests`; SDK class name `RateLimitError`.
- Not matched, despite looking adjacent: `ThrottlingTargetException` and `RequestThrottled` — neither
  word-bounds against `Throttling`, and adding them is only worth it with a real captured body that
  shows the code and proves no hard-cap meaning hides behind it.

**Deliberately excluded**, each for a reason that must survive future edits:

- **Hard usage caps first.** `PROVIDER_HARD_USAGE_CAP_PATTERN` (`insufficient_quota`, `quota exceeded`,
  `billing`, plan-access, `budget has been exhausted`) is evaluated **before** the throttle tokens.
  Anthropic wraps a hard 402 in a `429 rate_limit_error` envelope, so precedence — not pattern
  ordering luck — is what keeps the billing park a billing park.
- **Google `RESOURCE_EXHAUSTED`.** Ambiguous: Vertex/Gemini use this one code for both the
  transient per-minute request rate *and* daily/per-project quota exhaustion, and nothing in the body
  distinguishes them (`"Resource has been exhausted (e.g. check quota.)"` appears for both). Guessing
  wrong in the transient direction is a silent endless backoff against a dead account that never pages
  anyone, so it stays unclassified; it still gets the bounded retry budget and then parks
  `error-retry-exhausted`, which IS visible. Add it only together with a field that separates the two.
  Google's unambiguous shape still matches via `TooManyRequests` / `rate_limit_exceeded`.
- **A bare `429` with no code identifier** (`APIError: 429`) proves nothing about which tier tripped.
- **Generic prose** ("we hit a rate limit, retrying", the internal `provider-rate-limit:<id>` pause
  reason). `classifyError` already owns those as `usage-limit`, which drives provider-level pausing;
  making the same prose mean "agent-throttled, wait" would give two classifiers opposite answers for
  one string.

## Who owns the wait

The **heartbeat timer** is the only re-probe owner. A throttle failure:

1. leaves the agent `error` (never `paused`), burns **zero** budget units, and writes
   `heartbeatErrorRecovery.throttleStreak` + `cooldownUntilAt`, emitting
   `agent:throttle-cooldown-armed` (`attempt`/`limit`/`backoffMs`/`source: "run-failure"` — the provider
   envelope stays on `agent.lastError`, never in run-audit);
2. is deferred at **run entry** (`agent.state === "error"` + active cooldown → the tick restores the
   row to `error` and completes with `reason: "throttle-cooldown"`) — an arm-only tick does **not**
   consume a `heartbeatErrorRecoveryAttempts` unit, so the horizon is never crossed "by paying for it";
3. re-probes at the horizon, and only a *failed* re-probe burns a shared unit;
4. exhausts into `error-retry-exhausted` **while keeping** `throttleStreak` + `lastError`, so the
   operator sees "provider throttle exhausted the retries", not a bare "unknown error";
5. is stood down by self-healing while a cooldown is live, so no second lane races the timer.

Backoff is `throttleBackoffMs(streak) = min(60 s × 2^(streak−1), 900 s)` — floor and cap are
justified constants in `@fusion/core/heartbeat-recovery-state`, not settings, and the *attempt* budget
deliberately stays the existing `heartbeatErrorRecoveryAttempts` (default 5). RUFU-286 adds a **wait**,
not a second retry pool.

Operator recovery needs no new tool, because the exhaustion park is the ordinary recoverable one:
`error-retry-exhausted` is cleared by `fn_agent_start` (`updateAgentState(id, "active")`) and by an
engine restart (FN-7884 startup recovery resets `heartbeatErrorRecovery` + legacy
`durableErrorRecovery` through `resetHeartbeatErrorRecoveryMetadata`), which is exactly why this class
must **never** park `error-unrecoverable` — that park is excluded from FN-7884 and re-parks on every
restart, which is how the pre-fix loop re-broke after each reboot. A manual start inside an armed
horizon is still waited out: the next timer tick defers to the horizon (at most 15 min) rather than
re-probing early, and that deferral costs no budget unit. A pre-fix
`error-unrecoverable` throttle mis-park is now a narrow FN-7884 startup candidate
(`agent:auto-recover-error-state` with `source: "startup"`), so upgrading recovers cards that would
previously have waited for a human.

## The P0 the first implementation got wrong: two facts, one write

**`throttleStreak` (which rung) and `cooldownUntilAt` (has this rung elapsed) are different facts.**
The first implementation's "preserving" budget writer conflated them: an *elapsed* horizon sent the
whole row down the clearing (success/reset) path, taking the episode counter with it:

```ts
// pre-385011d1d5, buildHeartbeatErrorRecoveryMetadataPreservingThrottle
const keepCooldown = cooldownIso !== null && Date.parse(cooldownIso) > nowMs;
if (!keepCooldown) {
  return buildHeartbeatErrorRecoveryMetadata(agent, consecutiveAttempts); // ← also drops throttleStreak
}
```

`incrementHeartbeatErrorRecoveryMetadata` — the run-entry budget write — routes through that builder,
and the run-entry gate is the **only** writer that runs between two probes, firing exactly at the
elapsed horizon: the same instant the next rung must be computed from `throttleStreak + 1`. So every
re-arm restarted at rung 1: the ladder was dead, the episode re-probed at the 60 s floor forever, and
the 5-attempt budget was burned in ~5 min of sustained throttling instead of the ~30 min the
60→120→240→480→900 s ladder buys — turning the exhaustion park RUFU-286 exists to soften into the
actual outcome — with the "exhausted **while throttled**" attribution erased, so the
park read as a generic failure. The self-healing re-probe write had the same defect in its plain form
(it called the clearing builder directly), which is why both writers now share one entry point.

The rule that fixes it, and the rule to preserve if you touch these helpers: **a budget write may drop
an expired horizon but must never end the episode.** `buildHeartbeatErrorRecoveryMetadataPreservingThrottle`
drops `cooldownUntilAt` and carries `throttleStreak`; the episode ends only via
`resetHeartbeatErrorRecoveryMetadata` (success), a non-throttle failure taking over, or an explicit
operator/startup reset. `self-healing.ts`'s recovery write goes through the same builder — any writer
of this row must.

## Why the test was green while the code was wrong

The lifecycle tests drove a "tick" with a hand-composed `monitor.startRun(...)` + `completeRun(...)`
pair, so the run-entry recovery gate — the only writer that runs *between* probes, where the bug lived —
never executed. Each test then read the row and saw exactly what the arm had written: a horizon, a
streak, all consistent. Nothing the test asserted could distinguish "the arm wrote rung 1" from "rung 1
survived the intervening gate".

The lifecycle tests now call **`monitor.executeHeartbeat({ agentId, source: "timer" })`** — the same
entry point the timer uses — drain the in-run `withRateLimitRetry` timers, and assert the **persisted
horizon ladder** (floor → ×2 → ×4 …) measured from the arm instant, plus one control per park route:
audit shows the ladder grew while every probe after the first consumed exactly one budget unit, and no
`agent:error-parked-unrecoverable` row was emitted. Generalize: *when a test drives a lifecycle by calling two production
methods by hand, the bug is exactly in the third method they skipped.* Drive the entry point
(`executeHeartbeat({ agentId, source: "timer" })`) when the thing under test is who owns a wait.

## How to recognize this class again

```sql
-- Throttle episodes and their parks (run-audit; ids/counts/outcomes only by contract):
SELECT mutation_type, agent_id, metadata
  FROM project.run_audit_events
 WHERE mutation_type IN ('agent:throttle-cooldown-armed', 'agent:error-parked-unrecoverable',
                         'agent:error-retry-exhausted', 'agent:auto-recover-error-state')
 ORDER BY timestamp DESC;
```

- `agent:throttle-cooldown-armed` rows whose `backoffMs` climbs 60000 → 120000 → 240000 … = working as designed.
- A *flat* `backoffMs` across hours = the streak/horizon split has been broken again by some new writer.
- `agent:error-parked-unrecoverable` whose `target`'s `lastError` contains a throttle token = mis-park;
  the startup sweep should clear it on the next boot. If it does not, the predicate and the sweep disagree.
### Surfaces: one reader, no second opinion

Every surface reads `metadata.heartbeatErrorRecovery` through `@fusion/core/heartbeat-recovery-state`
only — a browser-safe pure leaf (sync, no I/O, allowlisted in
`scripts/lib/dashboard-browser-safe-core-modules.json`) that owns the whole ladder and every derived
fact: `throttleBackoffMs(streak)`, `readHeartbeatRecoveryState`, `heartbeatThrottleCooldownRemainingMs`,
`isHeartbeatThrottleCooldownActive`, and `describeHeartbeatThrottle`, whose `HeartbeatThrottleDisplay`
codes the only three answers a reader may print:

- `throttle-cooldown` (`retryingAt`/`remainingMs`/`throttleStreak`) — the timer WILL re-probe; never
  returned for a `paused` agent, because a pause promises no timer re-probe.
- `throttle-exhausted` (`throttleStreak`/`consecutiveAttempts`) — an `error-retry-exhausted` park whose
  streak says "the wait was provider throttling", so the exhausted label doesn't imply a credentials bug.
- `null` — healthy, a durable-class park, or an operator pause.

Consumers: the engine health cell (`classifyReportHealth` gets `throttleCooldownUntilAt` from the leaf →
"rate limited — auto-retry scheduled (…)" instead of "needs operator repair"), the agent-card health
label (`AGENT_HEALTH_LABEL_RATE_LIMITED`, ranked above `state-error` because it is a fact about the
*same* `state: "error"` row and reading `lastError` off that row is the misdiagnosis this card exists to
remove), the fleet-verdict `rate-limited` bucket (bucket unchanged, only the *why* is named), the task
stall chip `agent-rate-limited` (badge "Rate limited", headline "The provider is rate limiting this
agent", description "The engine will retry automatically at {{retryAt}} — nothing needs fixing."), and
`fn agent show`'s throttle line. `stallReason.ts` deliberately does **not** import the leaf: the mapper
(`stallAgent.ts`) resolves `throttleRetryAt` once and forwards only a live cooldown, so no surface can
re-derive an expiry. A new surface must consume the leaf, never re-parse the row.
