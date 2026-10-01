---
"@runfusion/fusion": patch
---

summary: Planning failures now name the resource that failed instead of blaming principal routing.
category: fix
dev: A 5-second planning lifecycle lock timeout surfaced as `workflow-principal-fence-unavailable:triage`, which reads as a routing defect. The wrapper keeps its greppable prefix and now appends the underlying cause, so the existing `[plan] planning failed:` line names the real resource. `cause` is still attached. Recovery (a bounded reseed for planning-lane nodes) stays on the separate card.
