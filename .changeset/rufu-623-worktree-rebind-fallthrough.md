---
"@runfusion/fusion": patch
---

summary: A restored task checkout that git names no branch for is set aside and recreated, not failed as a card error.
category: fix
dev: Pinned worktree acquisition now treats an unprovable branch rebind as advisory only for the branchless (detached) shape — the crash-recovery / archive-restore checkout RUFU-298 documents — and falls through to the content-classification reclaim, which preserves the evidence beside the worktrees root and recreates the pinned path. A checkout on a branch the rebind prover cannot still attribute to the task keeps FN-9442's terminal refusal, because falling through there would let acquisition `git worktree remove` a checkout whose owner cannot be proven (RUFU-730's non-`FN` foreign-prefix grammar). Ownership-drift CAS rejection is unchanged.
