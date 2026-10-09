---
"@runfusion/fusion": patch
---

summary: Cards stuck behind an abandoned post-merge verification run are now released instead of reported as "not idle".
category: fix
dev: A dispatcher can claim a work item by writing `state=running` with a `leaseOwner` and no `leaseExpiresAt`. That NULL makes the row invisible to its two owners — the scheduler claims only `runnable`/`retrying`, while the recovery seam's idle check treats any `running` row as an active continuation — so the card was pinned forever (`post-merge-continuation-not-idle`) while `failed` rows for the same gate accumulated (measured: 5 rows board-wide, 6,6–10,7 h old; one card carried 20). Recovery now retires the gate's own ownerless `running` row to `failed` (never deleted, so the merge gate stays closed per FN-8492) before re-seeding, gated on the row being this gate's node, leaseless or lease-expired, older than a 2 h floor, with no other active row for the card and no live session. The reclaim uses its own log marker so it never charges the per-gate re-seed budget.
