---
"@runfusion/fusion": patch
---

Throttle `oauth-token-expired` notifications to at most once per provider every 12 hours, even when the credential `expires` timestamp changes across refreshes/replacements.
