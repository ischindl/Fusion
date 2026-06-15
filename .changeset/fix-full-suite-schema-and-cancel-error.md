---
"@runfusion/fusion": patch
---

Fix two post-merge Full Suite test failures. Sync the roadmap store's schema-version assertion to core's `SCHEMA_VERSION` (116 → 117). Stop `useCeSessions` background refreshes (poll fallback and push events) from clearing an error a `cancel`/`remove` just surfaced — an in-flight session kept the poll running, which silently erased the action error before the user could see it.
