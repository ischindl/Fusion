import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  buildPerTurnMemoryRecallCue,
  buildFocusRecallQuery,
  deriveFocusQueryTokens,
  deriveRecallKeywords,
  __resetPerTurnRecallDedupForTests,
  FOCUS_RECALL_QUERY_MAX_LENGTH,
  PER_TURN_RECALL_CUE_MAX_CHARS,
  PER_TURN_RECALL_DEDUP_MAX_SESSIONS,
  PER_TURN_RECALL_DEDUP_MAX_SIGNATURES,
  PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS,
  RECALL_KEYWORD_MAX_TERMS,
  RECALL_KEYWORD_MAX_TERM_LENGTH,
  type PerTurnRecallOptions,
} from "../memory/recall/per-turn-recall.js";
import { normalizeStashSearchQuery } from "../memory/memory-backend-stash.js";
import { MEMORY_PRE_STEERING_MARKER } from "../memory/memory-pre-steering.js";
import {
  registerMemoryBackend,
  type MemoryBackend,
  type MemorySearchResult,
} from "../memory/memory-backend.js";
import type { Settings } from "../types/settings/settings-scope.js";

/*
FNXC:PerTurnMemoryRecall 2026-08-18-22:35:
RUFU-120 B.2 symptom-verification tests for the per-turn recall core (per-turn-recall.ts).
All cases run against in-memory fake backends with UNIQUE type names (perturn-fake,
perturn-fake-nosearch, perturn-fake-reject) to avoid cross-file registry pollution, mirroring
the fake pattern of memory-backend.test.ts. No real Stash/qmd process is spawned.

2026-08-18-22:35:
The original test file was lost when the azure-frost worktree was removed with
uncommitted content (engine worktree re-home onto opal-creek during a dependency-content
import). This file is a faithful re-implementation of the same test contract: the
Symptom Verification assertions (marker cue on first prompt; no re-injection on the second
turn), the full silent-skip surface enumeration, client-side score filtering, the 800-char
whole-entry budget, top-K clamping, and the bounded session-scoped dedup registry.
*/

const ROOT = "/tmp/perturn-recall-fake-project";
const TOPIC = "čo sme diskutovali o LCM B.1 B.2";

function makeSettings(overrides: Partial<Settings> = {}): Partial<Settings> {
  return {
    memoryEnabled: true,
    memoryBackendType: "perturn-fake",
    memoryPerTurnRecallEnabled: true,
    memoryPerTurnRecallTopK: 3,
    ...overrides,
  };
}

function makeHit(path: string, lineStart: number, lineEnd: number, snippet: string, score: number): MemorySearchResult {
  return { path, lineStart, lineEnd, snippet, score, backend: "perturn-fake" };
}

// Mutable per-test state for the score-filter fake.
let fakeHits: MemorySearchResult[] = [];
let searchCalls: Array<{ query: string; limit?: number }> = [];
/*
FNXC:RUFU172TwoLaneRecall 2026-08-31-19:41:
Two-lane recall issues up to two backend searches (lane P = derived keywords, lane T = the
focus-derived query). The old single-array fake could not answer the two queries differently,
so tests set `fakeSearch` to route a response by query text (or throw, to exercise lane-T
failure isolation). Null keeps every existing single-lane test on the shared `fakeHits` path
unchanged.

FNXC:MemoryFocusRecall 2026-09-03-00:21:
RUFU-173 changed lane T's query shape: it is buildFocusRecallQuery(focus) — the focus's
content terms joined by " OR " — so query-routing fixtures key on THAT literal
(e.g. "pamäťové OR hladiny"), not the focus phrase itself.
*/
type FakeSearchFn = (query: string, limit?: number) => MemorySearchResult[];
let fakeSearch: FakeSearchFn | null = null;

beforeAll(() => {
  const baseCapabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };
  const read: MemoryBackend["read"] = async () => ({ content: "", exists: false, backend: "perturn-fake" });
  const write: MemoryBackend["write"] = async () => {
    throw new Error("read-only fake");
  };

  registerMemoryBackend({
    type: "perturn-fake",
    name: "Per-turn recall fake backend",
    capabilities: baseCapabilities,
    read,
    write,
    search: async (_rootDir, opts) => {
      searchCalls.push(opts);
      if (fakeSearch) return fakeSearch(opts.query, opts.limit);
      return fakeHits;
    },
  });
  registerMemoryBackend({
    type: "perturn-fake-nosearch",
    name: "Per-turn recall fake backend (no search)",
    capabilities: baseCapabilities,
    read,
    write,
  });
  registerMemoryBackend({
    type: "perturn-fake-reject",
    name: "Per-turn recall fake backend (rejecting search)",
    capabilities: baseCapabilities,
    read,
    write,
    search: async () => {
      throw new Error("backend search exploded");
    },
  });
});

beforeEach(() => {
  fakeHits = [];
  searchCalls = [];
  fakeSearch = null;
  __resetPerTurnRecallDedupForTests();
});

function call(topic: string, opts: Partial<PerTurnRecallOptions> = {}): Promise<string> {
  return buildPerTurnMemoryRecallCue({
    rootDir: ROOT,
    topic,
    sessionKey: opts.sessionKey ?? "chat:test-session",
    settings: opts.settings ?? makeSettings(),
    topK: opts.topK,
    ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
  });
}

function entryLines(cue: string): string[] {
  return cue.split("\n").filter((line) => /^\d+\. `/.test(line));
}

// ── Symptom Verification (B.2: recall on the first prompt; dedup on the second turn) ──

describe("Symptom Verification: per-turn recall on the current topic", () => {
  it("injects a marker-tagged, snippet-bearing cue on the first prompt (recognition gap is gone)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const cue = await call(TOPIC);
    expect(cue).not.toBe("");
    // Original symptom assertion 1: the injected prompt contains the recall cue.
    expect(cue).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(cue).toContain("docs/research/volt-lcm-analysis.md:12-18");
    expect(cue).toContain("B.2 LCM per-turn recall");
    expect(cue).toContain("Use fn_memory_get");
  });

  it("does not re-inject the identical cue on the second turn (session-scoped dedup)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const first = await call(TOPIC);
    expect(first).not.toBe("");
    const second = await call(TOPIC);
    // Original symptom assertion 2: second identical prompt has no repeated cue.
    expect(second).toBe("");
  });

  it("does re-inject for a different session (dedup is session-scoped, not global)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const first = await call(TOPIC, { sessionKey: "chat:session-a" });
    expect(first).not.toBe("");
    const other = await call(TOPIC, { sessionKey: "chat:session-b" });
    expect(other).not.toBe("");
    expect(other).toBe(first);
  });
});

// ── Requirement 6: short AND-reliable Stash query (no multi-word full-sentence query) ──

describe("deriveRecallKeywords (Stash AND-semantics guard)", () => {
  it("drops sub-3-char tokens and stopwords, keeping 2-3 content keywords", () => {
    // "LCM B.1 B.2 priorita plan" failed against Stash (0 events) because of AND-matching;
    // the derived query keeps only surviving content terms.
    const keywords = deriveRecallKeywords(TOPIC);
    expect(keywords).toEqual(["diskutovali", "lcm"]);
  });

  it("drops English and Slovak stopwords and ranks by length descending", () => {
    const keywords = deriveRecallKeywords("What did we do about the memory backend refactor?");
    expect(keywords).toEqual(["refactor", "backend", "memory"]);
  });

  it("returns [] for empty and stopword-only topics", () => {
    expect(deriveRecallKeywords("")).toEqual([]);
    expect(deriveRecallKeywords("   ")).toEqual([]);
    expect(deriveRecallKeywords("čo sme na sú ako")).toEqual([]);
  });

  it("caps at 3 keywords, deduped, keeping the longest content terms", () => {
    const keywords = deriveRecallKeywords("alpha beta gamma delta epsilon zeta");
    expect(keywords.length).toBeLessThanOrEqual(3);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it("truncates each term at 24 chars", () => {
    const keywords = deriveRecallKeywords("a".repeat(40));
    expect(keywords).toEqual(["a".repeat(24)]);
  });

  it("caps the joined query at 64 chars by dropping trailing keywords", () => {
    const keywords = deriveRecallKeywords(
      "abcdefghijklmnopqrstuvwx yzabcdefghijklmnopqrstuvwx abcdefghijklmnopqrstuvwx",
    );
    expect(keywords.join(" ").length).toBeLessThanOrEqual(64);
    expect(keywords.length).toBe(2);
  });
});

describe("query construction against the backend", () => {
  it("sends the short joined keyword query with 3x topK limit headroom", async () => {
    fakeHits = [makeHit("m.md", 1, 2, "snippet", 0.5)];
    await call(TOPIC);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe("diskutovali lcm");
    expect(searchCalls[0].limit).toBe(9); // 3 * topK(3), below the 20 cap
  });
});

// ── Silent-skip contract (surface enumeration: every data state) ──

describe("silent skip contract", () => {
  it("returns '' and makes NO backend call when memoryPerTurnRecallEnabled is false", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryPerTurnRecallEnabled: false }) });
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' and makes NO backend call when memoryEnabled is false (project memory off)", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryEnabled: false }) });
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' and makes NO backend call for a stopword-only topic", async () => {
    const cue = await call("čo sme na sú ako");
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  /*
  FNXC:RUFU172FocusBias 2026-09-02-05:20:
  RUFU-172 keeps the keyword gate authoritative: a focus is a RANKING input on an existing
  recall turn, never a trigger for one. A blank/stopword-only topic must still short-circuit
  BEFORE either lane is issued, so a focused conversation cannot start searching memory on
  every no-content turn (which would also let lane T grow the cue past the keyword contract).
  */
  it("returns '' and makes NO backend call for a stopword-only topic even with an active focus", async () => {
    const cue = await call("čo sme na sú ako", { focus: "pamäťové hladiny LCM" });
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' when the backend has no search capability", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryBackendType: "perturn-fake-nosearch" }) });
    expect(cue).toBe("");
  });

  it("returns '' when backend.search rejects", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryBackendType: "perturn-fake-reject" }) });
    expect(cue).toBe("");
  });

  it("returns '' for an unregistered backend type (resolver fallback cannot serve the cue)", async () => {
    const cue = await call(TOPIC, {
      settings: makeSettings({ memoryBackendType: "perturn-definitely-not-registered-xyz" }),
    });
    expect(cue).toBe("");
  });

  it("returns '' when the search yields no hits", async () => {
    fakeHits = [];
    const cue = await call(TOPIC);
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(1);
  });
});

// ── Client-side score filtering (Stash has no server-side score filter) ──

describe("client-side score filtering and top-K", () => {
  it("keeps only positive-score hits, sorted by score descending (default topK=3)", async () => {
    fakeHits = [
      makeHit("b.md", 1, 2, "snip b", 0.1),
      makeHit("c.md", 1, 2, "snip c", 0.9),
      makeHit("d.md", 1, 2, "snip d", 0.5),
      makeHit("zero.md", 1, 2, "snip zero", 0),
    ];
    const cue = await call(TOPIC);
    const entries = entryLines(cue);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("c.md"); // 0.9 first
    expect(entries[1]).toContain("d.md"); // 0.5 second
    expect(entries[2]).toContain("b.md"); // 0.1 third
    expect(cue).not.toContain("zero.md");
  });

  it("trusts backend order when ALL scores are zero (Stash-style ranking-less results)", async () => {
    fakeHits = [
      makeHit("z.md", 1, 2, "snip z", 0),
      makeHit("y.md", 1, 2, "snip y", 0),
      makeHit("x.md", 1, 2, "snip x", 0),
      makeHit("w.md", 1, 2, "snip w", 0),
    ];
    const cue = await call(TOPIC);
    const entries = entryLines(cue);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("z.md");
    expect(entries[1]).toContain("y.md");
    expect(entries[2]).toContain("x.md");
  });

  it("honors an explicit topK override (1)", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
      makeHit("c.md", 1, 2, "snip c", 0.7),
    ];
    const cue = await call(TOPIC, { topK: 1 });
    expect(entryLines(cue)).toHaveLength(1);
  });

  it("clamps an oversized topK to 10", async () => {
    fakeHits = Array.from({ length: 12 }, (_, i) => makeHit(`${i}.md`, 1, 2, `snip ${i}`, 0.9 - i * 0.01));
    const cue = await call(TOPIC, { topK: 99 });
    expect(entryLines(cue)).toHaveLength(10);
  });

  it("falls back to the default topK (3) when topK is 0", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
      makeHit("c.md", 1, 2, "snip c", 0.7),
      makeHit("d.md", 1, 2, "snip d", 0.6),
    ];
    const cue = await call(TOPIC, { topK: 0 });
    expect(entryLines(cue)).toHaveLength(3);
  });

  it("honors the settings topK when no explicit override is given", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
    ];
    const cue = await call(TOPIC, { settings: makeSettings({ memoryPerTurnRecallTopK: 1 }) });
    expect(entryLines(cue)).toHaveLength(1);
  });
});

// ── 800-char cue budget (whole-entry drops only) ──

describe("800-char cue budget", () => {
  it("never exceeds PER_TURN_RECALL_CUE_MAX_CHARS and only drops whole trailing entries", async () => {
    const longSnippet = "snippet ".repeat(26).trim(); // 160 chars
    fakeHits = [
      makeHit("h1.md", 1, 2, longSnippet, 0.9),
      makeHit("h2.md", 1, 2, longSnippet, 0.8),
      makeHit("h3.md", 1, 2, longSnippet, 0.7),
      makeHit("h4.md", 1, 2, longSnippet, 0.6),
    ];
    const cue = await call(TOPIC);
    expect(cue).not.toBe("");
    expect(cue.length).toBeLessThanOrEqual(PER_TURN_RECALL_CUE_MAX_CHARS);
    // Every entry line is a complete numbered entry (no partial entry survives).
    for (const line of cue.split("\n")) {
      if (line.includes("snippet")) {
        expect(/^\d+\. `/.test(line)).toBe(true);
      }
    }
    expect(cue).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(cue).toContain("Use fn_memory_get");
  });
});

// ── Bounded session-scoped dedup registry (FIFO eviction) ──

describe("dedup registry bounds", () => {
  it("evicts the oldest session key after PER_TURN_RECALL_DEDUP_MAX_SESSIONS insertions", async () => {
    // Fill the registry: one distinct topic per session key.
    for (let s = 0; s < PER_TURN_RECALL_DEDUP_MAX_SESSIONS; s++) {
      fakeHits = [makeHit("m.md", 1, 2, `fill ${s}`, 0.9)];
      const cue = await call(`alpha ${s}`, { sessionKey: `s${s}` });
      expect(cue).not.toBe("");
    }
    // A brand-new session at capacity evicts the oldest (s0).
    fakeHits = [makeHit("m.md", 1, 2, "evict", 0.9)];
    expect(await call("alpha 999", { sessionKey: "s-overflow" })).not.toBe("");

    // s2 is still present → still deduped (assert before the next eviction disturbs it).
    fakeHits = [makeHit("m.md", 1, 2, "fill 2", 0.9)];
    expect(await call("alpha 2", { sessionKey: "s2" })).toBe("");
    // s0's signature is evicted → its cue is injected again.
    fakeHits = [makeHit("m.md", 1, 2, "fill 0", 0.9)];
    expect(await call("alpha 0", { sessionKey: "s0" })).not.toBe("");
  });

  it("evicts the oldest signature after PER_TURN_RECALL_DEDUP_MAX_SIGNATURES per-session insertions", async () => {
    for (let t = 0; t < PER_TURN_RECALL_DEDUP_MAX_SIGNATURES + 1; t++) {
      fakeHits = [makeHit("m.md", 1, 2, `topic ${t}`, 0.9)];
      expect(await call(`beta ${t}`, { sessionKey: "one-session" })).not.toBe("");
    }
    // t0's signature was shifted out → re-injected.
    fakeHits = [makeHit("m.md", 1, 2, "topic 0", 0.9)];
    expect(await call("beta 0", { sessionKey: "one-session" })).not.toBe("");
    // The newest signature (t63) is still retained → still deduped.
    fakeHits = [makeHit("m.md", 1, 2, `topic ${PER_TURN_RECALL_DEDUP_MAX_SIGNATURES - 1}`, 0.9)];
    expect(await call(`beta ${PER_TURN_RECALL_DEDUP_MAX_SIGNATURES - 1}`, { sessionKey: "one-session" })).toBe("");
  });
});

/*
FNXC:RUFU172TwoLaneRecall 2026-08-31-19:41:
RUFU-172 two-lane focus-biased recall. A conversation focus biases ranking as a SECOND
"lane T" search whose hits lead the merged cue; it is NEVER a corpus filter.
These cases use the per-query `fakeSearch` seam (lane P = the derived keyword query
"diskutovali lcm", lane T = the focus-derived query) to assert the observable merge/ordering/
budget contract. The no-focus path must stay byte-identical to RUFU-120.

FNXC:MemoryFocusRecall 2026-09-03-00:21:
RUFU-173: lane T's query is the focus's content terms OR-joined (buildFocusRecallQuery) —
the deployed keyword backend keeps only the first word token of a phrase-less query, so the
earlier raw-phrase shape collapsed multi-word foci to one term.
*/
describe("two-lane focus-biased recall (RUFU-172)", () => {
  const LANE_P_QUERY = "diskutovali lcm"; // deriveRecallKeywords(TOPIC).join(" ")

  it("runs a single search with no focus (RUFU-120 path)", async () => {
    fakeSearch = () => [makeHit("m.md", 1, 2, "hit", 0.9)];
    await call(TOPIC);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe(LANE_P_QUERY);
  });

  it("focus='' collapses to a single search and a byte-identical no-focus cue", async () => {
    fakeHits = [makeHit("m.md", 1, 2, "same hit", 0.9)];
    const noFocus = await call(TOPIC, { sessionKey: "a" });
    const emptyFocus = await call(TOPIC, { sessionKey: "b", focus: "" });
    expect(emptyFocus).toBe(noFocus);
    // The empty focus adds no second search.
    expect(searchCalls.filter((c) => c.query === LANE_P_QUERY)).toHaveLength(2);
    expect(searchCalls).toHaveLength(2); // 1 per call, no lane T on either
  });

  it("runs two searches when a focus is set, lane T querying the OR-joined focus terms", async () => {
    fakeSearch = (query) =>
      query === LANE_P_QUERY ? [makeHit("p.md", 1, 2, "project hit", 0.9)] : [makeHit("t.md", 3, 4, "topic hit", 0.9)];
    const cue = await call(TOPIC, { focus: "pamäťové hladiny" });
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0].query).toBe(LANE_P_QUERY);
    // RUFU-173: both diacritic terms reach the backend as separate OR'd terms — the
    // keyword path's first-word-only collapse can no longer flatten the focus to one term.
    expect(searchCalls[1].query).toBe("pamäťové OR hladiny");
    // Lane T leads the merged cue.
    const entries = entryLines(cue);
    expect(entries[0]).toContain("t.md:3-4");
    expect(entries[1]).toContain("p.md:1-2");
  });

  it("lane T hits lead and lane P survives (topic-first, never crowd-out)", async () => {
    fakeSearch = (query) =>
      query === LANE_P_QUERY
        ? [makeHit("p1.md", 1, 2, "p one", 0.5), makeHit("p2.md", 1, 2, "p two", 0.4)]
        : [makeHit("t1.md", 1, 2, "t one", 0.9), makeHit("t2.md", 1, 2, "t two", 0.8)];
    const cue = await call(TOPIC, { focus: "focused" });
    const entries = entryLines(cue);
    // topK=3: lane T takes ≤topK-1=2 slots, lane P keeps ≥1.
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("t1.md");
    expect(entries[1]).toContain("t2.md");
    expect(entries[2]).toContain("p1.md");
    // topic-first ordering: both topic entries precede every project entry.
    const firstProjectIdx = entries.findIndex((l) => l.includes("p1.md") || l.includes("p2.md"));
    const lastTopicIdx = Math.max(...entries.map((l, i) => (l.includes("t1.md") || l.includes("t2.md") ? i : -1)));
    expect(lastTopicIdx).toBeLessThan(firstProjectIdx);
  });

  it("de-dupes by (path, lineStart): a project hit already surfaced by lane T is dropped", async () => {
    const shared = makeHit("shared.md", 42, 44, "shared snippet", 0.9);
    fakeSearch = (query) =>
      query === LANE_P_QUERY ? [shared, makeHit("p-only.md", 1, 2, "p only", 0.5)] : [shared];
    const cue = await call(TOPIC, { focus: "focused" });
    const occurrences = (cue.match(/shared\.md:42-44/g) ?? []).length;
    expect(occurrences).toBe(1);
    // lane T surfaced it, so it holds the lead slot.
    expect(entryLines(cue)[0]).toContain("shared.md:42-44");
  });

  it("caps lane T at ≤60% of the budget, keeps ≥1 lane P line, and never truncates mid-line", async () => {
    const big = "x".repeat(160);
    fakeSearch = (query) =>
      query === LANE_P_QUERY
        ? [makeHit("p1.md", 1, 2, "short project hit", 0.5), makeHit("p2.md", 1, 2, "other project hit", 0.4)]
        : [
            makeHit("t1.md", 1, 2, big, 0.9),
            makeHit("t2.md", 1, 2, big, 0.8),
            makeHit("t3.md", 1, 2, big, 0.7),
            makeHit("t4.md", 1, 2, big, 0.6),
          ];
    const cue = await call(TOPIC, { focus: "focused", topK: 4 });
    expect(cue.length).toBeLessThanOrEqual(PER_TURN_RECALL_CUE_MAX_CHARS);
    const entries = entryLines(cue);
    // Lane T lines are the leading block; their combined length honors the ≤60% share.
    const laneTEntries = entries.filter((l) => /`t\d+\.md:/.test(l));
    const laneTChars = laneTEntries.reduce((sum, l) => sum + l.length, 0);
    expect(laneTChars).toBeLessThanOrEqual(PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS);
    // A lane P line survives even though lane T overshot its share.
    expect(entries.some((l) => /`p\d+\.md:/.test(l))).toBe(true);
    // Every snippet line is a whole numbered entry (the whole-entry budget never leaves a
    // partial entry line behind).
    for (const line of entries) {
      expect(line).toMatch(/^\d+\. `[^`]+:\d+-\d+` — .+$/);
    }
  });

  /*
  FNXC:RUFU172LanePReservation 2026-09-01-21:56:
  Production-shaped budget regression. The short-path fixtures above cannot catch this one:
  with repo-length paths, snippet-capped entries, and a topic long enough to fill the header's
  80-char topic cap, lane T fills its 60% share and the 800-char budget then drops WHOLE
  TRAILING entries — which are lane P's. Before lane P's line was reserved inside the lane T
  allowance, the focused cue emitted here was topic-only: the focus had silently become the
  filter the operator asked against ("memory of the project, but aimed at the topic"). The
  invariant is that whole-project memory keeps its reserved line whenever it fits the budget.
  */
  it("reserves lane P's line inside the 800-char budget when lane T fills its share (production-shaped entries)", async () => {
    const longTopic = "Ahoj potrebujem aby si sa pozrel na tu konfiguraciu pamatovych hladin v tejto sekcii projektu";
    const big = "x".repeat(160);
    fakeSearch = (query) =>
      // RUFU-173: lane T arrives as the OR-joined focus query, not the raw phrase.
      query === "pamäťové OR hladiny"
        ? [
            makeHit("packages/core/src/memory/project-memory.ts", 12, 34, big, 0.9),
            makeHit("packages/core/src/memory/recall/per-turn-recall.ts", 12, 34, big, 0.8),
          ]
        : [makeHit("packages/dashboard/src/chat.ts", 12, 34, big, 0.5)];

    const cue = await call(longTopic, { focus: "pamäťové hladiny", sessionKey: "lane-p-reservation" });
    const entries = entryLines(cue);
    expect(cue.length).toBeLessThanOrEqual(PER_TURN_RECALL_CUE_MAX_CHARS);
    // Topic hits still lead the cue…
    expect(entries[0]).toContain("packages/core/src/memory/project-memory.ts:12-34");
    // …but whole-project memory keeps its reserved line instead of being evicted by the budget.
    expect(entries.some((line) => line.includes("packages/dashboard/src/chat.ts:12-34"))).toBe(true);
  });

  it("lane T search failure cannot suppress lane P", async () => {
    fakeSearch = (query, limit) => {
      if (query === LANE_P_QUERY) return [makeHit("p.md", 1, 2, "project hit survives", 0.9)];
      throw new Error("lane T backend exploded");
    };
    const cue = await call(TOPIC, { focus: "unstable focus" });
    expect(cue).not.toBe("");
    expect(cue).toContain("p.md:1-2");
    expect(cue).toContain("project hit survives");
  });

  /*
  FNXC:RUFU172TwoLaneRecall 2026-08-31-21:49:
  RUFU-172 spec case 4: lane T returning ZERO hits is the common topic-miss path and must
  degrade to the byte-identical whole-project cue — the focus may bias ranking, never
  remove the whole-project result set. Asserted against a live no-focus baseline call
  (not a frozen string) so the two cue-building paths cannot drift.
  */
  it("lane T returning 0 hits degrades to the byte-identical no-focus cue", async () => {
    fakeSearch = (query) => (query === LANE_P_QUERY ? [makeHit("p.md", 1, 2, "project hit", 0.9)] : []);
    const focused = await call(TOPIC, { sessionKey: "t-empty", focus: "focused" });
    const noFocus = await call(TOPIC, { sessionKey: "t-baseline" });
    // Lane T did run (one extra search) but contributed nothing, so the merged cue
    // must equal the no-focus cue byte-for-byte.
    expect(searchCalls).toHaveLength(3); // focused: P+T, no-focus: P
    expect(searchCalls.filter((c) => c.query !== LANE_P_QUERY)).toHaveLength(1);
    expect(focused).toBe(noFocus);
    expect(focused).toContain("p.md:1-2");
  });

  it("a rejected lane P search still honors the silent-skip contract even with a focus", async () => {
    fakeSearch = (query) => {
      if (query === LANE_P_QUERY) throw new Error("lane P exploded");
      return [makeHit("t.md", 1, 2, "topic hit", 0.9)];
    };
    // Lane P rejection is today's "" contract — lane T does not substitute for a failed
    // whole-project search.
    const cue = await call(TOPIC, { focus: "focused" });
    expect(cue).toBe("");
  });

  /*
  FNXC:RUFU172LanePReservation 2026-09-01-22:29:
  At topK=1 the crowd-out rule (lane T holds at most topK-1 slots when lane P has survivors)
  gives lane T zero slots: the whole-project reservation outranks the topical bias. This pins
  both halves — the cue never grows past topK, and the single line it does emit is the
  project lane's, so a single-slot recall cannot be captured by the focus.
  */
  it("topK=1 with both lanes populated yields exactly one entry line (the lane P reservation holds the only slot)", async () => {
    fakeSearch = (query) =>
      query === LANE_P_QUERY ? [makeHit("p.md", 1, 2, "project", 0.9)] : [makeHit("t.md", 1, 2, "topic", 0.9)];
    const cue = await call(TOPIC, { focus: "focused", topK: 1 });
    const entries = entryLines(cue);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("p.md:1-2");
    // Both searches still ran (the focus is a query, not a switch on search count).
    expect(searchCalls).toHaveLength(2);
  });

  it("dedup: same topic + focus twice suppresses the second cue; a changed focus re-emits", async () => {
    fakeSearch = (query) =>
      query === LANE_P_QUERY
        ? [makeHit("p.md", 1, 2, "project hit", 0.9)]
        : // RUFU-173: routing keys are the BUILT lane T queries ("focus one" → "focus OR one").
          query === "focus OR one"
          ? [makeHit("t1.md", 1, 2, "topic one", 0.9)]
          : [makeHit("t2.md", 1, 2, "topic two", 0.9)];
    const first = await call(TOPIC, { focus: "focus one", sessionKey: "dedup-sess" });
    expect(first).not.toBe("");
    // Same topic + same focus: identical cue text → deduped.
    const repeat = await call(TOPIC, { focus: "focus one", sessionKey: "dedup-sess" });
    expect(repeat).toBe("");
    // Same topic + CHANGED focus: different cue text → a fresh cue (signature moved).
    const changed = await call(TOPIC, { focus: "focus two", sessionKey: "dedup-sess" });
    expect(changed).not.toBe("");
    expect(changed).toContain("t2.md");
  });

  it("same topic, focus cleared, returns to the whole-project form (no lane T, P-only cue)", async () => {
    fakeSearch = (query) =>
      query === LANE_P_QUERY ? [makeHit("p.md", 1, 2, "project hit", 0.9)] : [makeHit("t.md", 1, 2, "topic hit", 0.9)];
    const focused = await call(TOPIC, { focus: "some focus", sessionKey: "s" });
    expect(focused).toContain("t.md");
    const cleared = await call(TOPIC, { focus: "all", sessionKey: "s" });
    // 'all' resolves to no focus → single search, project-only cue, and it differs from the
    // focused cue so the ledger re-emits it.
    expect(cleared).not.toBe(focused);
    expect(cleared).not.toContain("t.md");
    expect(cleared).toContain("p.md:1-2");
  });

  it("keeps every header/no-focus invariant when the focus is an all/* sentinel", async () => {
    fakeSearch = () => [makeHit("m.md", 1, 2, "hit", 0.9)];
    const noFocus = await call(TOPIC, { sessionKey: "n1" });
    for (const sentinel of ["all", "*", "   "]) {
      const c = await call(TOPIC, { sessionKey: `n-${sentinel}`, focus: sentinel });
      expect(c).toBe(noFocus);
    }
  });
});

/*
FNXC:MemoryFocusRecall 2026-09-03-00:21:
RUFU-173 — lane T query-shape table + round-trip against the REAL Stash keyword normalizer
(the deployed `stashVectorSearch`-off path). The crux: the builder's output survives
normalizeStashSearchQuery as MULTIPLE word terms while the raw focus phrase collapses to
exactly one — the automated statement of the bug the raw-phrase lane T had in the deployed
config. The diacritic half (the server strips non-ASCII without transliteration) is pinned
in memory-backend-stash.test.ts as observed behavior, not hidden.
*/
describe("lane T focus-query builder (RUFU-173)", () => {
  const OPERATOR_FOCUS = "memory projektu zamerala na tu temu";

  /** Word terms the backend keyword path actually keeps (the "OR" operator excluded). */
  const keptWordTerms = (normalized: string): string[] =>
    normalized.split(/\s+/).filter((t) => t !== "" && t !== "OR");

  it("maps focus text to the OR-joined query across the shape table", () => {
    const cases: Array<[string, string]> = [
      // Operator's real Slovak focus: stopwords (na/tu) and the 4th content term dropped
      // by the 3-term cap; word order preserved.
      [OPERATOR_FOCUS, "memory OR projektu OR zamerala"],
      // Diacritics must NOT be ASCII-mangled by core (the vector lane needs them intact).
      ["pamäťové hladiny", "pamäťové OR hladiny"],
      // Single usable token → no OR: the exact string RUFU-172 sent (raw passthrough).
      ["hladiny", "hladiny"],
      // A hyphen-joined word is ONE Unicode token → stays byte-identical (this is what
      // keeps engine fixture FOCUS_TEXT="deploy-ledger-focus" unchanged).
      ["deploy-ledger-focus", "deploy-ledger-focus"],
      // Duplicate tokens dedupe case-insensitively, first occurrence's casing wins.
      ["Memory Focus memory", "Memory OR Focus"],
      // A focus already carrying a literal uppercase OR: dropped as a separator (it is in
      // RECALL_STOPWORDS case-insensitively) and re-supplied by the joiner — semantics
      // unchanged for the backend.
      ["alpha OR beta", "alpha OR beta"],
      ["alpha or beta", "alpha OR beta"],
      // Stopword-only / short-token-only focus → nothing usable; lane T must be SKIPPED.
      ["na na sú", ""],
      ["is to a", ""],
      ["", ""],
    ];
    for (const [focus, expected] of cases) {
      expect(buildFocusRecallQuery(focus), `focus: ${JSON.stringify(focus)}`).toBe(expected);
    }
  });

  it("keeps every emitted term ≤24 chars and the joined query inside the ≤96-char budget", () => {
    const focus = [
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "supercalifragilisticexpialidocious",
      "konštruktívne-programovanie",
      "architektúra",
    ].join(" ");
    const terms = deriveFocusQueryTokens(focus);
    expect(terms.length).toBeLessThanOrEqual(RECALL_KEYWORD_MAX_TERMS);
    for (const term of terms) {
      expect(term.length).toBeLessThanOrEqual(RECALL_KEYWORD_MAX_TERM_LENGTH);
    }
    const query = buildFocusRecallQuery(focus);
    expect(query.length).toBeLessThanOrEqual(FOCUS_RECALL_QUERY_MAX_LENGTH);
    // No server-side token-boundary drop: normalization preserves the SAME term count
    // (terms themselves may arrive character-stripped — the residual diacritic limit).
    expect(keptWordTerms(normalizeStashSearchQuery(query))).toHaveLength(terms.length);
    // A pure-ASCII focus survives normalization with its terms EXACTLY.
    const asciiQuery = buildFocusRecallQuery("alpha bravo charlie delta echo");
    expect(keptWordTerms(normalizeStashSearchQuery(asciiQuery))).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("survives the real keyword normalizer with multiple terms where the raw focus collapses to one", () => {
    const built = buildFocusRecallQuery(OPERATOR_FOCUS);
    // The builder's shape survives normalization as multiple word terms…
    expect(normalizeStashSearchQuery(built)).toBe("memory OR projektu OR zamerala");
    expect(keptWordTerms(normalizeStashSearchQuery(built)).length).toBeGreaterThanOrEqual(2);
    // …while the RUFU-172 raw phrase is flattened to a single term — the bug, asserted.
    expect(normalizeStashSearchQuery(OPERATOR_FOCUS)).toBe("memory");
    expect(keptWordTerms(normalizeStashSearchQuery(OPERATOR_FOCUS))).toHaveLength(1);
  });

  it("keeps a multi-token lane T query ≥2 whitespace tokens so the vector branch gate holds", () => {
    // RUFU-126's vector path fires only for ≥2 whitespace tokens of the trimmed raw query;
    // the OR-joined shape must not silently regress that gate when stashVectorSearch is on.
    const query = buildFocusRecallQuery(OPERATOR_FOCUS);
    expect(query.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
    expect(buildFocusRecallQuery("pamäťové hladiny").trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });
});

/*
FNXC:MemoryFocusRecall 2026-09-03-00:21:
RUFU-173 Symptom Verification. The deployed config runs the Stash KEYWORD path
(`stashVectorSearch` off), so this fake backend emulates it with the REAL
normalizeStashSearchQuery applied to the query it receives, case-insensitive term
containment over a fixture corpus, and a score of distinct-matched-terms (a ts_rank
proxy) — no real server, no drift from the deployed contract. The reported symptom:
the operator's multi-word focus matched only via a NON-FIRST term, so RUFU-172's
raw-phrase lane T (normalized to that first term alone) retrieved nothing topical and
the cue was lane P only. The same test pins the counterfactual so the improvement is
asserted, not narrated.
*/
describe("lane T keyword-backend behavioral regression (RUFU-173 symptom)", () => {
  const OPERATOR_FOCUS = "memory projektu zamerala na tu temu"; // no diacritics: survives the server's ASCII strip
  const LANE_P_QUERY = deriveRecallKeywords(TOPIC).join(" "); // "diskutovali lcm"

  // Corpus fixture: the topic event matches a NON-FIRST focus term ("projektu") and never
  // the first ("memory"); the lane-P event matches only the lane-P keyword.
  const TOPIC_EVENT = { path: "memory/topic-notes.md", lineStart: 10, lineEnd: 12, text: "Hladiny projektu a ich vrstvy" };
  const LANE_P_EVENT = { path: "memory/lcm-log.md", lineStart: 3, lineEnd: 5, text: "Diskutovali sme o LCM B.1 a B.2" };

  /** Emulate the deployed Stash keyword path: real normalizer, term-containment match,
   *  score = distinct matched terms. The literal `OR` is the backend's operator, never a term. */
  function emulateKeywordSearch(query: string, limit = 8): MemorySearchResult[] {
    const terms = normalizeStashSearchQuery(query)
      .split(/\s+/)
      .filter((t) => t !== "" && t !== "OR")
      .map((t) => t.toLowerCase());
    return [TOPIC_EVENT, LANE_P_EVENT]
      .map((e) => {
        const haystack = e.text.toLowerCase();
        const matched = new Set(terms.filter((t) => haystack.includes(t))).size;
        return { e, matched };
      })
      .filter((s) => s.matched > 0)
      .sort((a, b) => b.matched - a.matched || a.e.path.localeCompare(b.e.path))
      .slice(0, limit)
      .map((s) => makeHit(s.e.path, s.e.lineStart, s.e.lineEnd, s.e.text, s.matched));
  }

  it("topic hit matched by a non-first focus term leads the cue under the keyword backend", async () => {
    fakeSearch = (query) => emulateKeywordSearch(query);
    const cue = await call(TOPIC, { focus: OPERATOR_FOCUS, sessionKey: "symptom-1" });
    // Lane T shipped the OR-joined shape, not the raw phrase.
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[1].query).toBe("memory OR projektu OR zamerala");
    const entries = entryLines(cue);
    // (b) the topic event is retrieved AND leads the cue, with a lane P line surviving.
    expect(entries[0]).toContain("memory/topic-notes.md:10-12");
    expect(entries.some((line) => line.includes("memory/lcm-log.md"))).toBe(true);
    // (c) counterfactual, pinned in-test: the raw focus phrase normalizes to exactly one
    // term, and that single-term shape matches ZERO corpus events — under RUFU-172's
    // raw-query lane T this cue had no topical line at all.
    const rawTerms = normalizeStashSearchQuery(OPERATOR_FOCUS)
      .split(/\s+/)
      .filter((t) => t !== "" && t !== "OR");
    expect(rawTerms).toHaveLength(1);
    expect(emulateKeywordSearch(OPERATOR_FOCUS)).toHaveLength(0);
  });

  it("skips lane T entirely for an unusable focus: one search, never an empty query, cue = no-focus cue", async () => {
    fakeSearch = (query) => (query === LANE_P_QUERY ? [makeHit("p.md", 1, 2, "project hit", 0.9)] : []);
    const stopwordFocus = await call(TOPIC, { focus: "na na sú", sessionKey: "unusable-1" });
    // Exactly one search — and NEVER an empty/whitespace query, which would hit Stash's
    // legacy broad-recall URL and inject non-topical hits into lane T's lead slot.
    expect(searchCalls).toHaveLength(1);
    for (const c of searchCalls) expect(c.query.trim()).not.toBe("");
    const noFocus = await call(TOPIC, { sessionKey: "unusable-2" });
    expect(stopwordFocus).toBe(noFocus);
    expect(stopwordFocus).toContain("p.md:1-2");
  });
});
