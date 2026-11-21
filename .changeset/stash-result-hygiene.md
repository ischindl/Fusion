---
"@runfusion/fusion": patch
---

summary: Stash memory recall returns varied, readable rows instead of one session's repeated tool names.
category: fix
dev: New `stash-result-hygiene.ts` (`STASH_MAX_ROWS_PER_SESSION`, `classifyStashRow`, `hygieneStashItems`, `labelStashRanking`) filters, dedups and caps Stash results at one row per session after project scoping; `MemorySearchResult` grows an optional `rankingSource: "positional" | "server-rank-fallback"`, and surfaces print an order sentence instead of `(score N)` when a page carries no real relevance signal. No new request and no URL change.
