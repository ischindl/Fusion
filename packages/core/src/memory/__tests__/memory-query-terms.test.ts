/**
 * Contract tests for the single memory tokenizer/matcher/window helper (RUFU-1012).
 *
 * The token table below is MEASURED, not invented: each expected array is what the named query
 * actually produced under the pre-fix ASCII class `/[^a-z0-9_-]+/i` versus the Unicode class
 * `/[^\p{L}\p{N}_-]+/u` when the defect was reported. Keep the pre-fix column in the comments —
 * it is the evidence for why the assertion exists, and deleting it turns these into tautologies.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012).
 */
import { describe, expect, it } from "vitest";
import {
  MEMORY_QUERY_MIN_TERM_LENGTH,
  MEMORY_QUERY_TOKEN_BOUNDARY,
  MEMORY_SNIPPET_STRIDE_LINES,
  MEMORY_SNIPPET_WINDOW_LINES,
  countMemoryTermMatches,
  deriveMemoryQueryTerms,
  dropLineOverlappingMemoryHits,
} from "../memory-query-terms.js";

/** The English prose from the reported repro: a block whose only shared word was `test`. */
const HARD_RULES_CORPUS =
  "Hard Rules - never start test servers on it. The system route delete rate template is fine.";

describe("deriveMemoryQueryTerms — Unicode word boundaries", () => {
  it("keeps a diacritic letter inside its word instead of shredding the word", () => {
    // pre-fix ASCII: ["ktor","as","file","scope","je","operat","vna"]
    expect(deriveMemoryQueryTerms("Ktorá časť file scope je operatívna")).toEqual([
      "ktorá",
      "časť",
      "file",
      "scope",
      "je",
      "operatívna",
    ]);
  });

  it("does not turn one Slovak word into two scoring fragments", () => {
    // pre-fix ASCII: ["zlucovanie","dlhodobej","pam","te"] — `pam` + `te` were the false-positive engine
    expect(deriveMemoryQueryTerms("zlucovanie dlhodobej pamäte")).toEqual([
      "zlucovanie",
      "dlhodobej",
      "pamäte",
    ]);
    // pre-fix ASCII: ["pam","taj","syst","move","pravidlo"]
    expect(deriveMemoryQueryTerms("pamätaj systémove pravidlo")).toEqual([
      "pamätaj",
      "systémove",
      "pravidlo",
    ]);
  });

  it("never loses a whole word just because its first letter is accented", () => {
    // pre-fix ASCII dropped `čo` entirely: both ASCII fragments are under the length floor.
    expect(deriveMemoryQueryTerms("čo je 1122")).toEqual(["čo", "je", "1122"]);
  });

  it("leaves an ASCII query exactly as it was before the change (no English regression)", () => {
    expect(deriveMemoryQueryTerms("Post-merge verification gate")).toEqual([
      "post-merge",
      "verification",
      "gate",
    ]);
    expect(deriveMemoryQueryTerms("PG-gated test harness recipe")).toEqual([
      "pg-gated",
      "test",
      "harness",
      "recipe",
    ]);
  });

  it("keeps hyphen-joined compounds as ONE token, both here and on the candidate side", () => {
    expect(deriveMemoryQueryTerms("project-wide refactor")).toEqual(["project-wide", "refactor"]);
    expect(deriveMemoryQueryTerms("project-wide")[0]).toBe("project-wide");
    // The matcher must agree with the query side, or a whole token would never match.
    expect(countMemoryTermMatches("the project-wide refactor landed", deriveMemoryQueryTerms("project-wide refactor"))).toBe(2);
  });

  it("dedupes a repeated term keeping first occurrence order", () => {
    expect(deriveMemoryQueryTerms("pamäte pamäte backend pamäte")).toEqual(["pamäte", "backend"]);
  });

  it("returns [] for a query with no usable tokens", () => {
    expect(deriveMemoryQueryTerms("")).toEqual([]);
    expect(deriveMemoryQueryTerms("   ")).toEqual([]);
    expect(deriveMemoryQueryTerms("*")).toEqual([]);
    expect(deriveMemoryQueryTerms("...")).toEqual([]);
    expect(deriveMemoryQueryTerms("?!.,;")).toEqual([]);
    // single letters are under the floor, and the floor is deliberately still 2
    expect(deriveMemoryQueryTerms("a b 1")).toEqual([]);
    expect(MEMORY_QUERY_MIN_TERM_LENGTH).toBe(2);
  });

  it("is total over non-string input", () => {
    expect(deriveMemoryQueryTerms(undefined)).toEqual([]);
    expect(deriveMemoryQueryTerms(null)).toEqual([]);
    expect(deriveMemoryQueryTerms(42)).toEqual([]);
  });

  it("compares a composed query against a decomposed corpus (NFC)", () => {
    const composed = deriveMemoryQueryTerms("pamäte");
    const decomposedCorpus = "dlhodobá pamäte".normalize("NFD");
    expect(decomposedCorpus).not.toBe("dlhodobá pamäte");
    expect(countMemoryTermMatches(decomposedCorpus, composed)).toBe(1);
  });

  it("exposes one boundary constant for every lane to share", () => {
    expect(MEMORY_QUERY_TOKEN_BOUNDARY.flags).toContain("u");
    expect("operatívna".split(MEMORY_QUERY_TOKEN_BOUNDARY)).toEqual(["operatívna"]);
  });
});

describe("countMemoryTermMatches — word level, never substring", () => {
  it("a two-character fragment cannot cash in against unrelated English prose", () => {
    // The reported defect: `normalized.includes("te")` was true for system/route/delete/rate/template.
    expect(HARD_RULES_CORPUS.includes("te")).toBe(true);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["te"])).toBe(0);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["pam"])).toBe(0);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["zlu"])).toBe(0);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["ovanie"])).toBe(0);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["syst"])).toBe(0);
  });

  it("a whole word present in the text scores, once per distinct term", () => {
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["test"])).toBe(1);
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, ["test", "system"])).toBe(2);
    // one point per DISTINCT term, not per occurrence — repeated terms add nothing
    expect(countMemoryTermMatches("test test test", ["test"])).toBe(1);
  });

  it("scores zero when the words simply are not there", () => {
    expect(countMemoryTermMatches(HARD_RULES_CORPUS, deriveMemoryQueryTerms("pamätaj systémove pravidlo"))).toBe(0);
    expect(countMemoryTermMatches("anything at all", [])).toBe(0);
    expect(countMemoryTermMatches("", ["test"])).toBe(0);
  });

  it("does not match a query word that is only a prefix or infix of a corpus word", () => {
    expect(countMemoryTermMatches("the retrieval pipeline", ["retrieve"])).toBe(0);
    expect(countMemoryTermMatches("unbreakable", ["break"])).toBe(0);
  });
});

describe("window geometry constants", () => {
  it("stride equals window, which IS the non-overlapping invariant", () => {
    expect(MEMORY_SNIPPET_WINDOW_LINES).toBe(12);
    expect(MEMORY_SNIPPET_STRIDE_LINES).toBe(12);
    expect(MEMORY_SNIPPET_STRIDE_LINES).toBe(MEMORY_SNIPPET_WINDOW_LINES);
  });
});

describe("dropLineOverlappingMemoryHits", () => {
  const hit = (path: string, lineStart: number, lineEnd: number) => ({ path, lineStart, lineEnd, tag: `${path}:${lineStart}` });

  it("drops a later window of the same path that shares a line, keeping the first", () => {
    const hits = [hit("a.md", 97, 108), hit("a.md", 105, 116), hit("a.md", 113, 124)];
    expect(dropLineOverlappingMemoryHits(hits).map((h) => h.tag)).toEqual(["a.md:97", "a.md:113"]);
  });

  it("keeps every disjoint window and preserves input order (it is not a sorter)", () => {
    const hits = [hit("a.md", 13, 24), hit("a.md", 1, 12), hit("a.md", 25, 36)];
    expect(dropLineOverlappingMemoryHits(hits).map((h) => h.tag)).toEqual(["a.md:13", "a.md:1", "a.md:25"]);
  });

  it("never compares line numbers across different paths", () => {
    const hits = [hit(".fusion/agent-memory/x/MEMORY.md", 1, 12), hit(".fusion/memory/MEMORY.md", 1, 12)];
    expect(dropLineOverlappingMemoryHits(hits)).toHaveLength(2);
  });

  it("drops adjacency-by-one-line but not a clean boundary", () => {
    expect(dropLineOverlappingMemoryHits([hit("a.md", 1, 12), hit("a.md", 12, 20)])).toHaveLength(1);
    expect(dropLineOverlappingMemoryHits([hit("a.md", 1, 12), hit("a.md", 13, 20)])).toHaveLength(2);
  });

  it("survives unusable line numbers without inventing a duplicate-free claim", () => {
    const hits = [
      { path: "a.md", lineStart: Number.NaN, lineEnd: Number.NaN },
      { path: "a.md", lineStart: 1, lineEnd: 1 },
    ];
    expect(dropLineOverlappingMemoryHits(hits)).toHaveLength(1);
    // inverted range is read as a range, not dropped
    expect(dropLineOverlappingMemoryHits([hit("a.md", 20, 5), hit("a.md", 30, 40)])).toHaveLength(2);
  });

  it("returns a new array and does not mutate the input", () => {
    const hits = [hit("a.md", 1, 12), hit("a.md", 5, 16)];
    const result = dropLineOverlappingMemoryHits(hits);
    expect(result).not.toBe(hits);
    expect(hits).toHaveLength(2);
  });
});
