---
"@runfusion/fusion": patch
---

summary: Implementation cards can no longer start or strand on lanes that cannot run them; ineligible lanes decline by name.
category: fix
dev: Heartbeat wakes revalidate the bind verdict against workflow-resolved implementation lanes and emit `task:lane-capability-declined`; new self-healing sweep `reconcile-lane-capability-misbind` re-binds stranded cards via `updateTask({ assignedAgentId })` (progress preserved) or freezes them once with the `lane-capability-mismatch` external block.
