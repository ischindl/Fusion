---
"@runfusion/fusion": minor
---

summary: A provider rate limit now auto-retries an agent instead of parking it until a human intervenes.
category: fix
dev: A 429 `rate_limit_error` classifies as a time-bounded throttle at the shared heartbeat-error predicate, so it arms a bounded exponential cooldown (`heartbeatErrorRecovery.throttleStreak`/`cooldownUntilAt`) and emits `agent:throttle-cooldown-armed` instead of parking `error-unrecoverable`. Exhaustion parks `error-retry-exhausted`. Durable OAuth-scope, model-access, and hard quota-exhausted errors still park `error-unrecoverable` immediately and unchanged. Read throttle state via `@fusion/core/heartbeat-recovery-state`; no new `pauseReason` value was added.
