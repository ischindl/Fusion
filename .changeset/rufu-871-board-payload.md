---
"@runfusion/fusion": patch
---

summary: Board cards load four times smaller — the card feed no longer ships spec bodies, comments, or step reports.
category: performance
dev: `GET /api/tasks/page` and `GET /api/tasks` now carry a bounded spec preview (`BOARD_DESCRIPTION_PREVIEW_CHARS`, 400 chars, flagged with `descriptionTruncated`), an allowlisted `sourceMetadata`, `retrySummary: { total }` only, and `tokenUsage` only when the project's `showCostBadgeOnCards` is on. The task card's inline editor fetches the full body via `GET /tasks/:id` before it can save, so a preview is never written back over the stored spec.
