---
"@runfusion/fusion": patch
---

summary: Fix workspace partial-land recovery losing the already-landed sub-repo sha.
category: fix
dev: merger-ai.ts landWorkspaceTask now recovers the EXACT proven landed commit (the task's own Fusion-Task-Id trailer commit, or the recorded landedSha when it is still an ancestor) via findProvenLandedCommit, instead of dropping it when the A1 trailer-fallback proved a sub-repo landed but its sha was never persisted. This avoids attributing a later unrelated integration tip to the repo after an intervening sub-repo land, so finalizeWorkspaceTask builds durable merge proof and the partial-land retry completes to done.
