---
"@runfusion/fusion": patch
---

summary: Review cards stuck behind a reviewer run whose session died now recover on their own.
category: fix
dev: New self-healing sweep `reconcile-stranded-reviewer-runs` (startup + maintenance batch 2) closes reviewer attempts that are still `running` after a 30-minute floor once the canonical liveness triple proves the session is gone, emitting `task:reconcile-stranded-reviewer-runs`. Closes carry the `engine-lost:` reason prefix, which the review dispatch attempt budget now exempts, so an orphaned attempt no longer spends a card's retries. Rows are never deleted and `userPaused` cards are untouched.
