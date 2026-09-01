---
"@runfusion/fusion": minor
---

summary: Tasks report a canonical `stallReason` (code + sentence) on every board/API read whenever they are not moving.
category: feature
dev: `stallReason` is derived at read time (never persisted) via `deriveTaskStallReason` in `@fusion/core`, hydrated on `getTask`, `listTasks`, `listTasksModifiedSince`, and `searchTasks` with pinned parity across all four. Codes: `paused | blocked-by | dependency-blocked | merge-blocker | held-human-review | pre-merge-gate-pending | suppressed | terminal-conflict`. Diagnostic-only — not an auto-completion signal and never a merge gate.
