---
"@runfusion/fusion": minor
---

Add workflow interpreter dual-observe parity instrumentation surfaces for phased rollout.

- Export pure workflow parity comparison helpers from `@fusion/core` (`compareWorkflowRunObservations`, `compareWorkflowRunAudits`) with structured drift reports.
- Add `observeWorkflowParity` in the engine as a default-OFF, fail-soft observer gated by `experimentalFeatures.workflowInterpreterDualObserve`.
- Emit run-audit parity events (`workflow:parity-observed`, `workflow:parity-drift`) for shadow agreement/drift visibility without changing authoritative legacy execution.
