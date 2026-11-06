---
title: "A dead planner turn keeps its claim, so a reclaim that only writes a signal recovers nothing"
date: 2026-11-06
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: self-healing / triage planning admission
tags:
  - self-healing
  - planning
  - triage
  - liveness
  - in-process-state
  - reclaim
symptoms:
  - "a planning-lane card sits at status=planning on a live engine with no error and no pause"
  - "its agent-log is frozen (last row a completed tool_result) while its bound planner agent keeps planning its siblings"
  - "no planning-recovery sweep names it: no planAdmissionStall episode, no principal hold, no step-result rows"
  - "the card is freed only by an engine restart"
  - "writing needs-replan by hand changes nothing observable"
root_cause: "three owners each waited on a different one of them, and the thing all three waited on was in-process planner bookkeeping (processing + activeSessions) that no liveness probe can observe as alive"
resolution_type: product-fix
applies_when: "diagnosing a card stuck in planning, adding a planning-recovery sweep, or touching triage's claim/eviction seams"
---

## The shape (RUFU-467 / RUFU-470)

A card in the planner lane with `status:"planning"`, no `error`, no pause, no step-result rows, branch and
worktree retained, and an agent-log whose last row is a **completed** `tool_result` — silence after a
completed tool call is an abandoned turn, not a thinking gap. The bound planner agent is healthy: its
siblings bound to the same agent had log rows seconds old. RUFU-467 held this shape for 73 minutes, and was
released only when its own hung promise chain resumed spontaneously. Every existing sweep saw the card and
declined it for a reason that was, locally, correct.

## Why each existing owner declined

1. **Triage's poll sweep** (`sweepStalePlanningStatuses`) clears aged `planning` cards to null within one
   poll — but skips any card it currently holds a `processing` claim for. A dead turn leaves that claim.
2. **Triage's re-discovery** admits a `needs-replan` card only when `processing` **and**
   `hasLivePlanningWork(taskId)` are both clear. The retained `activeSessions` entry keeps the second one
   true.
3. **The in-process eviction** (`evictStaleProcessing`) is the only thing that clears those maps — and it
   refuses whenever `hasLivePlanningWork` is true, deliberately: that eviction never touches a task with
   finalize or subagent work in flight, and it never drops a possibly-live handle.

So the population this sweep can act on is precisely the population the other owners suppress. The card is
not unowned because nobody looks; it is unowned because the blocker is **in-process state that no liveness
probe can see**. A planner registers no active-session path, no executing lock, and no executor-active flag
(FN-299), so the canonical FN-8492 triple — the repo's general "is this task live?" test — is blind to the
planner's own session by construction.

## The trap that made the first two revisions wrong

**A reclaim that only writes `needs-replan` is decorative.** The retained pin is exactly what makes the
consumer refuse to re-consume the card, so the signal is unobservable — the card keeps `status:"planning"`
for the whole next poll. Any "recovery" whose whole effect is a status write must be tested against the
rung that is supposed to eat it, not against the write itself.

**And the reverse trap: releasing without terminating is worse.** `activeSessions` holds a real session
handle. Forgetting the entry orphans a possibly still-streaming planner and lets a second planner start on
the same card — the FN-1312 double-planner failure. So the repair is strictly ordered:

terminate (mark, untrack, abort, await the abort settling inside a bound, dispose)
→ release (claim, claim clock, session maps, coordinator admission, pre-held slot)
→ signal (`needs-replan`, after a settle window, under the planning lifecycle lock)

If the abort cannot be proven to have settled, **nothing is cleared and nothing is written** — the refusal
is the outcome. The settle window matters because the turn being aborted is the same turn whose re-drive
path re-claims the card: writing the status before its abort settles races a writer that will overwrite it.

## The two facts that make the population safe

The sweep requires the card to be **pinned** — a claim whose own start stamp is older than a code-owned
ceiling (45 min), and a planner-lane agent-log silent past its own bound (40 min). Without pinning, the
population becomes "every card planning longer than a poll interval", which is healthy work. Both facts are
measured from the record's own clock (`processingSince`, the agent-log row timestamp), never
`task.updatedAt`, which every writer on the card bumps and which had already advanced 12 minutes *after* the
planner's last session row on the broken card.

And the canonical triple still refuses absolutely, as do `finalizing` and non-empty
`activeSubagentSessions`: those legs hold authority over the card and are not this seam's to terminate.

## Placement and vocabulary gotchas

- **Batch 2, not batch 1.** Maintenance batch 1 is documented in-file as "housekeeping (safe under pause:
  filesystem/db cleanup only)"; batch 2 is "Task recovery". A sweep that writes lifecycle status belongs in
  batch 2, beside `reconcile-principal-held-planning`, `reconcile-planning-fence-park`, and
  `reconcile-planning-admission-stall`.
- **Resolve the planner lane by trait, not by column literal.** The sweep reads its own column through
  `resolveWorkflowIrForTask`, then `resolveColumnFlags(column)` (`packages/core/src/workflows/trait-registry.ts`)
  and admits the card only on `flags.intake || flags.hold` — the same pair triage discovers from. A board
  whose planning lane is renamed, merged, or split into a separate hold column is invisible to a
  `column === "todo"` test, and that blindness is its own recorded failure mode.
- **`needs-replan` must be written after the claim is released**, or the next triage poll refuses it and the
  card silently returns to `status:"planning"`. The consumability test drives the real
  `discoverReadyPlanningTasks` before and after the reclaim for exactly this reason.
- **Refusals are an enum, not prose** (`live-session`, `abort-unproven`, `finalize-in-flight`,
  `triage-owned-unpinned`, `continuation-active`, `paused`, `human-review-deferred`, `premise-held`,
  `race-lost`), so one query answers "why is this card still planning?" for the whole board.

## Verification note

The healthy twin is the test that keeps any of this honest: the same card with the same code path is silent
below both bounds and reclaims past both. A sweep that reclaims unconditionally passes every other test in
the file and would double-plan every healthy card in the system.
