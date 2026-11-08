---
"@runfusion/fusion": patch
---

summary: Scheduling passes fork far fewer git subprocesses, leaving the dashboard event loop freer.
category: performance
dev: `resolveTrustedIntegrationRefs` single-flights per (repoDir, integrationRef) key, so the concurrent workers of one checkout-emptiness pass share one identity probe instead of each forking `git remote` + `git for-each-ref`. Measured at the `child_process` boundary: a 4-card pass 24 -> 18 git forks, an 8-card pass 24 -> 18, four concurrent cold resolutions 8 -> 2. Proven verdicts are unchanged in both directions.
