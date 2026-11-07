---
"@runfusion/fusion": fix
---

summary: Project runtime state now reports the persisted truth for every project, not just the one this process has open.
category: fix
dev: The batched `project.config` runtime-flag read runs inside a transaction-local `fusion.project_bypass` (RLS is forced on that table, so a project-bound pool saw exactly one row); if the bypass cannot be obtained it reports "could not answer" and logs the per-store fallback instead of returning a one-project record.
