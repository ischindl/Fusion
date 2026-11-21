---
"@runfusion/fusion": patch
---

summary: A card held out of work-in-progress now says which gate refused it, instead of always blaming the slot pool.
category: fix
dev: `runHoldReleaseSweep` forwards the closed `WipAdmissionRejection` its release primitive returned as the sweep's held reason, instead of publishing a constant. The WIP-admission gate vocabulary gains `plan-premise-unmet` (a card whose plan premises cannot be verified — unreadable plan document, malformed contract, unposted verdict, exhausted budget, or source already delivered), which ranks at parity with `downstream-full`/`column-capacity` so the newest refusal keeps winning a same-signature refresh, and is deliberately not a gate with an in-lane remedy, so dispatch deferral is unchanged. `move-rejected-or-no-slot` now labels only refusals carrying no code (no reservable slot, the in-transaction capacity-exhausted transition, a live row paused or gone under the move lock). The refusal-to-gate map is total by construction, because an unmapped reason would publish no episode, History line, or badge at all.
