---
"@runfusion/fusion": patch
---

summary: Hold-release sweep logs name the project and split evaluate time into named sub-phase buckets.
category: performance
dev: The sweep summary line gains `project=<key>` and disjoint buckets `(release-config, dependency, readiness, issue-release, prompt, unplanned, workitem, handoff, slot, unattributed)` whose net semantics reconcile to `evaluate`; the `reads(...)` tally gains `prompts`, `workItems`, `evalSettings`. A per-scheduler-pass observation record memoises PROMPT.md, work items, settings, handoff markers, and dependency verdicts per task id for the pass only (never cross-pass, never truncated verdicts), so multi-consumer cards read once per pass. See `docs/architecture.md` "Bounded hold-release sweeps".
