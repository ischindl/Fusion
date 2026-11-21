---
"@runfusion/fusion": patch
---

summary: Two daemons can no longer share one integration-branch write window while merging.
category: fix
dev: Adds an `integration-land:<repo>:<branch>`-keyed workspace-lease claim (lease kind `land`, so no schema migration) per (repository, integration branch), held only across the git-mutating section (recovery, base selection, and the advance) rather than the whole merge episode; a pre-advance claim-and-tip re-proof that rebuilds instead of forcing a non-fast-forward write; and a pump lane that turns contention into a named, budget-neutral wait. Emits `merge:integration-land-acquired` / `merge:integration-land-contended` with metadata `{ taskId, holderTaskId, outcome }`.
