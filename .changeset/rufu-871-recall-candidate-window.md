---
"@runfusion/fusion": patch
---

summary: Memory search reads a bounded recent window instead of every recall record of the project.
category: fix
dev: `searchRecall` applied its limit in JavaScript after selecting every row for the project (measured 32,578 rows / 14 MB of content for one project), so a single `memory search` hydrated and tokenized the whole table inside the process that hosts every engine lane. The candidate read now carries a SQL window (`FUSION_RECALL_CANDIDATE_WINDOW`, default 2000, floored at `RECALL_SEARCH_MAX_LIMIT`). Trade-off: keyword recall searches the newest window, so a match older than the window is no longer reachable by keyword; hits were already capped at 50 by the shared clamp. Full-corpus recall needs a Postgres-side searchable index, which is the follow-up.
