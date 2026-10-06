---
"@runfusion/fusion": patch
---

summary: Board workflow metadata no longer loads card-by-card, cutting the slowest board request.
category: fix
dev: `buildBoardWorkflowsPayload` now runs the per-card workflow-selection fallback and the per-workflow IR description through a bounded worker pool instead of awaiting each item inside a `for … of` loop, so a board pays the slowest round-trip instead of the sum of all of them. The single batched selection read is still preferred whenever the store exposes it.
