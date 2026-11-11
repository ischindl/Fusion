---
"@runfusion/fusion": patch
---

summary: A spec's File Scope bullet may annotate its declared path with extra backticks instead of refusing the whole spec.
category: fix
dev: The declared-entry harvest is narrowed to the FIRST backticked token of each line in `## File Scope`, so `- \`path.ts\` (returns a \`rerouted\` false branch)` declares one entry and the annotation is commentary. Conservatism is not widened: a refused LEADING entry (`origin/main`, `HEAD`, a bare `rerouted`, a bare `todo`) still blocks the spec write at every `InvalidFileScopeError` throw site, and a bullet with no leading backtick stays prose for validation while still counting as a declared entry for the write-scope guard. One shared harvest now backs validation, classification, prompt sanitize, the `fn_task_file_scope_add` dedupe, and the shared-branch scope widen, so an annotation can no longer be mistaken for a declared path there either.
