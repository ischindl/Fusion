---
"@runfusion/fusion": patch
---

summary: A finished, approved card with no branch changes finalizes again even if a skipped step's title merely mentions testing.
category: fix
dev: Step-role classification moved to `resolveStepRole` in `@fusion/core` (`tasks/step-role.ts`): an anchored role label at the head of the step name, or structural `step.remediation` provenance. The zero-diff finalize guard and `resolveTrailingVerificationStepIndex` no longer run an unanchored `/test|verif|qa|review/i` over planner-written titles, so prose implementation steps such as "...deliberate and tested" are never in the blocking set. A genuinely skipped verification or remediation step still refuses finalization, and all refusal sentences are byte-identical.
