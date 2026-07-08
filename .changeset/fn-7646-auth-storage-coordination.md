---
"@runfusion/fusion": patch
---

summary: Fix provider API keys being wiped when the desktop and CLI apps share credentials on one machine.
category: fix
dev: createFusionAuthStorage() now reloads before persisting a refreshed OAuth credential so a concurrent Fusion process's newer login is not overwritten; adds cross-process regression coverage over ~/.fusion/agent/auth.json. Relies on the pi-coding-agent FileAuthStorageBackend locked per-provider merge (floor >=0.80.x).
