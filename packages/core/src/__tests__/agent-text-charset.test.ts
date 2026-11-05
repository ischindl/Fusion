import { describe, expect, it } from "vitest";
import {
  AGENT_TEXT_REJECTION_MAX_ENUMERATED,
  AgentTextCharsetError,
  assertAgentTextAllowed,
  describeAgentTextAllowlist,
  findDisallowedAgentTextChars,
  formatAgentTextRejection,
  isAgentTextAllowed,
} from "../index.js";
import {
  AgentTextCharsetError as AgentTextCharsetErrorGate,
  assertAgentTextAllowed as assertAgentTextAllowedGate,
  describeAgentTextAllowlist as describeAgentTextAllowlistGate,
  findDisallowedAgentTextChars as findDisallowedAgentTextCharsGate,
  formatAgentTextRejection as formatAgentTextRejectionGate,
  isAgentTextAllowed as isAgentTextAllowedGate,
} from "../index.gate.js";

/*
FNXC:AgentTextCharset 2026-11-04-12:08 (RUFU-307):
Every offender below is written as a `\uXXXX` escape, NOT as a raw letter. Two reasons, and both are
load-bearing: the repository's own gate (`scripts/check-nonlatin-tracked-text.mjs`, in pretest and the
blocking test:gate:static chain) refuses a tracked file holding a true non-Latin letter, and its documented
self-clean rule is "offenders are documented as U+XXXX escapes only". An escape still builds the REAL
character at runtime, so the assertion exercises the same code point the incident produced — the file bytes
just stay Latin-clean, which is how the incident evidence in AGENTS.md is written too.
*/

/** Build the incident string: `agent <U+521B><U+5EFA>uje proces` — the "-uje" ending survives, stem replaced. */
const incidentDescription = "agent \u521B\u5EFAuje proces";

describe("agent text charset allowlist", () => {
  it("accepts plain ASCII prose", () => {
    expect(isAgentTextAllowed("Fix lockfile drift in plugin workspaces")).toBe(true);
  });

  it("accepts LF and CRLF newlines", () => {
    expect(isAgentTextAllowed("line one\nline two")).toBe(true);
    expect(isAgentTextAllowed("line one\r\nline two")).toBe(true);
    expect(findDisallowedAgentTextChars("a\r\nb")).toEqual([]);
  });

  it("accepts a Slovak sentence carrying every allowed diacritic letter, lower and upper", () => {
    // Built from the two allowlist literals themselves, so a letter dropped from the allowlist fails here
    // rather than silently narrowing what agents may write (operator requirement 2).
    const lower = "áäčďéíĺľňóôŕšťúýž";
    const upper = "ÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ";
    for (const ch of lower) expect(isAgentTextAllowed(`písmeno ${ch}`)).toBe(true);
    for (const ch of upper) expect(isAgentTextAllowed(`${ch} na zaciatku`)).toBe(true);

    const sentence = "Príliš žlutosťouký kôň ugŕŤa buchty; ódnym deň uvidíš šťastnú dúhu.";
    expect(isAgentTextAllowed(sentence + lower + upper)).toBe(true);
    // Guards a real incident shape: legitimate Slovak prose must survive the fix unchanged.
    expect(findDisallowedAgentTextChars("Agent vytvára proces na karte")).toEqual([]);
  });

  it("rejects the incident Han code points that replaced a Slovak verb stem", () => {
    expect(isAgentTextAllowed(incidentDescription)).toBe(false);
    expect(findDisallowedAgentTextChars(incidentDescription).map((f) => f.codePoint))
      .toEqual(["U+521B", "U+5EFA"]);
  });

  it("rejects the Cyrillic homoglyph buried inside a Latin word", () => {
    // The self-generated evidence from the incident report: `kody` contaminated mid-word with U+044B.
    expect(isAgentTextAllowed("zapis s kody\u044B mimo latinky")).toBe(false);
    expect(findDisallowedAgentTextChars("kody\u044B")).toEqual([
      { index: 4, codePoint: "U+044B" },
    ]);
  });

  it("rejects the remaining code points named in the incident evidence", () => {
    expect(findDisallowedAgentTextChars("z\u0105kaz")).toEqual([{ index: 1, codePoint: "U+0105" }]);
    // The two code points measured on the shared-memory line that feeds every agent prompt.
    expect(findDisallowedAgentTextChars("stopa \u8DDF\u8FDB").map((f) => f.codePoint))
      .toEqual(["U+8DDF", "U+8FDB"]);
  });

  it("rejects emoji, em dash, and tab even though they render fine", () => {
    // Rejected by contract, not by accident: the allowlist has no slot for them.
    expect(findDisallowedAgentTextChars("hotovo \u{1F44D}")).toEqual([
      { index: 7, codePoint: "U+1F44D" },
    ]);
    expect(findDisallowedAgentTextChars("lomivena \u2014 ciarka")).toEqual([
      { index: 9, codePoint: "U+2014" },
    ]);
    expect(findDisallowedAgentTextChars("tab\u0009marker")).toEqual([
      { index: 3, codePoint: "U+0009" },
    ]);
  });

  it("reports 0-based first-occurrence indices and one finding per distinct code point", () => {
    const findings = findDisallowedAgentTextChars("ab\u521Bcd\u521Be\u5EFA");
    expect(findings).toEqual([
      { index: 2, codePoint: "U+521B" },
      { index: 7, codePoint: "U+5EFA" },
    ]);
  });

  it("keeps UTF-16 indices aligned across a surrogate pair", () => {
    // A BMP offender AFTER a pair must report the UTF-16 index, which is what `indexOf` returns.
    const findings = findDisallowedAgentTextChars("\u{1F44D}\u521B");
    expect(findings).toEqual([
      { index: 0, codePoint: "U+1F44D" },
      { index: 2, codePoint: "U+521B" },
    ]);
  });

  it("allows the empty string and an absent field", () => {
    expect(isAgentTextAllowed("")).toBe(true);
    expect(findDisallowedAgentTextChars("")).toEqual([]);
    expect(findDisallowedAgentTextChars(undefined)).toEqual([]);
    expect(findDisallowedAgentTextChars(null)).toEqual([]);
  });

  it("formats a rejection that names the offenders, counts them, and describes the allowlist", () => {
    const findings = findDisallowedAgentTextChars(incidentDescription);
    const text = formatAgentTextRejection("description", findings);
    expect(text).toContain('field "description"');
    expect(text).toContain("contains 2 disallowed code point(s): U+521B (index 6), U+5EFA (index 7)");
    expect(text).toContain(`Allowed: ${describeAgentTextAllowlist()}.`);
    expect(text).toContain("Rewrite with allowed characters and retry.");
    // The raw offending character never appears in the message an operator or agent reads.
    expect(text).not.toContain("\u521B");
  });

  it("caps the enumeration at 12 code points while still reporting the full total", () => {
    // 14 distinct disallowed code points, all in the CJK plane-1 extension block area.
    const many = Array.from({ length: 14 }, (_, i) => String.fromCodePoint(0x20000 + i)).join("x");
    const findings = findDisallowedAgentTextChars(many);
    expect(findings).toHaveLength(14);

    const text = formatAgentTextRejection("content", findings);
    expect(text).toContain("contains 14 disallowed code point(s)");
    expect(text).toContain(`+${14 - AGENT_TEXT_REJECTION_MAX_ENUMERATED} more`);
    const enumerated = (text.match(/U\+[0-9A-F]{4,5} \(index /g) ?? []).length;
    expect(enumerated).toBe(AGENT_TEXT_REJECTION_MAX_ENUMERATED);
  });

  it("throws AgentTextCharsetError from the assert helper and keeps it catchable by name", () => {
    expect(() => assertAgentTextAllowed("title", "karty \u5361")).toThrow(AgentTextCharsetError);
    try {
      assertAgentTextAllowed("title", "karty \u5361");
      throw new Error("assertAgentTextAllowed should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentTextCharsetError);
      const rejection = error as AgentTextCharsetError;
      expect(rejection.field).toBe("title");
      expect(rejection.rejection).toBe(formatAgentTextRejection("title", rejection.findings));
      expect(rejection.findings.map((f) => f.codePoint)).toEqual(["U+5361"]);
    }
    expect(() => assertAgentTextAllowed("title", "cista karta")).not.toThrow();
    expect(() => assertAgentTextAllowed("title", undefined)).not.toThrow();
  });

  it("exposes the same functions from BOTH barrels (index + index.gate stay in sync)", () => {
    // The engine-core vitest project resolves @fusion/core through index.gate.ts, so a gate-barrel
    // omission is a TypeError inside the merge gate that local lint/typecheck/build never see.
    expect(findDisallowedAgentTextCharsGate).toBe(findDisallowedAgentTextChars);
    expect(isAgentTextAllowedGate).toBe(isAgentTextAllowed);
    expect(formatAgentTextRejectionGate).toBe(formatAgentTextRejection);
    expect(assertAgentTextAllowedGate).toBe(assertAgentTextAllowed);
    expect(describeAgentTextAllowlistGate).toBe(describeAgentTextAllowlist);
    expect(AgentTextCharsetErrorGate).toBe(AgentTextCharsetError);
    expect(findDisallowedAgentTextCharsGate(incidentDescription).length).toBe(2);
    expect(describeAgentTextAllowlistGate()).toBe(describeAgentTextAllowlist());
  });
});
