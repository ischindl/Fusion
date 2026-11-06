---
"@runfusion/fusion": patch
---

summary: Auto-recover cards stuck in 'planning' after their planner dies; refusals are recorded with a reason on the card.
category: fix
dev: New self-healing sweep `reconcileAbandonedPlanningSessions` (startup + maintenance batch 2) reclaims a planning-lane card whose planner turn is provably dead: it terminates the turn through the new `TriageProcessor.releaseAbandonedPlanningClaim` seam, then writes `needs-replan` under the planning lifecycle lock. Emits `task:reconcile-abandoned-planning` and `task:reconcile-abandoned-planning-session-no-action` with a closed refusal-reason enum. No settings, no migration; the bounds are code-owned (45 min claim ceiling, 40 min planner-lane session silence).
