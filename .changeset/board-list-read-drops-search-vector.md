---
"@runfusion/fusion": patch
---

summary: Board refreshes transfer about 17% less data by skipping an unused search column on task list reads.
category: performance
dev: `readLiveTaskRows` now projects every `project.tasks` column except the stored `search_vector` tsvector, which is a search predicate target (`@@`, `ts_rank`) and never a value. Task search is unchanged; a new pg test asserts every other column still arrives and names the omission set explicitly.
