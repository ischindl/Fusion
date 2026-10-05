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
FNXC:PostMergeEvidenceRequirement 2026-10-05-08:52 (merge origin/main):
Upstream's disposition sentence (a linked follow-up with an accountable owner satisfies the requirement) is kept: it loosens
exactly the pressure RUFU-430 removed, so it belongs beside the no-CI-reporter wording rather than in the
CI-reporter block. What stays out is any demand for a CI run, shard, or artifact.
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

FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
Two more contracts, one per reporter that really exists on this fleet: `onedev-pipeline` and
`gitlab-pipeline`. RUFU-430 gave the gate a `provider` axis but implemented one reporter, so an OneDev or
GitLab board had exactly two options — inherit GitHub's shard/timing vocabulary it can never satisfy, or get
switched to `integration-only`, which asks for no run at all. Neither is a delivery gate. Each new contract
names the identifiers a reviewer on that platform can actually be shown (a build/pipeline id plus its
per-job conclusions and artifacts) and keeps the shared verdict protocol untouched.

What stays deliberately NOT parameterized: the verdict JSON, the `notes` rule, and the shared output block.
A platform changes the evidence list only, so every result-row consumer parses all four contracts identically.
*/
export type PostMergeEvidenceKind =
  | "github-actions-full-suite"
  | "integration-only"
  | "onedev-pipeline"
  | "gitlab-pipeline";

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
The allow-list and the parse-error sentence are generated from this one list. The IR validator used to
enumerate the two kinds twice (once in the condition, once in the message), which is the shape that drifts:
a kind added to the union but not to the message tells an operator their valid workflow is invalid.
*/
export const POST_MERGE_EVIDENCE_KINDS = [
  "github-actions-full-suite",
  "integration-only",
  "onedev-pipeline",
  "gitlab-pipeline",
] as const satisfies readonly PostMergeEvidenceKind[];

/** `'a', 'b', or 'c'` form of the allow-list, for parse-error text that must not drift from it. */
export function describePostMergeEvidenceKinds(): string {
  const quoted = POST_MERGE_EVIDENCE_KINDS.map((kind) => `'${kind}'`);
  return quoted.slice(0, -1).join(", ") + ", or " + quoted[quoted.length - 1];
}

/** The evidence contract a post-merge group node enforces; absent means `github-actions-full-suite`. */
export function postMergeEvidenceKindOf(config: { evidence?: { kind?: unknown } } | undefined): PostMergeEvidenceKind {
  return config?.evidence?.kind === "integration-only" ? "integration-only" : "github-actions-full-suite";
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
`postMergeEvidenceKindOf` cannot answer "did the author choose this, or is it the historical default?" — both
read as `github-actions-full-suite`. That distinction is what the provider-aware substitution below needs, so
it gets its own reader instead of a change to the existing one (whose single-argument meaning, including a
bare provider name falling back to the historical reading, is load-bearing for persisted IRs and their tests).
*/
/** The evidence kind a node AUTHORED, or undefined when it authored none or an unrecognized one. */
export function authoredPostMergeEvidenceKindOf(
  config: { evidence?: { kind?: unknown } } | undefined,
): PostMergeEvidenceKind | undefined {
  const kind = config?.evidence?.kind;
  return (POST_MERGE_EVIDENCE_KINDS as readonly unknown[]).includes(kind) ? kind as PostMergeEvidenceKind : undefined;
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
The final contract for a dispatch is `authored ?? platformDefault(provider)`, and the order IS the contract:
- An authored kind always wins. A repo whose CI contract is the integration lane keeps `integration-only` on
  a GitLab board too — that choice is a repo fact, not a host fact.
- An absent kind inherits the reporter's platform. That is the bug this task closes: absent is what every
  built-in and every un-updated custom workflow carries, and until now absent meant GitHub vocabulary no
  matter where the board lives.
- `github-actions`, `none`, and a missing contract all keep resolving the historical full-suite reading, so
  the `none` exemption path is untouched: `none` is decided by the gate-status seam, not by prompt wording.
*/
/** Resolve the evidence contract to enforce: what the author wrote, else what the reporter's platform implies. */
export function resolvePostMergeEvidenceKind(input: {
  authored: PostMergeEvidenceKind | undefined;
  provider: string | undefined;
}): PostMergeEvidenceKind {
  if (input.authored) return input.authored;
  if (input.provider === "onedev") return "onedev-pipeline";
  if (input.provider === "gitlab") return "gitlab-pipeline";
  return "github-actions-full-suite";
}

/** True when the contract can only be satisfied by a CI reporter (a run the reviewer can actually open). */
export function postMergeEvidenceDemandsCi(kind: PostMergeEvidenceKind): boolean {
  // `integration-only` is the one contract that names no run; every reporter contract demands one.
  return (
    kind === "github-actions-full-suite" ||
    kind === "onedev-pipeline" ||
    kind === "gitlab-pipeline"
  );
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

Judge failures against this task's landed changes. For evidence-backed unrelated failures, a linked follow-up with an accountable owner satisfies the disposition requirement; that follow-up may still be filed after approval.

Pre-landing, unrelated-main, or partial evidence does not satisfy this contract. If the required run is still running or required evidence is unavailable, return REVISE and state that final completion remains blocked pending the post-landing evidence.

Evidence from before the landing, or from unrelated content on the trunk, does not satisfy this contract. If the landed content cannot be located or does not match the deliverable, return REVISE and name what is missing. Record verified evidence in the task delivery record before approving.`;

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
One block per new reporter, shaped like the full-suite block (numbered items + a "not at or after the landed
SHA" disqualifier) and deliberately free of GitHub's shard/timing vocabulary: no `test-timings-shard-N`, no
Actions smoke job, no artifact-download demand. Those absences are the point — RUFU-430 measured 66 of 98
durable post-merge `failed` rows naming a CI pipeline it could not find, and the non-GitHub half of that was
a reviewer correctly reporting evidence that cannot exist on their platform. Each block also says the record
is READ on the platform's own page: Fusion queries no CI API and asks for no token in the report.
*/
const ONEDEV_PIPELINE_EVIDENCE_BLOCK = `## Required post-landing OneDev pipeline evidence
This enabled gate requires the OneDev pipeline delivery record for the landing. Do NOT approve until its delivery record names all of the following:
1. The landed SHA and the OneDev merge request / pipeline that produced the default-branch build at or after that SHA, including the build id and the request or pipeline id it came from.
2. The build's job/step conclusions, named individually, all successful.
3. The named artifacts the build published, or an explicit statement that this build is configured to publish none.
4. The trigger of that build, so the run is attributable to this landing rather than to an unrelated push to the same branch.

Read the record on OneDev's own build page for this repository; the report needs no access token and no API call from Fusion.

A build that is not at or after the landed SHA does not satisfy this contract, and neither does pre-landing, unrelated-branch, or partial evidence. Do NOT demand GitHub Actions shard artifacts, the Actions smoke job, or a shard-level flakiness comparison against recent main runs: OneDev produces none of them, and the \`gh\` CLI is not how this platform's record is read. If the required build or any required evidence is unavailable, return REVISE and state that final completion remains blocked pending the post-landing evidence. Record verified evidence in the task delivery record before approving.`;

const GITLAB_PIPELINE_EVIDENCE_BLOCK = `## Required post-landing GitLab pipeline evidence
This enabled gate requires the GitLab pipeline delivery record for the landing. Do NOT approve until its delivery record names all of the following:
1. The landed SHA and the GitLab pipeline that ran on the default-branch commit at or after that SHA, including the pipeline id and the pipeline's own SHA.
2. Every job in that pipeline, named individually with its status, all successful.
3. The artifact list the pipeline published, or an explicit statement that this pipeline publishes none.
4. The ref or merge-request source that ties the pipeline to this landing, so the run is attributable to it.

Read the record on the instance's pipeline page for this project; the report needs no access token and no API call from Fusion.

A pipeline whose SHA is not at or after the landed SHA does not satisfy this contract, and neither does pre-landing, unrelated-branch, or partial evidence. Do NOT demand GitHub Actions shard artifacts, the Actions smoke job, or a shard-level flakiness comparison against recent main runs: GitLab produces none of them, and the \`gh\` CLI is not how this platform's record is read. If the required pipeline or any required evidence is unavailable, return REVISE and state that final completion remains blocked pending the post-landing evidence. Record verified evidence in the task delivery record before approving.`;

const POST_MERGE_VERIFICATION_OUTPUT_RULES = `## Output Requirements
- APPROVE: post-merge verification is acceptable.
- APPROVE_WITH_NOTES: completion may proceed with non-blocking notes only when every post-landing evidence item above is recorded.
- REVISE: completion should be blocked; include the concrete post-merge issue and the needed follow-up.
- \`notes\` MUST contain one to three non-empty sentences naming what was checked and why the verdict was reached. An empty \`notes\` string is a protocol violation.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

const EVIDENCE_BLOCKS: Record<PostMergeEvidenceKind, string> = {
  "github-actions-full-suite": FULL_SUITE_EVIDENCE_BLOCK,
  "integration-only": INTEGRATION_ONLY_EVIDENCE_BLOCK,
  "onedev-pipeline": ONEDEV_PIPELINE_EVIDENCE_BLOCK,
  "gitlab-pipeline": GITLAB_PIPELINE_EVIDENCE_BLOCK,
};

/**
 * Build the post-merge reviewer prompt for one evidence contract. The full-suite branch is the historical
 * prompt unchanged; only the evidence section differs between contracts.
 *
 * FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457): the four contracts differ ONLY in the
 * evidence section — the review-focus preamble and `POST_MERGE_VERIFICATION_OUTPUT_RULES` are shared
 * verbatim, which is what keeps verdict parsing, the `notes` requirement, and every result-row consumer
 * platform-independent as the two reporter contracts are added.
 */
export function buildPostMergeVerificationPrompt(kind: PostMergeEvidenceKind = "github-actions-full-suite"): string {
  const evidence = EVIDENCE_BLOCKS[kind];
  return `You are a post-merge verification reviewer. Verify that the task's merged result is safe after integration.

## Review focus
1. Confirm the task has merge proof or already-on-main proof before treating the workflow as complete.
2. Check the final merged diff and task summary for obvious mismatches, missing verification evidence, or integration-only regressions.
3. If configured test/build commands are available in the task context, inspect their latest result or explain why no post-merge command was applicable.

${evidence}

${POST_MERGE_VERIFICATION_OUTPUT_RULES}`;
}

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
Exported as the one authorized copy of the untampered built-in text. The engine's prompt-materialization seam
substitutes a platform prompt ONLY on a byte-for-byte match against this constant, because the safety
property "an operator who edited this prompt in the workflow editor keeps their own wording" can only be
decided by exact comparison — matching on "does the prompt mention CI?" would rewrite authored text.
*/
export const POST_MERGE_VERIFICATION_PROMPT = buildPostMergeVerificationPrompt("github-actions-full-suite");

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
