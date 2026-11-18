import { describe, expect, it } from "vitest";
import { hasDurableLandingProof } from "../merge/zero-commit-landing-proof.js";
import {
  LANDING_PROOF_DEFERRAL_REASONS,
  LANDING_PROOF_REFUSAL_CODES,
  describeDefaultBranchLandingRefusal,
  evaluateDefaultBranchLandingProof,
  isFusionTaskBranchRefName,
  isTaskDeclaredLandingTarget,
  type DefaultBranchLandingProofInput,
} from "../merge/default-branch-landing-proof.js";

/*
Acceptance corpus for the default-branch landing-proof invariant (RUFU-702).

Every case names the DATA STATE it covers from the card's Surface Enumeration, because the invariant is
"no card reaches a complete-role lane claiming delivery the default branch cannot substantiate" and the
failure mode was one lane's word against its own recorded target. Read the module's FNXC block for the
RUFU-294 measurement these cases encode.
*/

/** Base: a readable `main`, a recorded sha, nothing proved. Each case overrides what it means to test. */
function input(overrides: Partial<DefaultBranchLandingProofInput> = {}): DefaultBranchLandingProofInput {
  return {
    integrationBranch: "main",
    integrationRefReadable: true,
    recordedSha: "62804b4340a3ac40e7d1e94216782e1d75b168d3",
    ancestryOutcome: "absent",
    patchEquivalentOutcome: "absent",
    ...overrides,
  };
}

describe("evaluateDefaultBranchLandingProof — proven arms", () => {
  it("proves a squash landing whose recorded sha is an ancestor of the integration branch", () => {
    // Data state: project default `always-squash`. The squash sha IS on main, so ancestry alone settles it.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
      ancestryOutcome: "proven",
      patchEquivalentOutcome: "unreadable",
    }))).toEqual({ disposition: "proven", proofKind: "integration-ancestry" });
  });

  it("proves a lane whose probe found the recorded squash commit ON the integration branch", () => {
    expect(evaluateDefaultBranchLandingProof(input({
      ancestryOutcome: "unreadable",
      squashRecordedOnIntegration: true,
    }))).toEqual({ disposition: "proven", proofKind: "recorded-squash-on-integration" });
  });

  it("proves a rewritten-history card (auto/always-rebase or a Direct Merge Commit Strategy override) on patch-equivalence", () => {
    // Data state: branch head legitimately differs from the landed sha. Demanding ancestry here is what
    // would mass-reopen genuinely delivered cards, so this is a mandatory positive control.
    expect(evaluateDefaultBranchLandingProof(input({
      landedBranchTipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ancestryOutcome: "absent",
      patchEquivalentOutcome: "proven",
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
    }))).toEqual({ disposition: "proven", proofKind: "patch-equivalent" });
  });

  it("proves an open-PR landing by the PR vehicle rather than by local ancestry", () => {
    // Data state: PR-backed landing (`mergeDetails.prNumber`, PR open).
    expect(evaluateDefaultBranchLandingProof(input({
      prNumber: 3732,
      prStateOpen: true,
    }))).toEqual({ disposition: "proven", proofKind: "pr-backed" });
  });

  it("treats a shared-branch-group member landing onto a live group branch as proven-for-member", () => {
    // Data state: member → `fusion/groups/<slug>` is a SANCTIONED intermediate target; the group→default
    // promotion owes its own proof separately, so this arm must not read as delivery to main.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "fusion/groups/planning-x",
      mergeTargetSource: "branch-group-integration",
      groupBranchIsLive: true,
    }))).toEqual({ disposition: "proven", proofKind: "group-intermediate" });
  });

  it("proves a workspace card only when every repository proved its own default-branch landing", () => {
    expect(evaluateDefaultBranchLandingProof(input({
      workspaceRepoLanding: { ".": "proven", "apps/web": "proven" },
    }))).toEqual({ disposition: "proven", proofKind: "workspace-per-repo" });
  });

  it("proves a verified no-op, which is a positive observation rather than an emptiness claim", () => {
    expect(evaluateDefaultBranchLandingProof(input({ noOpVerified: true, ancestryOutcome: "unreadable" })))
      .toEqual({ disposition: "proven", proofKind: "verified-no-op" });
  });
});

describe("evaluateDefaultBranchLandingProof — refused arms", () => {
  it("refuses the RUFU-294 shape: a landing that advanced a SIBLING task branch, with conflicts against main", () => {
    // The exact measured incident. `mergeTargetSource: "task-base-branch"` naming a Fusion task branch is
    // never an intermediate target, so no arm may read the advance as delivery.
    const verdict = evaluateDefaultBranchLandingProof(input({
      landedBranchTipSha: "09743fbedb3726ad9124d20c72808c707d1d0eb4",
      mergeTargetBranch: "fusion/rufu-293",
      mergeTargetSource: "task-base-branch",
      ancestryOutcome: "absent",
      patchEquivalentOutcome: "absent",
      conflictCount: 238,
    }));
    expect(verdict.disposition).toBe("refused");
    expect(verdict).toMatchObject({ refusalCode: "landing-target-not-integration" });
    if (verdict.disposition !== "refused") return;
    expect(verdict.reason).toContain("fusion/rufu-293");
    expect(verdict.reason).toContain("238 merge conflicts");
  });

  it("refuses a claimed squash landing on the integration branch when that sha is not on it", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
    }));
    expect(verdict).toMatchObject({ refusalCode: "squash-commit-not-recorded-on-integration" });
  });

  it("refuses rewritten history whose content match was measured absent, naming patch-equivalence", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({
      landedBranchTipSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
    }));
    expect(verdict).toMatchObject({ refusalCode: "patch-equivalence-absent" });
  });

  it("refuses a workspace card naming the unproven repositories, one of which is genuinely absent", () => {
    // Data state: workspace per-repo land where one repo's default branch cannot show the landing.
    const verdict = evaluateDefaultBranchLandingProof(input({
      workspaceRepoLanding: { ".": "proven", "packages/engine": "absent", "apps/web": "proven" },
    }));
    expect(verdict).toMatchObject({ refusalCode: "workspace-repo-landing-unproven" });
    if (verdict.disposition !== "refused") return;
    expect(verdict.reason).toContain("1 workspace repository");
  });

  it("refuses a bare off-main commit that claims no target at all", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({ mergeTargetBranch: null }));
    expect(verdict).toMatchObject({ refusalCode: "commit-not-on-integration-branch" });
  });

  it("refuses a row that every durable-claim census would call proven, because mergeConfirmed is not an input", () => {
    // Data state: `mergeDetails` present with `mergeConfirmed` (the RUFU-294 row: commitSha + landedFiles
    // + mergeConfirmed: true). `hasDurableLandingProof` calls that a durable claim — this predicate must
    // not, or the loophole stays open. Both directions are asserted so neither flag can swing it.
    const row = {
      commitSha: "62804b4340a3ac40e7d1e94216782e1d75b168d3",
      landedFiles: ["packages/engine/src/a.ts"],
      filesChanged: 1,
      mergeConfirmed: true,
      noOpMerge: false,
    };
    expect(hasDurableLandingProof(row).proven).toBe(true);
    expect(evaluateDefaultBranchLandingProof(input({ mergeTargetBranch: "main", mergeTargetSource: "project-default" }))
      .disposition).toBe("refused");
    expect(evaluateDefaultBranchLandingProof({ ...input(), ancestryOutcome: "proven" }).disposition).toBe("proven");
  });
});

describe("evaluateDefaultBranchLandingProof — deferred arms (never a refusal on unreadable evidence)", () => {
  it("defers when the integration ref does not resolve, even though the commit is off-main", () => {
    // Data state: bare repo / no `origin/HEAD` / detached worktree. Refusing here would fabricate a
    // delivery failure on every card the repository cannot currently describe.
    const verdict = evaluateDefaultBranchLandingProof(input({ integrationRefReadable: false }));
    expect(verdict).toEqual({ disposition: "deferred", reason: "integration-ref-unreadable" });
    expect(verdict.disposition).not.toBe("refused");
  });

  it("defers when the resolved integration branch name is blank", () => {
    expect(evaluateDefaultBranchLandingProof(input({ integrationBranch: "  " })))
      .toEqual({ disposition: "deferred", reason: "integration-ref-unreadable" });
  });

  it("defers when the card carries no delivery claim at all (no-op / verified short-circuit shape)", () => {
    // Data state: `mergeDetails` with no `commitSha`. There is nothing to disprove; the zero-commit door
    // owns the "was there anything to deliver" question.
    expect(evaluateDefaultBranchLandingProof(input({ recordedSha: null, landedBranchTipSha: null })))
      .toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("defers when ancestry is unmeasurable while the ref itself resolves", () => {
    expect(evaluateDefaultBranchLandingProof(input({ ancestryOutcome: "unreadable" })))
      .toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("defers rather than refuses when the patch probe could not run on an off-main commit", () => {
    expect(evaluateDefaultBranchLandingProof(input({ patchEquivalentOutcome: "unreadable" })))
      .toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("defers a workspace card whose only unproven repository was unreadable", () => {
    expect(evaluateDefaultBranchLandingProof(input({
      workspaceRepoLanding: { ".": "proven", "apps/web": "unreadable" },
    }))).toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });
});

/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
The operator ruled that a task-declared target branch which is not a Fusion task branch (`release`,
`release/9.9`, `integration/v2`) is a valid delivery vehicle, so `main` is not a universal yardstick. These
cases pin both halves of that ruling: the card that shipped to its own target is proven, and the class is
narrow enough that the RUFU-294 refusal cannot leak through it. The real-ref measurement behind
`declaredTargetAncestryOutcome` is covered against real git in the engine's
`default-branch-landing-proof-probe.test.ts`, and the finalize seam is covered by `merger-ai.test.ts`.
*/
describe("task-declared target branch as the delivery yardstick", () => {
  it("proves a card that delivered to the target branch it declared itself", () => {
    // Data state: `baseBranch: "release"` on the card, the lane landed the commit on `release`, `main` has
    // nothing of it. This is the case the operator decision unblocks.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "release",
      mergeTargetSource: "task-base-branch",
      declaredTargetAncestryOutcome: "proven",
    }))).toEqual({ disposition: "proven", proofKind: "task-declared-target" });
  });

  it("keeps the default-branch proof in front when both yardsticks would answer", () => {
    // The card also reached `main`: the stronger, universally-meaningful kind wins, so a downstream query for
    // `task-declared-target` never counts a card that is actually on the default branch.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "release",
      mergeTargetSource: "task-base-branch",
      ancestryOutcome: "proven",
      declaredTargetAncestryOutcome: "proven",
    }))).toEqual({ disposition: "proven", proofKind: "integration-ancestry" });
  });

  it("defers a declared-target card whose own target could not be read, and spends no refusal on it", () => {
    // Data state: a remote-only target that was never materialized locally. `absent` here would be invented.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "release/9.9",
      mergeTargetSource: "task-base-branch",
      declaredTargetAncestryOutcome: "unreadable",
    }))).toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
    // An unmeasured yardstick reads the same way: abstain, do not refuse.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "release/9.9",
      mergeTargetSource: "task-base-branch",
    }))).toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("refuses a declared-target card that reached neither ref, and names both in the sentence", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "release",
      mergeTargetSource: "task-base-branch",
      declaredTargetAncestryOutcome: "absent",
      conflictCount: 3,
    }));
    expect(verdict).toMatchObject({
      disposition: "refused",
      refusalCode: "commit-not-on-integration-branch",
    });
    if (verdict.disposition !== "refused") return;
    expect(verdict.reason).toContain('"main"');
    expect(verdict.reason).toContain('"release"');
    expect(verdict.reason).toContain("3 merge conflicts");
  });

  it("keeps rewritten history in its own refusal class while still naming the declared target", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({
      landedBranchTipSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeTargetBranch: "integration/v2",
      mergeTargetSource: "task-base-branch",
      declaredTargetAncestryOutcome: "absent",
      patchEquivalentOutcome: "absent",
    }));
    expect(verdict).toMatchObject({ refusalCode: "patch-equivalence-absent" });
    if (verdict.disposition !== "refused") return;
    expect(verdict.reason).toContain('"integration/v2"');
  });

  it("classifies only the card's own declared target as this class", () => {
    const classify = (over: Partial<DefaultBranchLandingProofInput>) => isTaskDeclaredLandingTarget({
      mergeTargetSource: over.mergeTargetSource ?? null,
      mergeTargetBranch: over.mergeTargetBranch ?? null,
      integrationBranch: over.integrationBranch ?? "main",
    });
    // A human ref the card declared as its own base branch is a delivery vehicle.
    expect([
      classify({ mergeTargetBranch: "release", mergeTargetSource: "task-base-branch" }),
      classify({ mergeTargetBranch: "release/9.9", mergeTargetSource: "task-base-branch" }),
      classify({ mergeTargetBranch: "integration/v2", mergeTargetSource: "task-base-branch" }),
      // A human branch that merely shares the `fusion/` prefix keeps its delivery behavior.
      classify({ mergeTargetBranch: "fusion/release-1.0", mergeTargetSource: "task-base-branch" }),
    ]).toEqual([true, true, true, true]);
    // The RUFU-294 shape, and every target the card did not declare for itself.
    expect([
      classify({ mergeTargetBranch: "fusion/rufu-293", mergeTargetSource: "task-base-branch" }),
      classify({ mergeTargetBranch: "fusion/groups/planning-x", mergeTargetSource: "task-base-branch" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: "task-branch-context" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: "branch-group-integration" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: "project-default" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: "legacy-main" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: null }),
      classify({ mergeTargetBranch: "main", mergeTargetSource: "task-base-branch" }),
      classify({ mergeTargetBranch: "release", mergeTargetSource: "task-base-branch", integrationBranch: "release" }),
      classify({ mergeTargetBranch: "  ", mergeTargetSource: "task-base-branch" }),
    ]).toEqual([false, false, false, false, false, false, false, false, false, false]);
  });

  it("refuses the RUFU-294 shape even when the sibling task branch holds the commit", () => {
    // The negative control that keeps this whole class honest: a ref another card's delivery claim owns is
    // never a yardstick, however well-populated it is.
    expect(evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "fusion/rufu-293",
      mergeTargetSource: "task-base-branch",
      declaredTargetAncestryOutcome: "proven",
    }))).toMatchObject({ refusalCode: "landing-target-not-integration" });
  });
});

describe("refusal vocabulary and wording", () => {
  it("declares exactly the closed refusal-code and deferral-reason vocabularies this card specified", () => {
    expect([...LANDING_PROOF_REFUSAL_CODES].sort()).toEqual([
      "commit-not-on-integration-branch",
      "landing-target-not-integration",
      "patch-equivalence-absent",
      "squash-commit-not-recorded-on-integration",
      "workspace-repo-landing-unproven",
    ].sort());
    expect([...LANDING_PROOF_DEFERRAL_REASONS].sort()).toEqual([
      "integration-ref-unreadable",
      "landing-evidence-incomplete",
    ]);
  });

  it("names the reason code and the integration branch in the durable sentence, and carries no content", () => {
    const verdict = evaluateDefaultBranchLandingProof(input({
      mergeTargetBranch: "fusion/rufu-293",
      mergeTargetSource: "task-base-branch",
      conflictCount: 238,
    }));
    if (verdict.disposition !== "refused") throw new Error("expected a refusal");
    const sentence = describeDefaultBranchLandingRefusal(verdict, {
      taskId: "RUFU-294",
      integrationBranch: "main",
      recordedSha: "62804b4340a3ac40e7d1e94216782e1d75b168d3",
    });
    // The operator's query key and the ref that was consulted must both be readable on the card face.
    expect(sentence).toContain("(landing-target-not-integration)");
    expect(sentence).toContain('"main"');
    expect(sentence).toContain("RUFU-294 stays in review");
    // The sha is truncated to a 10-char id, never a diff, never a file list.
    expect(sentence).toContain("62804b4340");
    expect(sentence).not.toContain("62804b4340a3ac40");
  });
});

describe("isFusionTaskBranchRefName", () => {
  it.each([
    ["fusion/rufu-293", true],
    ["fusion/fn-5339", true],
    ["fusion/FN-1234", true],
    ["fusion/sane-430", true],
    ["fusion/kb-001", true],
    ["fusion/rufu-294-stranded", true],
    ["  fusion/rufu-293  ", true],
    // Sanctioned intermediate: a group branch has a second path segment.
    ["fusion/groups/planning-x", false],
    // A human branch that merely shares the prefix keeps its current behavior.
    ["fusion/release-1.0", false],
    ["fusion/main", false],
    ["main", false],
    ["", false],
    [undefined, false],
  ])("classifies %s as a Fusion task branch: %s", (branch, expected) => {
    expect(isFusionTaskBranchRefName(branch)).toBe(expected);
  });
});
