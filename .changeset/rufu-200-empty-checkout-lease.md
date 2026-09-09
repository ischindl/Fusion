---
"@runfusion/fusion": patch
---

summary: A retained checkout proven empty no longer holds file-scope leases or worktree-capacity slots, and is now reclaimable.
category: fix
dev: A retained checkout is a dormant lease/capacity holder only while clean-and-behind has not proven otherwise; git evidence is downgrade-only and fail-closed (occupied/unknown keep today's behavior). Heartbeat worktree acquisition is skipped for planning-lane cards that cannot dispatch — unmet dependencies, or the card's own `overlapBlockedBy` lease on a peer (`dependencies: []` variant) — and the blocked planning-lane reclaim widening lets `reclaimSelfOwnedBranchConflicts` clear such phantom holders without dropping their dependency edges.
