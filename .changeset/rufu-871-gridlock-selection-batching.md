---
"@runfusion/fusion": patch
---

summary: The gridlock sweep reads workflow lanes for the whole board in one query instead of one per card.
category: fix
dev: `detectGridlock` resolved lifecycle and dependency-satisfaction per card without a selection cache, so a pass over N cards issued N single `task_workflow_selection` SELECTs (production read attribution: `workflowSelection` at 72,309 reads / 15 min ≈ 80/s with zero running cards). The sweep now prefetches one batch into a per-pass cache shared by the lifecycle loop, the IR loop, and `resolveDependencySatisfactionColumns`. The cache still dies with the pass, so a selection written between passes is observed by the next.
