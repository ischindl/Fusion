---
title: "A lane full of failed cards reported itself full and refused every ready card"
date: 2026-10-10
problem_type: reliability
module: "@fusion/core"
component: column-capacity
tags:
  - capacity
  - wip
  - column-boundary
  - hold-release
  - workflow-suspend
  - failed-task
  - rufu-362
  - saneca
symptoms:
  - "hundreds of `task:workflow-run-suspended` rows with `reason: \"capacity\"` inside half an hour and zero board moves"
  - "`capacity-exhausted` refusal on a `todo -> in-progress` move while `runningAgentCount` reports 0 live agents"
  - "every ready card in the planning lane held with `heldReason: \"downstream-full\"`"
  - "the workflow switcher shows the WIP lane at its limit while nothing is executing"
root_cause: "the in-transaction column WIP counters AND the engine sweep's own mirror each counted every non-deleted row in the lane, so dead `status:\"failed\"` parks occupied slots; only the agent-capacity predicate `isRunningAgentTask` excluded them, per FN-8704, which is why `runningAgentCount` read 0 live agents while every column counter reported the lane full"
resolution_type: bugfix
---

## What an operator sees

Nothing is running, and nothing can start. The card sitting in `todo` is refused `capacity-exhausted`;
the whole planning lane is held `downstream-full`; the workflow switcher says the In Progress lane is at
its limit. A `run_audit` query for the last 30 minutes shows only one interesting row type, repeated
hundreds of times — a graph suspend with `waitReason: "capacity"`.

## Mechanism

Three surfaces count "how full is this lane". Pre-fix, two of them agreed with each other and the third dissented — and the dissenter was the only one that was right:

| Surface | Failed park (`status:"failed"`) |
| --- | --- |
| `countActiveInCapacitySlotSync` / `...Async` (in-transaction, authoritative — every move, drag, promote, release) | **counted** |
| `countCapacitySlot` in the hold/release sweep (documented as mirroring the in-txn count — and it did) | **counted** |
| `isRunningAgentTask` (agent `maxConcurrent` / `maxWorktrees`) | excluded since FN-8704 |

A dead card whose step died parks with `status:"failed"`. It holds no session, no agent slot and no
worktree slot, but it *stays in its lane on purpose* — FN-8704 deliberately keeps failed WIP rows
rendered so an operator can retry or re-home them. None of the three column counters had that
amendment, so debris occupied real slots.

At a WIP limit of 3, three dead cards therefore made the lane permanently full: `store.moveTask`
arbitration refused the crossing `capacity-exhausted` inside the transaction, the graph suspended it at
the column boundary with `waitReason: "capacity"`, and the hold/release sweep — counting through the
*same* gap in its own `countCapacitySlot` — refused to release ready cards into it and held them
`downstream-full`. Both refusals therefore had one cause, the shared counting gap: the mirror agreed
with the store, and both disagreed with FN-8704's ruling. The agent-capacity predicate was
the only truthful surface during the freeze: `isRunningAgentTask` excluded the parks, so
`runningAgentCount` correctly read 0 live agents while every column counter insisted the lane was at its
limit. The same cycle repeated on every poll. Measured on project `saneca`: 294 capacity suspensions in
~30 minutes, `runningAgentCount` 0 and `planningCount` 0, zero board-wide moves.

A consistency rule for anyone re-reading this table: `downstream-full` is the sweep's objection to a
lane it counts as **full**, so it cannot originate from a mirror that saw free capacity. A narrative
that pairs "the sweep saw free capacity" with cards held `downstream-full` is self-contradictory, and it
is the reverse of what happened here.

A second consistency rule, added by RUFU-758 because this article's own held-reason column was being read as a
capacity column: a card held under a **plan-premise** gate was never refused by capacity at all. The gate is
`plan-premise-unmet`, and it means the card's own plan contract could not be verified — its authoritative plan
document unreadable, its premises malformed, a verdict still unposted, its budget exhausted, or the source
already overtaken by its own delivery. That door shuts **before** any slot is requested, so a premise refusal
riding an episode whose pool facts show the lane with room is coherent, not contradictory: the pool had room
and the plan did not. Read the gate before the counts. Until RUFU-758 these cards were recorded
`move-rejected-or-no-slot` — the sweep discarded the refusal code its release primitive returned and published
a constant — which made a broken plan indistinguishable from a full lane, and was the reason this table's
evidence read as capacity pressure on a board with zero live executions.

RUFU-558 later bounded how often the sweep re-derives its objections, and the `downstream-full` rule above is why the bound keys on
the sweep's own measured held reason rather than on the durable episode's gate code. A refusal the sweep
measures as `downstream-full` is re-derived from the live lane sample every pass, so the class of objection
this table depends on can never be memoised into a stale verdict: what is paced is the codeless sibling
(`move-rejected-or-no-slot`), the one arm whose re-derivation costs readiness probes plus a pool reservation
plus a move. Note the asymmetry before quoting a marker as evidence: because gate labels sharpen upward
only, a marker reading `downstream-full` can be older than a later codeless refusal, so the label is
neither the cadence key nor proof of which arm spoke last.

## Fix

Extract the failed-park rule that FN-8704 had already written down inside `isRunningAgentTask` into one
exported predicate, and make every occupancy consumer answer through it:

```ts
export type FailedWipParkShape = { status?: string | null };
export function isFailedWipPark(task: FailedWipParkShape): boolean {
  return task.status === "failed";
}
```

Consumers: both store counters (after the marker-skip arm, so `status:"failed"` plus a
`transition_pending` marker still counts as a live holder), the hold/release sweep's mirror, the
dashboard workflow-switcher phase counts, and `isRunningAgentTask` itself — whose inlined literal was
deleted so a fourth call site cannot reappear with a different answer.

Two scopes were held deliberately narrow. The shared atom is the *failed check only*: adopting
`isRunningAgentTask` wholesale would also drop paused, stale-`planning` and externally-blocked rows from
column occupancy, which is a scheduler-admission change nobody asked for. And the dashboard excludes a
failed park from Progress and Review occupancy only — the Plan bucket reports queue depth, the merge
flash keys on the task's own merge status, and the cards remain rendered.

## Non-obvious details

- **The SQL projection is nullable.** Both counters call the predicate on a raw `project.tasks`
  projection, where `status` is `string | null`, so the predicate takes `{ status?: string | null }`
  rather than `Pick<Task, "status">`. Coalescing at the call sites instead would have been ceremony
  whose only purpose is to be dropped by the next caller.
- **The predicate ships in both core barrels.** `index.ts` and `index.gate.ts` export it, because the
  `engine-core` merge-gate lane resolves `@fusion/core` through the generated gate bundle; a
  full-barrel-only export breaks only the gate lane.
- **The marker-skip arm must stay first.** A live mover has a null `status` *and* a
  `transition_pending` marker; the marker arm counts it, and the failed arm must never see it.

## How the regression test was made non-vacuous

The first draft of the store-level test passed before the fix existed, which is how the bug would have
survived its own test. Two independent reasons, both silent (each helper returned `0`, the expected
number, for the wrong thing):

1. Fixture writes went through the harness's raw `admin_sql()` plane, which may reach a **different**
   database than the store's own drizzle data plane reads from. Writes belong on
   `h.layer().db.update(schema.project.tasks)` with `projectPartition(...)` in the `WHERE` clause.
2. The counter was asked about the `DEFAULT_WORKFLOW_POOL_ID` bucket while the seeded rows were bucketed
   under the card's own selected workflow. Ask about the pool `resolveCapacityPoolId` actually returns
   for the contending card.

The guard that made it provable: assert a **live** occupant reads the expected non-zero count *before*
asserting a failed park reads zero. A positive-exclusion test with no live control is unfalsifiable. A
RED check against the pre-fix counter then confirmed exactly the new exclusion cases fail and the
negative cases stay green.

## Related

- `docs/architecture.md` → *Independent task and worktree concurrency* (the three occupancy dimensions).
- `docs/solutions/reliability/` FN-8704 debris rule: failed WIP rows stay visible.
- `packages/core/src/__tests__/postgres/workflow-capacity-invariant.pg.test.ts` — the invariant suite.
- `packages/engine/src/__tests__/hold-release-capacity-failed-parks.test.ts` — the sweep mirror.
