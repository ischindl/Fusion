/**
 * RUFU-680 — the one task-search plan, decided on RAW whitespace tokens.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19:
 * Pure unit coverage for `planTaskSearch` / `isLiteralOnlySearchQuery`. No database and no timers: the plan is
 * a string decision, and it is the decision that used to answer a multi-word duplicate-scan query with a single
 * `%whole query%` substring match — zero rows — which every caller then read as "no duplicate exists".
 *
 * The suite deliberately pins BOTH halves of the contract, because the defect is only half of it:
 *   1. recall — a multi-token punctuated query must yield the same lexemes as its punctuation-free variant;
 *   2. exactness — a SINGLE punctuated raw token must stay literal-only and must not be broadened.
 * Half (2) is the promise RUFU-312 landed and it is why this change is a narrowing of scope rather than a
 * removal: `.txt`, `%`, `_`, `foo*` and `RUFU-276` keep answering literally, exactly as before.
 */
import { describe, expect, it } from "vitest";
import {
  isLiteralOnlySearchQuery,
  planTaskSearch,
  sanitizeSearchTokens,
} from "../async/async-search.js";

describe("planTaskSearch — empty and whitespace input", () => {
  it("yields an empty plan for an empty query so callers keep returning [] / total 0", () => {
    for (const query of ["", "   ", "\t\n "]) {
      const plan = planTaskSearch(query);
      expect(plan.rawTokens).toEqual([]);
      expect(plan.lexemes).toEqual([]);
      expect(plan.punctuatedTokenLiterals).toEqual([]);
      expect(plan.literalOnly).toBe(true);
      expect(isLiteralOnlySearchQuery(query)).toBe(true);
    }
  });
});

describe("planTaskSearch — a single punctuated raw token stays literal-only", () => {
  /*
  These are the KEEP-LIST shapes, each one raw token. Their membership is the contract this change had to
  preserve: broadening `.txt` to a `txt` lexeme would match a card that never contains the string the operator
  typed, because the `simple` dictionary stores `bonjour.txt` as ONE lexeme with no separate `txt` (measured at
  planning) and prefix matching is left-anchored, so `txt:*` could never recover that row lexically anyway.
  */
  const SINGLE_PUNCTUATED_TOKENS = [
    ".txt",
    ".TXT",
    "%",
    "_",
    "foo*",
    "RUFU-276",
    "fn_task_search",
    "nothingmatches_this",
    "zzzz-no-such-match-zzzz",
    "MEMORY.md",
    "%_",
  ];

  it.each(SINGLE_PUNCTUATED_TOKENS)("%s is literal-only with no per-token literal arms", (query) => {
    const plan = planTaskSearch(query);
    expect(plan.literalOnly).toBe(true);
    expect(isLiteralOnlySearchQuery(query)).toBe(true);
    // literalOnly means the whole-query literal IS the answer; a second arm per token would be a broadening.
    expect(plan.punctuatedTokenLiterals).toEqual([]);
  });

  it("records the lexemes of a literal-only query without letting them reach membership", () => {
    // `RUFU-276` does have word fragments, and the plan reports them — but membership never consults them,
    // which is the assertion that keeps `RUFU-276` from matching a card carrying only `RUFU` and `276`.
    expect(planTaskSearch("RUFU-276").lexemes).toEqual(["RUFU", "276"]);
    expect(planTaskSearch("RUFU-276").literalOnly).toBe(true);
  });

  it("treats a lexeme-less query as literal-only so it can never mean 'nothing required'", () => {
    for (const query of ["%", "_", "% _", "% _ %"]) {
      const plan = planTaskSearch(query);
      expect(plan.lexemes).toEqual([]);
      expect(plan.literalOnly).toBe(true);
    }
  });
});

describe("planTaskSearch — a single pure word token keeps its lexical arm", () => {
  it("does not mark a punctuation-free word or number literal-only, and adds no per-token arms", () => {
    for (const query of ["memory", "52", "duplicita"]) {
      const plan = planTaskSearch(query);
      expect(plan.literalOnly).toBe(false);
      expect(plan.punctuatedTokenLiterals).toEqual([]);
      expect(plan.lexemes).toEqual([query]);
    }
  });
});

describe("planTaskSearch — a multi-token punctuated query recovers lexical recall", () => {
  it("produces the SAME lexemes as its punctuation-free variant plus one literal arm", () => {
    // The measured symptom pair from the card: the punctuated row returned "No tasks matched" while the
    // space-variant returned a dozen cards. Identical lexemes is the structural reason they can no longer
    // disagree about which cards qualify.
    const punctuated = planTaskSearch("memory long-term budget over budget consolidation");
    const spaced = planTaskSearch("memory long term budget over budget consolidation");

    expect(new Set(punctuated.lexemes)).toEqual(new Set(spaced.lexemes));
    expect(new Set(punctuated.lexemes)).toEqual(
      new Set(["memory", "long", "term", "budget", "over", "consolidation"]),
    );
    expect(punctuated.literalOnly).toBe(false);
    expect(punctuated.punctuatedTokenLiterals).toEqual(["long-term"]);
  });

  it("splits a path token into word fragments while keeping the path itself as a literal arm", () => {
    const plan = planTaskSearch("packages/engine/src/self-healing.ts duplicate cards");

    expect(new Set(plan.lexemes)).toEqual(
      new Set(["packages", "engine", "src", "self", "healing", "ts", "duplicate", "cards"]),
    );
    expect(plan.literalOnly).toBe(false);
    expect(plan.punctuatedTokenLiterals).toEqual(["packages/engine/src/self-healing.ts"]);
  });

  it("keeps every punctuated raw token when a query carries more than one", () => {
    const plan = planTaskSearch("fn_task_search RUFU-276 duplicate scan");
    expect(plan.literalOnly).toBe(false);
    expect(plan.punctuatedTokenLiterals).toEqual(["fn_task_search", "RUFU-276"]);
    expect(new Set(plan.lexemes)).toEqual(
      new Set(["fn", "task", "search", "RUFU", "276", "duplicate", "scan"]),
    );
  });

  it("leaves only letters and digits in every lexeme, so no query can reach to_tsquery as an operator", () => {
    // Measured at planning: a raw `-` becomes the phrase-distance operator `<->` and a raw `|` becomes a real
    // OR inside to_tsquery. Fragments are the guarantee that neither can ever be authored by user input.
    for (const query of [
      "a|b memory",
      "x:* y",
      "foo&bar baz",
      "select(1) from",
      "long<->term search",
      "MEMORY.md rozpočet",
    ]) {
      for (const lexeme of planTaskSearch(query).lexemes) {
        expect(lexeme).toMatch(/^[\p{L}\p{N}]+$/u);
      }
    }
  });

  it("deduplicates lexemes so a repeated word appears once", () => {
    const plan = planTaskSearch("memory long-term memory long-term");
    expect(plan.lexemes.filter((lexeme) => lexeme === "memory")).toHaveLength(1);
    expect(plan.lexemes.filter((lexeme) => lexeme === "long")).toHaveLength(1);
  });
});

describe("planTaskSearch — language neutrality", () => {
  it("passes Slovak accented words through as whole lexemes, unstemmed", () => {
    // FTS_TS_CONFIG is 'simple': no stemming, no stopword list, no language analysis. The fix must not
    // introduce any, or Slovak and English membership parity breaks.
    const plan = planTaskSearch("duplicita kariet rozpočet konsolidácia");
    expect(plan.lexemes).toEqual(["duplicita", "kariet", "rozpočet", "konsolidácia"]);
    expect(plan.literalOnly).toBe(false);
    expect(plan.punctuatedTokenLiterals).toEqual([]);
  });

  it("keeps an accented word next to a punctuated token as its own lexeme", () => {
    const plan = planTaskSearch("MEMORY.md rozpočet konsolidácia agent memory");
    expect(plan.literalOnly).toBe(false);
    expect(plan.punctuatedTokenLiterals).toEqual(["MEMORY.md"]);
    // Fragments keep the case they were typed in: the plan never case-mangles a token, which is what makes
    // the lexical arm byte-identical to today's for a punctuation-free query. `to_tsquery` folds case itself.
    expect(new Set(plan.lexemes)).toEqual(
      new Set(["MEMORY", "md", "rozpočet", "konsolidácia", "agent", "memory"]),
    );
  });
});

describe("isLiteralOnlySearchQuery — the punctuation verdict is derived from RAW tokens", () => {
  /*
  FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
  This is the guard this revision exists for. `sanitizeSearchTokens` strips `"{}:*^+()`, so a plan built on
  sanitized output reads `foo*` as the pure word `foo`, calls it non-literal, and the card titled `foo` walks
  back in twice — through the lexical arm and through the cold-index LIKE fallback the gate no longer
  suppresses. That is the shipped regression at store-search.pg.test.ts:125. A future refactor onto sanitized
  tokens fails HERE, in a file with no database, instead of at the pg layer.
  */
  it("keeps foo* literal-only", () => {
    expect(planTaskSearch("foo*").literalOnly).toBe(true);
    expect(isLiteralOnlySearchQuery("foo*")).toBe(true);
  });

  it("would give a DIFFERENT answer if the verdict were built from sanitized tokens", () => {
    // The sanitizer really does erase the character the verdict is about...
    expect(sanitizeSearchTokens("foo*")).toEqual(["foo"]);
    // ...and a plan reading that erased answer reclassifies the query. Asserting the difference is what makes
    // the raw-token basis load-bearing rather than incidental.
    const sanitizedReading = planTaskSearch(sanitizeSearchTokens("foo*").join(" "));
    expect(sanitizedReading.literalOnly).toBe(false);
    expect(sanitizedReading.literalOnly).not.toBe(planTaskSearch("foo*").literalOnly);
  });

  it("agrees with the plan for every shape that a consumer reads", () => {
    for (const query of ["", "memory", "52", ".txt", "%_", "foo*", "RUFU-276", "legacy cleanup", "a-b c"]) {
      expect(isLiteralOnlySearchQuery(query)).toBe(planTaskSearch(query).literalOnly);
    }
  });

  it("does not mark a multi-token query literal-only merely because one token carries punctuation", () => {
    // The old rule fired on any punctuation anywhere in the trimmed query; that reach was the defect.
    expect(isLiteralOnlySearchQuery("long-term cleanup")).toBe(false);
    expect(isLiteralOnlySearchQuery("long-term")).toBe(true);
  });
});
