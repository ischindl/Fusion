---
category: reliability
module: packages/engine/src/tool-store-errors.ts
tags: [dependency-cycle, tool-boundary, agent-turn, planning-lane, refusal-shapes, RUFU-552]
problem_type: reliability
applies_when: adding or editing any tool that writes task dependencies, or when a card parks as a planning failure while its dependency list reads empty
---

# A dependency-cycle refusal must be a tool result, never an exception through the tool boundary

## Symptom

Measured fleet-wide on 2026-10-04: 40 rows of `task:dependency-cycle-rejected`, every single one
`source=updateTask` (stash 28, saneca 6, ds_eclipse_plugins 3, lpp 2, RunFusion 1). SANE-480 took five
rejections between 19:59 and 23:05 on 2026-10-03, and the third one tripped
`PLANNING_FAILED_EXHAUSTED: specification failed 3 times … Dependency cycle detected for X: X → Y → X`.
The board showed `SANE-480.dependencies = []`.

Two things are wrong with that picture and only one of them is obvious:

- The card is parked as a **specification** failure although nothing about its specification failed. An
  agent proposed a dependency edge, the board refused the edge on the merits, and the card was punished
  with an authoring-crash label.
- The refused edge is **unrecoverable after the fact**. The guard throws before the write, so nothing was
  persisted for it, and `agent-log.jsonl` records tool *names*, never tool *arguments* — SANE-480's log has
  58 `fn_task_update` mentions and not one carries the arguments that produced the refusal.

Upstream FN-9512 (merged 2026-10-08) later deleted the `PLANNING_FAILED_EXHAUSTED:` terminal park, because a
`failed` row in the planning lane has no automatic planning claimant. The park is therefore the *historical*
shape. What survives it is subtler and was the actual residual harm: three wasted planner turns per episode,
a History line that reads as a generic `Specification failed:` crash rather than a refused board rule, and a
re-seed exit that cycles without ever charging the card's own ceiling.

## Root cause

`assertNoDependencyCycleImpl` in `packages/core/src/task-store/task-id-integrity.ts` is a **durable board
rule**. It refuses an edge that would close a cycle *before* the write and emits
`task:dependency-cycle-rejected` first. That part is correct and stayed untouched.

The defect is at the boundary above it. Every dependency-writing tool let the resulting
`DependencyCycleError` escape its own handler, so the rule arrived in an agent turn as an uncaught
exception. A rule delivered as an exception is not a refusal — the agent cannot read it, cannot correct it,
and the run dies. Three deaths in the planning lane then looked like a planner that could not produce a spec.

A second, quieter defect sat behind it: `storeWriteFailure` classifies only through `DOMAIN_PHRASE`
(`not found|does not exist|read-only$`), which **no dependency error message matches**. So even a dependency
refusal that did reach that composer would have been worded as `did not reach the task store … Retry the
call` — guidance that instructs the agent to re-send the exact edge the board just refused.

## The invariant

1. **A deterministic dependency-domain refusal is a tool result, never a throw.** The three codes
   `DEPENDENCY_CYCLE`, `SELF_SPAWNED_DEPENDENCY`, `SELF_DEFEATING_DEPENDENCY` resolve in band with
   `isError: true` and `details.code`, naming the refused edge and the cycle path.
2. **The store keeps sole authority over what closes a cycle.** No tool re-implements cycle detection, and
   no tool bisects a rejected edge set. `assertNoDependencyCycleImpl` is the one authority.
3. **Classification keys on the stable `code`, not on class identity.** `SelfSpawnedDependencyError` is
   deliberately absent from `packages/core/src/index.gate.ts`, the barrel the engine-core gate bundle
   resolves, so an `instanceof` arm over all three classes passes every local run and fails the merge gate.
   `instanceof DependencyCycleError` is accepted only as an *additional* signal, so it can widen recognition
   and never narrow it. A structurally-shaped error carrying only `code` is still a refusal.
4. **A refused half must not let the other half half-apply.** In a combined call (title rename + step
   transition + dependencies), a refused dependency means the step never transitions, and the result text
   states which halves persisted and which did not.
5. **A board-rule refusal never spends the planning cadence budget and never authors a new terminal park.**
   A residual escaped refusal is attributed and handed to the ONE existing bounded seam,
   `escalatePlanningReseed`, which charges the RUFU-768 ceiling on
   `sourceMetadata.planningReseedCycles` and parks `PLANNING_RESEED_CYCLE_EXHAUSTED:` at the limit. Terminal
   planning stays with that ceiling alone; no new prefix, no new lifecycle state, no new
   `recoveryDisposition` value.
6. **The refused edge is recorded on the card.** `agent-log.jsonl` holds tool names, not arguments, so the
   durable per-card diagnostic is a `store.logEntry` line naming the refused edge and cycle path.

## Where it is enforced

Every write that reaches the store's guard through `updateTask` (all 40 measured rows say `source=updateTask`):

| Surface | File | Behavior after the fix |
| --- | --- | --- |
| Executor `fn_task_update`, dependencies-only | `packages/engine/src/executor/create-task-update-tool.ts` | refusal; step untouched |
| Executor `fn_task_update`, step + dependencies | same file | classified **before** the step write |
| Executor `fn_task_add_dep` | `packages/engine/src/executor/task-add-dep-tool.ts` | refusal returns **before** `depAborted.add`, session dispose and step-session termination |
| `fn_task_done` blocked park | `packages/engine/src/executor/create-task-done-tool.ts` | park survives, edge degrades (see below) |
| Agent lane `fn_task_update` / `fn_task_add_dep` | `packages/engine/src/agent-tools.ts` | dependency arm ahead of the generic store-outage result |
| CLI planning lane `fn_task_update` | `packages/cli/src/extension.ts` | shares the engine composer, no duplicated classifier |
| Planning-lane consumer | `packages/engine/src/triage.ts` `specifyTask` catch ladder | attributed arm, routed through the existing seam |

The shared composer is `packages/engine/src/tool-store-errors.ts`, re-exported from
`packages/engine/src/index.ts` so the CLI consumes it instead of duplicating the classifier. One classifier,
two consumers: the tool result and the triage arm cannot disagree about which edge was refused.

## The `fn_task_done` degradation contract

An honest blocked park writes `status`, `error` and merged `blockedBy` dependencies in one call, so a cyclic
edge would otherwise destroy the block report itself. The contract is:

- The park **survives**. The write is retried once, identically, minus the `dependencies` key. One
  deterministic retry — no bisect, no local cycle detection.
- The tool text and the card log name the refused blocked-by ids, say the edge was dropped because it closes
  a cycle, and state the consequence: the card stays parked blocked, and because the durable edge is what the
  dependency-completion requeue reads, **it may need a manual retry when the blocker finishes**.
- `task:execution-blocked-parked` reports what **persisted**. After a degradation its `blockedBy` is `[]`,
  not the requested ids — the row reads as the durable edges this park recorded, and naming a refused edge
  would re-create exactly the invisible state this rule removes elsewhere. The metadata key set is
  unchanged.
- A transient store rejection keeps the existing outage behavior, including propagation: the degradation is
  reserved for a board rule, not for an unreachable database.

## Deliberately out of scope

Create-lane writers (`createTask`, `fn_task_create`, `fn_delegate_task` — the operator measured zero such
rows), dashboard HTTP/mission dependency routes (a human UI, not an agent turn), dependency-release and
requeue lifecycle, cycle-detection semantics, and `agent-log.jsonl` argument persistence. Also out: the two
inline re-seed exits in the `specifyTask` catch that write `recoveryDisposition: "escalated-reseed"` without
`planningReseedCyclePatch` — a real adjacent gap, its own task rather than a silent widening of this one.

## Verification

`packages/engine/src/__tests__/tool-dependency-refusal.test.ts`,
`executor-dependency-refusal.test.ts`, `agent-tools-dependency-refusal.test.ts`,
`triage-planning-dependency-refusal.test.ts`, and `packages/cli/src/__tests__/extension-dependency-refusal.test.ts`
assert per surface that the tool **resolves** with a refusal, that nothing half-applied, that the refused edge
reaches the card log, and that a planning-lane escape spends no `recoveryRetryCount` while charging only the
existing ceiling. The core suites `store-dependency-cycle.pg.test.ts` and
`task-dependency-mutation.pg.test.ts` pass unchanged: the store must still throw, and still write
`task:dependency-cycle-rejected`.
