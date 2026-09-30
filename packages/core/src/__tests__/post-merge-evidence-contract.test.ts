/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
The built-in post-merge gate demanded a GitHub Actions delivery record from every project. Measured across
this fleet, 2 of 26 boards can name it; the rest answered with 66 CI-shaped refusals out of 98 durable
post-merge failures, 12 operator waivers (11 of them on one saneca day), and — because the impossible
instruction was interpreted by a reviewer agent — approvals on boards where Actions cannot exist. These
cases pin the replacement fact (which reporter a project has) AND its boundaries: a board with no reporter
stops being asked; a board that merely has one is still asked exactly as before.
*/
import { describe, expect, it } from "vitest";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import {
  buildPostMergeVerificationPrompt,
  postMergeEvidenceDemandsCi,
  postMergeEvidenceKindOf,
} from "../workflows/builtin-post-merge-group.js";
import {
  derivePostMergeEvidenceContract,
  isPostMergeEvidenceUnreportable,
  parseDeclaredPostMergeEvidence,
} from "../merge/post-merge-evidence-contract.js";
import {
  getPostMergeEvidenceGateStatuses,
  getRequiredPostMergeEvidenceBlocker,
} from "../merge/confirmed-merge-reconciliation.js";
import type { Task, WorkflowIr } from "../types.js";

const GATE_ID = "post-merge-verification";
const OBSERVED_AT = "2026-09-30T20:00:00.000Z";

function irWithPostMergeGate(): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    name: "Coding",
    nodes: [
      { id: "merge-attempt", kind: "action", column: "in-review" },
      {
        id: GATE_ID,
        kind: "optional-group",
        column: "in-review",
        config: {
          phase: "post-merge",
          defaultOn: true,
          template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
        },
      },
    ],
    edges: [],
    columns: [{ id: "in-review", label: "In review", traits: [] }],
  } as unknown as WorkflowIr;
}

function taskWith(overrides: Partial<Task> = {}): Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults"> {
  return { id: "RUFU-430", enabledWorkflowSteps: [GATE_ID], workflowStepResults: [], ...overrides } as never;
}

function storeFor(ir: WorkflowIr) {
  return {
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir }),
  } as never;
}

const failedRow = (completedAt: string) => ({
  workflowStepId: GATE_ID,
  workflowStepName: "Post-merge verification",
  status: "failed" as const,
  verdict: "REVISE" as const,
  verdictRequired: true,
  completedAt,
});

const approvedRow = {
  workflowStepId: GATE_ID,
  workflowStepName: "Post-merge verification",
  status: "passed" as const,
  verdict: "APPROVE" as const,
  verdictRequired: true,
};

const noneContract = derivePostMergeEvidenceContract({
  repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
  observedAt: OBSERVED_AT,
});

describe("post-merge evidence contract derivation", () => {
  it("names GitHub Actions as the reporter only for a GitHub remote that actually has workflows", () => {
    expect(derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: 11 },
      observedAt: OBSERVED_AT,
    })).toMatchObject({ provider: "github-actions", reason: "github-remote-with-workflows" });

    // scp-style ssh remotes are the same host and must not be mistaken for an unknown host.
    expect(derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "git@github.com:Fergana-Labs/stash.git", githubWorkflowFileCount: 4 },
      observedAt: OBSERVED_AT,
    }).provider).toBe("github-actions");
  });

  it("reports no reporter for the hosts this fleet actually pushes to", () => {
    const cases: Array<[string, string]> = [
      ["http://192.168.12.60:6610/saneca.git", "OneDev trunk"],
      ["https://gitlab.digitalsystems.eu/ai/test_banks.git", "self-hosted GitLab"],
      ["ssh://schindler@192.168.12.40:2222/home/schindler/dgx_spark.git", "private Gitea"],
      ["", "a repo with no remote at all"],
    ];
    for (const [remoteUrl, label] of cases) {
      const contract = derivePostMergeEvidenceContract({
        repo: { factsReadable: true, remoteUrl, githubWorkflowFileCount: 0 },
        observedAt: OBSERVED_AT,
      });
      expect(contract.provider, label).toBe("none");
      expect(isPostMergeEvidenceUnreportable(contract), label).toBe(true);
    }
  });

  it("keeps demanding the evidence when a GitHub remote has no workflow directory inspected or populated", () => {
    // A GitHub remote whose workflows were never counted is NOT evidence that the reporter is missing.
    expect(derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: null },
      observedAt: OBSERVED_AT,
    }).provider).toBe("github-actions");
    // A GitHub repo with an empty workflow directory genuinely has no Actions runs to name.
    expect(derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: 0 },
      observedAt: OBSERVED_AT,
    })).toMatchObject({ provider: "none", reason: "github-remote-without-workflows" });
  });

  it("never derives 'no reporter' from an unreadable repo — that would disable a gate on a transient error", () => {
    const contract = derivePostMergeEvidenceContract({
      repo: { factsReadable: false },
      observedAt: OBSERVED_AT,
    });
    expect(contract).toMatchObject({ provider: "github-actions", reason: "repo-facts-unreadable" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(false);
  });

  it("lets an operator declaration win in both directions", () => {
    expect(derivePostMergeEvidenceContract({
      declared: { provider: "none", note: "OneDev board" },
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: 11 },
      observedAt: OBSERVED_AT,
    })).toMatchObject({ provider: "none", source: "declared", reason: "operator-declared" });

    expect(derivePostMergeEvidenceContract({
      declared: { provider: "github-actions" },
      repo: { factsReadable: true, remoteUrl: null, githubWorkflowFileCount: 0 },
      observedAt: OBSERVED_AT,
    }).provider).toBe("github-actions");
  });

  it("ignores a declaration it cannot read instead of guessing at it", () => {
    expect(parseDeclaredPostMergeEvidence("none")).toEqual({ provider: "none" });
    expect(parseDeclaredPostMergeEvidence({ provider: "GitHub-Actions", note: " pinned "})).toEqual({
      provider: "github-actions", note: "pinned",
    });
    expect(parseDeclaredPostMergeEvidence({ provider: "onedev-pipeline" })).toBeUndefined();
    expect(parseDeclaredPostMergeEvidence({ note: "no provider key" })).toBeUndefined();
    expect(parseDeclaredPostMergeEvidence(undefined)).toBeUndefined();
    expect(parseDeclaredPostMergeEvidence(null)).toBeUndefined();
    expect(parseDeclaredPostMergeEvidence("true")).toBeUndefined();
  });
});

describe("post-merge gate under an unreportable evidence contract", () => {
  it("resolves an absent gate to not-applicable and lifts the blocker", async () => {
    const ir = irWithPostMergeGate();
    expect(getPostMergeEvidenceGateStatuses(taskWith(), ir, noneContract))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "no-evidence-reporter" }]);
    await expect(getRequiredPostMergeEvidenceBlocker(storeFor(ir), taskWith(), noneContract)).resolves.toBeUndefined();
  });

  it("CONTROL: without the contract the same card is still blocked by the same sentence", async () => {
    const ir = irWithPostMergeGate();
    expect(getPostMergeEvidenceGateStatuses(taskWith(), ir))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
    await expect(getRequiredPostMergeEvidenceBlocker(storeFor(ir), taskWith())).resolves
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
  });

  it("CONTROL: a board WITH a reporter is unaffected by this change", async () => {
    const github = derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: 11 },
      observedAt: OBSERVED_AT,
    });
    const ir = irWithPostMergeGate();
    expect(getPostMergeEvidenceGateStatuses(taskWith(), ir, github)).toEqual([{ gateId: GATE_ID, state: "missing" }]);
    await expect(getRequiredPostMergeEvidenceBlocker(storeFor(ir), taskWith(), github)).resolves
      .toContain("has not reported");
  });

  it("treats a refusal recorded before the contract was observed as a verdict about an impossible contract", () => {
    const statuses = getPostMergeEvidenceGateStatuses(
      taskWith({ workflowStepResults: [failedRow("2026-09-30T15:39:25.003Z")] as never }),
      irWithPostMergeGate(),
      noneContract,
    );
    expect(statuses).toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "verdict-precedes-contract" }]);
  });

  it("CONTROL: a refusal recorded after the observation stays the operator's decision", () => {
    const statuses = getPostMergeEvidenceGateStatuses(
      taskWith({ workflowStepResults: [failedRow("2026-09-30T21:00:00.000Z")] as never }),
      irWithPostMergeGate(),
      noneContract,
    );
    expect(statuses).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("CONTROL: an explicit operator declaration exempts absences but never overwrites a recorded refusal", () => {
    const declared = derivePostMergeEvidenceContract({
      declared: { provider: "none" },
      repo: { factsReadable: true, remoteUrl: null, githubWorkflowFileCount: 0 },
      observedAt: OBSERVED_AT,
    });
    const statuses = getPostMergeEvidenceGateStatuses(
      taskWith({ workflowStepResults: [failedRow("2026-09-30T15:39:25.003Z")] as never }),
      irWithPostMergeGate(),
      declared,
    );
    expect(statuses).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("CONTROL: an approval is still an approval, and RUFU-429's workspace exemption still works unaided", async () => {
    const ir = irWithPostMergeGate();
    expect(getPostMergeEvidenceGateStatuses(taskWith({ workflowStepResults: [approvedRow] as never }), ir, noneContract))
      .toEqual([]);
    const workspaceTask = taskWith({
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
      workflowStepResults: [failedRow("2026-09-30T15:39:25.003Z")] as never,
    });
    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
    await expect(getRequiredPostMergeEvidenceBlocker(
      storeFor(ir),
      taskWith({ workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } } }),
    )).resolves.toBeUndefined();
  });
});
