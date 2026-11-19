---
"@runfusion/fusion": patch
---

summary: A crashed self-healing recovery pass is now a queryable record instead of only a console line.
category: fix
dev: Adds the `sweep:pass-failure` / `sweep:candidate-failure` run-audit family, authored by `emitSweepFailureAudit` (`packages/engine/src/self-healing/sweep-failure-audit.ts`) over the FN-9175 bounded seam and keyed on the sweep METHOD name so every self-healing pass reports the same fact through one vocabulary. A pass-level abort emits one `sweep:pass-failure` (sweep, `outcome:"aborted"`, `candidateFailureCount`; no `taskId`, because a pass spans every card) at most once per 6-hour window, and each card whose own repair threw emits one `sweep:candidate-failure` (sweep, `taskId`, closed `stage`) once per card per window — dedupe is RUFU-318's bucket with the bucket inside the key, claimed prune-then-check. Metadata is a closed set that structurally cannot receive the caught error, so exception text, stacks, and paths stay in the engine log. Both sweeps' return values, admission conditions, and card writes are unchanged (the instrumentation is insertion-only); the two events sit outside the curated delivery-pipeline catalogue and are documented as prose in `docs/run-audit.md`.
