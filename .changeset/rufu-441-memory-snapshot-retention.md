---
"@runfusion/fusion": patch
---

summary: Memory maintenance now prunes its own snapshots to the configured retention, stopping unbounded backup-folder growth.
category: fix
dev: `runLongTermMemoryMaintenance` calls `MemoryBackupManager.cleanupOldBackups()` once per pass after taking its own snapshot, mirroring the create-then-cleanup pairing `fn memory-backup --create` already used. Eviction is best-effort — it can neither fail the consolidation whose snapshot it was asked to trim nor change the pass's audit row — runs only on a pass that actually took a snapshot, and a configured `memoryBackupRetention` below 1 is floored to 1 on this path so a sweep can never delete the backup that authorized its own rewrite. Snapshot-before-write ordering and its independence from `memoryBackupEnabled` are unchanged.
