---
"@runfusion/fusion": patch
---

summary: A card the engine parked over a lost review verdict now gets that review re-run instead of sitting in review forever.
category: fix
dev: The no-verdict pre-merge review recovery used to skip any paused card, and its seed lane refused workspace cards. Both now admit exactly one class — the engine's own `in-review-stall-deadlock` park (pause marker + the park's own error sentence, `userPaused` and every other pause reason still refused). After the review node is re-seeded, the park is lifted in the same pass via `updateTaskAtomic`, all-or-nothing on the same signature; `task:review-no-verdict-park-repaired` records it with ids/counts/outcomes only.
