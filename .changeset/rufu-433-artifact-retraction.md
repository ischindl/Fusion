---
"@runfusion/fusion": minor
---

summary: Agents can retract a wrong artifact with a mandatory reason; it stays visible as a VOID tombstone, never deleted.
category: feature
dev: New `fn_artifact_retract` tool (author-bound; a foreign retractor is refused by name) plus `includeRetracted` on `fn_artifact_list` and a VOID header-with-reason answer from `fn_artifact_view`. Migration `0097` adds `artifacts.retracted_at`/`retracted_by`/`retract_reason`; nothing is ever deleted. Every read path hides a tombstone unless `includeRetracted: true` is passed explicitly, `GET /api/artifacts/:id` nulls `content` and sets `retracted: true`, and `GET /api/artifacts/:id/media` answers `410 Gone` before touching disk. New routes `POST /api/artifacts/:id/retract` and `POST /api/artifacts/:id/restore`; restore is operator-only by design, with no agent-facing tool. Retracting writes no card state: no column move, no gate verdict change, no pause clear. New `artifact:retracted` run-audit event carries ids/counts only - the mandatory reason stays on the tombstone row and the card's History line.
