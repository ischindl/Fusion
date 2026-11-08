---
"@runfusion/fusion": minor
---

summary: Optionally lower agent-lane CPU priority with FUSION_AGENT_CPU_NICENESS; off by default, never demotes the dashboard.
category: feature
dev: Opt-in only — unset means every lane spawns exactly as before. Set `FUSION_AGENT_CPU_NICENESS` to an integer `0`..`19` in the dashboard/engine service environment and restart; values outside that range (including every negative) are refused as invalid and leave the mechanism inert. The demotion is one in-process `os.setPriority` against each freshly-spawned lane child, so it covers the child's own subprocesses by inheritance and adds no `nice`/`renice` subprocess. Only the automatic lanes (`execute`, `planning`, `validator`, `ce`) are targeted: an interactive chat session and the process hosting the dashboard are never demoted. Documented in `docs/settings-reference.md` → Agent CPU priority environment variable.
