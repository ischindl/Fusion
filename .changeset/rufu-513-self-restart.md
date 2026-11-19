---
"@runfusion/fusion": minor
---

summary: Restart the dashboard from the System panel without killing the process or freeing port 4040.
category: feature
dev: A launch with no supervising parent now re-spawns itself at its own exit with the same argv, `execArgv`, and environment, so `NODE_OPTIONS` and `FUSION_PG_POOL_MAX` survive a restart, and the replacement retries the original port instead of silently rebinding. The supervising parent no longer outlives a child whose service is gone: an operator stop exits it with `128 + signum` and a child that never served `GET /api/health` exits it with `1`, so `pnpm dev` and `fn dashboard` now finish with a non-zero status after a normal stop. `--supervise`/`--no-supervise` stay compatibility flags; `restartSupported` is what the route, `/system/info`, Settings, the update banner, Command Center, and the auto-update lane all read.
