---
"@runfusion/fusion": patch
---

summary: A conversation Focus now meaningfully biases memory recall even without vector search.
category: fix
dev: Lane T now sends the focus's content terms OR-joined (≤3 terms, ≤96 chars) so the Stash keyword normalizer keeps each term; unusable foci skip lane T; no migration, no Stash change, no settings change.
