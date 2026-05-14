---
"@runfusion/fusion": minor
---

Add `--project <id|name>` support to `fn serve` and `fn daemon` for explicit primary project binding.

Headless startup now resolves its primary engine in this order: CLI `--project`, central `defaultProjectId`, cwd project, then first started engine from the central registry. `serve`/`daemon` no longer require cwd to be a registered project and now only exit when no engines start across the registry.

Add central `defaultProjectId` persistence so headless nodes can select a default project across restarts.
