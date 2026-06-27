---
"@runfusion/fusion": patch
---

summary: Preserve override column-agent models during task execution.
category: fix
dev: Engine override column-agent sessions now ignore task-level model fields during initial session creation and mid-flight re-resolution when the column agent governs.
