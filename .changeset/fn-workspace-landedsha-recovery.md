---
"@runfusion/fusion": patch
---

summary: Fix workspace partial-land recovery losing the already-landed sub-repo sha.
category: fix
dev: merger-ai.ts landWorkspaceTask now recovers the integration-tip sha as landedSha when the A1 trailer-fallback proved a sub-repo landed but its sha was never persisted, so finalizeWorkspaceTask can build merge proof instead of stranding the partial-land retry in-review.
