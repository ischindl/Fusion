---
"@runfusion/fusion": minor
---

summary: Cards now say why they are stuck straight from the engine, in every supported language.
category: feature
dev: The dashboard stall resolver treats the server-derived `task.stallReason` as its authority (present field wins, unknown codes fail open to the client chain), completing the seam the RUFU-175 resolver changeset deferred. merge-blocker and completion-blocker became card-face chips (the reported "no reason anywhere" symptom); `pre-merge-gate-pending` and `held-human-review` are detail-banner-only per the 2026-07-26 review-rest ruling, with human-hold copy that never pairs merge with blocked. New `stallAgent` mapper feeds the health pill, which ranks `Waiting for approval` below errors and named pauses. In the client chain the agent's approval wait sits behind the card-specific blockers, because the approval count is a per-actor aggregate and `agent-approval` renders no card-face chip, so ranking it first would silence a real per-card reason. All 51 `stall.*` catalog leaves filled in es, fr, ko, pt-BR, zh-CN, zh-TW, pinned by `stall-catalog-values.test.ts` because the parity gate deliberately tolerates empty secondary values.
