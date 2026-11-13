---
"@runfusion/fusion": minor
---

summary: A card stuck failing the same step now stops after 4 automatic re-tries instead of re-trying forever.
category: fix
dev: The execution re-arm ceiling (`MAX_EXECUTION_REARM_ATTEMPTS = 4`) was unreachable, so a card held its in-progress slot re-entering the same failing node indefinitely - measured 327 re-arms on one card in 24 h, every audit row `attempt: 1`, zero exhaustion rows.
dev: The episode counter moved from `mergeDetails.executionRearm` to `sourceMetadata.executionRearmEpisode`, because `cleanupMergeStateForReverification` legitimately writes `mergeDetails: null` on the stale-merge-state path these cards walk. The re-arm signature no longer keys on `status`/`error`, which the successful re-arm itself clears. Operator Retry clears the new key so one Retry buys the full ladder again; the pre-upgrade shape is still read, so no card is forgiven attempts it already burned. The fifth identical failure writes exactly one `task:execution-rearm-exhausted` row and one `EXECUTION_REARM_EXHAUSTED:` park, with no column move.
