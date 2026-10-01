---
"@runfusion/fusion": minor
---

summary: Comments and steering now reach one named agent, and say plainly when nobody can receive them.
category: fix
dev: New core seam `deliverTaskComment` (host `deliverTaskCommentFromStore`) resolves one recipient (assignee → column binding → workflow binding → triage pool → executor pool), writes an idempotent inbox row keyed `task-comment:<taskId>:<commentId>`, and reports the outcome via `describeTaskCommentDelivery`. `fn task comment`/`fn task steer` and Planner Chat steering print that sentence; `fn_task_show` gained `commentIds` (max 20) to read comment and steering bodies by id; wake deltas now advertise only ids whose body the card holds. New run-audit types `task:comment-delivery` and `task:comment-delivery-unowned` (ids/counts/enums only).
