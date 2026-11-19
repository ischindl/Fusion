/**
 * RUFU-1012: lane P (per-turn proactive recall) must derive its Stash keywords from the same Unicode
 * word rule as every other memory lane. The scoring lanes were the reported symptom, but this lane
 * split on an ASCII-only class too, so a diacritic topic was chopped into fragments and then mostly
 * dropped by its own 3-character floor — the recall cue silently lost the operator's subject word.
 *
 * These cases pin the NEW truth; `per-turn-recall.test.ts` stays untouched as the no-regression
 * witness for RUFU-172's ranking, stopword and cap contract.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:55 (RUFU-1012).
 */
import { describe, expect, it } from "vitest";
import { deriveRecallKeywords } from "../recall/per-turn-recall.js";

describe("deriveRecallKeywords keeps a diacritic word whole", () => {
  it("derives whole Slovak words, not ASCII fragments", () => {
    // pre-fix tokens: [ktor, as, file, scope, je, operat, vna] -> the 3-char floor left
    // [scope, file, operat] and the subject word never reached the query.
    expect(deriveRecallKeywords("Ktorá časť file scope je operatívna")).toEqual([
      "operatívna",
      "ktorá",
      "scope",
    ]);
  });

  it("never emits a fragment of a word it could emit whole", () => {
    // pre-fix tokens for this topic: [zlucovanie, dlhodobej, pam, te, dat] — "pam"/"te"/"dat" are
    // what reached the Stash query instead of pamäte/dátach.
    const keywords = deriveRecallKeywords("dlhodobej pamäte o dátach");
    expect(keywords).toContain("pamäte");
    expect(keywords).toContain("dátach");
    for (const fragment of ["pam", "te", "dat", "dlhobo"]) {
      expect(keywords).not.toContain(fragment);
    }
  });

  it("keeps the documented AND-narrowing shape: longest-first, at most 3 terms", () => {
    const keywords = deriveRecallKeywords("zlucovanie dlhodobej pamäte");
    expect(keywords).toEqual(["zlucovanie", "dlhodobej", "pamäte"]);
    expect(keywords.join(" ").length).toBeLessThanOrEqual(64);
  });

  it("leaves the RUFU-172 mixed-language case exactly as its suite recorded it", () => {
    expect(deriveRecallKeywords("čo sme diskutovali o LCM B.1/B.2?")).toEqual(["diskutovali", "lcm"]);
  });

  it("still returns [] when no term survives the floor and the stopwords", () => {
    expect(deriveRecallKeywords("čo sme na to")).toEqual([]);
    expect(deriveRecallKeywords("...")).toEqual([]);
  });
});
