import { describe, expect, it } from "vitest";
import {
  evaluateNoCommitsNoOpFinalize,
  type NoCommitsNoOpFinalizeEvidence,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { resolveNoOpFinalizeGateIds } from "../merge/zero-commit-finalization-guard.js";

/*
FNXC:PreMergeGateResolution 2026-09-29-17:17 (RUFU-274, review finding ae5d844d):
The zero-commit finalize guard has carried a `requiredVerificationStepIds` argument since FN-175, and a
reviewer proved the argument was always empty in this deployment: every lane filled it from a helper that
returned `undefined` the moment the store's workflow-selection reader came back empty, and an absent
selection is the NORMAL shape here (measured 2026-09-27: 0 of 91 recently-updated cards carried a
`workflowId`/`workflowSelection`). `RUFU-337` is the consequence — `code-review` enabled, zero
`workflow_step_results` rows, finalized `done` — while the identical row shape (`RUFU-225`) was refused at
the ordinary merge door, which resolves through `resolvePreMergeGateForTask`. These tests pin the seam the
dead branch was missing: what the gate set resolves to for each workflow-selection classification, and that
the resolved set actually reaches the guard's decision. The core-level suite cannot cover this because it
never had a selection to resolve (`selection` appears nowhere in it), which is exactly why the dead branch
survived a green suite.
*/

/** A workflow-aware store whose selection read returns nothing — the shape of the whole live board. */
function storeWithEmptySelection(): TaskStore {
  return {
    getTaskWorkflowSelectionAsync: async () => null,
    getWorkflowDefinition: async () => undefined,
  } as unknown as TaskStore;
}

/** A store that is NOT workflow-aware at all (legacy embedder / test double): no selection reader exists. */
function storeWithoutSelectionReaders(): TaskStore {
  return {
    getWorkflowDefinition: async () => undefined,
  } as unknown as TaskStore;
}

/** A store whose selection read throws — the classification that must never widen into a free pass. */
function storeWithFailingSelectionRead(): TaskStore {
  return {
    getTaskWorkflowSelectionAsync: async () => {
      throw new Error("connection terminated");
    },
    getWorkflowDefinition: async () => undefined,
  } as unknown as TaskStore;
}

function gateCard(enabledWorkflowSteps: string[]): Task {
  return { id: "RUFU-337", enabledWorkflowSteps } as unknown as Task;
}

/*
Only the gate under test is enabled: `resolveRequiredPreMergeStepIds` returns every enabled pre-merge
optional group, and the guard reports the FIRST missing one, so a fixture that also enabled `plan-review`
would assert about plan review instead of the `code-review` verdict RUFU-337 was missing.
*/
const RUFU_337_ENABLED = ["code-review"];

const CLEAN_TREE = { state: "clean" } as const;
const DELIVERED: NoCommitsNoOpFinalizeEvidence["landingProof"] = {
  kind: "durable-commit-sha",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

describe("resolveNoOpFinalizeGateIds (zero-commit finalize required gates)", () => {
  it("demands the default workflow's default-on gate for a card with no own workflow selection", async () => {
    const gates = await resolveNoOpFinalizeGateIds(storeWithEmptySelection(), gateCard(RUFU_337_ENABLED));

    expect(gates.has("code-review")).toBe(true);
  });

  it("keeps the legacy carve-out narrow: a store with no selection reader at all still demands nothing", async () => {
    const gates = await resolveNoOpFinalizeGateIds(storeWithoutSelectionReaders(), gateCard(RUFU_337_ENABLED));

    expect(gates.size).toBe(0);
  });

  it("does not invent a gate the card never enabled (control for the empty-selection arm)", async () => {
    const gates = await resolveNoOpFinalizeGateIds(storeWithEmptySelection(), gateCard([]));

    expect(gates.size).toBe(0);
  });

  it("fails closed rather than open when the selection read itself throws", async () => {
    const gates = await resolveNoOpFinalizeGateIds(storeWithFailingSelectionRead(), gateCard(RUFU_337_ENABLED));

    expect(gates.has("code-review")).toBe(true);
  });

  it("blocks the RUFU-337 row shape: enabled code-review, zero result rows, zero-commit finalize", async () => {
    const requiredVerificationStepIds = await resolveNoOpFinalizeGateIds(
      storeWithEmptySelection(),
      gateCard(RUFU_337_ENABLED),
    );

    const verdict = evaluateNoCommitsNoOpFinalize(
      { noCommitsExpected: false, steps: [], workflowStepResults: [] },
      { aheadCommitCount: 0, worktreeContent: CLEAN_TREE, landingProof: DELIVERED, requiredVerificationStepIds },
    );

    expect(verdict).toMatchObject({ blocked: true, reason: expect.stringContaining("code-review") });
  });

  /*
  FNXC:PreMergeGateResolution 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 1 — critical):
  Once this resolver started returning a real gate set (e5650000e4), the guard's own approval rule came
  under traffic — and it demanded a raw `status: "passed"` row, which the merge door does not. An operator
  who bypassed a stranded `code-review` gate (FN-7720: `skipped` + `bypassedBy`/`bypassedAt`/`bypassReason`)
  therefore had the waiver answered here as approved and refused there, and the finalize lanes read the
  refusal as unfinished work: `error` + `status: "failed"` + a backward rebound. Pinned at this seam because
  it is the resolved gate set — not a hand-written one — that the lanes hand to the guard.
  */
  it("finalizes the same card once the operator waived the gate with an audited bypass, like the merge door", async () => {
    const requiredVerificationStepIds = await resolveNoOpFinalizeGateIds(
      storeWithEmptySelection(),
      gateCard(RUFU_337_ENABLED),
    );

    const verdict = evaluateNoCommitsNoOpFinalize(
      {
        noCommitsExpected: false,
        steps: [],
        workflowStepResults: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "skipped",
          bypassedBy: "operator-1",
          bypassedAt: "2026-09-29T20:05:00.000Z",
          bypassReason: "review lane stranded: the reviewer harness emitted no verdict twice",
        }],
      },
      { aheadCommitCount: 0, worktreeContent: CLEAN_TREE, landingProof: DELIVERED, requiredVerificationStepIds },
    );

    expect(verdict).toMatchObject({ blocked: false });
  });

  /*
  FNXC:PreMergeGateResolution 2026-09-29-20:39 (RUFU-274 Step 11):
  The row this fixture carries changed shape when the guard stopped scanning raw statuses and started asking
  `evaluatePreMergeApprovals`. A bare `status: "passed"` `code-review` row is `not-approved` to the canonical
  door — a content review owes an authored verdict (FN-180/FN-288), and FN-279's self-healing sweep rewrites
  precisely that row shape to `failed` — so the fixture now states the verdict the row always owed instead of
  asserting a shape the merge door itself refuses.
  */
  it("finalizes the same card once the gate has a passing result (the block is the missing verdict, not a constant)", async () => {
    const requiredVerificationStepIds = await resolveNoOpFinalizeGateIds(
      storeWithEmptySelection(),
      gateCard(RUFU_337_ENABLED),
    );

    const verdict = evaluateNoCommitsNoOpFinalize(
      {
        noCommitsExpected: false,
        steps: [],
        workflowStepResults: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "passed",
          verdict: "APPROVE",
        }],
      },
      { aheadCommitCount: 0, worktreeContent: CLEAN_TREE, landingProof: DELIVERED, requiredVerificationStepIds },
    );

    expect(verdict).toMatchObject({ blocked: false });
  });
});
