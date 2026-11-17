import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { resolveBypassReviewCopy } from "../taskRetryCopy";

/*
FNXC:PostMergeGateOperatorWaiver 2026-11-14-02:10 (RUFU-599 Step 7, reproductions 1 and 2 / RUFU-474):
The waiver copy resolver is the single vocabulary for an audited operator decision, so this file pins both
halves of the rule: the two classes that already had words keep them byte-for-byte (a renamed audit prompt is a
regression for anyone reading a card written last month), and the two classes the derivation newly answers
(`verdictless-skipped`, and anything on the post-merge side) must never be described as a failed pre-merge row.
*/

const t = ((
  _key: string,
  fallback: string,
  options?: Record<string, unknown>,
) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_m, token: string) => String(options?.[token] ?? ""))) as unknown as TFunction<"app">;

describe("resolveBypassReviewCopy", () => {
  it("keeps the two existing classes word-for-word", () => {
    const failed = resolveBypassReviewCopy(t, { kind: "failed" });
    expect(failed.label).toBe("Bypass failed review");
    expect(failed.promptMessage).toBe("Reason for bypassing the failed pre-merge review step (required, audit-logged):");
    expect(failed.success("FN-1")).toBe("Bypassed failed review lane for FN-1");

    const absent = resolveBypassReviewCopy(t, { kind: "absent" });
    expect(absent.label).toBe("Bypass unrun review gate");
    expect(absent.promptMessage).toBe("Reason for bypassing the review gate that never ran (required, audit-logged):");
    expect(absent.success("FN-1")).toBe("Bypassed unrun review gate for FN-1");
  });

  it("names a verdict-less carrier as what it is, never as a failed review", () => {
    const copy = resolveBypassReviewCopy(t, { kind: "verdictless-skipped" });
    expect(copy.label).toContain("without a verdict");
    expect(copy.promptMessage).toContain("without a verdict");
    expect(copy.promptMessage).toContain("audit-logged");
    expect(copy.label).not.toContain("failed");
    expect(copy.promptMessage).not.toContain("failed");
  });

  it("never calls a post-merge gate a pre-merge step", () => {
    for (const kind of ["absent", "verdictless-skipped"] as const) {
      const copy = resolveBypassReviewCopy(t, { kind, phase: "post-merge" });
      expect(copy.label).toContain("post-merge");
      expect(copy.promptMessage).toContain("post-merge");
      expect(copy.success("SANE-482")).toContain("post-merge");
      expect(copy.success("SANE-482")).toContain("SANE-482");
      expect(copy.label).not.toMatch(/pre-merge|failed/);
    }
  });

  it("keeps the two post-merge classes distinguishable", () => {
    const unrun = resolveBypassReviewCopy(t, { kind: "absent", phase: "post-merge" });
    const owed = resolveBypassReviewCopy(t, { kind: "verdictless-skipped", phase: "post-merge" });
    expect(unrun.label).not.toBe(owed.label);
    expect(unrun.promptMessage).toContain("never ran");
    expect(owed.promptMessage).toContain("without a verdict");
  });
});

/*
FNXC:ReviewBypassDecline 2026-11-17-18:50 (RUFU-583, folded from RUFU-243):
The DECLINE copy contract lives in taskRetryCopy.bypass-decline.test.ts, beside its own resolver arms, not here.
This file states what an operator is OFFERED (RUFU-599); that one states what an operator is REFUSED (RUFU-243). Two
different operator questions, and the operator's fold-in instruction keeps them as two separately failing tests rather
than one file whose green pass would hide a red half.
*/
