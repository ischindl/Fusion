import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-09:00:
Factory for a POST-MERGE optional-group node — the graph-native execution mechanism
for post-merge workflow steps (U7 spike). Mirrors `codeReviewOptionalGroupNode` /
`browserVerificationOptionalGroupNode`, but the produced node carries
`config.phase: "post-merge"` so the graph executor:
  1. runs it only AFTER a successful merge (when wired off the merge region and the
     `graphNativePostMerge` flag is on), and
  2. records its WorkflowStepResult with `phase: "post-merge"` + emits `[post-merge]`
     logs. Advisory post-merge failures are non-blocking; explicit gate-mode
     verification failures block final graph success after merge proof.

FNXC:WorkflowPostMerge 2026-06-29-12:22:
Full task built-ins need an explicit default-off post-merge verification node so
post-merge audit/verification policy can live in workflow definitions instead of
merger-only fallback code. The group node id is the STABLE per-task enable key
(`enabledWorkflowSteps`), and the inner template node carries a DISTINCT id
(`${id}-step`) — a template node id may not collide with the group/top-level node id
(optional-group validation).
*/

export const POST_MERGE_VERIFICATION_GROUP_ID = "post-merge-verification";

const LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS = ["plan-review", "code-review"] as const;
const BUILTIN_CODING_WORKFLOW_IDS = new Set([
  "builtin:coding",
  "builtin:legacy-coding",
  "builtin:stepwise-coding",
]);

/**
 * FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
 * Upgrade the historical built-in coding default with the mandatory post-merge
 * delivery-evidence gate. Only the exact former default is changed; every other
 * optional-step configuration retains its recorded shape.
 */
export function upgradeLegacyCodingPostMergeVerificationStepIds(
  workflowId: string,
  stepIds: readonly string[],
): string[] | undefined {
  if (!BUILTIN_CODING_WORKFLOW_IDS.has(workflowId)
    || stepIds.length !== LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.length
    || !LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.every((id) => stepIds.includes(id))) {
    return undefined;
  }

  /*
  FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
  The former two-review default predates the required post-landing Full Suite evidence gate.
  Migrate only that exact inherited profile when it is next authoritatively resolved, preserving
  intentional optional-step configurations while preventing existing default coding tasks from
  completing without the five-lane CI evidence required by FN-9369.
  */
  return [...LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS, POST_MERGE_VERIFICATION_GROUP_ID];
}

/*
FNXC:PostMergeFullSuiteEvidence 2026-09-22-01:36:
An enabled post-merge gate owns the task's required post-landing Full Suite evidence. CI remains
non-blocking branch protection, but this gate must refuse final task completion until the first
push-to-main run at or after the landed SHA has recorded every shard conclusion and timing artifact.
*/
/*
FNXC:PostMergeEvidenceRequirement 2026-09-30-22:51 (RUFU-430):
The evidence a post-merge gate may demand is now a property of the WORKFLOW NODE, not a constant welded to
the built-in. Before this, `builtin:coding` was the default workflow on every board in the fleet and it
carried one GitHub-specific contract with `defaultOn: true`, so a board on OneDev, self-hosted GitLab, or a
repo with no remote inherited a demand it could not satisfy and had no way to select out of — the only
available choice was a workflow with no post-merge group at all, which throws away the host-agnostic half
of the check too (the same verifier found a real broken backup command on VLLM-078 while refusing for want
of shard artifacts).

`github-actions-full-suite` is today's contract, kept byte-for-byte so no existing board's bar moves.
`integration-only` demands evidence a repo without CI can actually name. Absence of the config means
`github-actions-full-suite`, so every persisted IR written before this change resolves unchanged.
*/
export type PostMergeEvidenceKind = "github-actions-full-suite" | "integration-only";

/** The evidence contract a post-merge group node enforces; absent means `github-actions-full-suite`. */
export function postMergeEvidenceKindOf(config: { evidence?: { kind?: unknown } } | undefined): PostMergeEvidenceKind {
  return config?.evidence?.kind === "integration-only" ? "integration-only" : "github-actions-full-suite";
}

/** True when the contract can only be satisfied by a CI reporter (a run the reviewer can actually open). */
export function postMergeEvidenceDemandsCi(kind: PostMergeEvidenceKind): boolean {
  return kind === "github-actions-full-suite";
}

const FULL_SUITE_EVIDENCE_BLOCK = `## Required post-landing Full Suite evidence
This enabled gate requires post-landing Full Suite evidence. Do NOT approve until its delivery record names all of the following:
1. The landed SHA and the first Full Suite push-to-main run at or after that SHA, including the run ID and run SHA.
2. A successful conclusion for Pipeline smoke tier.
3. A successful conclusion for every Test shard: 1/4, 2/4, 3/4, and 4/4.
4. All four timing artifacts: test-timings-shard-1, test-timings-shard-2, test-timings-shard-3, and test-timings-shard-4.

Pre-landing, unrelated-main, or partial evidence does not satisfy this contract. If the required run or any required evidence is unavailable, return REVISE and state that final completion remains blocked pending the post-landing evidence. Record verified evidence in the task delivery record before approving.`;

/*
FNXC:PostMergeEvidenceRequirement 2026-09-30-22:51 (RUFU-430):
Worded so a reviewer cannot satisfy it by pointing at nothing: it still names the landed SHA and still
requires explaining the absence of post-landing command results. What it must not do is ask for a CI run,
shard, or artifact — that is the one sentence that turned an honest reviewer into a permanent REVISE.
*/
const INTEGRATION_ONLY_EVIDENCE_BLOCK = `## Required post-landing evidence (no CI reporter configured)
This project declares no CI evidence reporter, so no CI run, job, shard, or build artifact may be demanded here and none may be treated as missing evidence. Do NOT approve until the delivery record names all of the following:
1. The landed SHA on the trunk branch, with merge proof or already-on-main proof.
2. That the merged result matches the task's stated deliverable — checked by reading the landed content, not the summary alone.
3. The result of the project's own configured verification command run at or after the landed SHA, or an explicit statement that no such command applies to this delivery and why.

Evidence from before the landing, or from unrelated content on the trunk, does not satisfy this contract. If the landed content cannot be located or does not match the deliverable, return REVISE and name what is missing. Record verified evidence in the task delivery record before approving.`;

const POST_MERGE_VERIFICATION_OUTPUT_RULES = `## Output Requirements
- APPROVE: post-merge verification is acceptable.
- APPROVE_WITH_NOTES: completion may proceed with non-blocking notes only when every post-landing evidence item above is recorded.
- REVISE: completion should be blocked; include the concrete post-merge issue and the needed follow-up.
- \`notes\` MUST contain one to three non-empty sentences naming what was checked and why the verdict was reached. An empty \`notes\` string is a protocol violation.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

/**
 * Build the post-merge reviewer prompt for one evidence contract. The full-suite branch is the historical
 * prompt unchanged; only the evidence section differs between contracts.
 */
export function buildPostMergeVerificationPrompt(kind: PostMergeEvidenceKind = "github-actions-full-suite"): string {
  const evidence = kind === "integration-only" ? INTEGRATION_ONLY_EVIDENCE_BLOCK : FULL_SUITE_EVIDENCE_BLOCK;
  return `You are a post-merge verification reviewer. Verify that the task's merged result is safe after integration.

## Review focus
1. Confirm the task has merge proof or already-on-main proof before treating the workflow as complete.
2. Check the final merged diff and task summary for obvious mismatches, missing verification evidence, or integration-only regressions.
3. If configured test/build commands are available in the task context, inspect their latest result or explain why no post-merge command was applicable.

${evidence}

${POST_MERGE_VERIFICATION_OUTPUT_RULES}`;
}

const POST_MERGE_VERIFICATION_PROMPT = buildPostMergeVerificationPrompt("github-actions-full-suite");

export interface PostMergeOptionalGroupSpec {
  /** Stable per-task enable key + group node id. */
  id: string;
  /** Display name (toggle/editor surfaces + recorded `workflowStepName`). */
  name: string;
  /** Column the group node sits in (typically a post-merge/`done` column). */
  column: string;
  /** Agent prompt for the inner post-merge step. */
  prompt: string;
  /** Optional short description for the inner node. */
  description?: string;
  /** Inner step tool access; defaults to "readonly". */
  toolMode?: "readonly" | "coding";
  /** Gate semantics; defaults to "advisory" (post-merge failures are non-blocking). */
  gateMode?: "advisory" | "gate";
  /** Seed the per-task enable toggle for new tasks; defaults to false (opt-in). */
  defaultOn?: boolean;
  /**
   * Which evidence this gate may demand, authored per workflow. Absent = "github-actions-full-suite"
   * (the historical contract), so pre-existing built-ins and persisted IRs are unchanged.
   */
  evidence?: PostMergeEvidenceKind;
}

/**
 * Build a post-merge `optional-group` node. The node config is marked
 * `phase: "post-merge"` so the graph executor's optional-group recording path keys
 * the result phase + log prefix off it.
 */
export function postMergeOptionalGroupNode(spec: PostMergeOptionalGroupSpec): WorkflowIrNode {
  return {
    id: spec.id,
    kind: "optional-group",
    column: spec.column,
    config: {
      name: spec.name,
      phase: "post-merge",
      defaultOn: spec.defaultOn ?? false,
      // Authored only when explicitly chosen, so an IR without the key stays byte-identical to before.
      ...(spec.evidence !== undefined ? { evidence: { kind: spec.evidence } } : {}),
      template: {
        nodes: [
          {
            id: `${spec.id}-step`,
            kind: "prompt",
            config: {
              name: spec.name,
              ...(spec.description !== undefined ? { description: spec.description } : {}),
              prompt: spec.prompt,
              toolMode: spec.toolMode ?? "readonly",
              gateMode: spec.gateMode ?? "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}

export function postMergeVerificationOptionalGroupNode(column = "done"): WorkflowIrNode {
  return postMergeOptionalGroupNode({
    id: POST_MERGE_VERIFICATION_GROUP_ID,
    name: "Post-merge verification",
    column,
    prompt: POST_MERGE_VERIFICATION_PROMPT,
    description: "Verify the integrated result after merge proof before final completion",
    gateMode: "gate",
    /*
    FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:04:
    Post-merge evidence is a delivery boundary, not an advisory observation. Seed this gate for
    merge-capable built-ins so completion cannot claim GitHub-hosted Full Suite success before the
    landed run has proved Pipeline smoke, every shard, and each timing artifact.
    */
    defaultOn: true,
  });
}
