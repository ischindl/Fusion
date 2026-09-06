/**
 * RUFU-128 Step 6 — memory-recall service tests.
 *
 * The thin engine service (`recallForChatTurn`) wraps the RUFU-120 core with
 * session key `cli:<sessionId>` and the caller's fresh settings. All cases run
 * against in-memory fake backends with UNIQUE type names (registry pollution
 * pattern of per-turn-recall.test.ts) — no real Stash/qmd process is spawned.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_PRE_STEERING_MARKER,
  __resetPerTurnRecallDedupForTests,
  registerMemoryBackend,
  type MemorySearchResult,
  type Settings,
} from "@fusion/core";
import { recallForChatTurn } from "../memory-recall-service.js";

const ROOT = mkdtempSync(join(tmpdir(), "rufu128-recall-service-fake-project-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const TOPIC = "what did we decide about the LCM steering marker";

function makeSettings(overrides: Partial<Settings> = {}): Partial<Settings> {
  return {
    memoryEnabled: true,
    memoryBackendType: "rufu128-svc-fake",
    memoryPerTurnRecallEnabled: true,
    memoryPerTurnRecallTopK: 3,
    ...overrides,
  };
}

function makeHit(path: string, lineStart: number, lineEnd: number, snippet: string, score: number): MemorySearchResult {
  return { path, lineStart, lineEnd, snippet, score, backend: "rufu128-svc-fake" };
}

let fakeHits: MemorySearchResult[] = [];
// RUFU-172: per-query routing + query capture, to prove a focus reaches the core's lane-T
// search (the service forwards it verbatim; gating is the caller's job — see
// runtime-chat-recall-wiring.test.ts).
//
// FNXC:MemoryFocusRecall 2026-09-03-00:21: RUFU-173 — lane T's backend query is
// buildFocusRecallQuery(focus) (content terms OR-joined), not the raw focus phrase, so
// fixtures key on the built query string.
let fakeSearch: ((query: string) => MemorySearchResult[]) | null = null;
let searchQueries: string[] = [];

beforeAll(() => {
  const capabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };
  const read = async (): Promise<{ content: string; exists: boolean; backend: string }> => ({
    content: "",
    exists: false,
    backend: "rufu128-svc-fake",
  });
  const write = async (): Promise<never> => {
    throw new Error("read-only fake");
  };
  registerMemoryBackend({
    type: "rufu128-svc-fake",
    name: "RUFU-128 service test fake backend",
    capabilities,
    read,
    write,
    search: async (_rootDir, opts) => {
      searchQueries.push(opts.query);
      if (fakeSearch) return fakeSearch(opts.query);
      return fakeHits;
    },
  });
  registerMemoryBackend({
    type: "rufu128-svc-fake-reject",
    name: "RUFU-128 service test rejecting backend",
    capabilities,
    read,
    write,
    search: async () => {
      throw new Error("backend search exploded");
    },
  });
});

beforeEach(() => {
  fakeHits = [];
  fakeSearch = null;
  searchQueries = [];
  __resetPerTurnRecallDedupForTests();
});

const call = (overrides: { topic?: string; sessionId?: string; settings?: Partial<Settings>; focus?: string } = {}) =>
  recallForChatTurn({
    rootDir: ROOT,
    topic: overrides.topic ?? TOPIC,
    sessionId: overrides.sessionId ?? "session-1",
    settings: overrides.settings ?? makeSettings(),
    focus: overrides.focus,
  });

describe("recallForChatTurn (RUFU-128 Step 6)", () => {
  it("returns the cue for a populated backend (pre-steering marker + numbered hits)", async () => {
    fakeHits = [makeHit("docs/notes.md", 10, 12, "the LCM marker was decided here", 1.5)];
    const cue = await call();
    expect(cue.length).toBeGreaterThan(0);
    expect(cue).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(cue).toContain("docs/notes.md:10-12");
    expect(cue).toContain("the LCM marker was decided here");
  });

  it("silent skip → empty string: per-turn recall disabled", async () => {
    fakeHits = [makeHit("docs/notes.md", 1, 2, "snippet", 1)];
    expect(await call({ settings: makeSettings({ memoryPerTurnRecallEnabled: false }) })).toBe("");
  });

  it("silent skip → empty string: project memory disabled", async () => {
    fakeHits = [makeHit("docs/notes.md", 1, 2, "snippet", 1)];
    expect(await call({ settings: makeSettings({ memoryEnabled: false }) })).toBe("");
  });

  it("silent skip → empty string: keyword-yielding-empty topic (no backend call)", async () => {
    fakeHits = [makeHit("docs/notes.md", 1, 2, "snippet", 1)];
    // Stopword-only / short tokens → no keywords → "" without touching the backend.
    expect(await call({ topic: "a b the it" })).toBe("");
  });

  it("silent skip → empty string: backend search rejects", async () => {
    expect(
      await call({ settings: makeSettings({ memoryBackendType: "rufu128-svc-fake-reject" }) }),
    ).toBe("");
  });

  it("dedup: second identical prompt in the same session key → empty string; different session key → cue again", async () => {
    fakeHits = [makeHit("docs/notes.md", 10, 12, "the LCM marker was decided here", 1.5)];

    const first = await call({ sessionId: "session-A" });
    expect(first.length).toBeGreaterThan(0);

    // Same session key (cli:session-A), identical cue signature → deduped.
    expect(await call({ sessionId: "session-A" })).toBe("");

    // A different session still gets its own cue (dedup is session-scoped).
    const other = await call({ sessionId: "session-B" });
    expect(other).toBe(first);
  });

  /*
  FNXC:RUFU172CliFocusLane 2026-08-31-19:41:
  RUFU-172: the service forwards an already-gated focus to the core verbatim; the core's
  canonical resolver still collapses ""/whitespace to "no focus", so the byte-identical
  single-search path is preserved for every non-focus caller.
  */
  it("forwards a focus: a second search queries the OR-joined focus terms; no focus → one search", async () => {
    // A focus string no keyword derivation of TOPIC can equal, so the lane-T query
    // identity assertion is unambiguous. RUFU-173: the two content terms reach the
    // backend OR-joined (hyphenated tokens stay one term).
    const FOCUS = "xterm-ledger focus";
    const LANE_T_QUERY = "xterm-ledger OR focus";
    fakeSearch = (query) =>
      query === LANE_T_QUERY
        ? [makeHit("notes/focus.md", 1, 2, "focus lane hit", 2)]
        : [makeHit("docs/notes.md", 10, 12, "the LCM marker was decided here", 1.5)];

    const focused = await call({ sessionId: "svc-focus", focus: FOCUS });
    expect(searchQueries.length).toBe(2);
    expect(searchQueries[1]).toBe(LANE_T_QUERY);
    expect(focused).toContain("notes/focus.md");

    // No focus (and the "all" sentinel, which the core collapses to no-focus) → one search.
    searchQueries = [];
    const unfocused = await call({ sessionId: "svc-nofocus" });
    expect(searchQueries.length).toBe(1);
    expect(unfocused).toContain("docs/notes.md");

    searchQueries = [];
    await call({ sessionId: "svc-sentinel", focus: "all" });
    expect(searchQueries.length).toBe(1);
  });
});
