/*
FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
Parity between the two halves of the attention ladder, over the ONE fixture matrix.

WHY THIS SUITE EXISTS AT ALL. The client comparator decides how a lane is ARRANGED; the SQL `ORDER BY`
decides WHICH rows a truncated lane page CARRIES. A row the server ranks more urgently than the client
would be fetched and shown ahead of work that is actually worse - and it would also mint a cursor key the
client's own comparator does not reproduce, which is how a page walk starts repeating and skipping rows.
So the two halves are not allowed to disagree in one particular direction, and the disagreement that IS
allowed has to be named, not discovered later by an operator.

THE RULE, PRECISELY. For every fixture row and for both settings of the review-scope gate:

    sqlAttentionTier(row, gate) >= resolveAttentionTier(row, gate)

The server may under-rank - a signal it cannot see from durable columns leaves the row sitting idle - and
must never over-rank. The permitted direction is the boring one: a card that should have been at the top
appears where the operator already expects an idle card, rather than a calm card being shouted about.

Equality is expected EVERYWHERE EXCEPT the rows whose client tier came from a hydrated derivation the
durable columns cannot express: `stallReason` and `inReviewStall` are computed at hydration from the
workflow IR and the merge state, so no single SQL predicate reproduces them without resolving an IR per
row. Those rows are enumerated below by RULE rather than by a hand-typed list, so a fixture added later
is judged by the same test instead of quietly joining an allowlist.

The one case worth reading by name is a card parked by the review-stall classifier:
`pausedReason: "in-review-stall-deadlock"`. The client calls that tier 3 (a review stall), the server
calls it tier 4 (a pause, which is literally what the durable column says), and both readings are true of
the same row. It is pinned in `task-queue-attention.pg.test.ts` against a real database as well, because
that file's cursor-walk is where a minted tier of 3 would silently skip every genuine tier-4 row between
the two.
*/
import { describe, expect, it } from "vitest";
import {
  ATTENTION_TIER_IDLE,
  resolveAttentionTier,
  sqlAttentionTier,
  type AttentionTask,
} from "../tasks/task-attention.js";
import { ATTENTION_FIXTURE_A } from "./task-attention-fixtures.ts";

/** Tier 3 as the client spells it: a review stall. Not exported - the ladder's own module owns the value. */
const TIER_REVIEW_STALL = 3;

/** The hydrated-only signals: computed at hydration, never a durable column. */
function hasHydratedStall(task: AttentionTask): boolean {
  return task.stallReason !== undefined || task.inReviewStall !== undefined;
}

const GATES = [false, true] as const;

describe("attention ladder parity: the SQL mirror never over-ranks the client", () => {
  for (const reviewScope of GATES) {
    const gate = reviewScope ? "review lane (gate ON)" : "plain lane (gate OFF)";

    it.each([...ATTENTION_FIXTURE_A].map((row) => [row.name, row] as const))(
      `%s under ${reviewScope ? "gate ON" : "gate OFF"}`,
      (_name, row) => {
        const client = resolveAttentionTier(row.task, { reviewScope });
        const server = sqlAttentionTier(row.task, { reviewScope });
        // The direction the ladder's contract allows, and the only one.
        expect(server).toBeGreaterThanOrEqual(client);
        // And the fixture's own declared client tier still holds, so a change to either half has to pass
        // through this file rather than only through the suite that reads the numbers.
        expect(client).toBe(reviewScope ? row.withGate : row.withoutGate);
      },
    );

    it(`names every row where the two halves differ under ${gate}`, () => {
      /*
      The difference set is derived, not hand-listed: a row may differ ONLY when the client's verdict came
      from the hydrated stall arm, which is the one input the durable columns cannot carry. Anything else
      that diverges is a bug in one of the two halves and fails here with the row's name, which is the
      whole reason this assertion is separate from the per-row loop above.
      */
      const diverging = ATTENTION_FIXTURE_A.filter((row) => {
        const client = resolveAttentionTier(row.task, { reviewScope });
        const server = sqlAttentionTier(row.task, { reviewScope });
        return server !== client;
      });

      for (const row of diverging) {
        const client = resolveAttentionTier(row.task, { reviewScope });
        expect(client).toBe(TIER_REVIEW_STALL);
        expect(hasHydratedStall(row.task)).toBe(true);
      }

      /*
      And the divergence is only ever reachable where the client can actually SEE a review stall: with the
      gate off, tier 3 is not on offer in the client either, so no row may differ at all. A difference
      appearing with the gate off would mean the server ranked something the client considered idle, i.e.
      an over-rank wearing a disguise.
      */
      if (!reviewScope) expect(diverging.map((row) => row.name)).toEqual([]);
    });
  }

  it("pins the declared divergence row rather than excluding it", () => {
    /*
    The one disagreement a reviewer will ask about. `in-review-stall-deadlock` is a real `paused_reason`
    value AND a review stall, so the durable column and the hydrated derivation both tell the truth about
    it and land a tier apart. Pinning the numbers here means the row cannot be "fixed" by deleting the
    fixture or by quietly moving the SQL arm.
    */
    const row = ATTENTION_FIXTURE_A.find((candidate) => candidate.name.includes("in-review-stall-deadlock"));
    expect(row).toBeDefined();
    expect(resolveAttentionTier(row!.task, { reviewScope: true })).toBe(TIER_REVIEW_STALL);
    expect(sqlAttentionTier(row!.task, { reviewScope: true })).toBe(4);
    // With the gate off the client has no stall arm either, and both halves agree on the pause.
    expect(resolveAttentionTier(row!.task, { reviewScope: false })).toBe(4);
    expect(sqlAttentionTier(row!.task, { reviewScope: false })).toBe(4);
  });

  it("keeps the idle floor the largest tier, so an under-rank lands on the floor and nowhere else", () => {
    /*
    The under-rank direction is only harmless because the floor is the LAST tier: a signal the server
    cannot see has to cost the row its rank and nothing more. If a tier were ever added above the idle
    floor, or the floor renumbered, every server-blind row would move and this assertion is where that
    becomes visible.
    */
    for (const row of ATTENTION_FIXTURE_A) {
      for (const reviewScope of GATES) {
        const server = sqlAttentionTier(row.task, { reviewScope });
        expect(server).toBeLessThanOrEqual(ATTENTION_TIER_IDLE);
        expect(server).toBeGreaterThanOrEqual(0);
      }
    }
    expect(ATTENTION_TIER_IDLE).toBe(6);
  });

  it("agrees with the client on a blank text signal, in the direction that keeps SQL quiet", () => {
    /*
    Both halves test text fields for "carries something", and they are deliberately NOT spelled the same
    way: SQL uses PostgreSQL's `~ '\\S'` and the client treats only ASCII whitespace as blank. The
    asymmetry is one-directional on purpose - client-blank is a SUBSET of SQL-blank - so a value the
    server considers filled can never be one the client considers blank. A value that is blank for SQL
    and filled for the client (a Unicode space, say) is the accepted direction: the server stays idle.
    */
    const blankish = ["", " ", "   ", "\t", "\n", "\r", "\v", "\f", "\t ", "x", " x ", " "];
    for (const value of blankish) {
      const server = sqlAttentionTier({ error: value }, {});
      const client = resolveAttentionTier({ error: value }, {});
      expect(server).toBeGreaterThanOrEqual(client);
      if (server === 0) expect(client).toBe(0);
    }
  });
});
