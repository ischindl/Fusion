/**
 * RUFU-1088 — the pure hygiene + ranking-honesty module.
 *
 * The measured symptom these shapes come from (2026-11-18T13:58Z, served build b9d149751f): one query,
 * 10 rows, 9 of them from `fusion-task-SANE-367`, every score `0.18558138608932495`, every snippet the
 * literal `bash`. Pure-module cases first because the ordering and the degeneracy rule must be provable
 * without a transport in the room; the lane wiring is proven in
 * `src/memory/__tests__/stash-result-hygiene.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  STASH_MAX_ROWS_PER_SESSION,
  STASH_PROSE_EVENT_TYPES,
  STASH_SINGLE_TOKEN_MAX_CHARS,
  classifyStashRow,
  hygieneStashItems,
  labelStashRanking,
  type StashHygieneItem,
} from "../memory/stash-result-hygiene.js";

/** A row shaped like the server's, with the fields this module reads. */
function item(overrides: Partial<StashHygieneItem> = {}): StashHygieneItem {
  return {
    id: overrides.id ?? "e1",
    content: overrides.content ?? "a sentence with words in it",
    event_type: overrides.event_type ?? "memory",
    session_id: overrides.session_id ?? "ses-a",
    ...(overrides.rank !== undefined ? { rank: overrides.rank } : {}),
    ...(overrides.score !== undefined ? { score: overrides.score } : {}),
  };
}

describe("classifyStashRow (the two drop arms and nothing else)", () => {
  it("drops a row whose text is empty or whitespace", () => {
    expect(classifyStashRow("", "memory")).toBe("empty");
    expect(classifyStashRow("   \n\t ", "memory")).toBe("empty");
    expect(classifyStashRow(undefined, "memory")).toBe("empty");
  });

  it("drops the measured `bash` row: one short token from a non-prose event type", () => {
    expect(classifyStashRow("bash", "tool_use")).toBe("bare-token");
    expect(classifyStashRow("execute_command", "tool_result")).toBe("bare-token");
    // An unknown type and a MISSING type are non-exempt by construction — allowlist, not negation.
    expect(classifyStashRow("bash", "some_future_type")).toBe("bare-token");
    expect(classifyStashRow("bash", undefined)).toBe("bare-token");
  });

  it("keeps prose-exempt one-word content and any multi-word content", () => {
    for (const type of STASH_PROSE_EVENT_TYPES) {
      expect(classifyStashRow("DECISION", type)).toBe("usable");
    }
    // Multi-word tool rows are kept: the filter is about the TEXT, not about the event type.
    expect(classifyStashRow("ran bash on the failing host", "tool_use")).toBe("usable");
    // A single token LONGER than the label ceiling is content, not a label.
    expect(classifyStashRow("x".repeat(STASH_SINGLE_TOKEN_MAX_CHARS + 1), "tool_use")).toBe("usable");
    expect(STASH_MAX_ROWS_PER_SESSION).toBe(1);
  });
});

describe("hygieneStashItems (filter → dedup → per-session cap → slice)", () => {
  it("gives one session the whole page no more — the 9-of-10 measurement", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => item({ id: `s-${i}`, session_id: "fusion-task-SANE-367", content: `note body ${i}` })),
      item({ id: "r-1", session_id: "fusion-task-RUFU-180", content: "another session's note" }),
    ];
    const kept = hygieneStashItems(rows, 10);
    expect(kept.map((r) => r.session_id)).toEqual(["fusion-task-SANE-367", "fusion-task-RUFU-180"]);
  });

  it("spreads a page across sessions instead of taking the first N rows", () => {
    const rows = [
      item({ id: "a1", session_id: "sa", content: "first note from sa" }),
      item({ id: "a2", session_id: "sa", content: "second note from sa" }),
      item({ id: "b1", session_id: "sb", content: "first note from sb" }),
      item({ id: "c1", session_id: "sc", content: "first note from sc" }),
    ];
    expect(hygieneStashItems(rows, 3).map((r) => r.id)).toEqual(["a1", "b1", "c1"]);
  });

  it("dedups the same event twice by id, and same text in one session when no id exists", () => {
    const withIds = [item({ id: "x" }), item({ id: "x" }), item({ id: "y", session_id: "other" })];
    expect(hygieneStashItems(withIds, 5).map((r) => r.id)).toEqual(["x", "y"]);
    const noIds = [
      { content: "Same Note Text", session_id: "sa", event_type: "memory" },
      { content: "same   note   text", session_id: "sa", event_type: "memory" },
      { content: "same note text", session_id: "sb", event_type: "memory" },
    ];
    // Same normalized text in ONE session collapses; the same text in a DIFFERENT session does not.
    expect(hygieneStashItems(noIds, 5).map((r) => r.session_id)).toEqual(["sa", "sb"]);
  });

  it("never caps a row that carries no session_id", () => {
    const rows = [
      { id: "n1", content: "sessionless note one", event_type: "memory" },
      { id: "n2", content: "sessionless note two", event_type: "memory" },
      { id: "n3", content: "sessionless note three", event_type: "memory" },
    ];
    expect(hygieneStashItems(rows, 5)).toHaveLength(3);
  });

  it("slices to the caller's limit and never returns more", () => {
    const rows = Array.from({ length: 8 }, (_, i) => item({ id: `i${i}`, session_id: `s${i}` }));
    expect(hygieneStashItems(rows, 3)).toHaveLength(3);
    expect(hygieneStashItems(rows, 0)).toEqual([]);
  });

  it("drops textless rows and returns an empty page rather than padding", () => {
    const rows = [
      item({ id: "d1", content: "bash", event_type: "tool_use", session_id: "s1" }),
      item({ id: "d2", content: "   ", event_type: "memory", session_id: "s2" }),
      item({ id: "d3", content: "", event_type: "memory", session_id: "s3" }),
    ];
    expect(hygieneStashItems(rows, 5)).toEqual([]);
  });

  it("is deterministic: same input, two calls, identical output and order", () => {
    const rows = [
      item({ id: "z", session_id: "s9", content: "zeta note" }),
      item({ id: "a", session_id: "s1", content: "alpha note" }),
      item({ id: "m", session_id: "s1", content: "mid note" }),
    ];
    expect(hygieneStashItems(rows, 5)).toEqual(hygieneStashItems(rows, 5));
    expect(hygieneStashItems(rows, 5).map((r) => r.id)).toEqual(["z", "a"]);
  });

  it("judges the text the caller says it will deliver", () => {
    // `snippet` is empty but the caller's text is `content`: kept, because that is what the agent sees.
    const rows = [{ id: "v1", snippet: "", content: "the delivered vector sentence", session_id: "s", event_type: "memory" }];
    expect(hygieneStashItems(rows, 3, (r) => String(r.content ?? ""))).toHaveLength(1);
    expect(hygieneStashItems(rows, 3)).toHaveLength(0);
  });
});

describe("labelStashRanking (a constant is not a relevance claim)", () => {
  const CONSTANT = 0.18558138608932495;

  it("leaves a single-row page untouched — degeneracy needs more than one row", () => {
    expect(labelStashRanking([item({ score: CONSTANT })], [CONSTANT])).toEqual([{ score: CONSTANT }]);
  });

  it("leaves a non-degenerate page untouched, so normal result objects stay byte-identical", () => {
    const items = [item({ score: 0.9 }), item({ score: 0.4, id: "e2" })];
    expect(labelStashRanking(items, [0.9, 0.4])).toEqual([{ score: 0.9 }, { score: 0.4 }]);
  });

  it("re-scores from the rank tier when distinct ranks exist", () => {
    const items = [
      item({ score: CONSTANT, rank: 0.2 }),
      item({ score: CONSTANT, rank: 0.1, id: "e2" }),
    ];
    const out = labelStashRanking(items, [CONSTANT, CONSTANT]);
    expect(out.map((r) => r.score)).toEqual([1, 0.5]);
    expect(out.every((r) => r.rankingSource === "server-rank-fallback")).toBe(true);
  });

  it("labels the order positional and keeps the magnitudes when no rank signal exists", () => {
    // The measured page: ten identical constants, no rank anywhere. The number a consumer SEES is
    // unchanged (merged-page arithmetic and the tier-3 2.0/1.0 values stay intact); only the claim
    // that it ranks anything is replaced by a label.
    const items = [item({ score: CONSTANT }), item({ score: CONSTANT, id: "e2" })];
    const out = labelStashRanking(items, [CONSTANT, CONSTANT]);
    expect(out.map((r) => r.score)).toEqual([CONSTANT, CONSTANT]);
    expect(out.map((r) => r.rankingSource)).toEqual(["positional", "positional"]);
  });

  it("treats a page whose tier-3 positional score is constant as positional too", () => {
    // tier 3 gives 2.0 then 1.0, so it is never degenerate; but a one-row-per-score page of equal
    // numbers (e.g. a server score of 0 on every row) must not be presented as a ranking either.
    const items = [item({ score: 0 }), item({ score: 0, id: "e2" })];
    expect(labelStashRanking(items, [0, 0]).map((r) => r.rankingSource)).toEqual([
      "positional",
      "positional",
    ]);
  });

  it("is deterministic and never reorders the page", () => {
    // One usable rank value is not an ordering either (nothing to be relative to), so this page is
    // labelled positional and keeps its numbers — the point being that the function never invents a
    // magnitude and never shuffles rows.
    const items = [item({ score: CONSTANT }), item({ score: CONSTANT, id: "e2", rank: 1 })];
    const first = labelStashRanking(items, [CONSTANT, CONSTANT]);
    expect(labelStashRanking(items, [CONSTANT, CONSTANT])).toEqual(first);
    expect(first.map((r) => r.score)).toEqual([CONSTANT, CONSTANT]);
    expect(first.map((r) => r.rankingSource)).toEqual(["positional", "positional"]);
  });
});
