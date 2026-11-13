---
"@runfusion/fusion": patch
---

summary: Re-login banner and expiry alerts now fire only for providers a model lane actually resolves through.
category: fix
dev: Adds a per-provider `laneReferenced` boolean to `GET /api/auth/status`, gates the OAuth re-login banner and the engine `oauth-token-expired` notification on it (fail-open on any scan error), and surfaces a Remove control for an expired single-instance OAuth provider in Settings -> Authentication.
