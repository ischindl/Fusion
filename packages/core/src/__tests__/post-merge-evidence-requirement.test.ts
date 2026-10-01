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
  authoredPostMergeEvidenceKindOf,
  resolvePostMergeEvidenceKind,
  POST_MERGE_VERIFICATION_PROMPT,
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
/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
Still the "no reporter" fixture, and it survives RUFU-457 unchanged for a reason: the same self-hosted GitLab
origin resolves `none` while NO endpoint is configured. The GitLab reporter needs the instance's configured
URL to match, so a bare remote stays an honest exemption instead of a guessed reporter.
*/
const noReporter = derivePostMergeEvidenceContract({
  repo: { factsReadable: true, remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git", githubWorkflowFileCount: 0 },
  observedAt: "2026-09-30T20:00:00.000Z",
});
const onedevReporter = derivePostMergeEvidenceContract({
  repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
  endpoints: [{ provider: "onedev", baseUrl: "http://192.168.12.60:6610" }],
  observedAt: "2026-10-01T06:00:00.000Z",
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

    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
    This assertion used `onedev-pipeline` as its refusal example, because before this change that kind did not
    exist. It now parses, so the refusal moves to values the prompt builder genuinely has no text for: the
    bare provider name (which RUFU-430's fallback test above still reads as the historical contract at the
    kind-reader level) and a near-miss plural typo of the new kind. The guard being pinned — "a kind with no
    prompt text cannot be persisted" — is unchanged.
    */
    expect(() => parseWorkflowIr(JSON.parse(JSON.stringify(ir({ kind: "onedev" }))))).toThrow(/evidence\.kind/);
    expect(() => parseWorkflowIr(JSON.parse(JSON.stringify(ir({ kind: "gitlab-pipelines" }))))).toThrow(/evidence\.kind/);

    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):CONTROL — the two reporter kinds are parseable,
    which is what makes a per-platform contract authorable at all.
    */
    for (const kind of ["onedev-pipeline", "gitlab-pipeline"]) {
      const accepted = parseWorkflowIr(JSON.parse(JSON.stringify(ir({ kind }))));
      const acceptedNode = accepted.nodes.find((candidate) => candidate.id === GATE_ID);
      expect((acceptedNode?.config as { evidence?: unknown }).evidence).toEqual({ kind });
    }

    // Absence is still absence: no key is invented.
    const untouched = parseWorkflowIr(JSON.parse(JSON.stringify(ir())));
    expect((untouched.nodes.find((n) => n.id === GATE_ID)?.config as Record<string, unknown>).evidence).toBeUndefined();
  });
});

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
RUFU-430 gave the contract a provider axis but shipped one reporter, so OneDev and GitLab boards were forced
between GitHub's shard vocabulary and no run request at all. These cases pin the two new shapes, that they
name a real run, and — the part that keeps every downstream consumer intact — that switching platform changes
ONLY the evidence section of the prompt.
*/
describe("per-platform evidence contracts (OneDev / GitLab)", () => {
  const OUTPUT_MARKERS = '## Output Requirements';
  const VERDICT_JSON = '{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}';
  const SHARD_ARTIFACTS = ["test-timings-shard-1", "test-timings-shard-2", "test-timings-shard-3", "test-timings-shard-4"];

  it("treats both reporter contracts as demanding a real CI run, and integration-only as the only that does not", () => {
    expect(postMergeEvidenceDemandsCi("onedev-pipeline")).toBe(true);
    expect(postMergeEvidenceDemandsCi("gitlab-pipeline")).toBe(true);
    expect(postMergeEvidenceDemandsCi("integration-only")).toBe(false);
  });

  it("names the platform's own run identifiers and none of the GitHub-only artifact demands", () => {
    const onedev = buildPostMergeVerificationPrompt("onedev-pipeline");
    expect(onedev).toContain("OneDev");
    expect(onedev).toContain("build id");
    expect(onedev).toContain("job/step conclusions");
    expect(onedev).toContain("not at or after the landed SHA");

    const gitlab = buildPostMergeVerificationPrompt("gitlab-pipeline");
    expect(gitlab).toContain("GitLab");
    expect(gitlab).toContain("pipeline id");
    expect(gitlab).toContain("pipeline's own SHA");
    expect(gitlab).toContain("not at or after the landed SHA");

    // The four shard timing artifacts and the Actions smoke job are the demands that cannot exist here.
    for (const prompt of [onedev, gitlab]) {
      for (const artifact of SHARD_ARTIFACTS) expect(prompt).not.toContain(artifact);
      expect(prompt).not.toContain("Pipeline smoke");
      expect(prompt).toContain(VERDICT_JSON);
    }
  });

  it("shares the output-requirements block verbatim across all four contracts", () => {
    const shared = (kind: Parameters<typeof buildPostMergeVerificationPrompt>[0]) =>
      buildPostMergeVerificationPrompt(kind).slice(buildPostMergeVerificationPrompt(kind).indexOf(OUTPUT_MARKERS));
    const fullSuite = shared("github-actions-full-suite");
    expect(shared("integration-only")).toBe(fullSuite);
    expect(shared("onedev-pipeline")).toBe(fullSuite);
    expect(shared("gitlab-pipeline")).toBe(fullSuite);
  });

  it("keeps the built-in constant equal to both the no-arg and the explicit full-suite form", () => {
    expect(POST_MERGE_VERIFICATION_PROMPT).toBe(buildPostMergeVerificationPrompt());
    expect(POST_MERGE_VERIFICATION_PROMPT).toBe(buildPostMergeVerificationPrompt("github-actions-full-suite"));
    // A platform contract is a different text — it must never be mistaken for the untampered built-in.
    expect(buildPostMergeVerificationPrompt("onedev-pipeline")).not.toBe(POST_MERGE_VERIFICATION_PROMPT);
  });

  it("distinguishes an authored kind from an absent one", () => {
    expect(authoredPostMergeEvidenceKindOf(undefined)).toBeUndefined();
    expect(authoredPostMergeEvidenceKindOf({})).toBeUndefined();
    expect(authoredPostMergeEvidenceKindOf({ evidence: { kind: "onedev" } })).toBeUndefined();
    expect(authoredPostMergeEvidenceKindOf({ evidence: { kind: "onedev-pipeline" } })).toBe("onedev-pipeline");
  });

  it("resolves authored-vs-implied: authored wins, absent inherits the reporter's platform", () => {
    // Absent kind: the reporter decides, which is precisely the behavior RUFU-457 adds.
    expect(resolvePostMergeEvidenceKind({ authored: undefined, provider: "onedev" })).toBe("onedev-pipeline");
    expect(resolvePostMergeEvidenceKind({ authored: undefined, provider: "gitlab" })).toBe("gitlab-pipeline");
    // GitHub, no reporter, and no contract at all keep the historical reading — the `none` path is untouched.
    expect(resolvePostMergeEvidenceKind({ authored: undefined, provider: "github-actions" })).toBe("github-actions-full-suite");
    expect(resolvePostMergeEvidenceKind({ authored: undefined, provider: "none" })).toBe("github-actions-full-suite");
    expect(resolvePostMergeEvidenceKind({ authored: undefined, provider: undefined })).toBe("github-actions-full-suite");
    // An authored kind always wins, including the CI-less shape on a board that HAS a reporter.
    expect(resolvePostMergeEvidenceKind({ authored: "integration-only", provider: "onedev" })).toBe("integration-only");
    expect(resolvePostMergeEvidenceKind({ authored: "github-actions-full-suite", provider: "gitlab" })).toBe("github-actions-full-suite");
    expect(resolvePostMergeEvidenceKind({ authored: "gitlab-pipeline", provider: "onedev" })).toBe("gitlab-pipeline");
  });

  it("owes the platform's own CI evidence to an OneDev board instead of exempting it", () => {
    expect(onedevReporter.provider).toBe("onedev");
    expect(getPostMergeEvidenceGateStatuses(task, ir(), onedevReporter))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
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
