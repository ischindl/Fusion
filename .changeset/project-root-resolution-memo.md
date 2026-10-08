---
"@runfusion/fusion": patch
---

summary: Repo-root lookups no longer spawn git on every call, cutting per-request subprocess churn.
category: performance
dev: `getProjectRootFromGitLinkedWorktree` and `resolvePiExtensionProjectRoot` are memoised per resolved path (negative answers expire after 60 s), so an ordinary repository no longer pays two synchronous `git rev-parse` spawns per call.
