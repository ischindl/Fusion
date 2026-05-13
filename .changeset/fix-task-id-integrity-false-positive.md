---
"@fusion/core": patch
"@fusion/dashboard": patch
---

Remove false-positive `committed_reservation_for_existing_id` task-ID-integrity check. The rule flagged every committed reservation that pointed at an existing task, but that's the happy-path steady state — a reservation transitions to `committed` immediately after the task row is inserted, so it's always expected to map to an existing ID. The banner was firing on every healthy node with task history.
