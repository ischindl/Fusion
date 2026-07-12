---
"@runfusion/fusion": minor
---

summary: The Task Detail Terminal tab is now always available, falling back to the project root when a task has no worktree.
category: feature
dev: Relaxes the TaskDetailModal `showWorktreeTerminalTab` gate to always render and passes `defaultCwd` = worktree when present else undefined (project-root auto-create via useTerminalSessions). Covers no-worktree and multi-repo workspace tasks. Sessions stay task-scoped via `scopeId`.
