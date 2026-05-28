---
"@runfusion/fusion": patch
---

feat(FN-5627): self-heal transient merge failures stuck at mergeRetries=3

After the FN-5627 merger fix landed, two in-review tasks (FN-5628, FN-5632) remained stuck at `mergeRetries=3` with `status='failed'` due to transient merge errors that the merger correctly identified but had no auto-recovery for:

- `lease-handoff-failed: target-not-queued` — FN-5353 class race where the merge queue lease acquisition saw the task drop out of the queue between enqueue and handoff (typically due to a self-healing sweep cleaning stale `mergeQueue` rows mid-flight).
- Legacy same-SHA spurious concurrent-advance errors persisted before FN-5627's `merger-ref-update-advance.ts` classifier fix landed.

These tasks had no path forward except manual intervention. The `AUTO_MERGE_COOLDOWN_MS` cooldown reset takes hours and gives up too easily.

This change adds `SelfHealingManager.recoverTransientMergeFailures()`, wired into both startup recovery and the periodic Batch 2 maintenance loop. For each in-review task with `mergeRetries >= MAX_AUTO_MERGE_RETRIES`, `status='failed'`, and an `error` matching `classifyTransientMergeError()`:

1. Reset `mergeRetries=0`, clear `status`/`error`.
2. Increment `mergeDetails.transientRecoveryCount` (new field on `MergeDetails`).
3. Re-enqueue via `requeueForAutoMerge`.
4. Emit `merger:transient-failure-auto-recovered` run-audit event.

Bounded by `MAX_TRANSIENT_MERGE_RECOVERIES = 2` to avoid infinite loops on genuinely stuck tasks. Once exhausted, the task stays parked as failed and emits `merger:transient-failure-budget-exhausted` once with a `[transient-recovery-budget-exhausted]` marker on `error` for repeat-suppression.

Non-transient failure classes (verification, build, real conflicts, etc.) are not eligible — only the pattern-matched transient classes auto-recover. No-op when `autoMerge=false`, no `requeueForAutoMerge` callback wired, or pause is active.

Tests:
- Lease-handoff transient recovery path
- Same-SHA spurious-advance recovery (legacy pre-FN-5627)
- Genuine concurrent-advance (different SHAs) NOT recovered
- Non-transient failures (verification errors) NOT recovered
- Budget exhaustion behavior
- autoMerge=false no-op
