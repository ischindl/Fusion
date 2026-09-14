---
"@runfusion/fusion": patch
---

summary: fn_task_logs_read now honors an explicit target task, refuses unsafe ids, and names the card it served.
category: fix
dev: Task-bound log reads accept `task_id` (or the pi/CLI `id` alias) to read another card's log instead of silently returning the bound card's; omitting both keeps the bound-card default. Conflicting spellings and ids that are not one safe path segment are refused before any directory join (the dashboard log route answers 400 instead of 500). Every payload header now reads `Agent log (<taskId>): N/M entries`.
