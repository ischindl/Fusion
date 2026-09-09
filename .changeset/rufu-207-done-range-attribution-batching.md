---
"@runfusion/fusion": patch
---

summary: Done-card change attribution resolves all its commits in one git call, so finished tasks stop stalling the board.
category: performance
dev: filterFilesToOwnTaskCommits now batches per-commit file resolution (1 git log + 1 batched git log --no-walk, <=2 spawns vs 1+C before) behind a content-addressed 10s cache with in-flight coalescing; per-commit attribution byte-identical, proven by a differential oracle test.
