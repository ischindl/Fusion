---
"@runfusion/fusion": patch
---

summary: `fusion_domain_projects_total` now counts registered projects instead of projects with an already-open store.
category: fix
dev: The three project gauges are counted over one population — the project registry (`central.projects`) — read on each 5 s domain tick through `createRegisteredProjectIdReader`, concurrently with the per-store fan-out and bounded by `REGISTRY_CENSUS_BOUND_MS` (2 s, at most one read in flight). Before this the population was the set of already-open stores, which warms lazily: live the gauge read 3 at boot and 11 three minutes later while 25 projects were registered, with the per-project agent gauges growing in step. `projects_active` is a registered project whose already-open store reports ≥1 agent; `projects_idle` is `total - active`, so a cold registered project counts idle and the help text says so. A registered project with no open store contributes no `fusion_domain_project_running_agents` series — absence is stated in that family's help text, never rendered as a measured zero. With no central registry, or a census that throws or misses its bound, the population degrades to the served-store set (the previous behaviour) and a failed census keeps the last registry count rather than collapsing to store warmth.
