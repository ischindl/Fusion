---
"@runfusion/fusion": minor
---

Auto-recover from post-merge audit blocks: programmatic per-file survival check, optional AI-driven restoration pass, and an audit-bounce loop (parallel to conflict bounces) before parking a task as failed. Governed by the new `mergeAuditAutoRecovery` setting (default: `ai-assisted`).
