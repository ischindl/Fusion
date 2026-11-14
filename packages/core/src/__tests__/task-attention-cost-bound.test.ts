/*
FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
The cost half of the requirement: a 200-idle-card `todo` lane must not pay for a predicate it cannot
benefit from, and the review-scope gate is what keeps that promise. This suite asserts the promise on the
generated SQL text rather than on a stopwatch, because a timing assertion on shared CI hardware is either
so loose it proves nothing or so tight it becomes the next flake - and the claim being made is not "fast
today" but "the machinery is structurally absent from the plain lane's statement".

Rendered SQL is a legitimate assertion target here in a way a comment is not: it is the exact bytes the
database will execute, it is produced by the same builder the read uses (there is no second spelling to
drift), and the failure mode it guards is invisible in every behavioural test - a lane that still RANKS
correctly while quietly running a jsonb subquery per row for 200 rows it will never rank differently.
*/
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  attentionTierSql,
  taskAttentionOrderBy,
  taskAttentionOrderCursorPredicate,
  taskQueueOrderBy,
} from "../task-store/task-queue-order-ops.js";
import type { TaskAttentionPageKey } from "../task-store/task-queue-order-ops.js";

/**
 * The executed bytes, through the same dialect the store's driver uses. An `SQL` chunk carries no
 * renderer of its own (`toSQL()` is not on it), so asking the PostgreSQL dialect is the only way to see
 * what would actually go over the wire - which is the point of a cost-bound assertion.
 */
const dialect = new PgDialect();
function render(fragment: SQL | SQL[]): string {
  const parts = Array.isArray(fragment) ? fragment : [fragment];
  return parts.map((part) => dialect.sqlToQuery(part as never).sql).join(" , ");
}

/*
The two column names are the whole cost: reading them per row is the jsonb array walk (a `CASE` guard, an
`EXISTS` over the step-result array, `WITH ORDINALITY`). Nothing else in the ladder costs more than a
column comparison, so their absence IS the bound.
*/
const GATE_COLUMNS = ["workflow_step_results", "enabled_workflow_steps"];

const CURSOR: TaskAttentionPageKey = {
  sequence: "1730000000000",
  tier: 1,
  createdAt: "2026-11-13T00:00:00.000Z",
  id: "FN-010",
};

/**
 * Layout- and placeholder-insensitive form. Drizzle re-indents a fragment when it embeds it, wraps it in
 * parentheses, and numbers its bind parameters by position in the whole statement, so the SAME ladder
 * reads `$1` alone and `$3` inside the cursor predicate. All three are artifacts of embedding; the
 * question "is this the same ladder in both places" has to be asked in a form where they are not
 * differences. Every other assertion in this file reads the raw rendered text.
 */
function flat(text: string): string {
  return text.replace(/\$\d+/g, "?").replace(/[\s()]/g, "");
}

describe("attention order cost bound", () => {
  it("builds a plain lane's ORDER BY without touching the step tables", () => {
    const text = render(taskAttentionOrderBy({ reviewScope: false }));
    for (const column of GATE_COLUMNS) {
      expect(text).not.toContain(column);
    }
    /*
    Deliberately NOT `not.toContain("EXISTS")`: the dependency tier legitimately runs a small
    `jsonb_array_elements` existence test on `dependencies`, which is a two-element array at worst. The
    cost being bounded is the STEP arrays - unbounded in length, and the reason the arm is gated at all -
    and their two columns above are the assertion that says so.
    */
  });

  it("builds a review lane's ORDER BY with the gate arm actually present", () => {
    /*
    The other direction, because a gate that silently stopped emitting its arm would make the plain-lane
    assertion above pass forever while the review lane quietly lost tier 1. The card that has to be seen
    first in a review lane is the one this subquery finds.
    */
    const text = render(taskAttentionOrderBy({ reviewScope: true }));
    for (const column of GATE_COLUMNS) {
      expect(text).toContain(column);
    }
    expect(text.toUpperCase()).toContain("EXISTS");
  });

  it("keeps the cursor continuation on the same cost boundary as the read that minted it", () => {
    /*
    A page-2 statement is a second chance to smuggle the gate into a plain lane: the continuation predicate
    re-derives the tier to compare against the cursor's minted tier. If only the ORDER BY were gated, a
    plain lane would pay the full cost from the second page on and the first page would look clean.
    */
    expect(render(taskAttentionOrderCursorPredicate(CURSOR, { reviewScope: false }))).not.toMatch(
      new RegExp(GATE_COLUMNS.join("|")),
    );
    const review = render(taskAttentionOrderCursorPredicate(CURSOR, { reviewScope: true }));
    for (const column of GATE_COLUMNS) {
      expect(review).toContain(column);
    }
  });

  it("shares ONE tier builder between the order and the cursor", () => {
    /*
    The pair must be the same ladder or a page walk drops and repeats rows inside a tier. Deriving the
    cursor's tier clause from the ORDER BY's - rather than asserting they look similar - is the only
    assertion that catches a second spelling of the ladder being introduced.
    */
    const tier = flat(render(attentionTierSql({ reviewScope: true })));
    const fromOrder = flat(render(taskAttentionOrderBy({ reviewScope: true })[1]!));
    const cursorText = flat(render(taskAttentionOrderCursorPredicate(CURSOR, { reviewScope: true })));
    expect(tier.length).toBeGreaterThan(80);
    expect(fromOrder).toContain(tier);
    expect(cursorText).toContain(tier);
  });

  it("leaves the dispatch queue order free of any attention machinery", () => {
    /*
    The engine's dispatch read consumes `queue-order`. It must stay a byte-for-byte statement with no
    attention term in it - the coupling the requirement forbids is exactly this one, and it is asserted
    here (on the generated bytes) rather than only on the caller list.
    */
    const queue = taskQueueOrderBy();
    expect(queue).toHaveLength(5);
    const text = render(queue);
    for (const column of GATE_COLUMNS) {
      expect(text).not.toContain(column);
    }
    expect(text.toUpperCase()).not.toContain("EXISTS");
    // And the attention statement is a strict superset of it, so the queue order did not just lose terms.
    expect(render(taskAttentionOrderBy({ reviewScope: false }))).toContain(text.split(" , ")[0]!);
  });
});
