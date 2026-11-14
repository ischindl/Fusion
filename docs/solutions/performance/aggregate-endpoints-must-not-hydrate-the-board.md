---
title: Aggregate endpoints must stop hydrating the whole board (RUFU-591)
date: 2026-11-14
component: dashboard API aggregation endpoints / agent roster
category: performance
module: packages/dashboard/src/routes.ts, packages/dashboard/src/shared-agent-store.ts, packages/core/src/agents/agent-token-usage.ts, packages/dashboard/app/hooks/useAgents.ts
tags: [hydration, aggregate, agent-store, workflow-ir, token-totals, roster-fanout, RUFU-591]
problem_type: performance
applies_when: A dashboard endpoint returns a few hundred bytes after seconds, or one visible roster refresh becomes a burst of identical fetches
symptoms:
  - GET /api/agents/stats returns a 157-byte payload after 7.6 s
  - Agents-sidebar counters and the fleet header counters stall the dashboard for 7-8 s on a project with hundreds of cards
  - One roster refresh in the dashboard network log turns into a burst of identical fetches
  - An /api/agents poll issues ~3 read round-trips per linked task and the count grows with the board
root_cause: Three aggregation patterns materialized entities to answer a cheap question - a fresh AgentStore constructed and init()-ed per request, one workflow IR resolved per linked task, and every token-bearing task row shipped to Node to be summed - plus a client fan-out where each mounted consumer started its own refresh.
resolution_type: structural-change-plus-guards
---

# Aggregate endpoints must stop hydrating the whole board

An aggregation endpoint is allowed to read only as much as its answer. A payload of a few hundred
bytes that costs seconds of wall clock, or a read count that grows with the number of cards on the
board, is a bug even when every response field is correct. Three distinct causes behind that shape
cost the dashboard 7-8 s stalls on a 565-card / 42 MB project and 5 concurrent agents, and one
client-side fan-out turned a single visible refresh into a burst of identical fetches.

## The three rules this fix leaves behind

1. **No entity materialization in aggregation paths.** A count, total, or roster refresh reads through
   a bounded read (SQL `COUNT`, a SQL aggregate, a lane vocabulary) instead of hydrating rows or
   materializing an entity (a store, a workflow IR, a full task row).
2. **A shared instance is shared through a refcount, never re-created per request or per consumer.**
   Server-side that means one initialized store per option shape; client-side it means one in-flight
   refresh per cache key with consumers subscribing to it.
3. **A response shape is not a licence to hydrate.** Byte-compatible JSON is the constraint on the
   fix, never the justification for the read.

## Cause 1: a fresh store per request

`routes.ts` and `register-agent-core-routes.ts` constructed `new AgentStore(...)` inside eight route
handlers and awaited `init()`. `init()` re-lists every agent to provision the built-in workflow-role
agents, so the open-store tax was paid per request, in the request's critical path, on a route that
answers with eight counters.

**Fix:** `packages/dashboard/src/shared-agent-store.ts` memoizes one initialized instance per
full-option identity and joins concurrent callers onto the in-flight construct+`init()` promise.

The non-obvious parts, each of which is a trap:

- **The key must cover every behavior-changing option.** `rootDir`, `asyncLayer`, `taskStore`,
  `claimStore`, `projectId`, and `nodeId` all change what the instance does. Object options key by
  identity through a `WeakMap`-minted token: `JSON.stringify`/`String()` either throws on a cyclic
  store or reduces every layer to `"[object Object]"`, which would silently merge two distinct
  projects' stores into one entry. A checkout-semantics call (with `taskStore`/`claimStore`) therefore
  can never be served a bare read-only instance.
- **Eviction drops the map reference only.** `AgentStore extends EventEmitter`, and `close()` on an
  instance also evicts the module-level SQLite handle cache for its `rootDir`. A closing eviction
  would break a store another live request still holds, so the LRU simply forgets the entry and lets
  the instance be collected. The module never calls `close()`, `stopWatching()`, or `.on()`.
- **A failed `init()` is dropped, reference only,** so the next request rebuilds instead of being
  served a half-provisioned store forever.

## Cause 2: one workflow IR per linked task

`sanitizeAgentTaskLinks` resolved the terminal ("Complete") lanes of each linked task to decide
whether its link is still live. It did that by resolving the card's own workflow selection and then
its IR, so `/api/agents` issued roughly one selection read plus one workflow-definition read per
linked card, per poll.

**Fix:** batch the selection leg through the `TaskStore.getTaskWorkflowSelectionsAsync` primitive FN-085
added and the definition leg through `WorkflowSelectionStore.getWorkflowDefinition`, which already
memoizes per process. Reads are now constant in the number of cards.

The guard that proves it (`agent-task-link-terminal-lanes.test.ts`) asserts three things at once,
because each one fails independently:

- read count is **constant** between 1 and 20 linked tasks (a growing count fails, so an
  implementation that swaps one lookup for another per-card lookup cannot pass);
- each card is judged against **its own** workflow's lanes, never a shared one. The substitution hazard
  is structural, not hypothetical: `prefetchWorkflowIrs` maps a task through
  `selectionCache.get(taskId)?.workflowId ?? FALLBACK_WORKFLOW_ID`, so a card whose selection was never
  warmed into that cache is resolved against `builtin:coding`. Calling the IR prefetch before the
  selection prefetch, or on a cold cache, silently judges every card against the default workflow's
  Complete lanes - a card done in a custom workflow's `Ship` lane would keep its agent's "working on"
  indicator lit. The call order in `sanitizeAgentTaskLinks` is therefore load-bearing, and the test
  pins both the batched leg and the single-lookup fallback leg (a store without
  `getTaskWorkflowSelectionsAsync`) so neither path can substitute.
- the prefetched payload **deep-equals** the payload with prefetching skipped, so no card's
  `taskColumn` shifts.

`builtin:coding` appears nowhere in the dashboard route code: the only source of a task's lanes is the
workflow selection and IR it resolves.

## Cause 3: summing rows in Node

`aggregateTaskTokenTotalsByAgentLinkAsync` selected every token-bearing task row and folded it in JS,
while the same file already summed `agent_runs` in SQL for the other half of the same panel. The
response is one row per agent.

**Fix:** one SQL query returning one row per agent, keeping the accumulator's attribution semantics
byte-identical:

- `CROSS JOIN LATERAL (VALUES (assigned_agent_id), (source_agent_id), (checked_out_by))` unpivots the
  three link columns, and `DISTINCT ON (agent_id, task_id)` collapses an agent linked through several
  columns of the *same* task into one credit - what the accumulator's per-row `Set` of agent ids does.
  Without it `nTasks` would count three link paths as three tasks.
- `total_tokens` falls back to the sum of the four parts per row (`COALESCE`), mirroring
  `row.totalTokens ?? sum-of-parts`, and every `SUM` is `COALESCE`d to 0 like `?? 0` in JS.
- **node-postgres returns `bigint` sums as strings.** The drizzle column mode parses typed selects,
  not raw `db.execute`, so each numeric field is coerced with `Number()` before entering the `Map`.
  Skip that and the response carries string token totals, which breaks the `inputTokens <= 0` guards
  in `withTaskDerivedTokenTotals`.

**Project scoping must use the same operand the board uses.** `taskListProjectScope(layer, reason)` is
what `countLiveTasks` uses: it binds `project_id = $n` as a *parameter* (never interpolated text) and
records the RUFU-871 unbound-shared-layer guard. The previous row-shipping query relied on the
connection's `fusion.project_id` session GUC alone, so a bypass-mode connection aggregated every
project's rows while still returning the correct *shape*.

**The SQLite leg is byte-for-byte the old row-shipped accumulator.** Two backends are separate code
paths; porting an aggregate is not a free rename and the two paths drift. `countAgentTaskLinks` - a
bounded `COUNT` that already satisfied the rule - was deliberately left alone rather than rewritten
into a row-returning GROUP BY whose result size is unbounded.

## Cause 4 (client): one refresh, not one per consumer

Two agents surfaces mounting at once made every 5 s interval fetch the roster twice, and every
non-visible interval refetched because the shared in-flight promise had already resolved without its
result ever being stored. `useAgents` now subscribes to a refcounted roster owner keyed by
`(projectId, state filter, includeEphemeral)` (`packages/dashboard/app/hooks/agent-roster-owner.ts`): a
burst issues
one fetch pair, a late mount hydrates from the shared result instead of refetching, and one of two
unmounting consumers leaves the subscription alive.

Consequences worth knowing:

- The owner is **module-level** in the `app/` bundle on purpose. A React context would not work
  because the consumers live in separate component subtrees behind `React.lazy` boundaries, and a
  per-hook-instance `useRef` cannot be shared across two mounted consumers at all.
- **The refcount is held across the network fetch**, so an unmount that races an in-flight fetch does
  not dispose the owner mid-flight and lose the result the other consumer is waiting for.
- The SWR snapshot slot carries the same variant key as the owner (`agentsRosterCacheKey`), so an
  ephemeral-inclusive refresh cannot overwrite the default roster snapshot every other reader
  hydrates from. The default slot keeps its existing name, and `clearCache(AGENTS)`'s prefix sweep
  still covers every variant.
- **An empty roster never wipes a populated snapshot.** The owner publishes whatever a `forceFresh`
  pair returns, so one transient empty read used to overwrite the snapshot every later mount hydrates
  from: a board booting to no agents, with no way back while the endpoint kept answering empty. Live
  state still takes the empty list - a roster genuinely deleted to zero must not keep its agent
  indicators lit - so only the hydrate source is protected, and an empty answer with nothing cached is
  still stored. The guard is "empty never displaces populated", not "never store empty".

## A rule this card's tests now pin (pre-existing, relocated not introduced)

`isTerminalTaskStatus` judges a card with `(resolvedTerminal ?? TERMINAL_TASK_STATUSES)`, so an **empty**
resolved lane set is authoritative: a custom workflow whose Complete set resolved empty is not silently
re-judged against the hardcoded `done` fallback. That `??` shape predates this card (it came in with the
2026-07-31 lifecycle-columns work); this card only hoisted the function from the `createApiRoutes`
closure to module scope so it could be tested, byte-for-byte. The distinction matters for future reads
of this file: the hardcoded `TERMINAL_TASK_STATUSES` vocabulary is a DELIBERATE-LITERAL fallback for a
workflow that will not resolve at all, and it is reachable only when no resolved set was threaded - not
when a resolved set happened to be empty.

## What was deliberately left out

64 `new AgentStore(` sites remain in `packages/dashboard/src/` outside its tests (the other registrars:
`register-approval-routes.ts`, `register-agent-runtime-routes.ts`, `register-workflow-routes.ts`,
`register-org-portability-routes.ts`, `server.ts`, and the CLI's three), 2 in `packages/engine/src/`
(`agent-tools.ts`, `executor/get-authoritative-assigned-agent.ts`), and one single-selection read remains
at `routes/board-workflows.ts:429`. None of them sits on a measured aggregate path - the two route files
this card covered now construct zero stores and contain zero `builtin:coding` literals. Converting an unmeasured site is how a
perf task becomes an unplanned refactor and how shared-instance lifecycle bugs get written, so each of
those needs its own measurement and its own card.

## How to verify

```bash
pnpm --filter @fusion/dashboard exec vitest run \
  src/__tests__/agents-shared-store.test.ts \
  src/__tests__/agent-task-link-terminal-lanes.test.ts \
  src/__tests__/agents-stats-queued-count.test.ts \
  src/__tests__/agents-token-totals-aggregate.test.ts
pnpm --filter @fusion/dashboard exec vitest run \
  app/hooks/__tests__/useAgents-shared-refresh.test.tsx
FUSION_PG_TEST_URL_BASE=postgresql://localhost:5432 \
  pnpm --filter @fusion/core exec vitest run src/__tests__/postgres/agent-token-usage.pg.test.ts
```

The PostgreSQL case self-skips without a server, so **a green run is not proof the aggregate was
executed**. To make it prove something, bring a throwaway server up and point the suite at it:

```bash
pnpm pg:test:up -- --port 25432
FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432 \
  pnpm --filter @fusion/core exec vitest run src/__tests__/postgres/agent-token-usage.pg.test.ts
pnpm pg:test:down
```

Four passing cases (two parity cases against the accumulator over the same fixture rows, one
statement-shape case that needs no server, one real-aggregate case whose `nTasks` equals the
distinct-card count) is the evidence that the SQL aggregate actually ran.
