---
"@runfusion/fusion": patch
---

summary: Waiting cards stop re-stamping "updated" and re-broadcast a change every scheduler pass.
category: fix
dev: `transitionQueuedEpisode` (packages/core/src/task-store/audit-ops.ts) now gates the `tasks` row write, the `task.json` mirror rewrite and the `task:updated` event on a difference in the four fields it writes (`status`, `blockedBy`, `overlapBlockedBy`, queued log episode signature, compared with `?? null` normalization). The in-transaction `project.task_overlap_waits` observation still runs on every pass, the advisory lock is held for the whole comparison, and the `{ appended, task }` return shape is unchanged. No migration and no data change.
FNXC:QueuedTaskLogging 2026-11-10-17:56: a scheduler pass that found the same blocker on every waiting card used to rewrite each card's row, mirror and event; the queue edge guard now extends to the writer side, so an unchanged queued episode writes nothing at all.
FNXC:TaskLogSideTable 2026-11-10-17:56: the side-table dedupe probe keeps its job of skipping the entry INSERT; the writer gate skips the row write, the mirror write and the event for the same unchanged episode.
