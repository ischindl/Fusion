---
"@runfusion/fusion": patch
---

summary: Non-FN task id prefixes now work for orphan rehoming, worktree start-point warnings and room coordination.
category: fix
dev: Three task-id attribution families still matched only `FN-<n>` after RUFU-292 generalized commit attribution, so cards minted under a project `settings.taskPrefix` like `SANE` or `RUFU` were read as naming no card. Orphan rehoming returned `no-trailer`, so another card's finished commit was never rehomed onto the integration branch; the foreign worktree start-point warning returned before probing the tip, so a misbound lane logged nothing; and room coordination/ambiguity missed a peer's `filed RUFU-318` announcement, so the room re-filed a card that already existed and a deictic "do that" lost its referent. All three now compose the exported `TASK_ID_TOKEN_SOURCE` grammar from `packages/engine/src/execution/branch-conflicts.ts`, plus `TASK_ID_TOKEN_PROSE_SOURCE` for free-text room scanning, where a token inside a longer hyphenated word (`step-3-build`) must not become a phantom card id. Recovery and observation refusal gates are unchanged, and `deriveTaskIdFromFusionBranch` and `isForeignTaskPinnedBranch` remain FN-only on purpose because they gate destructive git reclaim and deletion.
