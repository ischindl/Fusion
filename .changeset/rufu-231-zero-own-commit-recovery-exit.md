---
"@runfusion/fusion": patch
---

summary: Wedged branch-conflict cards now release automatically or park with a named operator remedy.
category: fix
dev: Branch-conflict refusals persist `recoveryRetryCount` and terminate at `autoRecovery.maxRetries` with a `branch-conflict-recovery-exhausted` park that performs no git mutation; landedness proofs now trust `<remote>/<integration>` identities (zero-loss release/re-anchor for zero-own-commit branches landed on the fetched integration ref); lease release stays proof-gated (RUFU-200 emptiness predicate), so an unproven checkout is held deliberately. New audit surfaces: `task:branch-conflict-recovery-parked`, `task:branch-conflict-zero-loss-proven`.
