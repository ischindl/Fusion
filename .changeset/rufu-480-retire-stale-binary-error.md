---
"@runfusion/fusion": patch
---

summary: Booting against a database a newer build migrated now logs one clear operator warning.
category: fix
dev: Removes the never-constructed `StaleBinarySchemaError` export from `@fusion/core` (main, postgres, and gate barrels) and tombstones it; the warn-only stale-binary guard now emits a single line carrying the stable token `stale-binary-schema`, both schema versions, and the operator-only remedy, so the condition is greppable and is never mistaken for a card failure.
