---
"@runfusion/fusion": patch
---

summary: Worktrees holding only gitignored build output are released again instead of refusing forever.
category: fix
dev: An automatic checkout release now decides from occupancy alone — a tracked modification, a staged
change, or an untracked path (quoted or not) — and records gitignored content it discards rather than
gating on it. `probeWorktreeRemovalContent()` is the sole authority and additionally reports the ignored
paths it saw, so the release names its discard. Retired as a result: the `REGENERABLE_IGNORED_DIR_NAMES`
basename allowlist, the child-probed `FUSION_SCRATCH_REGENERABLE_CHILDREN` exception, the
`regenerable-ignored` classification, and the durable-landing-proof gate that was the only way to remove
ignored content (proof is now metadata on the discard record, never a permission). The audit types
`worktree:post-landing-ignored-content-discarded` and `worktree:removal-discarded-regenerable-content`
are replaced by `worktree:removal-discarded-ignored-content`, which lists the discarded paths.
The other cleanliness probe, `taskWorktreeCheckoutIsClean()`, no longer reads `git status` on its own —
it derives from the same probe, so the four conflict doors and the release they lead to cannot answer
differently about one tree. Its answers are unchanged: a deliverable, unreadable or absent checkout
still fails closed.
Deliverable, unreadable and project-root content still refuse, so no defensive sweep can destroy work.
