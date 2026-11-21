/*
FNXC:TaskLogProjections 2026-11-19-19:55 (RUFU-636):
The unit half of the sufficiency contract. RUFU-615 shipped an envelope that could PROVE its own answer
and no reader that asked; RUFU-636 makes the asking happen in one function (`taskLogEnvelopeProves`) that
all four resolvers and the read gate in `reads.ts` share. This file pins the pure rules — the fixed reason
vocabulary, the window boundary, the horizon computation, the row cap, the per-parser version asymmetry,
and the named-timestamp scoping the fallback's fourth proof consumes — so the pg lane (`postgres/
task-log-recent-sufficiency.pg.test.ts`) only has to prove the read path actually consults them.
*/
import { describe, expect, it } from "vitest";
import {
  LOG_RECENT_SCHEMA_VERSION,
  emptyTaskLogRecent,
  parseProjectionTimestamp,
  parseTaskLogRecent,
  sufficiencyHas,
  sufficiencyProves,
  taskLogEnvelopeProves,
  stalledReviewFromProjection,
  latestLogTimestampFromProjection,
  stallSurfacedAtFromProjection,
  countIdenticalStallFromProjection,
  TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING,
  TASK_LOG_ENVELOPE_SCOPE_WINDOW_MATCH,
  TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS,
  type TaskLogRecentEnvelope,
  horizonFromServedWindows,
  taskLogHistoryReadBound,
  sideHoldsNamedTimestamps,
  withholdReasonForGatedRow,
  withheldReasonsFor,
  pickSufficiencyGateRows,
  LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
} from "../task-log-projections.js";
import { pickTaskLogEnvelope, type TaskLogRollupRow } from "../task-log-entries.js";
import { STALLED_REVIEW_WINDOW_MS } from "../../tasks/stalled-review-detector.js";

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const WINDOW_START = NOW - STALLED_REVIEW_WINDOW_MS;

/** An envelope that proves everything, then whatever a case wants to break. */
function envelope(patch: Partial<TaskLogRecentEnvelope> = {}): TaskLogRecentEnvelope {
  return { ...emptyTaskLogRecent(), ...patch };
}

describe("taskLogEnvelopeProves — the one sufficiency decision", () => {
  it("proves a plain envelope and names no reason", () => {
    const verdict = taskLogEnvelopeProves(envelope({ latestAt: new Date(NOW).toISOString() }), { windowStartMs: WINDOW_START });
    expect(verdict).toEqual({ proves: true, reason: null, reasons: [] });
  });

  it("refuses a missing envelope as no-envelope, including an explicit null and undefined", () => {
    for (const missing of [null, undefined]) {
      const verdict = taskLogEnvelopeProves(missing, { windowStartMs: WINDOW_START });
      expect(verdict.proves).toBe(false);
      expect(verdict.reason).toBe("no-envelope");
    }
  });

  it("refuses an unknown version, which only the rollup author can hand over", () => {
    const verdict = taskLogEnvelopeProves(envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1 }), { windowStartMs: WINDOW_START });
    expect(verdict.reason).toBe("unknown-envelope-version");
    /*
    The two authors of the asymmetry, named by behaviour rather than by a comment: `parseTaskLogRecent`
    refuses an unknown `v` by comparison (so the legacy column pair can never reach a reader shaped like
    this), while the rollup lane types ANY numeric `v` as an envelope — reproduced here through
    `pickTaskLogEnvelope`, which is the seam `reads.ts` uses. This helper is the only place that refuses.
    */
    expect(parseTaskLogRecent({ v: LOG_RECENT_SCHEMA_VERSION + 1, latestAt: null })).toBe(null);
    const rollup: TaskLogRollupRow = {
      entryCount: 3,
      timingTotalMs: 0,
      computedAt: new Date(NOW).toISOString(),
      logRecent: envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1 }) as TaskLogRecentEnvelope,
    };
    const picked = pickTaskLogEnvelope({
      rollup,
      legacyProjectionAt: null,
      legacyTimingTotalMs: null,
      legacyLogRecent: null,
    });
    expect(picked.logRecent?.v).toBe(LOG_RECENT_SCHEMA_VERSION + 1);
    expect(taskLogEnvelopeProves(picked.logRecent, { windowStartMs: WINDOW_START }).reason)
      .toBe("unknown-envelope-version");
  });

  it("refuses unparseable entries whatever else the envelope looks like", () => {
    const verdict = taskLogEnvelopeProves(envelope({ unparseableCount: 1 }), { windowStartMs: WINDOW_START });
    expect(verdict.reason).toBe("unparseable-entries");
    expect(sufficiencyHas(verdict, "unparseable-entries")).toBe(true);
  });

  describe("the cap-drop window boundary", () => {
    const marker = NOW - 5 * 60_000;

    it("calls a marker inside the window insufficient, for either match array", () => {
      for (const key of ["reenqueueNewestDroppedAt", "invalidTransitionNewestDroppedAt"] as const) {
        const verdict = taskLogEnvelopeProves(envelope({ [key]: marker }), { windowStartMs: WINDOW_START });
        expect(verdict.reason).toBe("dropped-match-in-window");
      }
    });

    it("treats a marker exactly at the window start as in-window (the bound is inclusive)", () => {
      const verdict = taskLogEnvelopeProves(envelope({ reenqueueNewestDroppedAt: WINDOW_START }), { windowStartMs: WINDOW_START });
      expect(verdict.reason).toBe("dropped-match-in-window");
    });

    it("treats a marker one millisecond older than the window start as proven", () => {
      const verdict = taskLogEnvelopeProves(envelope({ reenqueueNewestDroppedAt: WINDOW_START - 1 }), { windowStartMs: WINDOW_START });
      expect(verdict.proves).toBe(true);
    });

    it("with a zero window start, any real marker is inside the window", () => {
      const verdict = taskLogEnvelopeProves(envelope({ reenqueueNewestDroppedAt: 1 }), { windowStartMs: 0 });
      expect(verdict.reason).toBe("dropped-match-in-window");
    });

    it("asks no windowed question when windowStartMs is null (the trailing-run resolver's question)", () => {
      const verdict = taskLogEnvelopeProves(envelope({ reenqueueNewestDroppedAt: NOW }), { windowStartMs: null });
      expect(verdict.reason).toBe(null);
      expect(sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_WINDOW_MATCH)).toBe(false);
      expect(sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS)).toBe(true);
    });
  });

  it("refuses a stored MAX stamp that fails the shared parse rule", () => {
    for (const latestAt of ["2026-11-19 12:00", "not-a-timestamp", ""]) {
      const verdict = taskLogEnvelopeProves(envelope({ latestAt }), { windowStartMs: WINDOW_START });
      expect(verdict.reasons).toContain("unparseable-latest");
      expect(verdict.proves).toBe(false);
    }
    // An explicit null is "no stall entry exists", which IS provable — the resolver answers -Infinity.
    expect(taskLogEnvelopeProves(envelope({ latestAt: null }), { windowStartMs: WINDOW_START }).proves).toBe(true);
  });

  it("keeps every reason in the exported fixed vocabulary", () => {
    const reasons = [
      ...taskLogEnvelopeProves(null, { windowStartMs: 0 }).reasons,
      ...taskLogEnvelopeProves(envelope({ v: 7, unparseableCount: 2, reenqueueNewestDroppedAt: NOW, latestAt: "x" }), { windowStartMs: 0 }).reasons,
    ];
    const vocabulary = new Set(["no-envelope", "unknown-envelope-version", "unparseable-entries", "dropped-match-in-window", "unparseable-latest"]);
    for (const reason of reasons) expect(vocabulary.has(reason)).toBe(true);
  });

  it("reports reasons in one fixed priority order, so the headline reason never depends on a row", () => {
    const verdict = taskLogEnvelopeProves(
      envelope({ v: 3, unparseableCount: 4, reenqueueNewestDroppedAt: NOW, latestAt: "garbage" }),
      { windowStartMs: 0 },
    );
    expect(verdict.reasons).toEqual(["unknown-envelope-version", "unparseable-entries", "dropped-match-in-window", "unparseable-latest"]);
    expect(verdict.reason).toBe("unknown-envelope-version");
  });
});

describe("the four resolvers answer through the one verdict", () => {
  it("stalledReview: a cap-drop marker in the window still ANSWERS and says it cannot prove it", () => {
    const churnAt = [NOW - 40 * 60_000, NOW - 30 * 60_000, NOW - 20 * 60_000].map((ms) => new Date(ms).toISOString());
    const target = envelope({
      latestAt: churnAt[2],
      reenqueueAt: churnAt,
      reenqueueNewestDroppedAt: NOW - 10 * 60_000,
    });
    const derived = stalledReviewFromProjection(target, { now: NOW });
    expect(derived.signal?.matchCount).toBe(3);
    expect(derived.provablyComplete).toBe(false);
  });

  it("stalledReview: an unparseable entry or an unknown version answers NOTHING", () => {
    const churnAt = [NOW - 40 * 60_000, NOW - 30 * 60_000, NOW - 20 * 60_000].map((ms) => new Date(ms).toISOString());
    for (const patch of [{ unparseableCount: 1 }, { v: LOG_RECENT_SCHEMA_VERSION + 1 }]) {
      const derived = stalledReviewFromProjection(envelope({ latestAt: churnAt[2], reenqueueAt: churnAt, ...patch }), { now: NOW });
      expect(derived.signal).toBeUndefined();
      expect(derived.provablyComplete).toBe(false);
    }
  });

  it("the MAX-stamp resolvers keep RUFU-615's answers and inherit the version refusal", () => {
    const at = new Date(NOW - 60_000).toISOString();
    expect(latestLogTimestampFromProjection(envelope({ latestAt: at }))).toEqual({
      ms: Date.parse(at),
      provablyComplete: true,
    });
    expect(stallSurfacedAtFromProjection(envelope({ stallSurfacedAt: at }))).toEqual({ ms: Date.parse(at), provablyComplete: true });
    expect(latestLogTimestampFromProjection(envelope({}))).toEqual({ ms: Number.NEGATIVE_INFINITY, provablyComplete: true });
    expect(latestLogTimestampFromProjection(envelope({ unparseableCount: 1 }))).toEqual({ ms: Number.NEGATIVE_INFINITY, provablyComplete: false });
    expect(latestLogTimestampFromProjection(envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1, latestAt: at })))
      .toEqual({ ms: Number.NEGATIVE_INFINITY, provablyComplete: false });
    expect(stallSurfacedAtFromProjection(envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1, stallSurfacedAt: at })))
      .toEqual({ ms: null, provablyComplete: false });
  });

  it("the trailing-run resolver keeps its own facts and adds only the shared refusal", () => {
    const signal = { code: "merge-blocker", reason: "blocked" };
    const at = new Date(NOW - 60_000).toISOString();
    const run = envelope({ tailCode: signal.code, tailReason: signal.reason, tailCount: 2, tailAt: [at, at] });
    expect(countIdenticalStallFromProjection(run, signal)).toEqual({ count: 2, provablyComplete: true });
    expect(countIdenticalStallFromProjection(envelope({ ...run, tailTruncated: true }), signal).provablyComplete).toBe(false);
    expect(countIdenticalStallFromProjection(envelope({ ...run, unparseableCount: 1 }), signal).provablyComplete).toBe(false);
    expect(countIdenticalStallFromProjection(envelope({ ...run, v: LOG_RECENT_SCHEMA_VERSION + 1 }), signal).provablyComplete).toBe(false);
    // No trailing run at all answers 0 and proves it, exactly as RUFU-615 shipped it.
    expect(countIdenticalStallFromProjection(envelope({}), signal)).toEqual({ count: 0, provablyComplete: true });
  });

  it("cites the scopes it consumes, so no scope is a dead export", () => {
    const verdict = taskLogEnvelopeProves(envelope({ reenqueueNewestDroppedAt: NOW }), { windowStartMs: 0 });
    expect(sufficiencyProves(verdict, TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING)).toBe(true);
    expect(sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_WINDOW_MATCH)).toBe(false);
    expect(sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS)).toBe(true);
  });
});

describe("the fallback's horizon, bound, cap and four proofs", () => {
  const THRESHOLD = 24 * HOUR;

  it("computes the horizon from the windows the served badges actually consult", () => {
    // The churn detector's 1 h window and the in-review threshold share one earliest instant.
    expect(horizonFromServedWindows(THRESHOLD)).toBe(THRESHOLD);
    // A CUSTOM threshold is the whole point of threading it: an operator who sets 6 h must not keep reading
    // only 24 h of History, or the repair answers a window narrower than the badge it is proving.
    expect(horizonFromServedWindows(6 * HOUR)).toBe(6 * HOUR);
    expect(horizonFromServedWindows(30 * 60_000)).toBe(STALLED_REVIEW_WINDOW_MS);
    expect(horizonFromServedWindows(undefined)).toBe(STALLED_REVIEW_WINDOW_MS);
    expect(horizonFromServedWindows(Number.NaN)).toBe(STALLED_REVIEW_WINDOW_MS);
  });

  it("builds the read bound as the ISO text the side table is ordered by", () => {
    const bound = taskLogHistoryReadBound(NOW, horizonFromServedWindows(THRESHOLD));
    expect(bound).toBe(new Date(NOW - THRESHOLD).toISOString());
    // Lexicographic order IS the side table's order, so a line stamped before the horizon must sort below
    // the bound and a line inside it must not: assert the ordering the `>=` comparison actually applies.
    expect(new Date(NOW - 90 * 60_000).toISOString() < taskLogHistoryReadBound(NOW, HOUR)).toBe(true);
    expect(new Date(NOW - 30 * 60_000).toISOString() >= taskLogHistoryReadBound(NOW, HOUR)).toBe(true);
  });

  it("keeps the per-row read cap strictly below the retention limit it must never approach", () => {
    // `LOG_RECENT_RETENTION_LIMIT` is 1000 side rows per card; a read that merely stayed under it would
    // still be re-shipping the History the reader asked to stop shipping, so the bound is far tighter.
    expect(LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP).toBeGreaterThan(0);
    expect(LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP).toBeLessThan(1_000);
  });

  it("caps gated rows per pass and spends the budget on rows that can be repaired first", () => {
    const gated = Array.from({ length: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP + 4 }, (_, i) => `RUFU-636-${i}`);
    // Every row carries an envelope EXCEPT the first three, which can only ever fail proof 1.
    const hasEnvelope = new Map(gated.map((id, i) => [id, i >= 3]));
    const picked = pickSufficiencyGateRows({ candidates: gated, hasEnvelope });
    expect(picked.selected).toHaveLength(LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP);
    for (const id of picked.selected.slice(0, 3)) expect(hasEnvelope.get(id)).toBe(true);
    expect(picked.overCap).toHaveLength(gated.length - LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP);
  });

  describe("withholdReasonForGatedRow — the four ground-truth proofs, in order", () => {
    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const bound = taskLogHistoryReadBound(NOW, THRESHOLD);
    const entry = (timestamp: string) => ({ timestamp, action: "work" });

    it("fails side-history-absent when nothing came back", () => {
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000) }),
        entries: [],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBe("side-history-absent");
    });

    it("fails side-window-truncated when the read hit the row cap", () => {
      const cap = LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP;
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000) }),
        entries: Array.from({ length: cap }, () => entry(at(60_000))),
        readCap: cap,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBe("side-window-truncated");
    });

    it("fails side-behind-author when the newest side line predates the envelope's own MAX", () => {
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000) }),
        entries: [entry(at(2 * HOUR))],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBe("side-behind-author");
    });

    it("fails side-missing-named-timestamp when a stamp the envelope names inside the horizon is absent", () => {
      // Proofs 1-3 pass on their own: some entries came back, under the cap, newest is the envelope's MAX.
      const named = at(30 * 60_000);
      const verdict = withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000), reenqueueAt: [named], tailAt: [] }),
        entries: [entry(at(60_000))],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      });
      expect(verdict).toBe("side-missing-named-timestamp");
      // The same card with the named line present proves.
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000), reenqueueAt: [named], tailAt: [] }),
        entries: [entry(named), entry(at(60_000))],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBeNull();
    });

    it("requires a named stamp when it parses inside the horizon OR its text sorts with the bound", () => {
      /*
      A legacy line whose UTC instant (16:00Z) sits INSIDE the horizon while its raw text sorts BELOW the
      ISO bound, because of its negative offset. `Date.parse`-equivalent arithmetic would count it; the
      text-comparing SQL bound could never return it. A repair that answered from a window that cannot hold
      a line the derivation would have matched is a silent undercount, so the parse half of the union
      requires it — and here it is missing, which must withhold the row.
      */
      const odd = "2026-11-18T11:00:00-05:00";
      expect(parseProjectionTimestamp(odd)).toBe(NOW - 20 * HOUR);
      expect(odd < bound).toBe(true);
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000), reenqueueAt: [odd] }),
        entries: [entry(at(60_000))],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBe("side-missing-named-timestamp");
    });

    it("does NOT require a named stamp provably older than every served window", () => {
      // Demanding an ancient stamp would withhold every repair forever and buy no safety.
      const ancient = at(THRESHOLD + 5 * HOUR);
      expect(withholdReasonForGatedRow({
        envelope: envelope({ latestAt: at(60_000), reenqueueAt: [ancient], tailAt: [ancient], stallSurfacedAt: ancient }),
        entries: [entry(at(60_000))],
        readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
        bound,
        horizonMs: NOW - THRESHOLD,
      })).toBeNull();
    });

    it("names every stored stamp array it checks, including the trailing run it does not serve", () => {
      // Conservative bias, stated: a History missing a line its author named is not a proved History, even
      // for `tailAt`, which no badge served at the gated sites reads.
      for (const key of ["reenqueueAt", "invalidTransitionAt", "tailAt"] as const) {
        const missing = at(3 * HOUR);
        expect(withholdReasonForGatedRow({
          envelope: envelope({ latestAt: at(60_000), [key]: [missing] }),
          entries: [entry(at(60_000))],
          readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
          bound,
          horizonMs: NOW - THRESHOLD,
        })).toBe("side-missing-named-timestamp");
      }
      for (const key of ["stallSurfacedAt", "latestAt"] as const) {
        const missing = at(3 * HOUR);
        expect(withholdReasonForGatedRow({
          envelope: envelope({ latestAt: at(60_000), [key]: missing }),
          entries: [entry(at(60_000))],
          readCap: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
          bound,
          horizonMs: NOW - THRESHOLD,
        })).toBe("side-missing-named-timestamp");
      }
    });
  });

  describe("sideHoldsNamedTimestamps / withheldReasonsFor — proof 4 and the census's arithmetic", () => {
    const bound = taskLogHistoryReadBound(NOW, 24 * HOUR);
    const horizonMs = NOW - 24 * HOUR;
    const ago = (msAgo: number) => new Date(NOW - msAgo).toISOString();

    it("requires exactly the stamps that parse inside the horizon or sort with the bound", () => {
      const inside = ago(30 * 60_000);
      const olderThanEveryWindow = ago(30 * HOUR);
      expect(sideHoldsNamedTimestamps(envelope({ latestAt: ago(60_000), reenqueueAt: [inside] }), [inside, ago(60_000)], { bound, horizonMs })).toBe(true);
      expect(sideHoldsNamedTimestamps(envelope({ latestAt: ago(60_000), reenqueueAt: [inside] }), [ago(60_000)], { bound, horizonMs })).toBe(false);
      // Older than every served window AND below the bound text: nothing served reads it, so nothing is required.
      expect(sideHoldsNamedTimestamps(envelope({ latestAt: ago(60_000), reenqueueAt: [olderThanEveryWindow] }), [ago(60_000)], { bound, horizonMs })).toBe(true);
    });

    /*
    The union's two clauses exist because the writers never agreed on ONE textual shape. Each case below is a
    stamp some parser has actually emitted, and every one is asserted as the same property: a named stamp is
    required exactly when a served window could hold it — parsing inside the horizon, OR sorting with the
    bound text — and an unparseable stamp is ALWAYS required: the only text-based exemption available to it
    (`stamp < bound`) is the same comparison an in-window `-05:00` line satisfies, so exempting on text alone
    would re-open the exact undercount the clause exists to close. Requiring a stamp costs a refusal when the
    window cannot return it; declining one it CAN return is the silent undercount. The two clauses are one
    rule, so a shape must never be excluded from the set and included in the bound, or the other way round.
    */
    it("scopes a named stamp by parse AND by text order, whichever shape the writer emitted", () => {
      const offsetText = (instantMs: number, offset: "-05:00" | "+14:00"): string => {
        const [hh, mm] = offset.slice(1).split(":").map(Number);
        const shift = (hh! * 60 + mm!) * 60_000 * (offset.startsWith("-") ? -1 : 1);
        return `${new Date(instantMs + shift).toISOString().replace(/Z$/, "")}${offset}`;
      };
      const insideMs = NOW - 30 * 60_000;
      const cases: Array<{ shape: string; stamp: string; required: boolean; why: string }> = [
        { shape: "ISO with millis", stamp: ago(30 * 60_000), required: true, why: "parses inside the horizon and sorts above the bound" },
        { shape: "ISO without millis", stamp: new Date(insideMs).toISOString().replace(/\.\d{3}Z$/, "Z"), required: true, why: "the fraction is optional to the parser and to the text order alike" },
        { shape: "negative offset", stamp: offsetText(insideMs, "-05:00"), required: true, why: "its text sorts BELOW the bound, so only the parse clause can catch it" },
        { shape: "positive offset", stamp: offsetText(insideMs, "+14:00"), required: true, why: "both clauses catch it" },
        { shape: "space-separated", stamp: new Date(insideMs).toISOString().slice(0, 19).replace("T", " "), required: true, why: "no parser agrees on it, so it cannot be proved older than any served window — and the side table compares TEXT and would return the row" },
        { shape: "epoch millis", stamp: String(insideMs), required: true, why: "unparseable stamps cannot be placed, so they are required; a text bound that cannot return one WITHHOLDS the row rather than answering short" },
        { shape: "empty string", stamp: "", required: true, why: "the same conservative refusal as any stamp that cannot be placed — required, and never a crash" },
      ];
      for (const testCase of cases) {
        const env = envelope({ latestAt: ago(60_000), reenqueueAt: [testCase.stamp] });
        expect(
          sideHoldsNamedTimestamps(env, [ago(60_000)], { bound, horizonMs }),
          `${testCase.shape}: expected required=${testCase.required} — ${testCase.why}`,
        ).toBe(!testCase.required);
        expect(
          sideHoldsNamedTimestamps(env, [ago(60_000), testCase.stamp], { bound, horizonMs }),
          `${testCase.shape}: a stamp the window holds must satisfy it`,
        ).toBe(true);
      }
    });

    it("names per-field the lines the fallback proved absent — the same arithmetic as proof 4", () => {
      const missing = ago(3 * HOUR);
      expect(withheldReasonsFor(envelope({ latestAt: ago(60_000), reenqueueAt: [missing] })))
        .toEqual(["stale-matches-reenqueueAt"]);
      expect(withheldReasonsFor(envelope({ latestAt: ago(60_000), invalidTransitionAt: [missing], tailAt: [missing] })))
        .toEqual(["stale-matches-invalidTransitionAt", "stale-trailing-run-tailAt"]);
      expect(withheldReasonsFor(envelope({ stallSurfacedAt: ago(3 * HOUR) }))).toEqual(["stale-latest-surfaced-at"]);
      expect(withheldReasonsFor(envelope({ reenqueueNewestDroppedAt: NOW }))).toEqual(["dropped-match-in-window"]);
      expect(withheldReasonsFor(envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1 }))).toEqual(["unknown-envelope-version"]);
      expect(withheldReasonsFor(null)).toEqual(["no-envelope"]);
      expect(withheldReasonsFor(envelope({ latestAt: ago(60_000) }))).toEqual([]);
    });

    it("keeps the withheld vocabulary closed, exactly as the census's field test counts it", () => {
      const vocabulary = new Set<string>();
      for (const probe of [
        null,
        envelope({ v: LOG_RECENT_SCHEMA_VERSION + 1 }),
        envelope({ unparseableCount: 1 }),
        envelope({ reenqueueNewestDroppedAt: NOW }),
        envelope({ latestAt: "not-a-timestamp" }),
        envelope({ reenqueueAt: [ago(3 * HOUR)] }),
        envelope({ invalidTransitionAt: [ago(3 * HOUR)] }),
        envelope({ tailAt: [ago(3 * HOUR)] }),
        envelope({ stallSurfacedAt: ago(3 * HOUR) }),
      ]) for (const reason of withheldReasonsFor(probe)) vocabulary.add(reason);
      expect([...vocabulary].sort()).toEqual([
        "dropped-match-in-window",
        "no-envelope",
        "stale-latest-surfaced-at",
        "stale-matches-invalidTransitionAt",
        "stale-matches-reenqueueAt",
        "stale-trailing-run-tailAt",
        "unknown-envelope-version",
        "unparseable-entries",
        "unparseable-latest",
      ]);
    });
  });
});
