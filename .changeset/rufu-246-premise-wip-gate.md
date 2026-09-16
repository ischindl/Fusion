---
"@runfusion/fusion": minor
---

summary: Cards whose plan states a false repo fact are held, replanned once with the exact failing fact, then parked for review.
category: feature
dev: Refusal episodes persist at `sourceMetadata.planPremiseRejection` (key-level patch only). Identical refusals escalate 1=hold, 2=replan with the refusal detail delivered into the replan prompt, 3=terminal park with `plan-premise-exhausted`; operator Retry/Reset clears the episode. Fast-execution cards no longer bypass the premise check.
