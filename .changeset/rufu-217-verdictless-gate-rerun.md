---
"@runfusion/fusion": patch
---

summary: Cards stuck at a crashed review gate now re-run it automatically instead of waiting for a bypass.
category: fix
dev: A required pre-merge gate whose latest row is `failed` with no verdict is classified separately from an authored REVISE; the FN-9243 reseed lane, the stall-deadlock router, and parked-card recovery all admit the class with a bounded per-gate rerun budget. `task:merge-unrun-pre-merge-gate-rerouted` gains fixed `reason` values `verdictless-seeded` / `rerun-budget-exhausted`.
