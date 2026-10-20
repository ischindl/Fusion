---
"@runfusion/fusion": patch
---

summary: Suspended-card audit rows now say which gate refused and how full it was, so board idleness is diagnosable.
category: fix
dev: `task:workflow-run-suspended` gains `suspendSource` (`scheduler-seam` | `column-capacity` | `capacity-rejection-without-facts`) and, on a real pool refusal, `capacityColumn`/`capacityOccupants`/`capacityLimit` from the refusal's structured `CapacityRejectionFacts`. Counts describe the first sample of a wait — RUFU-442's notice signature is unchanged, so a card polling a full pool still writes one row.
