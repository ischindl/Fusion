---
"@runfusion/fusion": patch
---

summary: Fix workspace sub-repo worktree creation failing on absent shared branch.
category: fix
dev: worktree-acquisition.ts acquireWorkspaceRepoWorktree now strips the shared project integrationBranch/baseBranch overrides before forwarding to acquireTaskWorktree, so FN-7360's freshStartPoint resolution no longer tries to git-worktree-add a branch absent from the sub-repo.
