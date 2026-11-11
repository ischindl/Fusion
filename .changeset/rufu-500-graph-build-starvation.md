---
"@runfusion/fusion": patch
---

summary: Rebuilding the knowledge graph no longer freezes the board, and now reports how much it re-read.
category: performance
dev: An incremental pass re-reads only changed files via a regenerable `stat-cache.json` sidecar in the graph directory, so an unchanged tree reads zero file bodies; `--force` bypasses it. Builder bookkeeping is linear instead of quadratic, file discovery caps at 25,000 files, `runKnowledgeGraphBuild` is single-flight per resolved graph directory, and the build summary plus `fn knowledge-graph build` output gained `read N/M`, `stat-only`, and a `capped N` warning when discovery truncated the walk.
