---
"@runfusion/fusion": patch
---

summary: Usage data is no longer fetched on every dashboard load — only while the Usage view is open.
category: performance
dev: `useUsageData` gained an `enabled` gate; `autoRefresh` only ever stopped the 30s poll, while the initial fetch fired on mount because `UsageIndicator` is mounted with `isOpen={false}`. `fetchUsageData` now takes an `AbortSignal` so closing the view cancels the request (it measured 61-82s on a production board and held two of four client read slots per tab).
