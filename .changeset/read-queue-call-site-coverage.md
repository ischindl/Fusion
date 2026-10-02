---
"@runfusion/fusion": patch
---

summary: The remaining direct dashboard GETs now share the board's bounded read queue.
category: performance
dev: Five call sites that bypassed `api()` (ai-sessions list/detail, task logs, task detail, report discussion categories) are routed through `scheduleRead`, which is why `activeReadCount()` used to reach 10 against a ceiling of 4. The chat event stream stays out of the queue on purpose — it is long-lived and would convert the bound into a cap on open streams; `read-queue-call-site-coverage.test.ts` pins both halves.
