---
"@runfusion/fusion": patch
---

summary: A `--no-engine` dashboard beside a running engine no longer claims the AI engine is not running.
category: fix
dev: `/api/health` and `/api/engine/status` now read manager-free evidence (the engine singleton's loopback presence plus running agents in already-open stores) before answering; `reason:"dashboard-only"` now means no manager AND no evidence, while a proven-live project reports `externally-owned` or `live-without-handle` with `connected:true`. No engine is ever started to answer a status or health poll.
