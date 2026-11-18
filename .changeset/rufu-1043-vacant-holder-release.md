---
"@runfusion/fusion": patch
---

summary: Cards waiting on a file-scope predecessor that holds nothing are released automatically.
category: fix
dev: `overlapPredecessorRelease` gains a `vacant` face — a blocker with no checkout pointer that rests in a lane which cannot deliver, owns no live work item, and whose lane vocabulary resolved. Review-lane and WIP-lane holders keep their claim, and an unresolved lane vocabulary or an unreadable work-item table refuses the release.
