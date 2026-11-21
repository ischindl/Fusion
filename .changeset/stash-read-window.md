---
"@runfusion/fusion": patch
---

summary: Stash memory recall returns a full page again instead of often coming back empty.
category: fix
dev: Reads ask Stash for a window (min of the route's own `limit` ceiling and 6x the caller's page) before results are filtered to this project, then trim to the page asked for. `matchedCount` on `memory:stash-read-scope` now counts rows answered from that window; `limit` stays the caller's page.
