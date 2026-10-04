---
"@runfusion/fusion": patch
---

summary: Repair a review-waiver receipt table whose task key blocked merging two projects into one.
category: fix
dev: Migration 0089's composite task FK lost `ON UPDATE CASCADE` when the fork re-issued upstream's 0086. The schema applier now treats a non-cascading receipt FK as drift and re-applies the idempotent repair, so `ProjectPartitionRekeyError (unsafe-fk-update-graph)` no longer refuses the upgrade. The receipt drift probe also no longer reports a table-less database as "missing" — it was executing migration SQL on databases that have no product relations.
