---
"@runfusion/fusion": patch
---

summary: Review dispatch and auto-claim scheduling stop re-reading every card's activity log on each tick.
category: performance
dev: Both schedulers now pass `derive: false` to `listTasks`. They decide routing and candidacy from persisted columns only, so with derivation on they were paying for nine derived board badges, the workflow-selection prefetch and the whole `log` jsonb column (42.7% of live row bytes, 12.7 KiB per card measured on a 2 417-card board) every 15 s and 30 s respectively, then discarding it. Behaviour is unchanged; two tests now pin the read shape at the store boundary.
