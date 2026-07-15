---
"@runfusion/fusion": minor
---

summary: Deprecate the built-in Brainstorming workflow — it no longer appears for new task selection.
category: internal
dev: builtin:brainstorming is excluded from defaults and listWorkflowDefinitions through the deprecation registry/helper, but remains resolvable by id. Applied after a successful live-store query verified no active task selects it.
