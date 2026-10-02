---
"@runfusion/fusion": patch
---

summary: Dormant-checkout verdicts are dropped when a card moves or is deleted, instead of aging out on a timer.
category: fix
dev: New `invalidateEmptinessProofsForTask(rootDir, task)` is wired into the scheduler's `task:moved` and `task:deleted` handlers. It reuses `checkoutEmptinessEntries`, so a workspace card invalidates every member repo, and an unattributable mutation invalidates all verdicts. `CHECKOUT_EMPTINESS_PROOF_TTL_MS` is now a backstop rather than the only freshness mechanism — this is the prerequisite for any cadence change under RUFU-487.
