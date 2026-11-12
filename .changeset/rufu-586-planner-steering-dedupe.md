---
"@runfusion/fusion": patch
---

summary: Planner overseer now stops re-posting the same steering instruction; cap of 3 is finally enforceable.
category: fix
dev: The attempt cap lived in an in-memory map that a healthy signal, a stage change, or an engine restart emptied, so one card took 77 duplicate `[planner-oversight]` comments in ~20 h. The budget is now durable on the card at `sourceMetadata.plannerOversightSteering`, keyed per `(action, stage, normalized reason)`, capped at `PLANNER_RECOVERY_MAX_ATTEMPTS` (3) and re-arming only after a 6 h cooldown. The gate runs before the steering write and a refused post writes no lifecycle field, emits no success, and announces itself once per exhausted reason on the card's History and intervention timeline. A ledger that cannot read or write falls back to the previous behaviour rather than silencing a possibly stuck card.
