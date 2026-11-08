---
"@runfusion/fusion": patch
---

summary: Cut duplicated task-row hydration work on board list reads, so the board renders sooner.
category: performance
dev: `rowToTask` deserialized `sourceMetadata` and `prInfo` twice per row (once per output field each); the board's paged lane-resolution block hydrated every page row twice and discarded both results. Measured at 229.6 us per ~24 kB row, so one 100-card page no longer pays ~23 ms per duplicate pass. `pgRowToTaskRow`'s jsonb re-stringify is untouched — `getChangedTaskColumns` compares its output as JSON text, so removing it there is a separate, wider change.
