---
"@runfusion/fusion": patch
---

summary: Review cards that finished without merging no longer claim a merge retry stalled when none ever ran.
category: fix
dev: The `completed-review-status-none` stall badge read "Merge retry stalled", but that code is emitted only when `mergeRetries === 0` (`packages/core/src/tasks/in-review-stall.ts`), so the label described an event that cannot have happened; 26 saneca `in-review` cards wore it while their real condition was a Code Review row that died with no authored verdict. Badge is now "Review not merged" and the description names both real causes (missing verdict / merge hand-off never started). `merge-retries-exhausted` keeps the retry wording. Guarded by `app/__tests__/in-review-stall-copy-retry-wording.test.ts`, which asserts badge+headline never mention a retry and keeps the wording where retries really ran out.
