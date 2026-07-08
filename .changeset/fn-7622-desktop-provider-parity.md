---
"@runfusion/fusion": patch
---

summary: Fix desktop app showing a truncated provider/model list vs. the web build.
category: fix
dev: The Electron desktop app's in-process dashboard server (local-runtime.ts, local-server.ts) now routes through a shared `@fusion/engine` `seedDashboardProviders()` helper that mirrors the CLI serve/dashboard/daemon startup sequence (built-in Zai/API-key provider seeding, `wrapAuthStorageWithApiKeyProviders`, `registerCustomProviders`). `provider-auth.ts` and `custom-provider-registry.ts` moved from `@fusion/cli` into `@fusion/engine`; the CLI files are now re-export shims with unchanged observable behavior.
