---
"@runfusion/fusion": patch
---

summary: Fresh task branches start from the local default branch; diverged local defaults refuse acquisition with a named reason.
category: fix
dev: Acquisition records `worktree:workspace-repo-base-branch` `stage: "acquire"` (`source: "local-integration"`) with outcomes `resolved-local-base` / `refused-diverged` / `skipped-remote-unresolvable` / `skipped-remote-rebase-disabled`; proven divergence throws `TASK_BASE_DIVERGED:` at executor, heartbeat, merger, and graph-node entries without consuming the branch-conflict `recoveryRetryCount` budget, and the post-create rebase skips only proven-diverged remotes (strictly-behind linear rebase preserved).
