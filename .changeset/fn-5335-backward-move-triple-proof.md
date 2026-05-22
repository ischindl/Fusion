---
"@runfusion/fusion": patch
---

Self-healing: gate every backward-moving recovery stage on triple proof (dead session + unusable worktree + no recent executor activity). Stages that cannot satisfy the predicate are downgraded to observation-only, emitting task:<stage>-no-action audit events instead of lifecycle moves. Authoritative per-stage disposition lives in docs/self-healing-backward-move-audit.md. Companion to FN-5337.
