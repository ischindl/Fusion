---
"@runfusion/fusion": patch
---

summary: Durable project memory is now searchable and readable with the Stash memory backend.
category: fix
dev: Memory search surfaces (fn_memory_search, proactive cue, per-turn recall) union a deterministic layered-file lane with the remote lane when the resolved backend is `stash`; `fn_memory_get` serves real line windows for canonical `.fusion/memory/` paths instead of the empty stub. No backend registration or index write changed.
