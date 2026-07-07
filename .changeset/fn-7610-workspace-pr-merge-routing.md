---
"@runfusion/fusion": patch
---

summary: Fix workspace-mode tasks failing auto-merge under the pull-request merge strategy.
category: fix
dev: Engine merge dispatch now checks isWorkspaceTask before the mergeStrategy branch, routing workspace tasks to landWorkspaceTask instead of processPullRequestMerge (which threw "could not determine repository" against the non-git workspace root). processPullRequestMergeTask/syncGroupPrCallback now throw the named WorkspaceTaskMergeError for workspace tasks as defense-in-depth.
