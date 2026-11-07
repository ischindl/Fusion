---
"@runfusion/fusion": minor
---

summary: Projects list and project picker now show which projects have their engine runtime turned off.
category: feature
dev: `GET /api/projects` (and `/projects/across-nodes`) gained a `runtimeEnabled` field resolved once per project per request; `status` is unchanged. New LIVE → PAUSED → TURNED OFF ordering lives in `app/utils/projectDisplayOrder.ts`. A turned-off project now carries a "Turn runtime on" action that posts `x-fusion-surface: project-card` to `POST /api/projects/:id/runtime`.
