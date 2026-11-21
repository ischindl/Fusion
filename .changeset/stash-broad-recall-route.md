---
"@runfusion/fusion": patch
---

summary: Stash memory broad reads and the memory-exists probe work again against current Stash servers.
category: fix
dev: A read with no terms no longer sends `GET /me/sessions/events/search?q=` (that route declares `q` with `min_length=1` and answers 422); it sends `GET /me/sessions/events?limit=<window>&order=desc` and the same window, project scoping and result hygiene apply. `read()` and `exists()` use that lane, so `ensureMemoryFileWithBackend` stops re-seeding the scaffold on every project open. The read-outcome endpoint enum gains `recent-events`, and a refused broad read now records its refusal code instead of `no-match`.
