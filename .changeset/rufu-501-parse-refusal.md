---
"@runfusion/fusion": patch
---

summary: A plan whose step dependencies name a step that does not exist now goes back for a repair instead of failing the task.
category: fix
dev: `parse-steps` returns `invalid-plan-dependency:<diagnostic>` for a writer-facing dependency refusal, which the graph failure handler routes to `needs-replan`; `parse-error` now means infrastructure only. Refusal messages name the annotation positions the parser reads, the plan's authored heading labels, their numbering frame, and where `0` is valid. Authoring a `failure`-class edge into a terminal column node now warns at save/validate.
