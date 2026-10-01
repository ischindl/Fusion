---
"@runfusion/fusion": patch
---

summary: A workspace card marked "No commits expected" is no longer parked as failed for having no commits.
category: fix
dev: The `task:reconcile-workspace-partial-land` sweep now emits the deduped `-no-action` reason `no-commits-expected` instead of the FORK-A / starvation `failed` park, clears a park an earlier build wrote in place, and `getTaskMergeBlocker` (plus the review-lane stall classifiers that read it) no longer refuses such a card, so the merge door, the stall badge, and a manual drag to the completion lane all agree. Cards that owe commits keep the original park.
