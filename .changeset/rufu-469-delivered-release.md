---
"@runfusion/fusion": patch
---

summary: Cards waiting on overlapping files now unblock as soon as the predecessor's work lands, not only when it changes lane.
category: fix
dev: Adds a fifth `overlapPredecessorRelease` face, `delivered`, keyed on "no retained checkout plus a concrete delivery snapshot" with a non-WIP-lane floor, and widens the predicate's lane argument to a single `OverlapReleaseLanes` bag so both callers must resolve the WIP lanes as well as the complete lanes.
