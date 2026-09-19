---
"@runfusion/fusion": patch
---

summary: A card in progress with no live session is now reported stuck immediately instead of after two hours.
category: fix
dev: The planner overseer's executor-stage signal gains a sessionless-liveness check (same predicate the retry handler gates on) so it yields `stuck` at once and routes through the existing bounded `retry_step` recovery; no new lifecycle policy. Ported from timoteo7/Fusion `24139c54e6`.
