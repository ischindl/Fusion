---
"@runfusion/fusion": patch
---

summary: Landed cards wait for their post-merge verification gate again, and gate reseed recovery is fenced and retried.
category: fix
dev: Restores both halves of the merge-confirmed post-merge evidence hold in `project-engine.ts` (blocker resolution for landed cards plus `canMergeTask` deferral), restores the FN-9442 non-blocking disposition wording in the builtin post-merge group prompt, wraps the reseed's continuation insert and log write in the merge write fence, and makes the reseed's second admission test per-gate so rejected evidence is revisited automatically instead of only via an explicit Retry. Also restores FN-9412's planning-dependency filter at all three sites its changeset still promises (summary normalisation plus both planning create paths), so prose in `suggestedDependencies` can no longer reach a created task's dependencies.
