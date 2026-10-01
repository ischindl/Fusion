---
"@runfusion/fusion": patch
---

summary: A card already completed and handed off to review is no longer marked failed by a stale graph-failure signal.
category: fix
dev: Graph-failure sink honors a completed handoff in the resolved review lane (execute-family nodes only) and emits `task:graph-failure-after-handoff-honored`; the terminal-write and deferred-park fences decline handed-off rows.
