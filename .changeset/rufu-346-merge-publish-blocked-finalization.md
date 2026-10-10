---
"@runfusion/fusion": minor
---

summary: Publish a merged landing to the remote even while required post-merge evidence still blocks completion.
category: fix
dev: The publish moved inside finalization through a publish closure that can never throw, so a blocked or deferred card still offers its landing before the refusal. New run-audit pair `task:merge-publish-before-finalize` (outcome `pushed`/`not-pushed`, `landingProof` `lane`/`recorded`) and `task:merge-publish-before-finalize-unavailable` (fixed `MergePublishHold` code) records that decision on blocked arms only; a completed merge keeps `push:origin` as its only record.
