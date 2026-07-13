---
"@runfusion/fusion": patch
---

summary: Durable agents retry generic heartbeat failures instead of parking as unrecoverable on first error.
category: fix
dev: `isHeartbeatErrorRecoverable` now gates on operator-actionable and stale-module errors rather than requiring a transient-pattern match.
