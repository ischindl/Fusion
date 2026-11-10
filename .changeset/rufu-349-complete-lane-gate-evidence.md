---
"@runfusion/fusion": patch
---

summary: A card can no longer reach Done while its after-merge check never passed.
category: fix
dev: A complete-trait column is now entered only by merge-confirmed finalization or the no-merge completer. Built-ins draw their post-merge gate in the review lane; drawing one into a complete column is refused at save with a 4xx naming the node (loading such a workflow still works, so it can be repaired); the store applies its gate-evidence classifier to graph node-entry moves; and the report-only sweep now also names cards already sitting in Done whose required after-merge check produced no result at all, per card, without moving them.
