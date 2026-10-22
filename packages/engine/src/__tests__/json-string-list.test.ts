/**
 * FNXC:ReviewInputTypeSafety 2026-10-22-13:02 (RUFU-771):
 * Acceptance for the JSON-fed string list. The defect class is a TypeError thrown at a `.trim()` on an
 * element that persisted JSON delivered as null or undefined: it kills the lane before a reviewer exists
 * and before the review-input fingerprint is computed, so the surviving step row has no fingerprint at
 * all. Tests therefore assert that hostile input produces a NAMED REFUSAL and never throws, because a fix
 * that merely stopped throwing (silent drop, swallowed throw) would silently shrink a read-only MCP
 * allowlist or mint an approval over empty review input.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateReadonlyMcpAllowlist,
  parseTrimmedStringList,
} from "../executor/json-string-list.js";

describe("parseTrimmedStringList", () => {
  it("keeps non-empty strings and counts the elements it cannot use", () => {
    const parsed = parseTrimmedStringList([" alpha ", "beta", "", "  ", null, undefined, 7, {}]);
    expect(parsed.items).toEqual(["alpha", "beta"]);
    expect(parsed.rejectedCount).toBe(4);
  });

  it("treats a missing or non-array value as an empty list with no rejection", () => {
    for (const value of [undefined, null, "alpha", { a: 1 }, 42]) {
      expect(parseTrimmedStringList(value)).toEqual({ items: [], rejectedCount: 0 });
    }
  });

  it("never throws on the element shapes that used to crash the dispatch path", () => {
    for (const hostile of [[undefined], [null], [undefined, "ok"], [[["nested"]]], [Symbol.iterator ? 1 : 1]]) {
      expect(() => parseTrimmedStringList(hostile)).not.toThrow();
    }
  });
});

describe("read-only MCP allowlist decision", () => {
  it("leaves a non-readonly step untouched", () => {
    expect(evaluateReadonlyMcpAllowlist([undefined], false)).toEqual({ allowlist: [], rejectedCount: 0 });
  });

  it("passes through a well-formed allowlist", () => {
    expect(evaluateReadonlyMcpAllowlist([" filesystem ", "git", ""], true)).toEqual({
      allowlist: ["filesystem", "git"],
      rejectedCount: 0,
    });
  });

  it("refuses and names the field and count instead of running on a shrunk allowlist", () => {
    const decision = evaluateReadonlyMcpAllowlist(["filesystem", undefined, null], true);
    expect(decision.allowlist).toEqual([]);
    expect(decision.rejectedCount).toBe(2);
    expect(decision.diagnostic).toContain("readonlyMcpServers");
    expect(decision.diagnostic).toContain("2");
    expect(() => evaluateReadonlyMcpAllowlist([undefined], true)).not.toThrow();
  });
});
