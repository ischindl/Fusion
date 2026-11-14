/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's durable Boost mutation and the SQL half of the shared queue order.

TWO HALVES THAT MUST AGREE. `tasks/task-queue-order.ts` owns the TypeScript comparator; this module
owns the ORDER BY the PostgreSQL readers apply BEFORE their `LIMIT`. Sorting an already-truncated
page would silently drop a boosted card that started beyond the limit, which is precisely the case
the operator cares about, so the rank has to exist in SQL too.

WHY THE SQL EFFECTIVENESS CHECK IS A SUPERSET. A boost is scoped by workflow, column and column
entry. Column and entry are columns of `project.tasks` and are compared exactly here. The effective
WORKFLOW is not: it resolves through a selection table plus project defaults, which is a per-row
lookup rather than an expression. SQL therefore applies the two cheap identity checks and the
TypeScript layer re-resolves the winner — a superset can only admit an extra candidate into the
ordered scan, never hide one, and every admission path re-reads the canonical rank before it
commits to a winner.
*/

import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as schema from "../postgres/schema/index.js";
import { taskProjectScope, type DbTransaction } from "../postgres/data-layer.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { readTaskRowInTransaction } from "./async/async-persistence.js";
import {
  normalizeTaskQueueBoost,
  resolveTaskColumnEntryAt,
  type TaskQueueBoost,
} from "../tasks/task-queue-order.js";
/*
FNXC:BoardOrdering 2026-11-13-09:30: RUFU-526 - the SQL tier expression below is written against the
same ladder the TypeScript mirror returns, imported rather than re-stated so the two cannot drift.
*/
import { sqlAttentionTier, ATTENTION_TIER_IDLE, type AttentionTier, type ResolveAttentionTierOptions } from "../tasks/task-attention.js";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";

const tasks = schema.project.tasks;

/**
 * `true` when the stored boost still belongs to the row's CURRENT stay.
 *
 * Mirrors `resolveEffectiveQueueBoost` minus the workflow check (see the module header).
 */
export const QUEUE_BOOST_EFFECTIVE: SQL<boolean> = sql<boolean>`(
  ${tasks.queueBoost} IS NOT NULL
  AND ${tasks.queueBoost}->>'column' = ${tasks.column}
  AND ${tasks.queueBoost}->>'columnEntryAt' = COALESCE(${tasks.columnMovedAt}, ${tasks.createdAt})
  AND ${tasks.queueBoost}->>'sequence' ~ '^[0-9]{1,32}$'
)`;

/**
 * The boost sequence as a numeric, or 0 when no effective boost applies.
 *
 * `numeric` rather than `bigint` so a sequence beyond 2^63 still compares correctly, matching the
 * TypeScript comparator's arbitrary-precision decimal-string compare.
 */
export const QUEUE_BOOST_SEQUENCE: SQL<string> = sql<string>`(
  CASE WHEN ${QUEUE_BOOST_EFFECTIVE} THEN (${tasks.queueBoost}->>'sequence')::numeric ELSE 0 END
)`;

/**
 * The numeric id suffix expression shared by every queue ORDER BY and keyset predicate.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * ONE expression for both halves: an ORDER BY term and its keyset predicate must be written from the
 * same expression, or a page walk can repeat or drop rows around a non-numeric id suffix.
 */
const ID_NUMERIC_SUFFIX: SQL<string> = sql`COALESCE(NULLIF(regexp_replace(${tasks.id}, '^.*-', ''), '')::numeric, 0)`;

/**
 * The canonical queue ORDER BY: boosted first (latest boost at the head), then arrival
 * (`created_at` ASC with invalid/missing values last), then the id's numeric suffix, then the id.
 *
 * Apply this BEFORE any `LIMIT`. The numeric-suffix expression mirrors `compareTaskIdNumeric`, so a
 * `FN-2`/`FN-10` tie resolves identically in SQL and TypeScript.
 */
export function taskQueueOrderBy(): SQL[] {
  return [
    sql`${QUEUE_BOOST_SEQUENCE} DESC`,
    sql`(CASE WHEN ${tasks.createdAt} IS NULL THEN 1 ELSE 0 END) ASC`,
    sql`${tasks.createdAt} ASC NULLS LAST`,
    sql`${ID_NUMERIC_SUFFIX} ASC`,
    sql`${tasks.id} ASC`,
  ];
}

/** Manual-intake display order: newest first, deterministic descending id tiebreak. */
export function taskIntakeDisplayOrderBy(): SQL[] {
  return [
    sql`${tasks.createdAt} DESC NULLS LAST`,
    sql`${ID_NUMERIC_SUFFIX} DESC`,
    sql`${tasks.id} DESC`,
  ];
}

// ── Attention order (RUFU-526) ─────────────────────────────────────────────

/*
A value counts as a signal only when it holds something beyond whitespace. PostgreSQL's `\S` is the
class the SQL half uses, and the TypeScript half (`isFilledText` in `tasks/task-attention.ts`) treats
only the six ASCII whitespace characters as blank - a subset of what `\S` rejects, in every locale
PostgreSQL builds against. That ordering is what keeps the ladder directional: a row SQL considers to
carry a signal is one the client also considers to carry one, never the reverse. (Spelled `\\S` because
a JavaScript template would otherwise eat the backslash.)
*/
function attentionTextSignal(column: SQL | PgColumn): SQL {
  return sql`COALESCE(${column}, '') ~ '\\S'`;
}

/*
FNXC:BoardOrdering 2026-11-13-09:30:
The PostgreSQL half of the attention ladder. ONE exported fragment, read verbatim by the `ORDER BY`
below and by the keyset continuation predicate - the same rule `ID_NUMERIC_SUFFIX` records above: an
ORDER BY term and its cursor predicate must be written from one expression, or a page walk repeats or
drops rows around the term.

THE SAME SEVEN TIERS, MINUS THE ONE SQL CANNOT SEE. Tiers 0, 1, 2, 4, 5 and the idle floor are built
from durable `project.tasks` columns only. Tier 3 is DELIBERATELY ABSENT: `stallReason` and
`inReviewStall` are hydrated derivations (the Census in `tasks/task-attention.ts` records them as
never-persisted), so a card the client ranks 3 because of a merge/stall blocker is ranked by its
durable arms here - `paused_reason` carries `in-review-stall-deadlock` and lands it at 4. That is the
ONE declared divergence and it runs in the only allowed direction: SQL may rank a row CALMER than the
client, never more urgent, because `taskAttentionPageKey` writes the stored tier from
`sqlAttentionTier` and a key that ranked higher than the database's own would make the exclusive
continuation skip every row between the two.

THE ARM THAT IS NOT CHEAP, AND WHY IT IS BEHIND A GATE. Tiers 0, 2, 4 and 5 are scalar column reads.
Tier 1 correlates `enabled_workflow_steps` against `workflow_step_results` - the row's OWN step id
list, not `resolveRequiredPreMergeStepIds`, which resolves the workflow IR per row and so cannot be
one SQL predicate. It is emitted only when the caller resolved a review-scope lane, which is both the
correctness rule (a `todo` card has not reached its gates, so "no result row" is normal there and must
not float the whole backlog) and the cost bound: the 200-idle-card lane this card exists for pays zero
jsonb work per row.

THE STEP-STATUS VOCABULARY IS CLOSED. Only `failed`, `pending` and the absence of a latest row fire
the arm; `passed`, `advisory_failure` (non-blocking by contract) and `skipped` (often an audited
operator waiver) do not. The COALESCE to `''` is what spells "zero result rows", so the missing-row
shape and the two attention statuses are one test rather than two that can drift apart.
*/
export function attentionTierSql(options: ResolveAttentionTierOptions = {}): SQL {
  const durableSteps = sql`CASE WHEN jsonb_typeof(${tasks.enabledWorkflowSteps}) = 'array'
    THEN ${tasks.enabledWorkflowSteps} ELSE '[]'::jsonb END`;
  const durableResults = sql`CASE WHEN jsonb_typeof(${tasks.workflowStepResults}) = 'array'
    THEN ${tasks.workflowStepResults} ELSE '[]'::jsonb END`;
  /*
  The latest row for a step id is the LAST match in array order, mirroring `latestResultForStep` via
  `WITH ORDINALITY`. `jsonb` preserves array element order (it sorts object keys, never arrays), so
  ordinality is arrival order. The `jsonb_typeof = 'string'` filter mirrors the ladder skipping a
  non-string step id, and the `->>` match skips a row whose own id is absent or non-string.
  */
  const requiredGateStuck = sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(${durableSteps}) AS gate(el)
    WHERE jsonb_typeof(gate.el) = 'string'
      AND COALESCE((
        SELECT row ->> 'status'
        FROM jsonb_array_elements(${durableResults}) WITH ORDINALITY AS result(row, ord)
        WHERE result.row ->> 'workflowStepId' = gate.el #>> '{}'
        ORDER BY result.ord DESC
        LIMIT 1
      ), '') IN ('failed', 'pending', '')
  )`;

  return sql`(CASE
    WHEN ${attentionTextSignal(tasks.error)} OR ${tasks.status} IN ('failed', 'blocked') THEN 0
    ${options.reviewScope === true ? sql`WHEN ${requiredGateStuck} THEN 1` : sql``}
    WHEN ${attentionTextSignal(tasks.awaitingApprovalReason)}
      OR (jsonb_typeof(${tasks.humanPlanApproval}) = 'object'
          AND ${tasks.humanPlanApproval} ->> 'enabled' = 'true'
          AND jsonb_exists(${tasks.humanPlanApproval}, 'decision') = false)
      OR (jsonb_typeof(${tasks.humanMergeApproval}) = 'object'
          AND ${tasks.humanMergeApproval} ->> 'enabled' = 'true'
          AND jsonb_exists(${tasks.humanMergeApproval}, 'decision') = false)
      THEN 2
    WHEN ${attentionTextSignal(tasks.pausedReason)} THEN 4
    WHEN ${attentionTextSignal(tasks.blockedBy)}
      OR ${attentionTextSignal(tasks.overlapBlockedBy)}
      OR (jsonb_typeof(${tasks.dependencies}) = 'array' AND jsonb_array_length(${tasks.dependencies}) > 0)
      THEN 5
    ELSE ${ATTENTION_TIER_IDLE}
  END)`;
}

/**
 * The board lane ORDER BY that surfaces attention: the Boost bucket, the attention tier, then the
 * existing queue terms byte-for-byte.
 *
 * The tier sits INSIDE the bucket, never ahead of it, for the reason the module header gives: an
 * ordered scan may admit extra candidates, never hide a head row. Leading with the tier would drop an
 * operator-boosted idle card that today leads on `QUEUE_BOOST_SEQUENCE DESC` off a truncated page,
 * and would float the oldest low-tier row above a newest failure. `taskQueueOrderBy()` - the order
 * every engine dispatch path consumes - is untouched.
 *
 * `reviewScope` must come from `isReviewColumnRole` over the columns actually being read; a request
 * naming mixed columns gates OFF rather than letting one review column switch the step scan on for a
 * plain `todo` column, which would OVER-rank that column's backlog.
 */
export function taskAttentionOrderBy(options: ResolveAttentionTierOptions = {}): SQL[] {
  return [
    sql`${QUEUE_BOOST_SEQUENCE} DESC`,
    sql`${attentionTierSql(options)} ASC`,
    sql`(CASE WHEN ${tasks.createdAt} IS NULL THEN 1 ELSE 0 END) ASC`,
    sql`${tasks.createdAt} ASC NULLS LAST`,
    sql`${ID_NUMERIC_SUFFIX} ASC`,
    sql`${tasks.id} ASC`,
  ];
}

// ── Keyset continuation ─────────────────────────────────────────────────────

/** The exact sort key of one row under `taskQueueOrderBy()` / `taskIntakeDisplayOrderBy()`. */
export interface TaskQueuePageKey {
  /** The SQL-effective boost sequence, or `"0"` when the row carries no effective boost. */
  sequence: string;
  createdAt: string;
  id: string;
}

/**
 * The SQL-effective boost sequence of an already-hydrated task.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * A keyset cursor is only safe when the key it stores is the key the database sorted by, so this
 * mirrors `QUEUE_BOOST_SEQUENCE` exactly — including the deliberate omission of the workflow check
 * that the module header explains. Resolving the boost in TypeScript with the workflow identity
 * would produce `0` for a row SQL ranked above `0`, and pagination would then skip rows.
 */
export function sqlEffectiveBoostSequence(
  task: Pick<Task, "column" | "columnMovedAt" | "createdAt" | "queueBoost">,
): string {
  const boost = normalizeTaskQueueBoost(task.queueBoost);
  if (!boost) return "0";
  if (boost.column !== task.column) return "0";
  if (boost.columnEntryAt !== resolveTaskColumnEntryAt(task)) return "0";
  return /^[0-9]{1,32}$/.test(boost.sequence) ? boost.sequence : "0";
}

/** Read the exact page key of a hydrated row for the given order. */
export function taskQueuePageKey(
  task: Pick<Task, "id" | "column" | "columnMovedAt" | "createdAt" | "queueBoost">,
): TaskQueuePageKey {
  return { sequence: sqlEffectiveBoostSequence(task), createdAt: task.createdAt, id: task.id };
}

/**
 * Exclusive keyset predicate for `taskQueueOrderBy()`.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * ORDER and CONTINUATION are one invariant. Every ORDER BY term appears here in the same direction,
 * otherwise a page walk silently repeats or drops rows. Rows with a NULL `created_at` sort last
 * inside their sequence group, so they are admitted once the cursor is inside that group.
 */
export function taskQueueOrderCursorPredicate(cursor: TaskQueuePageKey): SQL {
  const seq = sql`${cursor.sequence}::numeric`;
  const suffix = sql`COALESCE(NULLIF(regexp_replace(${cursor.id}, '^.*-', ''), '')::numeric, 0)`;
  return sql`(
    ${QUEUE_BOOST_SEQUENCE} < ${seq}
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} IS NULL)
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} > ${cursor.createdAt})
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} > ${suffix})
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} = ${suffix} AND ${tasks.id} > ${cursor.id})
  )`;
}

/**
 * The exact sort key of one row under `taskAttentionOrderBy()`: the queue key plus the tier.
 *
 * `tier` is additive on purpose - `TaskQueuePageKey` stays the shape `queue-order` and `intake-desc`
 * cursors carry, so an existing page walk cannot receive a key whose tier it never sorted by.
 */
export interface TaskAttentionPageKey extends TaskQueuePageKey {
  /** The value the SQL tier EXPRESSION assigned, i.e. `sqlAttentionTier`, never the client ladder. */
  tier: AttentionTier;
}

/** The hydrated fields the attention key needs: the queue key's, plus the ladder's durable inputs. */
export type TaskAttentionKeyTask = Pick<
  Task,
  | "id"
  | "column"
  | "columnMovedAt"
  | "createdAt"
  | "queueBoost"
  | "error"
  | "status"
  | "awaitingApprovalReason"
  | "humanPlanApproval"
  | "humanMergeApproval"
  | "pausedReason"
  | "blockedBy"
  | "overlapBlockedBy"
  | "dependencies"
  | "enabledWorkflowSteps"
  | "workflowStepResults"
>;

/*
FNXC:BoardOrdering 2026-11-13-09:30:
Read the attention page key of a hydrated row.

The `tier` comes from `sqlAttentionTier`, the DURABLE-ONLY mirror, and never from the
`resolveAttentionTier` the comparator uses - this is the seam `sqlEffectiveBoostSequence` above exists
to illustrate. A card whose hydrated `stallReason` ranks it 3 client-side is ranked 4 by the SQL
expression through `paused_reason`; minting 3 here would make the exclusive predicate below ask for
rows strictly after tier 3 in an ordering that never contained one, silently skipping every tier-4 row
between them. Same bug shape, same fix: mirror what the database could see.

`reviewScope` MUST be the value the read passed to `taskAttentionOrderBy()`. A key minted with the gate
on for a lane sorted with it off stores tier 1 for a row SQL ranked 6, which skips rows; the reverse
under-ranks and repeats them.
*/
export function taskAttentionPageKey(task: TaskAttentionKeyTask, options: ResolveAttentionTierOptions = {}): TaskAttentionPageKey {
  return {
    sequence: sqlEffectiveBoostSequence(task),
    tier: sqlAttentionTier(task, options),
    createdAt: task.createdAt,
    id: task.id,
  };
}

/**
 * Exclusive keyset predicate for `taskAttentionOrderBy()`.
 *
 * ORDER AND CONTINUATION ARE ONE INVARIANT (the rule `ID_NUMERIC_SUFFIX` states): every ORDER BY term
 * appears here in the same direction, and the tier term is the SAME exported `attentionTierSql`
 * fragment rather than a second spelling of the ladder. The tier clause sits between the boost
 * sequence and the arrival terms because that is where the ORDER BY puts it; moving it here without
 * moving it there would make a page walk drop rows inside a boost-sequence group.
 */
export function taskAttentionOrderCursorPredicate(cursor: TaskAttentionPageKey, options: ResolveAttentionTierOptions = {}): SQL {
  const seq = sql`${cursor.sequence}::numeric`;
  const tier = sql`${attentionTierSql(options)}`;
  const suffix = sql`COALESCE(NULLIF(regexp_replace(${cursor.id}, '^.*-', ''), '')::numeric, 0)`;
  const sameSeq = sql`${QUEUE_BOOST_SEQUENCE} = ${seq}`;
  const sameTier = sql`${tier} = ${cursor.tier}`;
  /*
  FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
  The tier clause below is GREATER-THAN, and it is the one term that is not a copy of the queue predicate
  above. The boost bucket is DESCENDING, so "after the cursor" there reads `<`; the attention tier is
  ASCENDING - 0 is the card that must be seen first - so "after the cursor" here has to mean a LARGER tier.
  Writing `<` compiles, runs, and returns a page holding only the rest of the cursor row's own tier: a walk
  of a six-card lane came back with one row on page two and never reached the three calmer cards behind it.
  That is the row-loss direction a keyset cursor fails in, and it is what the page-walk case in the
  attention pg suite now pins. Note also that the clause must stay a SQL fragment rather than a constant
  from the cursor: the predicate and the ORDER BY share the ONE `attentionTierSql` builder, and a second
  spelling of the ladder is where a page walk starts disagreeing with the read that minted its cursor.
  */
  return sql`(
    ${QUEUE_BOOST_SEQUENCE} < ${seq}
    OR (${sameSeq} AND ${tier} > ${cursor.tier})
    OR (${sameSeq} AND ${sameTier} AND ${tasks.createdAt} IS NULL)
    OR (${sameSeq} AND ${sameTier} AND ${tasks.createdAt} > ${cursor.createdAt})
    OR (${sameSeq} AND ${sameTier} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} > ${suffix})
    OR (${sameSeq} AND ${sameTier} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} = ${suffix} AND ${tasks.id} > ${cursor.id})
  )`;
}

/** Exclusive keyset predicate for `taskIntakeDisplayOrderBy()` (newest first). */
export function taskIntakeDisplayCursorPredicate(cursor: Pick<TaskQueuePageKey, "createdAt" | "id">): SQL {
  const suffix = sql`COALESCE(NULLIF(regexp_replace(${cursor.id}, '^.*-', ''), '')::numeric, 0)`;
  return sql`(
    ${tasks.createdAt} IS NULL
    OR ${tasks.createdAt} < ${cursor.createdAt}
    OR (${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} < ${suffix})
    OR (${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} = ${suffix} AND ${tasks.id} < ${cursor.id})
  )`;
}

// ── boostTask ───────────────────────────────────────────────────────────────

export type BoostTaskRefusalReason =
  | "not-found"
  | "deleted"
  | "active"
  | "scope-changed"
  | "no-queue";

export interface BoostTaskOptions {
  /**
   * Caller-supplied idempotency key. A retried network call carrying the SAME id returns the
   * existing rank unchanged; a genuinely new click must carry a new id and mints a new sequence.
   */
  requestId: string;
  /** The effective workflow the caller believes the card is running; revalidated here. */
  workflowId: string;
  /** Optional precondition: refuse when the card's column is no longer this one. */
  expectedColumn?: string;
  /** Optional precondition: refuse when the card's stay marker has moved on. */
  expectedColumnEntryAt?: string;
  /** Resolved liveness for the card; a claimed, already-running card is never re-ranked. */
  isActive?: (task: Task) => boolean;
}

export type BoostTaskResult =
  | { ok: true; task: Task; boost: TaskQueueBoost; idempotent: boolean }
  | { ok: false; reason: BoostTaskRefusalReason; task?: Task };

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
The ONLY writer of `queueBoost`. Everything else — create, clone, refinement, import, revert,
restore, every generic `updateTask`/`updateTaskAtomic` patch and every self-healing sweep — is
forbidden from minting one, because a rank that a sweep can invent is a hidden priority.

ORDERING AND NON-PREEMPTION. The sequence is allocated INSIDE the same transaction as the write, so
two concurrent clicks are ordered by the database rather than by whichever browser's clock ran fast.
A card that is already active is refused rather than re-ranked: selection that has already been
accepted is never taken back to serve a boost that arrived afterwards.

LOCK ORDER. Task advisory lock first, then the row — the repository-wide order. The mutation writes
ONLY the rank plus the publication freshness stamp, so it cannot clobber a concurrent lifecycle
patch, and no model call or network emit happens while the transaction is open.
*/
export async function boostTaskImpl(
  store: TaskStore,
  id: string,
  options: BoostTaskOptions,
): Promise<BoostTaskResult> {
  const outcome = await store.withTaskLock(id, async () => {
    const layer = store.asyncLayer!;
    return layer.transactionImmediate(async (tx: DbTransaction): Promise<BoostTaskResult> => {
      await acquireTaskAdvisoryXactLock(tx, layer.projectId, id);
      const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
      if (!row) return { ok: false, reason: "not-found" };
      if (row.deletedAt) return { ok: false, reason: "deleted" };

      const current = store.rowToTask(store.pgRowToTaskRow(row));
      const columnEntryAt = resolveTaskColumnEntryAt(current);

      if (options.expectedColumn !== undefined && options.expectedColumn !== current.column) {
        return { ok: false, reason: "scope-changed", task: current };
      }
      if (options.expectedColumnEntryAt !== undefined && options.expectedColumnEntryAt !== columnEntryAt) {
        return { ok: false, reason: "scope-changed", task: current };
      }
      if (options.isActive?.(current) === true) {
        return { ok: false, reason: "active", task: current };
      }

      // Idempotent retry: the same request id already holds this stay's rank.
      const existing = normalizeTaskQueueBoost(current.queueBoost);
      if (
        existing &&
        existing.requestId === options.requestId &&
        existing.column === current.column &&
        existing.columnEntryAt === columnEntryAt &&
        existing.workflowId === options.workflowId
      ) {
        return { ok: true, task: current, boost: existing, idempotent: true };
      }

      const [sequenceRow] = (await tx.execute(
        sql`SELECT nextval('project.task_queue_boost_seq')::text AS sequence`,
      )) as unknown as Array<{ sequence: string }>;
      const sequence = sequenceRow?.sequence;
      if (!sequence) throw new Error(`Failed to allocate a queue boost sequence for ${id}`);

      const boost: TaskQueueBoost = {
        sequence,
        workflowId: options.workflowId,
        column: current.column,
        columnEntryAt,
        requestId: options.requestId,
      };

      const [updatedRow] = await tx
        .update(tasks)
        .set({ queueBoost: boost, updatedAt: new Date().toISOString() })
        .where(and(eq(tasks.id, id), taskProjectScope(layer)))
        .returning();
      if (!updatedRow) return { ok: false, reason: "not-found" };

      return {
        ok: true,
        task: store.rowToTask(store.pgRowToTaskRow(updatedRow)),
        boost,
        idempotent: false,
      };
    });
  });

  /*
  Publish only AFTER commit. A failed cosmetic projection must not make a committed rank invisible
  on re-read, so the task.json mirror is best-effort while the cache and the `task:updated` event
  carry the canonical row.
  */
  if (outcome.ok) {
    try {
      await store.writeTaskJsonFile(store.taskDir(id), outcome.task);
    } catch {
      // Intentionally swallowed: the durable rank is already committed in PostgreSQL.
    }
    if (store.isWatching) store.taskCache.set(id, { ...outcome.task });
    store.emitTaskLifecycleEventSafely("task:updated", [outcome.task]);
  }
  return outcome;
}
