---
"@runfusion/fusion": patch
---

summary: Fix boot failure on hosts with the Telegram bridge: its tables now get forced RLS and the project-isolation policy.
category: fix
dev: `telegramPluginSchemaInit` created `project.telegram_*` with `project_id` but no isolation envelope; `schema-applier`'s project-ownership gate refused `applySchema`, so both `fn serve` and `dashboard` exited ~1.3 s after start. Core plugin hooks get no automatic envelope, only `LoadedPluginSchemaContract` does.
