---
"@runfusion/fusion": patch
---

summary: Retry transient OAuth token-rotation errors so in-flight agent calls survive rotation without failing the task.
category: fix
dev: withRateLimitRetry now retries transient auth errors (authentication_error, invalid credentials, token_expired) on a separate ~5s flat-delay budget that does not consume rate-limit attempts. OAuth scope/permission failures are explicitly excluded (operator must re-authorize) so they surface immediately instead of retrying pointlessly.
