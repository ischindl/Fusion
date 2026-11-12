---
"@runfusion/fusion": patch
---

summary: Failed cards no longer keep holding their worktree after the last few failure parks.
category: fix
dev: Extends RUFU-323's release rule to the remaining non-releasing terminal parks — the branch-write provenance refusal, the workspace-preparation park, the execute dispatch-loop exhaustion cap, the graph-terminal merge arm, and the merge-retry parks — each releasing only on its own committed write. The merge-retry router now reports `handled` separately from `committed`, because a declined compare-and-set fence resolved without writing anything; releasing there would have evicted the replacement dispatch's binding. The drift park stays a keeping site: it preserves progress so a requeue resumes in the same checkout. Durable `worktree`/`branch` columns are never cleared, so Retry still resumes from the recorded checkout.
