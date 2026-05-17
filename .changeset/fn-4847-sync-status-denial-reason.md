---
"@runfusion/fusion": patch
---

GET /api/nodes/:id/settings/sync-status now includes an `actionableDenialReason` field
("missing-remote-api-key" | "auth-failed" | "unreachable" | "unknown" | null) so
dashboards can surface why a remote probe failed instead of silently reporting
`remoteReachable: false` with no diagnosis.
