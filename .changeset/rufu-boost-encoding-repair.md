---
"@runfusion/fusion": patch
---

summary: A Boost that had become unreadable in the database is repaired, so it ranks again.
category: fix
dev: The stored `queue_boost` jsonb can hold the boost one JSON layer too deep (a JSON string whose body is the boost), which makes every `->>'sequence'` read NULL and the queue count the boost as 0. `boostTask` now reads the raw column, recognizes that shape, and rewrites the same sequence in place — it never re-ranks. `normalizeTaskQueueBoost` stays strict on purpose, so the in-memory task and the SQL `ORDER BY` keep one authority over a rank.
