---
"@runfusion/fusion": patch
---

summary: A card's step list now follows its newest PROMPT.md, and a spec that repeats a section is refused instead of saved.
category: fix
dev: `updateTask({ prompt })` validates the submitted document through `inspectPromptDocument` (a report over `canonicalizePlan`, so `## Non-Goals` beside `## Do NOT` is one section) and throws `DuplicatedPromptSectionError` before the row commits — a refusal writes nothing, leaving the previous document, its steps, and its approval fingerprint byte-identical. The same call re-derives `task.steps` from the submitted bytes via `mergeReDerivedSteps` (statuses survive by name, dropped steps are named in History, remediation provenance is preserved and dead edges pruned); an explicit `steps` write is still honoured. `parseStepHeadings` now masks the generated `## Original Description` region, so headings the operator quoted can never become board steps. New refusal reason `duplicated-prompt-section` on `fn_task_prompt_write`.
