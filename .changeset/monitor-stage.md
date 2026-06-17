---
"@runfusion/fusion": minor
---

Add the **Monitor stage** (U13) — deployment and incident tracking that closes the SDLC loop.

- **Schema** — new `deployments` and `incidents` SQLite tables (`packages/core/src/db.ts`, `SCHEMA_VERSION` 119 → 120, migration added in the same change; fingerprint auto-covers SCHEMA_SQL tables).
- **Metrics** — real MTTR (incident-open → resolved) plus deploy/incident counts in `activity-analytics`, replacing the prior unavailable seam.
- **Ingestion** — `POST /api/monitor/{deployments,incidents}` self-authenticate via a shared ingest secret (constant-time bearer check, fail-closed) with SSRF-untrusted payload links; `GET /api/monitor/metrics` exposes the aggregates.
- **Loop closure** — a `monitor` workflow trait can auto-open a single fix task on a regression signal, guarded by `groupingKey` grouping, a threshold/sustained gate, cooldown absorption, a per-window circuit breaker, and a self-loop guard.
