---
"@runfusion/fusion": minor
---

summary: Remove node settings sync on the PostgreSQL backend — nodes share the database, so settings are already shared.
category: feature
dev: In backend mode the mesh sync route ignores inbound settings payloads and returns none; PeerExchangeService force-disables settings gossip; /nodes/:id/settings (fetch/push/pull/sync-status) and /settings/sync-receive answer 409 code settings-sync-disabled-postgres; the NodesView sync hook treats that 409 as a quiet steady state (no chips, no polling). Provider auth sync (/nodes/:id/auth/sync, auth-receive/auth-export) is intentionally kept — auth material is per-machine file state, not database state.
