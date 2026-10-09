---
"@runfusion/fusion": patch
---

summary: Worktree preservation refusals no longer terminalize a card — the checkout is moved aside, nothing is deleted.
category: fix
dev: Adds `WorktreeContentPreservationError`; task-pinned reclaim now vacates a refused checkout under `.fusion/recovery/worktrees/` instead of throwing, so a policy no-op no longer decides the card's lifecycle. This change also added a boolean "would this removal refuse?" predicate next to that error; RUFU-298 replaced its only caller with the probe's content class and RUFU-329 deleted it, since it had no callers left and was never part of the engine's public exports.
