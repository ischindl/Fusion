---
"@fusion/engine": minor
---

feat(engine): export `smartPull()` library for stash-aware fast-forward of a worktree

Standalone stash → fast-forward → pop implementation that the merger's upcoming `mergeAdvanceAutoSync` hook calls after advancing the integration-branch ref to auto-sync other worktrees still pinned at the previous tip. Returns a discriminated union (`clean-pull | stash-pull-pop | stash-pop-conflict | skipped-dirty | skipped-not-on-branch | failed`) and accepts an optional audit emitter so callers can record `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` run-audit events.

The dashboard's user-triggered Pull continues to use the existing `POST /api/git/pull` integration path (which runs the AI-aware autostash through `restoreUnrelatedRootDirChanges`) and is unchanged by this changeset — `smartPull()` is intentionally simpler so the merger's post-advance auto-sync stays free of mid-merge AI conflict resolution.
