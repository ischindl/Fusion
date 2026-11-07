---
"@runfusion/fusion": minor
---

summary: Project cards can now turn a project's engine runtime off, not only back on.
category: feature
dev: The card's runtime control is one callback carrying the desired state (`onEnableRuntime(project, enabled)`); `false` unloads the runtime via the existing `POST /projects/:id/runtime` route and never writes `status`.
