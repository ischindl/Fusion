---
"@runfusion/fusion": minor
---

summary: Show live database-migration progress during boot — dashboard holding page/banner and desktop launch screen.
category: feature
dev: CLI binds a temporary holding server on the dashboard port during `createTaskStoreForBackend` (new `onMigrationProgress` option) serving an auto-reloading page + `/api/health` `status:"migrating"`; open tabs render `MigrationInProgressBanner` from the health poll. Desktop publishes progress via `DesktopRuntimeStatus.migration` → IPC → `DesktopLaunchGate`, which shows the label and suspends its 30s timeout while progress advances.
