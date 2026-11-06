---
"@runfusion/fusion": minor
---

summary: /metrics now meters agent step-text production, so a growing heap can be attributed to a producer instead of guessed.
category: feature
dev: New census sources `step_output_open_captures`, `step_output_live_chars`, `step_output_captures_total`, `step_output_captured_chars_total`, `step_output_largest_chars`, registered at engine start. Cumulative counters report through `..._entries` with zero per-entry weight so they never inflate `fusion_retention_tracked_bytes`; `@fusion/core` now honours an explicit `bytesPerEntry: 0` instead of defaulting it to the 96 B overhead.
