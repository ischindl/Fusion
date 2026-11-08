---
"@runfusion/fusion": patch
---

summary: A planner that refuses its own spec for the identical deterministic reason twice stops early and parks for the operator.
category: fix
dev: Triage records the refused deterministic verdict in `sourceMetadata.deterministicSpecRejection` and parks the card `failed` with `DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED:` on the second identical verdict, instead of spending retry cadence and re-seed cycles. Self-healing owns the park and re-admits it exactly once per changed spec content (stamped `staleSpecFingerprint`, so identical bytes can never re-admit twice); Manual Retry clears the episode, so refusals restart at 1. New audit events `task:deterministic-spec-rejection-parked`, `task:reconcile-deterministic-spec-rejection-parks` and `...-no-action` (ids/counts/fixed outcomes only). The dangling-reference checker now treats a trailing U+2026 as terminal punctuation like the tolerated `...`, which is what made those refusals self-inflicted.
