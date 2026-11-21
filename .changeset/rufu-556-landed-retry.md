---
"@runfusion/fusion": patch
---

summary: Retry on a card that already merged no longer returns a server error; it re-runs the post-merge verification.
category: fix
dev: `POST /tasks/:id/retry` on a card with a durable landing proof and an owed required post-merge gate now calls the engine's post-merge gate resume seam (`resumeMissingPostMergeGate`, newly exported from `@fusion/engine`) with `manualRetry: true`, which overrides only the rejected-evidence revisit schedule. 200 means the verification was re-driven; every refusal answers 409 carrying the seam's own reason code (`operator-held`, `checkout-lease`, `rerun-budget-exhausted`, `fence-failed`, `unsupported-store`, …) and its remedy. The destructive stage restart is no longer reached for such a card, so an approved review carrier and the landing proof survive the click. Cards with no post-merge row, an operator-waived (`skipped` + `notRunReason`) row, or a workspace shape keep their existing behavior unchanged.
