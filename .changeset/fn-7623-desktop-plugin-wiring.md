---
"@runfusion/fusion": patch
---

summary: Fix desktop app plugin install and Browse registry (plugin subsystem now wired into the embedded server).
category: fix
dev: local-runtime.ts / local-server.ts now build a PluginStore + PluginLoader and pass pluginStore/pluginLoader/pluginRunner into createServer, mirroring the CLI dashboard command (FN-7623, issue #1937). Plugin subsystem init is fail-soft — a broken plugin (e.g. corrupt manifest) logs/traces via strace(...) but no longer blocks embedded dashboard startup.
