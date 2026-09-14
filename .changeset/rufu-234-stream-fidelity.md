---
"@runfusion/fusion": patch
---

summary: Fix streamed replies losing scattered characters and spaces (e.g. "healthy in-review" rendered "healthyin-review").
category: fix
dev: Assistant-text capture derives emitted spans from the authoritative block text instead of slicing deltas against a mutable mid-stream snapshot, delivers raw deltas verbatim where no content block resolves (mock runtimes, plugin/CLI bridges), and restarts the per-block ledger for a replaced block regardless of replacement length; losslessness and exactly-once are jointly regression-pinned across chat, executor, and reviewer lanes.
