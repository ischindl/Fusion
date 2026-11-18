---
"@runfusion/fusion": patch
---

summary: Duplicate closes and dependency guards name cards on any task prefix; title cleanup strips only ids this board mints.
category: fix
dev: The task-id grammar moved to `packages/core/src/tasks/task-id-token.ts` (`TASK_ID_TOKEN_SOURCE`, `TASK_ID_TOKEN_PROSE_SOURCE`, `createTaskIdProseRegExp`, `isTaskIdToken`, `taskIdPrefixOf`); the engine re-exports it. `TASK_ID_TOKEN_RE`'s capture group 1 is now the whole id, not just the digits. Title cleanup decides card references by prefix provenance — the row's own prefix or the `FN` minting fallback, widened only by an explicit `knownPrefixes` argument — because a shape-only strip deleted `UTF-8`, `SOC-2`, `RFC-2616` and `TLS-1` from ordinary titles. Drift follows the same rule, so a foreign-prefix id is reported without rewriting the title, and the card's `removed=[...]` History line now comes from `removedTaskIdTokens` (what the strip actually took) rather than the shape view. The destructive gates (`deriveTaskIdFromFusionBranch`, `isForeignTaskPinnedBranch`, `extractTaskIdFromTempMergeDir`, `isTaskNotFoundError`) stay `FN-`-only on purpose and are pinned by test.
