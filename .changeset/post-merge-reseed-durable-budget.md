---
"@runfusion/fusion": patch
---

summary: Post-merge verification gates now stop re-seeding after three attempts, as the limit always claimed.
category: fix
dev: `countReseedAttempts` read the caller's `task.log` projection, which board reads answer as `log: []`, so `MAX_POST_MERGE_GATE_RESEED_ATTEMPTS` never fired on the two self-healing lanes that pass slim rows (`self-healing.ts:3827`, `:3968`). It now reads the durable row via `store.getTask`, fails closed on a rejected read, and the log line reports the real attempt number. Mirrors RUFU-452 on the pre-merge counter.
