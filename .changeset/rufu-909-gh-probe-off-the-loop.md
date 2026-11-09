---
"@runfusion/fusion": patch
---

summary: Dashboard settings and auth-status reads no longer stall the server while probing GitHub CLI auth.
category: performance
dev: Both routes called the sync `isGhAvailable()`/`isGhAuthenticated()` pair, an `execFileSync` of `gh auth status` (a network round trip) that blocks the event loop for every in-flight request; they now await `isGhAvailableAsync()`/`isGhAuthenticatedAsync()`, which share the same TTL cache and single-flight concurrent polls into one spawn. `GET /api/settings` also skips the probe entirely when a server GitHub token is configured, since the answer cannot change the response.
