---
"@runfusion/fusion": patch
---

Respect per-task auto-merge overrides when the global auto-merge setting is off. Tasks with auto-merge explicitly enabled now get enqueued for merge and covered by the in-review self-healing sweeps (stall surfacing, merged-task finalization, retry recovery) even when the project-level setting is disabled; tasks without an explicit override keep the PR-based/manual review flow untouched.
