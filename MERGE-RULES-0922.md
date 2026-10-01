# Merge conflict rules — sync-0922 (upstream ee688b4c2b into production line bec4c5e701)

## HARD MECHANICS (non-negotiable)
- Resolve conflicts by LINE-LEVEL slicing of markers (`^<{7}`, `^={7}`, `^\|{7}`, `^>{7}`). NEVER fixed char offsets — fragment tails (`igin/main`, `04d3055e (...)`) compiles as code and broke CI three times.
- After every file edit, verify: `grep -nE "^(<<<<<<<|=======|>>>>>>>|\|{7})" <file>` is empty AND no orphan marker-tail fragments (lines starting mid-word like `04d3055e ` or fragments of commit subjects that were marker tails).
- `git add <file>` only after the above passes. Do not run `git commit`.

## SEMANTIC RULES (our line invariants)
1. OURS = production line (gitlab main bec4c5e701). THEIRS = canonical origin/main.
2. Both sides usually ADD distinct features touching the same region. Default = UNION: keep our feature AND theirs, preserving both sides' FNXC comments, calls, and tests. A hunk where one side silently wins is a defect.
3. Our line retired task ARCHIVING (FN-9187): drop THEIRS archive call sites / archive snapshot sources (keep the pure-mailbox/notification parts).
4. Run-audit: all best-effort emitters must stay on `emitBoundedRunAudit` (engine: packages/engine/src/util/emit-bounded-run-audit.ts). If upstream added a new emitter with a direct `store.recordRunAuditEvent`, keep its logic but route the emit through the bounded seam, mirroring a neighboring call site.
5. Lifecycle containment (FN-207/FN-217): no automatic move may target intake or move backward out of terminal lanes except the explicitly named revision paths. If upstream recovery code introduces moves, keep them in current-role repair unless it is the named merge-boundary evidence recovery (FN-9345) which may requeue per ITS OWN gating.
6. Wedge/notifications: OURS carries RUFU-180 stallReason codes (`merge-blocker`, `pre-merge-gate-pending`, `held-human-review`) via NotificationService as sole dispatch authority with settle window + per-reason claim + 6h cooldown. THEIRS FN-9346 "genuine execution blockers" is additive: reconcile so genuine blockers are surfaced through the SAME NotificationService path, keeping our cooldown/dedup semantics.
7. FN-9243 (unrun pre-merge gate reroute, taskId/nodeId/workflowStepId/reason/source/missingGateCount) must remain functional; upstream FN-9353 gate-recovery fencing is additive — union both guards.
8. Keep every side's new tests. Never delete a test to silence a conflict.
9. FNXC comments: keep both sides; new resolution notes (if needed) use `FNXC:<Area> yyyy-mm-dd-hh:mm` with date -u.
10. Prompt/docs prose conflicts: keep both entries; keep OURS where OURS is a superset wording of THEIRS.

## DO NOT
- Do not run pnpm install, builds, or tests (orchestrator verifies centrally).
- Do not commit, push, or amend.
- Do not touch files outside your assigned list.
