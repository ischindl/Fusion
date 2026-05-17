---
"@runfusion/fusion": patch
---

fix(FN-4811): close concurrent-execute race that produced parallel runs for the same task

`TaskExecutor.execute()` had an async race: after the synchronous `this.executing.has(task.id)` check, the code awaited `shouldDeferForHeartbeat(...)` BEFORE adding to the `executing` Set. Two concurrent `execute()` calls (scheduler dispatch + `task:moved` listener + restart-recovery) could both pass the check, both yield on the await, then both add to the Set and both proceed to create the same worktree.

Production signature (FN-4814, FN-4811):

```
01:30:56  [runA-caoe]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
01:30:56  [runB-w23q]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
01:30:58              worktree liveness assertion failed: not_usable_task_worktree
```

This is the canonical source of FN-4781/FN-4804/FN-4814/FN-4811 mid-task worktree disappearance and cross-task contamination — every other guard in the stack (FN-4811 active-session gate, self-healing reclaim defer, etc.) was patching the *symptoms* of the duplicate-run race.

Fix: claim the executing slot synchronously immediately after the `has()` check, release it on the heartbeat-defer early return. Closes the race window entirely.
