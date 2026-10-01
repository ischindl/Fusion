---
"@runfusion/fusion": patch
---

summary: Worktree preservation refusals no longer terminalize a card — the checkout is moved aside, nothing is deleted.
category: fix
dev: Adds `WorktreeContentPreservationError` and the `defensiveRemovalWouldPreserve()` predicate; task-pinned reclaim now vacates a refused checkout under `.fusion/recovery/worktrees/` instead of throwing, so a policy no-op no longer decides the card's lifecycle.
