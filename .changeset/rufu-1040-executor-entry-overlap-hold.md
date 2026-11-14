---
"@runfusion/fusion": patch
---

summary: A file-scope wait found at implementation entry no longer fails the card or spends a retry budget.
category: fix
dev: The `OverlapResumeSynchronizationError` raised by the acquisition and the external-worktree gate in `runImplementation` is caught alongside `WorktreeBaseRefreshError` and re-thrown past cleanup; `runGraphTaskStep` re-throws it; the graph interpreter publishes the typed node value `overlap-wait-hold`; `handleGraphFailure` routes it to a bounded in-place resume on `graphResumeRetryCount` that writes no `status`/`error`/pause and reaches neither `routeGraphFailureToExecutionResume` (which charges `executionRearmEpisode`) nor the terminal park. `recordOverlapAcquisitionPark` gains `releaseRegistration`, which the executor passes false so a refused WIP lease reports `registrationRelease: "retained-wip-lease"` instead of being torn down. `docs/run-audit.md`'s `registrationRelease` vocabulary is corrected to the values the code returns (the RUFU-849 list never matched them) and the executor is documented as a producer. No new lifecycle state, graph edge, event type, or wake owner.
