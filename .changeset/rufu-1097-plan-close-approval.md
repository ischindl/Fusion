---
"@runfusion/fusion": patch
---

summary: A card Plan Review closed as a no-op can now leave review instead of needing an operator voucher.
category: fix
dev: The required pre-merge plan gate (`evaluatePreMergeApprovals`) and the complete-column move guard
(`classifyPreMergeGateEvidence`) now recognise one accepted terminal Plan Review close — the shared
`isTerminalPlanReviewCloseRow` identity — so the may-land doors stop refusing a row every other authority
already accepts. `isPlanReviewSatisfied` (may-execute) and `isGateReleased` (may-resume-past) are unchanged:
a close still releases nothing forward. `task:reconcile-absent-branch-unproven` gained the fixed-enum keys
`gateId`, `gateState`, `gateStatus` and `gateVerdict`, present only for a gate-named refusal, and a refused
`fn task reconcile` now names the gate and its carrier in the CLI sentence and one History line. Nothing was
removed: the History marker that previously fired only for the merged-lane refusal now also fires for an
approval refusal, so the test that asserted that exclusivity now asserts the widening instead.
