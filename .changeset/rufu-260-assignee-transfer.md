---
"@runfusion/fusion": patch
---

summary: Re-assigning a card now stops the old owner's live session before its worktree is reused.
category: fix
dev: New typed `task:assignee-changed` store event published from `updateTask`; the executor aborts the previous owner's in-flight work with `abort-in-flight:assignee-transfer` provenance (never `userCanceled`), never aborts a live review-gate (workflow-step) session while the card sits in a trait-resolved review lane, and publishes the teardown into the per-task disposal barrier that heartbeat wakes must await before `acquireTaskWorktree`. Assignment wakes re-validate ownership after the barrier, pending-assignment and per-(agent, goal) wakes dedup onto the one in-flight run, and each outcome records `task:assignee-transfer-abort` / `task:heartbeat-wake-deduped` run-audit rows (ids and fixed outcomes only).
