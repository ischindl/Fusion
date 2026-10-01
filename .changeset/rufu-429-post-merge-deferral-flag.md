---
"@runfusion/fusion": patch
---

summary: An absent post-merge gate now defers a landed merge instead of failing the card, on every deferral path.
category: fix
dev: `deferredPostMergeEvidence` is derived from the structured gate state (`state === "missing"`) rather than by matching prose in the blocker sentence, and is now carried on the terminal-reseed-refusal deferral as well, so `merger-ai` keeps the merge proof instead of throwing.
