import { describe, expect, it } from "vitest";
import {
  CONTENT_UNVERIFIABLE_REFUSAL,
  describeUncommittedWorkRefusal,
  evaluateZeroCommitLandingProof,
  hasDurableLandingProof,
  worktreeContentCounts,
  type LandingProof,
  type WorktreeContentClassification,
  type ZeroCommitLandingProofInput,
  type ZeroCommitLandingProofVerdict,
} from "../merge/zero-commit-landing-proof.js";

/*
FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
The classification table for the shared durable landing-proof predicate. RUFU-262 is the motivating
row: zero commits ahead of `main`, uncommitted files still in the worktree, card standing in `done`.
Each case below is one row of the table the predicate must answer identically at all four
finalization lanes.

FNXC:ZeroCommitDeliveryProof 2026-09-26-02:00 (RUFU-274) Step 1/2 gap-fill:
`worktreeContent` became a discriminated evidence object rather than a bare state label, because the
refusal has to carry modified/untracked counts that came from the SAME git observation that produced the
classification — a second `git status` could disagree with the first, and a hold whose counts do not
match the tree that triggered it is unauditable. Landing proof likewise became a declared shape
(`hasDurableLandingProof` derives it from the fields a lane actually records) so a lane cannot invent a
private proof form.
*/

const zeroAhead = { aheadCommitCount: 0 } satisfies Partial<ZeroCommitLandingProofInput>;
const landedSha = "0123456789abcdef0123456789abcdef01234567";
const landedProof = { kind: "durable-commit-sha", sha: landedSha } satisfies LandingProof;

function dirty(modifiedCount = 1, untrackedCount = 0): WorktreeContentClassification {
  return { state: "deliverable", modifiedCount, untrackedCount, paths: ["src/a.ts"] };
}

const CLEAN: WorktreeContentClassification = { state: "clean" };
const UNVERIFIABLE: WorktreeContentClassification = { state: "unverifiable", probeDetail: "status-probe-failed" };
const ABSENT: WorktreeContentClassification = { state: "absent" };

describe("evaluateZeroCommitLandingProof — classification table", () => {
  it("never reaches a proven class for a dirty checkout, whatever else is true", () => {
    const cases: ZeroCommitLandingProofInput[] = [
      { ...zeroAhead, worktreeContent: dirty() },
      { ...zeroAhead, worktreeContent: dirty(), landingProof: landedProof },
      { ...zeroAhead, worktreeContent: dirty(), noCommitsExpected: true },
      { ...zeroAhead, worktreeContent: dirty(), presentsNoOp: true },
      { ...zeroAhead, worktreeContent: dirty(0, 4) },
      { ...zeroAhead, worktreeContent: dirty(), landingProof: landedProof, noCommitsExpected: true, presentsNoOp: true },
    ];
    for (const input of cases) {
      const verdict = evaluateZeroCommitLandingProof(input);
      expect(verdict.kind, JSON.stringify(input)).toBe("refuse");
      expect((verdict as Extract<ZeroCommitLandingProofVerdict, { kind: "refuse" }>).code, JSON.stringify(input)).toBe("uncommitted-work");
    }
  });

  it("classifies every case into exactly one of proven / proven-legitimate-noop / refuse / retry", () => {
    const table: Array<[string, ZeroCommitLandingProofInput, ZeroCommitLandingProofVerdict["kind"]]> = [
      ["commits ahead of the integration branch", { aheadCommitCount: 3, worktreeContent: dirty() }, "proven"],
      // An unreadable count is the ABSENCE of proof, so it can never license the finalize: with deliverable
      // content in the tree this is RUFU-262's second shape (branch ref gone, work surviving only uncommitted).
      ["ahead count unreadable, deliverable content", { aheadCommitCount: null, worktreeContent: dirty() }, "refuse"],
      ["zero ahead, deliverable content", { ...zeroAhead, worktreeContent: dirty() }, "refuse"],
      ["zero ahead, content unclassifiable, no proof", { ...zeroAhead, worktreeContent: UNVERIFIABLE }, "retry"],
      ["zero ahead, content unclassifiable, proof exists", { ...zeroAhead, worktreeContent: UNVERIFIABLE, landingProof: landedProof }, "refuse"],
      ["zero ahead, clean, content already landed", { ...zeroAhead, worktreeContent: CLEAN, landingProof: landedProof }, "proven-legitimate-noop"],
      ["zero ahead, regenerable-only, content already landed", { ...zeroAhead, worktreeContent: { state: "regenerable-ignored", scratchEntryCount: 12 }, landingProof: landedProof }, "proven-legitimate-noop"],
      ["zero ahead, clean, Commits Expected marker on", { ...zeroAhead, worktreeContent: CLEAN, noCommitsExpected: true }, "proven-legitimate-noop"],
      // Step 2 states this from the guard side: `clean` does not block. A positive probe that found nothing
      // deliverable IS the evidence a zero-commit card needs; only an UNOBSERVED tree (absent/unverifiable) needs proof.
      ["zero ahead, clean, commit-expected, no proof", { ...zeroAhead, worktreeContent: CLEAN }, "proven-legitimate-noop"],
      ["zero ahead, worktree gone, content already landed", { ...zeroAhead, worktreeContent: ABSENT, landingProof: landedProof }, "proven-legitimate-noop"],
      ["zero ahead, worktree gone, legitimate no-op basis", { ...zeroAhead, worktreeContent: ABSENT, noCommitsExpected: true }, "proven-legitimate-noop"],
      // A gone path cannot hold this card's files (the classifier checked the worktree registry first), so the
      // content door has nothing to protect; the delivery claim is proven by a different authority.
      ["zero ahead, worktree gone, commit-expected, no proof", { ...zeroAhead, worktreeContent: ABSENT }, "proven-legitimate-noop"],
      ["zero ahead, evidence omitted entirely", { ...zeroAhead } as ZeroCommitLandingProofInput, "refuse"],
    ];
    for (const [label, input, expected] of table) {
      expect(evaluateZeroCommitLandingProof(input).kind, label).toBe(expected);
    }
  });

  it("names `nothing-to-deliver` for a zero-commit card whose probe found nothing deliverable", () => {
    /*
    FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 4):
    Step 4's authority for a no-op finalize is "durable landing proof OR a content probe classifying the
    tree clean", so an unmarked clean tree takes the same legitimate-no-op arm as the marked one: zero
    commits ahead plus a checkout holding nothing means nothing is left to lose, which is the whole
    criterion for "nothing to refuse". Refusing it instead wedges the legitimate clean-tree no-op lanes —
    the intentional zero-diff branch and the ignored-only scratch tree — while protecting nothing, because
    a lane that FAILED to probe reports `unverifiable`, never `clean`. The cards genuinely at risk stay
    refused: `deliverable` content and an unclassifiable tree behind a delivery claim.
    */
    const authorized = evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: CLEAN, noCommitsExpected: true });
    expect(authorized).toEqual({ kind: "proven-legitimate-noop", basis: "nothing-to-deliver" });

    const unmarked = evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: CLEAN });
    expect(unmarked).toEqual({ kind: "proven-legitimate-noop", basis: "nothing-to-deliver" });
  });

  it("names `nothing-to-merge` when the content is provably already on the integration branch", () => {
    const verdict = evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: CLEAN, landingProof: landedProof });
    expect(verdict).toEqual({ kind: "proven-legitimate-noop", basis: "nothing-to-merge" });
  });

  it("refuses unverifiable content when the card already claims delivery, and retries when it does not", () => {
    expect(evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: UNVERIFIABLE, landingProof: landedProof })).toEqual({
      kind: "refuse",
      code: "content-unverifiable",
      reason: CONTENT_UNVERIFIABLE_REFUSAL,
      contentState: "unverifiable",
      modifiedCount: 0,
      untrackedCount: 0,
      uncommittedPaths: [],
    });
    // `retry` names the state and nothing else: an unobserved tree has no counts to report, and inventing
    // zeros there would read as "we looked and found nothing".
    expect(evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: UNVERIFIABLE })).toEqual({
      kind: "retry",
      reason: "content-probe-failed",
      contentState: "unverifiable",
    });
  });

  it("abstains on an unreadable ahead-count only while nothing is at risk", () => {
    // A repository that cannot be counted, with a clean tree, is not this guard's business: refusing here
    // would wedge every card in a repository whose revision walk fails, with no content anywhere at risk.
    expect(evaluateZeroCommitLandingProof({ aheadCommitCount: null, worktreeContent: CLEAN })).toEqual({
      kind: "proven",
      basis: "ahead-unproven",
    });
  });

  it("refuses an unreadable ahead-count when the deliverable exists only as uncommitted files", () => {
    /*
    FNXC:ZeroCommitLandingProof 2026-09-26-08:05 (RUFU-274):
    The second RUFU-262 shape: the branch ref is gone, so nothing can be counted, while the work survives
    only in a tree. An unreadable count is the absence of proof, so it can never license the finalize —
    `null` must not be read as zero, and here it must not be read as "not my case" either.
    */
    const verdict = evaluateZeroCommitLandingProof({ aheadCommitCount: null, worktreeContent: dirty() });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.kind === "refuse" && verdict.code).toBe("uncommitted-work");
  });

  it("ignores the lane's own no-op claim — a lane cannot approve itself", () => {
    const withoutClaim = evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: dirty() });
    const withClaim = evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: dirty(), presentsNoOp: true });
    expect(withClaim).toEqual(withoutClaim);
  });

  it("carries the counts from the classification itself into the refusal, so no second probe is needed", () => {
    const verdict = evaluateZeroCommitLandingProof({
      ...zeroAhead,
      worktreeContent: { state: "deliverable", modifiedCount: 3, untrackedCount: 2, paths: ["a.ts", "b.ts"] },
    });
    expect(verdict).toMatchObject({ modifiedCount: 3, untrackedCount: 2, uncommittedPaths: ["a.ts", "b.ts"] });
    // The sentence names totals, not just the capped path list, so a 400-file tree is not described as 5.
    expect((verdict as Extract<ZeroCommitLandingProofVerdict, { kind: "refuse" }>).reason).toContain("5 uncommitted");
  });
});

describe("worktreeContentCounts", () => {
  it("reports zero for every state that cannot hold deliverable work", () => {
    for (const content of [CLEAN, ABSENT, UNVERIFIABLE, { state: "ignored-only", entryCount: 9 } as const]) {
      const counts = worktreeContentCounts(content);
      expect(counts.modifiedCount, JSON.stringify(content)).toBe(0);
      expect(counts.untrackedCount, JSON.stringify(content)).toBe(0);
    }
  });

  it("counts an untracked-only tree as uncommitted work with modified=0", () => {
    const counts = worktreeContentCounts({ state: "deliverable", modifiedCount: 0, untrackedCount: 7 });
    expect(counts).toMatchObject({ modifiedCount: 0, untrackedCount: 7 });
  });

  it("is empty-safe for a missing classification rather than throwing", () => {
    expect(worktreeContentCounts(undefined)).toEqual({ modifiedCount: 0, untrackedCount: 0, paths: [] });
  });
});

describe("hasDurableLandingProof", () => {
  it("counts a landed sha, a recorded landed file set, or a verified no-op short-circuit as durable proof", () => {
    expect(hasDurableLandingProof({ commitSha: "abc123" })).toEqual({
      proven: true,
      kind: "durable-commit-sha",
      proof: { kind: "durable-commit-sha", sha: "abc123" },
    });
    expect(hasDurableLandingProof({ landedBranchTipSha: "def456" }).proof).toEqual({ kind: "durable-commit-sha", sha: "def456" });
    expect(hasDurableLandingProof({ landedFiles: ["a.ts"] })).toMatchObject({ proven: true, kind: "landed-files" });
    expect(hasDurableLandingProof({ filesChanged: 3 })).toMatchObject({ proven: true, kind: "landed-files" });
    expect(hasDurableLandingProof({ workspaceLandedFiles: { "packages/core": ["a.ts"] } })).toMatchObject({
      proven: true,
      kind: "workspace-landed-at",
    });
    // `noOpVerifiedShortCircuit` is written only by the rebase-strategy capture that PROVED the branch's
    // commits were already on main, so it is a positive verification, not a lane's self-declaration.
    expect(hasDurableLandingProof({ noOpVerifiedShortCircuit: true })).toMatchObject({ proven: true, kind: "verified-no-op" });
  });

  it("refuses to treat the lane's own mergeConfirmed / noOpMerge claim as landing proof", () => {
    // The empty-merge lane writes mergeConfirmed:true itself, so it can never be the evidence.
    expect(hasDurableLandingProof({ mergeConfirmed: true } as never).proven).toBe(false);
    expect(hasDurableLandingProof({ noOpMerge: true, mergeConfirmed: true } as never).proven).toBe(false);
    expect(hasDurableLandingProof({ mergedAt: "2026-09-25T00:00:00.000Z" } as never).proven).toBe(false);
    expect(hasDurableLandingProof(undefined).proven).toBe(false);
    expect(hasDurableLandingProof({ filesChanged: 0 }).proven).toBe(false);
    expect(hasDurableLandingProof({ noOpVerifiedShortCircuit: false }).proven).toBe(false);
  });

  it("accepts a caller-declared proof the row cannot carry (self-healing's classification result)", () => {
    expect(hasDurableLandingProof({})).toMatchObject({ proven: false });
    const asserted: LandingProof = { kind: "caller-asserted" };
    expect(evaluateZeroCommitLandingProof({ ...zeroAhead, worktreeContent: CLEAN, landingProof: asserted }))
      .toEqual({ kind: "proven-legitimate-noop", basis: "nothing-to-merge" });
  });
});

describe("describeUncommittedWorkRefusal", () => {
  it("names the paths and the operator action, and bounds how many it names", () => {
    const sentence = describeUncommittedWorkRefusal(["packages/engine/src/a.ts", "docs/b.md"]);
    expect(sentence).toContain("2 uncommitted file(s) survived on the branch; automatic merge refused");
    expect(sentence).toContain("packages/engine/src/a.ts");
    expect(sentence).toContain("docs/b.md");
    expect(sentence).toContain("then merge manually");

    const many = Array.from({ length: 9 }, (_, i) => `src/file-${i}.ts`);
    const bounded = describeUncommittedWorkRefusal(many);
    expect(bounded).toContain("9 uncommitted file(s)");
    expect(bounded).toContain("(+4 more)");
    expect(bounded).toContain("src/file-4.ts");
    expect(bounded).not.toContain("src/file-5.ts");
  });

  it("states split totals when the path list is capped, so counts and sentence cannot disagree", () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const sentence = describeUncommittedWorkRefusal(paths, 300, 140);
    expect(sentence).toContain("440 uncommitted file(s)");
    expect(sentence).toContain("300 modified");
    expect(sentence).toContain("140 untracked");
  });

  it("describes an untracked-only tree without claiming modifications", () => {
    const sentence = describeUncommittedWorkRefusal(["notes.md"], 0, 1);
    expect(sentence).toContain("1 uncommitted file(s)");
    expect(sentence).not.toContain("modified");
  });
});
