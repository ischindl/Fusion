---
"@runfusion/fusion": patch
---

summary: Autonomous git can no longer hang on editor/credential prompts; orphaned git children of deleted worktrees are reaped.
category: fix
dev: New core applyNonInteractiveGitEnv floor applied last at every engine, verification, and plugin-runtime spawn seam; new self-healing sweep reap-orphaned-worktree-git-children emits worktree:orphaned-git-child-reaped / -reap-no-action (process signals only, 30m grace floor).
