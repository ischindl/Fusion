---
"@runfusion/fusion": patch
---

summary: Rebuilding the codebase knowledge graph no longer freezes the dashboard.
category: performance
dev: "The build now runs in a forked child (`knowledge-graph-worker.js`, emitted beside `bin.js`) instead of inside the dashboard process, which measured 84.8% of its CPU for minutes at a time with `/api/health` answering in 3.5 s. Both automatic (Memory Keeper consolidation) and manual (`POST /api/knowledge/graph/build`) paths use it. It falls back to an in-process build only when the child cannot be spawned at all; a real build failure still surfaces instead of being retried in-process. Set `--max-old-space-size` on the build child (4 GB) rather than inheriting the server's 16 GB ceiling."
  Path resolution now tries the true sibling, the launcher-relative `dist` sibling, and the package-root shape, and the offloader logs which worker it chose or why it refused — a declined offload was previously indistinguishable from a missing feature.
