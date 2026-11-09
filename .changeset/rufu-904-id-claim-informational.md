---
"@runfusion/fusion": patch
---

summary: Task IDs shared with another project are now reported as informational, not as a blocking integrity anomaly.
category: fix
dev: `TaskIdIntegrityReport.status` stays the closed `"ok" | "anomaly"` partition and now reflects same-project classes only; cross-project pairs moved to the additive `crossProjectDuplicates` field (`prefix`, `affectedIds`, `ownerProjectIds`, `note`), which `/api/health` publishes under `taskIdIntegrity`. The `cross_project_duplicate_id` anomaly kind and its banner label are removed. Reason: task ids are unique per project — `(project_id, id)` is the task key and runtime reads are row-level-security bound — while RUFU-320 asserted claims database-wide over `(prefix, sequence)`, so every pre-existing per-project mint (measured: 74 ids, 2026-07-04..2026-09-27) tripped the anomaly forever and its banner told operators to rename or archive live cards in unrelated projects. No data was migrated or renumbered.
