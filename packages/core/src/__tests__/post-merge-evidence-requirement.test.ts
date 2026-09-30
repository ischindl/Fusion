/*
FNXC:PostMergeEvidenceRequirement 2026-09-30-22:51 (RUFU-430):
The second half of the fix is that the EVIDENCE CONTRACT is authored on the workflow node, not welded to the
built-in. Measured reason: `builtin:coding` — the default workflow on every board in this fleet — carries the
gate with `defaultOn: true`, so no board chose the GitHub Actions contract; 287 finalize deferrals named it
on 2026-09-30 alone, and the only selection that avoided it was a workflow with no post-merge group at all,
which also drops the integration review that found the broken backup command on VLLM-078. These cases pin
that a board can now keep the gate and ask it for evidence its repo can produce.
*/
import { describe, expect, it } from "vitest";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import {
  buildPostMergeVerificationPrompt,
  postMergeEvidenceDemandsCi,
  postMergeEvidenceKindOf,
} from "../workflows/builtin-post-merge-group.js";
import { getPostMergeEvidenceGateStatuses } from "../merge/confirmed-merge-reconciliation.js";
import { derivePostMergeEvidenceContract } from "../merge/post-merge-evidence-contract.js";
import type { Task, WorkflowIr } from "../types.js";

const GATE_ID = "post-merge-verification";

function ir(evidence?: { kind: string }): WorkflowIr {
  return {
    version: "v2",
    name: "Coding",
    columns: [{ id: "in-review", label: "In review", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "in-review" },
      { id: "end", kind: "end", column: "in-review" },
      { id: "merge-attempt", kind: "action", column: "in-review" },
      {
        id: GATE_ID,
        kind: "optional-group",
        column: "in-review",
        config: {
          phase: "post-merge",
          defaultOn: true,
          ...(evidence ? { evidence } : {}),
          template: { nodes: [{ id: `${GATE_ID}-step`, kind: "prompt", config: { gateMode: "gate" } }], edges: [] },
        },
      },
    ],
    edges: [
      { from: "start", to: "merge-attempt", condition: "success" },
      { from: "merge-attempt", to: GATE_ID, condition: "success" },
      { from: GATE_ID, to: "end", condition: "success" },
    ],
  } as unknown as WorkflowIr;
}

const task = { id: "RUFU-430", enabledWorkflowSteps: [GATE_ID], workflowStepResults: [] } as never;
const noReporter = derivePostMergeEvidenceContract({
  repo: { factsReadable: true, remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git", githubWorkflowFileCount: 0 },
  observedAt: "2026-09-30T20:00:00.000Z",
});

describe("post-merge verification prompt", () => {
  it("keeps the historical Full Suite contract byte-for-byte as the default", () => {
    const prompt = buildPostMergeVerificationPrompt();
    expect(prompt).toContain("## Required post-landing Full Suite evidence");
    expect(prompt).toContain("1/4, 2/4, 3/4, and 4/4");
    expect(prompt).toContain("test-timings-shard-4");
    expect(prompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}');
    expect(buildPostMergeVerificationPrompt("github-actions-full-suite")).toBe(prompt);
  });

  it("names evidence a CI-less repo can produce when the node declares integration-only", () => {
    const prompt = buildPostMergeVerificationPrompt("integration-only");
    expect(prompt).toContain("landed SHA");
    expect(prompt).toContain("already-on-main");
    // The exact demands that turned honest reviewers into permanent REVISEs on CI-less boards.
    expect(prompt).not.toMatch(/1\/4, 2\/4, 3\/4/);
    expect(prompt).not.toMatch(/test-timings-shard-\d/);
    expect(prompt).not.toContain("Required post-landing Full Suite evidence");
    expect(prompt).not.toContain("push-to-main run");
    // The verdict protocol is shared, so downstream parsing is unaffected by the contract choice.
    expect(prompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}');
  });
});

describe("post-merge evidence kind resolution", () => {
  it("reads an absent config as the historical contract so existing IRs are unchanged", () => {
    expect(postMergeEvidenceKindOf(undefined)).toBe("github-actions-full-suite");
    expect(postMergeEvidenceKindOf({})).toBe("github-actions-full-suite");
    expect(postMergeEvidenceKindOf({ evidence: { kind: "integration-only" } })).toBe("integration-only");
    // An unrecognised value must not silently downgrade a delivery gate.
    expect(postMergeEvidenceKindOf({ evidence: { kind: "onedev" } })).toBe("github-actions-full-suite");
    expect(postMergeEvidenceDemandsCi("integration-only")).toBe(false);
    expect(postMergeEvidenceDemandsCi("github-actions-full-suite")).toBe(true);
  });

  it("persists the authored contract through IR parse and refuses a kind with no prompt text", () => {
    const parsed = parseWorkflowIr(JSON.parse(JSON.stringify(ir({ kind: "integration-only" }))));
    const node = parsed.nodes.find((candidate) => candidate.id === GATE_ID);
    expect((node?.config as { evidence?: unknown }).evidence).toEqual({ kind: "integration-only" });

    expect(() => parseWorkflowIr(JSON.parse(JSON.stringify(ir({ kind: "onedev-pipeline" }))))).toThrow(/evidence\.kind/);

    // Absence is still absence: no key is invented.
    const untouched = parseWorkflowIr(JSON.parse(JSON.stringify(ir())));
    expect((untouched.nodes.find((n) => n.id === GATE_ID)?.config as Record<string, unknown>).evidence).toBeUndefined();
  });
});

describe("post-merge gate under an authored evidence contract", () => {
  it("exempts only the contract that names CI artifacts", () => {
    expect(getPostMergeEvidenceGateStatuses(task, ir(), noReporter))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "no-evidence-reporter" }]);
  });

  it("CONTROL: an integration-only gate is still owed by a board with no CI reporter", () => {
    expect(getPostMergeEvidenceGateStatuses(task, ir({ kind: "integration-only" }), noReporter))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
  });

  it("CONTROL: an explicit declaration exempts a CI contract but never an integration-only one", () => {
    const declared = derivePostMergeEvidenceContract({
      declared: { provider: "none" },
      repo: { factsReadable: true, remoteUrl: null },
      observedAt: "2026-09-30T20:00:00.000Z",
    });
    expect(getPostMergeEvidenceGateStatuses(task, ir(), declared)[0].state).toBe("not-applicable");
    expect(getPostMergeEvidenceGateStatuses(task, ir({ kind: "integration-only" }), declared)[0].state).toBe("missing");
  });
});
