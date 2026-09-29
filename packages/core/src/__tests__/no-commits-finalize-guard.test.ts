import { describe, expect, it } from "vitest";
import { evaluateNoCommitsNoOpFinalize, type NoCommitsNoOpFinalizeEvidence, type TaskStep } from "../index.js";

function steps(statuses: Array<TaskStep["status"]>): TaskStep[] {
  return statuses.map((status, index) => ({ name: `Step ${index}`, status }));
}

/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-01:40 (RUFU-274):
The Step 2 contract makes worktree-content evidence a REQUIRED parameter, so every fixture has to state
what its tree held. These helpers keep the pre-existing step-ledger assertions readable while making the
new dimension explicit: the default says "branch genuinely empty, tree genuinely clean, no recorded
delivery proof" — the shape those tests were always implicitly about. Tests that exercise the content
class itself override it rather than relying on a permissive default.
*/
const CLEAN_TREE = { state: "clean" } as const;
const DIRTY_TREE = { state: "deliverable", modifiedCount: 1, untrackedCount: 0 } as const;
const UNVERIFIABLE_TREE = { state: "unverifiable", probeDetail: "status-probe-failed" } as const;
const ABSENT_TREE = { state: "absent" } as const;

function evidence(
  overrides: Partial<NoCommitsNoOpFinalizeEvidence> = {},
): NoCommitsNoOpFinalizeEvidence {
  return { aheadCommitCount: 0, worktreeContent: CLEAN_TREE, landingProof: null, ...overrides };
}

function evaluate(
  task: Parameters<typeof evaluateNoCommitsNoOpFinalize>[0],
  evidenceOverride?: NoCommitsNoOpFinalizeEvidence,
) {
  return evaluateNoCommitsNoOpFinalize(task, evidenceOverride ?? evidence());
}

function namedSteps(entries: Array<[string, TaskStep["status"]]>): TaskStep[] {
  return entries.map(([name, status]) => ({ name, status }));
}

describe("evaluateNoCommitsNoOpFinalize", () => {
  it("blocks the FN-6455 skipped-release shape", () => {
    const result = evaluate({
      noCommitsExpected: true,
      steps: steps(["done", "skipped", "skipped", "skipped", "skipped", "skipped"]),
    });

    expect(result).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 5 });
  });

  it("allows legitimate all-done no-op tasks", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: steps(["done", "done", "done"]),
    })).toEqual({ blocked: false, doneCount: 3, incompleteCount: 0 });
  });

  it("allows mostly-done no-commits ops tasks with only a minor non-verification skipped tail", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: namedSteps([
        ["Plan", "done"],
        ["Configure", "done"],
        ["Apply", "done"],
        ["Announce release", "done"],
        ["Update dashboard", "done"],
        ["Optional cleanup", "skipped"],
      ]),
    })).toEqual({ blocked: false, doneCount: 5, incompleteCount: 1 });
  });

  it("allows intentional no-op tasks when all remaining steps are done", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: namedSteps([
        ["Preflight", "done"],
        ["Restore the invariant if needed", "skipped"],
        ["Apply the invariant everywhere", "skipped"],
        ["Add regressions if needed", "skipped"],
        ["Testing & Verification", "done"],
        ["Documentation & Delivery", "done"],
      ]),
    })).toEqual({ blocked: false, doneCount: 3, incompleteCount: 3 });
  });

  it("still blocks an equal done/skipped split without completed verification", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: namedSteps([
        ["Preflight", "done"],
        ["Apply", "done"],
        ["Document", "done"],
        ["Deploy", "skipped"],
        ["Announce", "skipped"],
        ["Follow up", "skipped"],
      ]),
    })).toMatchObject({ blocked: true, doneCount: 3, incompleteCount: 3 });
  });

  it("blocks pending or in-progress work on no-commits tasks", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: steps(["done", "pending"]),
    })).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 1 });
    expect(evaluate({
      noCommitsExpected: true,
      steps: steps(["in-progress"]),
    })).toMatchObject({ blocked: true, doneCount: 0, incompleteCount: 1 });
  });

  // RUFU-274 supplies the durable landing proof here on purpose: this case is about the STEP LEDGER with
  // zero steps, and the proof keeps the newer content dimension from deciding a case it never described.
  it("preserves zero-step behavior", () => {
    const delivered = evidence({ landingProof: { kind: "durable-commit-sha", sha: "0123456789abcdef0123456789abcdef01234567" } });
    expect(evaluate({ noCommitsExpected: true, steps: [] }))
      .toEqual({ blocked: false, doneCount: 0, incompleteCount: 0 });
    expect(evaluate({ noCommitsExpected: false, steps: [] }, delivered))
      .toEqual({ blocked: false, doneCount: 0, incompleteCount: 0 });
  });

  // FN-8141: the laundered shape — a commit-expected task whose branch is empty
  // because the work was reverted, with a majority of steps done and the
  // remainder skipped. Must block even though it is not `noCommitsExpected` and
  // done (3) > skipped (2).
  it("blocks the FN-8141 reverted commit-expected shape (3 done + 2 skipped)", () => {
    const result = evaluate({
      noCommitsExpected: false,
      steps: namedSteps([
        ["Update pi SDK", "done"],
        ["Wire runtime", "done"],
        ["Verify Kimi K3", "done"],
        ["Testing & Verification", "skipped"],
        ["Documentation & Delivery", "skipped"],
      ]),
    });

    expect(result).toMatchObject({ blocked: true, doneCount: 3, incompleteCount: 2 });
    expect(result.reason).toContain("Testing & Verification");
  });

  it("blocks a skipped verification step regardless of done/skip ratio or noCommitsExpected", () => {
    // Majority done, only one skipped step, but it is verification-flavored.
    for (const noCommitsExpected of [true, false]) {
      const result = evaluate({
        noCommitsExpected,
        steps: namedSteps([
          ["Implement", "done"],
          ["Refactor", "done"],
          ["Docs", "done"],
          ["QA sign-off", "skipped"],
        ]),
      });
      expect(result).toMatchObject({ blocked: true });
      expect(result.reason).toContain("QA sign-off");
    }
  });

  it("blocks any non-verification skipped step on a commit-expected task", () => {
    const result = evaluate({
      noCommitsExpected: false,
      steps: namedSteps([
        ["Implement", "done"],
        ["Deploy notes", "skipped"],
      ]),
    });
    expect(result).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 1 });
    expect(result.reason).toContain("Deploy notes");
  });

  it("blocks a skipped remediation step structurally even when its name has no gate word", () => {
    expect(evaluate({
      noCommitsExpected: true,
      steps: [{ name: "Fix: inverted condition", status: "skipped", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "inverted condition" } }],
    })).toMatchObject({ blocked: true });
  });

  it("requires each supplied verification gate to have a passing result", () => {
    // Delivered proof supplied so the gate under test stays the only subject (RUFU-274 added the content
    // dimension to a guard that used to read the step ledger alone).
    const task = { noCommitsExpected: false, steps: [{ name: "Implement", status: "done" as const }], workflowStepResults: [] };
    const delivered = { kind: "durable-commit-sha" as const, sha: "0123456789abcdef0123456789abcdef01234567" };
    expect(evaluate(task, evidence({ landingProof: delivered, requiredVerificationStepIds: new Set(["verification"]) })))
      .toMatchObject({ blocked: true });
    expect(evaluate({ ...task, workflowStepResults: [{ workflowStepId: "verification", status: "passed" }] }, evidence({ landingProof: delivered, requiredVerificationStepIds: new Set(["verification"]) })))
      .toMatchObject({ blocked: false });
  });

  it("accepts the passed empty Code Review gate required by no-op finalization", () => {
    const task = {
      noCommitsExpected: true,
      steps: namedSteps([["Implementation", "done"], ["Testing & Verification", "done"]]),
      workflowStepResults: [{
        workflowStepId: "code-review",
        status: "passed" as const,
        verdict: "APPROVE" as const,
        reviewKind: "code" as const,
        reviewInputFingerprint: "empty-review-input:v1",
      }],
    };

    expect(evaluate(task, evidence({ requiredVerificationStepIds: new Set(["code-review"]) })))
      .toMatchObject({ blocked: false });
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-01:55 (RUFU-274):
  This case used to read "no skipped step and not noCommitsExpected → out of this guard's scope", because
  the guard only understood the step ledger. RUFU-274 narrowed that: a commit-expected card arriving here
  with nothing ahead of the integration branch is AT the zero-diff door, and the door now requires a content
  classification regardless of its step ledger. What satisfies the door is decided by that classification, not
  by the card's step history: a tree the probe could not rule out blocks, while a tree with nothing deliverable
  in it does not — nothing survives to be lost. Either way the bare-card exemption ("not this guard's scope")
  is gone, which is the half of this test that used to read "out of scope".
  */
  it("does not block a skip-free card that can show delivery, and refuses one that cannot", () => {
    expect(evaluate(
      { noCommitsExpected: false, steps: steps(["done", "done"]) },
      evidence({ landingProof: { kind: "durable-commit-sha", sha: "0123456789abcdef0123456789abcdef01234567" } }),
    )).toEqual({ blocked: false, doneCount: 2, incompleteCount: 0 });
    // The step-ledger exemption is gone: a commit-expected card with a pending step is now evaluated by the
    // content door too, and a clean tree answers it.
    expect(evaluate({ steps: steps(["pending"]) }))
      .toMatchObject({ blocked: false, doneCount: 0, incompleteCount: 1 });
    // Same card, but the probe could not rule the tree out: that is the class this change exists to stop.
    expect(evaluate({ steps: steps(["pending"]) }, evidence({ worktreeContent: UNVERIFIABLE_TREE })))
      .toMatchObject({ blocked: true, reason: "worktree-content-unproven", doneCount: 0, incompleteCount: 1 });
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-01:40 (RUFU-274) Step 2:
  The shared guard used to reason about the step ledger ALONE, so a lane that reached it with a zero commit
  range and a passing gate could finalize a card whose tree still held the work. These cases pin the new
  dimension: a lane must HAND the guard its content classification, and any state that could be holding
  deliverable content blocks the door with the fixed operator reason. Pre-existing step/gate reasons stay
  ahead of it, so a card already blocked for a named gate keeps the message operators recognised.
  */

  const allDoneSteps = (): TaskStep[] => namedSteps([["Implement", "done"], ["Testing & Verification", "done"]]);

  it("blocks a dirty tree with tracked modifications, using the fixed content reason", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({ worktreeContent: { state: "deliverable", modifiedCount: 2, untrackedCount: 0 } }),
    );
    expect(result).toMatchObject({ blocked: true, reason: "worktree-content-unproven" });
    expect(result.deliveryUnproven).toMatchObject({
      contentState: "deliverable",
      modifiedCount: 2,
      untrackedCount: 0,
      refusalCode: "uncommitted-work",
    });
  });

  it("blocks a dirty tree holding ONLY untracked files — an untracked file is still a deliverable", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({ worktreeContent: { state: "deliverable", modifiedCount: 0, untrackedCount: 3 } }),
    );
    expect(result).toMatchObject({ blocked: true, reason: "worktree-content-unproven" });
    expect(result.deliveryUnproven).toMatchObject({ contentState: "deliverable", modifiedCount: 0, untrackedCount: 3 });
  });

  it("blocks when the content probe itself failed — no news is not good news", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({ worktreeContent: UNVERIFIABLE_TREE }),
    );
    expect(result).toMatchObject({ blocked: true, reason: "worktree-content-unproven" });
    expect(result.deliveryUnproven).toMatchObject({ contentState: "unverifiable" });
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-02:40 (RUFU-274) Step 2:
  An absent path is separable from a dirty or unprobeable one, and the separation carries a different
  consequence rather than a refusal: `pathMissing` is what lets Step 5's pointer rule clear the row's
  worktree/stale-branch pointers when durable proof backs it, while dirty/unprobed/unprobeable refuse and
  preserve. Content-wise a gone tree cannot hold this card's files — the classifier only calls it absent after
  reading the worktree registry and finding no other checkout holding the branch — so the content door has
  nothing to protect. The delivery CLAIM is a separate authority (`getMergeConfirmedFinalizationBlocker`,
  `hasDurableLandingProof`) and stays enforced there; this door answers only "could work be lost?".
  */
  it("does not block a commit-expected card whose worktree path is gone — no tree, no work at risk", () => {
    const result = evaluate(
      { noCommitsExpected: false, steps: namedSteps([["Implement", "done"]]) },
      evidence({ worktreeContent: ABSENT_TREE }),
    );
    expect(result).toMatchObject({ blocked: false });
    expect(result.deliveryUnproven).toBeUndefined();
  });

  it("does NOT treat a provably-absent path as uncommitted work when the card legitimately had none", () => {
    // RUFU-274 acceptance: an absent tree cannot hold uncommitted work, so it must never wedge a card.
    expect(evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({ worktreeContent: ABSENT_TREE }),
    )).toMatchObject({ blocked: false });
  });

  it("does NOT block a clean tree, and records no refusal marker", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({ worktreeContent: CLEAN_TREE }),
    );
    expect(result).toMatchObject({ blocked: false });
    expect(result.deliveryUnproven).toBeUndefined();
  });

  it("does NOT count regenerable scratch or ignored-only output as uncommitted delivery", () => {
    for (const worktreeContent of [
      { state: "regenerable-ignored", scratchEntryCount: 40 } as const,
      { state: "ignored-only", entryCount: 3 } as const,
    ]) {
      expect(evaluate(
        { noCommitsExpected: true, steps: allDoneSteps() },
        evidence({ worktreeContent }),
      )).toMatchObject({ blocked: false });
    }
  });

  it("blocks when a lane supplies no classification at all — the runtime floor under the required parameter", () => {
    // TypeScript makes the parameter required; this pins that a JavaScript caller cannot recover the old
    // implicit-clean behavior by omitting it.
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      { aheadCommitCount: 0, landingProof: null } as unknown as NoCommitsNoOpFinalizeEvidence,
    );
    expect(result).toMatchObject({ blocked: true, reason: "worktree-content-unproven" });
    expect(result.deliveryUnproven).toMatchObject({ contentState: "unverifiable" });
  });

  it("keeps a pre-existing skipped-gate reason ahead of the content reason", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: namedSteps([["Implement", "done"], ["QA sign-off", "skipped"]]) },
      evidence({ worktreeContent: DIRTY_TREE }),
    );
    expect(result).toMatchObject({ blocked: true });
    expect(result.reason).toContain("QA sign-off");
    expect(result.reason).not.toBe("worktree-content-unproven");
    /*
    FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 2 — high):
    The two precedence tests above used to assert ONLY the reason, which is exactly how the losing shape
    stayed invisible: a refusal that names the step but drops `deliveryUnproven` tells every finalize lane
    "incomplete work" and nothing about the modified/untracked files still sitting in the worktree, so the
    lane wrote `error` + `status: "failed"` and rebound the card instead of holding it in place. The reason
    precedence is still the contract; the marker is now asserted as part of it.
    */
    expect(result.deliveryUnproven).toMatchObject({ contentState: "deliverable", modifiedCount: 1 });
  });

  it("keeps a missing required verification gate ahead of the content reason", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps(), workflowStepResults: [] },
      evidence({ worktreeContent: DIRTY_TREE, requiredVerificationStepIds: new Set(["code-review"]) }),
    );
    expect(result).toMatchObject({ blocked: true });
    expect(result.reason).toContain("code-review");
    expect(result.reason).not.toBe("worktree-content-unproven");
    expect(result.deliveryUnproven).toMatchObject({ contentState: "deliverable", modifiedCount: 1 });
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 1 — critical):
  The required-gate arm used to demand a raw `status: "passed"` row, while the canonical merge door
  (`evaluatePreMergeApprovals`) accepts an audited FN-7720 operator waiver and a not-run carrier too. The
  arm was dead until commit e5650000e4 made the finalize gate resolver ask the same canonical resolver the
  door asks, which activated the divergence: an operator who bypassed a stranded `code-review` gate — the
  documented remedy for a review lane no reviewer will ever answer — got `required verification gate
  'code-review' has no passing result` back, so the finalize lanes classified the card as unfinished work:
  `error` + `status: "failed"` + a backward rebound out of the review lane, undoing the waiver that had just
  been recorded with an audit trail. The arm now asks the same authority, so the two doors cannot disagree
  about one gate.
  */
  it("finalizes a required gate the operator waived with an audited bypass, like the merge door does", () => {
    const waivedGate = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "skipped" as const,
      bypassedBy: "operator-1",
      bypassedAt: "2026-09-29T20:05:00.000Z",
      bypassReason: "review lane stranded: the reviewer harness emitted no verdict twice",
    };

    expect(evaluate(
      { noCommitsExpected: false, steps: allDoneSteps(), workflowStepResults: [waivedGate] },
      evidence({ requiredVerificationStepIds: new Set(["code-review"]) }),
    )).toEqual({ blocked: false, doneCount: allDoneSteps().length, incompleteCount: 0 });

    // Control for the same arm: a gate with NO row is the merge door's `missing` state and must still block.
    const blocked = evaluate(
      { noCommitsExpected: false, steps: allDoneSteps(), workflowStepResults: [] },
      evidence({ requiredVerificationStepIds: new Set(["code-review"]) }),
    );
    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.reason).toContain("code-review");
  });

  it("blocks a required gate whose skipped row carries neither a waiver nor a not-run carrier", () => {
    const result = evaluate(
      {
        noCommitsExpected: false,
        steps: allDoneSteps(),
        workflowStepResults: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "skipped" as const,
        }],
      },
      evidence({ requiredVerificationStepIds: new Set(["code-review"]) }),
    );

    expect(result).toMatchObject({ blocked: true });
    expect(result.reason).toContain("code-review");
  });

  it("blocks a dirty tree even with durable landing proof recorded — a sha proves delivery, not this content", () => {
    const result = evaluate(
      { noCommitsExpected: true, steps: allDoneSteps() },
      evidence({
        worktreeContent: { state: "deliverable", modifiedCount: 1, untrackedCount: 1 },
        landingProof: { kind: "durable-commit-sha", sha: "0123456789abcdef0123456789abcdef01234567" },
      }),
    );
    expect(result).toMatchObject({ blocked: true, reason: "worktree-content-unproven" });
  });
});
