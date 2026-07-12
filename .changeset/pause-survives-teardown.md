---
"@runfusion/fusion": patch
---

summary: Pausing an in-progress task now sticks — the pause survives session teardown instead of auto-resuming.
category: fix
dev: New `preservePause` moveTask option; the executor pause teardown passes it so the todo re-queue keeps `paused`/`pausedByAgentId`/`pausedReason`. The graph-failure classifier now labels a preserved task pause as operator intent (never "engine abort during pause/resume" auto-continue), and the benign re-queue log says "parked … awaiting explicit unpause" for paused rows.
