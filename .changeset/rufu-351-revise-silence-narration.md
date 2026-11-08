---
"@runfusion/fusion": patch
---

summary: A review fix round that was refused now says why on the card instead of staying silent.
category: fix
dev: New run-audit event `task:review-remediation-declined` (ids/counts/fixed enums only: `taskId`, `column`, `code`, `gate`, `scannedCount`) plus one History line per narrated decline. Self-healing's pre-merge revival filter is now a decline classifier; the refusal sentences moved to `packages/engine/src/executor/review-remediation-refusal-text.ts`. A class its owning surface already narrates (convergence-ladder escalation, verdict-less re-seed pre-pass, the graph-terminal "remediation was not scheduled" sentence, pause, terminal status, live execution) stays engine-log-only. No column, status, pause or stall field is written and no lease is released. Documented in `docs/run-audit.md` (Declined review remediation narration), `docs/architecture.md` and `AGENTS.md`. Forensics outcome: the motivating card was already narrated durably by the graph-terminal leg, so that leg ships a no-regression guard, not a new sentence; the remaining board-surface gap is recorded as follow-up work.
