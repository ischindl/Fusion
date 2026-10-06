---
"@runfusion/fusion": patch
---

summary: Dashboard no longer drowns in duplicate workflow-selection queries, so task views stop stalling under load.
category: fix
dev: `resolveWorkflowIrForTask` callers that pass no `selectionCache` now coalesce concurrent reads for the same task onto one query and share a per-store concurrency bound (16). Coalescing is per-query-lifetime, so the documented live-per-call behavior is unchanged.
