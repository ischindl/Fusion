---
"@runfusion/fusion": patch
---

summary: Opening Settings no longer waits on a legacy auto-merge stamp sweep; it now scans on demand.
category: fix
dev: MergeSection dropped its mount-time GET /api/maintenance/legacy-automerge-stamps (measured 8.8-24.7s per project, returning 0 candidates) in favour of a session cache keyed by project plus an explicit "Scan now" control. The apply flow is unchanged and still re-scans afterwards.
