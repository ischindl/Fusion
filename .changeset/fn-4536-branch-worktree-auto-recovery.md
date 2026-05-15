---
"@runfusion/fusion": patch
---

Add branch/worktree auto-recovery handler that resolves FN-4519-class incidents (ghost worktrees, branch misbinding, stale branch-conflict-unrecoverable parking) by re-running deterministic classification (FN-4499 bootstrap re-anchor, FN-4500 zero-unique-commit reclaim via inspectBranchConflict kinds `stale-resolved` / `fully-subsumed`, FN-4499 `reclaimable`-with-zero-own-commits re-anchor) against live evidence and requeueing through the FN-4534 dispatcher. Adds run-audit events branch-worktree:auto-requeue, branch-worktree:ai-session-spawned, branch-worktree:irreducible-pause. Genuine live-foreign (FN-3936-class) cases continue to pause; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" behavior is byte-identical to legacy parking.
