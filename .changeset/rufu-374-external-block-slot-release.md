---
"@runfusion/fusion": patch
---

summary: A task frozen by an external failure gives up its concurrency slot when it holds no unmerged checkout.
category: fix
dev: `maxConcurrent` accounting now downgrades an externally blocked task only on a checkout-emptiness proof (no retained checkout path, or every retained repository proven clean against its base and zero commits ahead). No proof, an absent or throwing prover, an unknown/dirty/ahead/unreadable verdict, or any unproven workspace sub-repo keeps the task counted, so Retry still resumes into a retained checkout. One proof object per evaluation feeds the agent holders, worktree holders, plan-admission claim snapshot, continuation dispatch, merge admission, and the spawn gate, so the throttle line's `used=N/limit; holders=…` and the claimed holder count cannot disagree. Flagless surfaces (dashboard/CLI) stay conservatively counting a frozen task as active.
