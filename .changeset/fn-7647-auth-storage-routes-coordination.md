---
"@runfusion/fusion": patch
---

summary: Route node settings-sync and mesh credential writes through the coordinated auth store to prevent concurrent clobbers.
category: fix
dev: register-settings-sync-routes.ts, register-settings-sync-inbound-routes.ts, and register-mesh-routes.ts now persist received credentials via @fusion/engine createFusionAuthStorage() instead of raw AuthStorage.create(getFusionAuthPath()), sharing FN-7646's reload-before-persist + per-provider locked-merge path over ~/.fusion/agent/auth.json. Adds route-level regression coverage.
