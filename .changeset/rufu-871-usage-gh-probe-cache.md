---
"@runfusion/fusion": patch
---

summary: Board and API latency fixed: the GitHub usage poll no longer spawns `gh auth status` on every request.
category: fix
dev: The usage route spawned its own `gh auth status` per poll; a production CPU profile measured `spawn @ (native)` at 59.9% of process CPU and a 1 KB `/api/health` answer at 2.2 s, because spawn cost lands on the shared event loop. It now calls `isGhAuthenticatedAsync()` from `@fusion/core`, the single cached single-flight gh probe (same 60 s TTL and same stdout-content verdict as the sync readers, so there is one owner of the question). Pinned by `packages/core/src/__tests__/gh-cli-async-probe.test.ts` — one child for 20 concurrent polls, zero children on a warm cache, negative verdict cached too.
