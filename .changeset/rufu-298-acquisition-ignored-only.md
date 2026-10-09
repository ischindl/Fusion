---
"@runfusion/fusion": patch
---

summary: A pinned worktree holding only ignored build output no longer blocks acquisition; it is moved aside, never deleted.
category: fix
dev: Pinned reclaim now decides from the shared FN-9233 probe `probeWorktreeRemovalContent()` (extracted from `assertCleanForDefensiveRemoval()`, so removal and acquisition cannot drift) instead of the boolean predicate `defensiveRemovalWouldPreserve()` it replaced: `clean`/`regenerable-ignored` still remove in place, `ignored-only`/`deliverable` preserve aside under `.fusion/recovery/worktrees/`, and an unreadable status probe preserves nothing and defers to defensive removal's fail-closed re-probe. The preserve rename is now followed by an explicit `worktree:admin-entry-pruned` pass (`reason: "task-pinned-preserving-reclaim"`), so recreating the pinned path never depends on the branch-collision ladder's incidental prune. On the same preserve path, the acquisition `file:write` audit row and its task-log line now name the probed content class that caused the preserve, keeping the earlier fixed placeholder only as the fallback for a missing probe result; an earlier version of this note wrongly credited that change to the `worktree:removal-preserved` event, whose own emitters always derived a real classification (attribution corrected in RUFU-329).
<!-- RUFU-329 -->
