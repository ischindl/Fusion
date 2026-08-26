---
"@runfusion/fusion": patch
---

summary: Stash keyword memory recall now returns comparable 0..1 relevance scores.
category: fix
dev: StashMemoryBackend.search maps a server-provided score (clamped) or raw rank normalized by the max rank to 0..1, falling back to positional 2/1 when the deployed Stash image predates the score field; the Stash-side field ships on the local undeployed branch fusion-rufu-133-keyword-score (no deploy performed; see task doc stash-handoff).
