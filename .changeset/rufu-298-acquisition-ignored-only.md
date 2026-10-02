---
"@runfusion/fusion": patch
---

summary: A pinned worktree holding only ignored build output no longer blocks acquisition; it is moved aside, never deleted.
category: fix
dev: Pinned reclaim now decides from the shared FN-9233 probe `probeWorktreeRemovalContent()` (extracted from `assertCleanForDefensiveRemoval()`, so removal and acquisition cannot drift) instead of the `defensiveRemovalWouldPreserve()` boolean: `clean`/`regenerable-ignored` still remove in place, `ignored-only`/`deliverable` preserve aside under `.fusion/recovery/worktrees/`, and an unreadable status probe preserves nothing and defers to defensive removal's fail-closed re-probe. The preserve rename is now followed by an explicit `worktree:admin-entry-pruned` pass (`reason: "task-pinned-preserving-reclaim"`), so recreating the pinned path never depends on the branch-collision ladder's incidental prune, and the `worktree:removal-preserved` row carries the concrete class instead of the old `content-preservation` label.
