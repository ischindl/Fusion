import { describe, expect, it } from "vitest";
import { parseNoOpCompletionMarker } from "../merge/no-op-completion-marker.js";

describe("parseNoOpCompletionMarker", () => {
  it.each([
    ["PREMISE STALE: already implemented on HEAD", "premise-stale"],
    ["NO-OP: existing behavior already satisfies the request", "no-op"],
    ["NOOP: no code changes are needed", "no-op"],
    ["DUPLICATE: FN-6239 covers the same requested behavior", "duplicate"],
    ["REDUNDANT: FN-6239 already landed this", "redundant"],
  ] as const)("recognizes leading prefix %s", (summary, kind) => {
    const marker = parseNoOpCompletionMarker(summary);

    expect(marker).toMatchObject({ kind });
    expect(marker?.reason.length).toBeGreaterThan(0);
  });

  it("matches prefixes case-insensitively", () => {
    expect(parseNoOpCompletionMarker("no-op: verified unchanged")?.kind).toBe("no-op");
    expect(parseNoOpCompletionMarker("duplicate: fn-6239 already covers it")).toMatchObject({
      kind: "duplicate",
      canonicalId: "FN-6239",
    });
  });

  it("requires the marker at the start of the summary", () => {
    expect(parseNoOpCompletionMarker("Verified existing behavior; NO-OP: no changes needed")).toBeNull();
    expect(parseNoOpCompletionMarker("The task is DUPLICATE: FN-6239")).toBeNull();
  });

  it("returns null for empty, undefined, and ordinary prose", () => {
    expect(parseNoOpCompletionMarker(undefined)).toBeNull();
    expect(parseNoOpCompletionMarker("")).toBeNull();
    expect(parseNoOpCompletionMarker("Implemented the requested behavior and verified tests.")).toBeNull();
  });

  it("captures duplicate and redundant canonical task ids", () => {
    expect(parseNoOpCompletionMarker("DUPLICATE: FN-6239 existing QuickChatFAB tests cover this")).toMatchObject({
      kind: "duplicate",
      canonicalId: "FN-6239",
      reason: "FN-6239 existing QuickChatFAB tests cover this",
    });
    expect(parseNoOpCompletionMarker("REDUNDANT: covered by fn-42 after rebase")).toMatchObject({
      kind: "redundant",
      canonicalId: "FN-42",
    });
  });

  it("does not require a canonical id for duplicate and redundant summaries", () => {
    expect(parseNoOpCompletionMarker("DUPLICATE: same request already exists on HEAD")).toEqual({
      kind: "duplicate",
      reason: "same request already exists on HEAD",
    });
  });

  /*
  FNXC:DuplicateIntake 2026-11-18-05:59 (RUFU-730):
  The symptom this card removes: on a project whose `settings.taskPrefix` is not `FN`, a legitimate
  duplicate close named no canonical card, so the redirect never happened and the card closed as an
  ordinary zero-commit close. These are real executor summary strings, not a stubbed helper output.
  */
  it("names the canonical card for a non-FN project prefix", () => {
    expect(parseNoOpCompletionMarker("DUPLICATE: RUFU-318 already specifies the read-back contract")).toMatchObject({
      kind: "duplicate",
      canonicalId: "RUFU-318",
    });
    expect(parseNoOpCompletionMarker("REDUNDANT: covered by sane-452 after rebase")).toMatchObject({
      kind: "redundant",
      canonicalId: "SANE-452",
    });
  });

  it("still upper-cases a lower-case non-FN id, as it already did for fn-ids", () => {
    expect(parseNoOpCompletionMarker("duplicate: rufu-318 covers it")).toMatchObject({ canonicalId: "RUFU-318" });
  });

  it("invents no canonical id out of a compound or out of prose", () => {
    // The generalization must not widen WHAT counts as an id beyond the canonical grammar: `XFN-123Y`
    // is not `FN-123`, and "step-3-build" is not a card named `STEP-3`.
    expect(parseNoOpCompletionMarker("DUPLICATE: XFN-1Y duplicates it")).toEqual({
      kind: "duplicate",
      reason: "XFN-1Y duplicates it",
    });
    expect(parseNoOpCompletionMarker("DUPLICATE: step-3-build is the same work")).not.toHaveProperty("canonicalId");
  });

  it("keeps refusing a mid-summary sentinel whatever the prefix", () => {
    expect(parseNoOpCompletionMarker("The task is DUPLICATE: RUFU-318")).toBeNull();
  });
});
