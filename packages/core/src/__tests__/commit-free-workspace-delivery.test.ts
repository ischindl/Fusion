/*
 * Surface enumeration (docs/testing.md checklist): the ONE reading of a recorded commit-free workspace
 * delivery, consumed by the delivery guard (`hasDurableLandingProof`), the no-commits finalize guard
 * (`evaluateNoCommitsNoOpFinalize`), and the engine reconcile arm (covered in
 * `packages/engine/src/__tests__/self-healing-workspace-commit-free-closeout.test.ts`). No UI, streaming,
 * or provider path reads this fact, so no desktop/mobile surface applies here.
 *
 * FNXC:ZeroCommitWorkspaceDelivery 2026-11-14-02:10 (RUFU-599):
 * The SANE-482 shape: a workspace card the land lane finalized COMMIT-FREE — every declared repository's
 * branch tip already an ancestor of that repository's own integration branch, so the landing authored no
 * commit anywhere. The lane recorded the claim (`commit-free delivery:` + the per-repository basis + the
 * tips it read) and nothing downstream read it: the delivery guard asked for a sha or a file set, the
 * finalize guard asked for the same, and reconcile answered the bare word `workspace`. These cases pin
 * the single reading all three now share, and the four refusals that keep it from becoming a loophole.
 */
import { describe, expect, it } from "vitest";
import {
  CLEAN_WORKTREE_CONTENT,
  COMMIT_FREE_DELIVERY_REASON_PREFIX,
  classifyCommitFreeWorkspaceDelivery,
  hasDurableLandingProof,
} from "../merge/zero-commit-landing-proof.js";
import { evaluateNoCommitsNoOpFinalize } from "../merge/no-commits-finalize-guard.js";
import type { MergeDetails } from "../types.js";

/** The recorded delivery exactly as the workspace land lane writes it for a zero-ahead board. */
function recordedDelivery(overrides: Partial<MergeDetails> = {}): MergeDetails {
  return {
    mergedAt: "2026-11-13T10:00:00.000Z",
    mergeConfirmed: true,
    noOpMerge: true,
    noOpReason: `${COMMIT_FREE_DELIVERY_REASON_PREFIX} every declared repository's task branch tip is an ancestor`,
    workspaceCommitFreeBasis: {
      saneca: "zero-ahead",
      "lager-manager": "zero-ahead",
      "lager-2026": "absent",
    },
    workspaceCommitFreeBranchTipShas: {
      saneca: "a11d1111a11d1111",
      "lager-manager": "b22c2222b22c2222",
    },
    ...overrides,
  } as MergeDetails;
}

describe("classifyCommitFreeWorkspaceDelivery", () => {
  it("reads a complete record and separates the certified repositories from the absent ones", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery())).toEqual({
      zeroAheadRepos: ["saneca", "lager-manager"],
      absentRepos: ["lager-2026"],
    });
  });

  it("refuses a record with any unproven repository — the writer's own never-a-delivery word", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({
      workspaceCommitFreeBasis: {
        saneca: "zero-ahead",
        "lager-manager": "unproven",
      },
    }))).toBeUndefined();
  });

  it("refuses an all-absent basis: nothing was measured, so nothing reached integration", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({
      workspaceCommitFreeBasis: { saneca: "absent", "lager-manager": "absent" },
      workspaceCommitFreeBranchTipShas: {},
    }))).toBeUndefined();
  });

  it("refuses a zero-ahead basis whose tip was never recorded — the ancestry claim was never observed", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({
      workspaceCommitFreeBranchTipShas: { saneca: "a11d1111a11d1111" },
    }))).toBeUndefined();
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({
      workspaceCommitFreeBranchTipShas: {},
    }))).toBeUndefined();
  });

  it("refuses a basis with no recorded delivery kind, and a kind with no basis — half a pair is not evidence", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({ noOpReason: undefined }))).toBeUndefined();
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({ workspaceCommitFreeBasis: undefined }))).toBeUndefined();
  });

  it("refuses another lane's sentence: only the recorded commit-free kind names this delivery", () => {
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({
      noOpReason: "no-op landing: branch already merged into main",
    }))).toBeUndefined();
  });

  it("never reads mergeConfirmed or noOpMerge — the finalizing lane's own claim stays non-proof", () => {
    // Same record with the self-authored flags removed is still the same git observation…
    expect(classifyCommitFreeWorkspaceDelivery(recordedDelivery({ mergeConfirmed: false, noOpMerge: false })))
      .toEqual({ zeroAheadRepos: ["saneca", "lager-manager"], absentRepos: ["lager-2026"] });
    // …while the flags ALONE, which is what a finalizing lane can write about nothing, prove nothing.
    expect(classifyCommitFreeWorkspaceDelivery({ mergeConfirmed: true, noOpMerge: true } as MergeDetails))
      .toBeUndefined();
    expect(hasDurableLandingProof({ mergeConfirmed: true, noOpMerge: true } as MergeDetails))
      .toEqual({ proven: false, kind: null, proof: null });
  });
});

describe("hasDurableLandingProof over a recorded commit-free workspace delivery", () => {
  it("reports the delivery kind it actually read, ahead of the weaker file-set proofs", () => {
    expect(hasDurableLandingProof(recordedDelivery())).toEqual({
      proven: true,
      kind: "workspace-commit-free",
      proof: { kind: "workspace-commit-free" },
    });
  });

  it("keeps the landed-sha reading first when the card did author commits somewhere", () => {
    expect(hasDurableLandingProof(recordedDelivery({
      workspaceLandedFiles: { "lager-2026": ["src/a.ts"] },
    }))).toMatchObject({ proven: true, kind: "workspace-landed-at" });
    expect(hasDurableLandingProof(recordedDelivery({ commitSha: "cafe1234" })))
      .toMatchObject({ proven: true, kind: "durable-commit-sha" });
  });

  it("proves nothing for a workspace card with no recorded delivery", () => {
    expect(hasDurableLandingProof({ mergeConfirmed: true } as MergeDetails).proven).toBe(false);
  });
});

describe("a recorded delivery is not a content waiver", () => {
  /*
  The widening stops at the delivery question. `evaluateNoCommitsNoOpFinalize` deliberately refuses a tree
  it can read as holding uncommitted work, and refuses an unreadable tree, REGARDLESS of any landing proof
  (`evaluateZeroCommitLandingProof` has no proof arm for either state) — so a recorded commit-free delivery
  cannot finalize a card whose checkout still holds bytes. These cases exist so nobody "completes" the
  widening by handing the proof to those arms.
  */
  const finishedSteps = [{ name: "Implement", status: "done" as const }];
  const evaluate = (worktreeContent: unknown) => evaluateNoCommitsNoOpFinalize(
    { noCommitsExpected: true, steps: finishedSteps, workflowStepResults: [], mergeDetails: recordedDelivery() },
    { aheadCommitCount: 0, worktreeContent, landingProof: { kind: "workspace-commit-free" } },
  );

  it("refuses uncommitted work in the checkout even with the recorded delivery", () => {
    const evaluation = evaluate({ state: "deliverable", modifiedCount: 1, untrackedCount: 0 });
    expect(evaluation).toMatchObject({
      blocked: true,
      reason: "worktree-content-unproven",
      deliveryUnproven: { refusalCode: "uncommitted-work" },
    });
  });

  it("refuses an unreadable checkout even with the recorded delivery", () => {
    const evaluation = evaluate({ state: "unverifiable", probeDetail: "status-probe-failed" });
    expect(evaluation).toMatchObject({
      blocked: true,
      reason: "worktree-content-unproven",
      deliveryUnproven: { refusalCode: "content-unverifiable" },
    });
  });

  it("authorizes the delivered card whose tree holds nothing deliverable", () => {
    expect(evaluate(CLEAN_WORKTREE_CONTENT).blocked).toBe(false);
  });
});
