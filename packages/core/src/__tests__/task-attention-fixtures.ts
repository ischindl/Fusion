/*
FNXC:BoardOrdering 2026-11-13-09:30:
"Fixture A" for RUFU-526's attention ladder - ONE row matrix that three separate suites must agree
over, so it is declared once here rather than re-typed per suite:
  - `task-attention.test.ts`      asserts every row's CLIENT tier,
  - `task-attention-parity.test.ts` asserts `sqlAttentionTier >= resolveAttentionTier` per row and
    pins the one declared divergence,
  - `task-queue-acceptance.test.ts` / the store integration suite run the same shapes through the
    real comparator and the real PostgreSQL `ORDER BY`.

Deliberately NOT a `.test.ts` file: `packages/core/vitest.config.ts` collects only test-suffixed
sources under `src`, so a helper carrying that suffix would be collected twice - once on its own and
once through every import - and duplicate a suite under two names.

The matrix is the union of what each consumer must prove, which is why some rows carry a code the
client half alone can see (`stallReason`) and some carry only durable columns: the two halves are
allowed to differ on exactly those rows and nowhere else.
*/

import type { AttentionTask, AttentionTier } from "../tasks/task-attention.js";

export interface AttentionFixtureRow {
  /** Stable name so a failure names the shape instead of an index. */
  name: string;
  task: AttentionTask;
  /** Expected client tier with the review-scope gate OFF (a plain `todo` lane). */
  withoutGate: AttentionTier;
  /** Expected client tier with the review-scope gate ON (a lane containing a review column). */
  withGate: AttentionTier;
}

/* A `HumanPlanApprovalState`-shaped decision, reduced to what the ladder reads: the KEY existing. */
const DECIDED = { decidedBy: "operator", decidedAt: "2026-11-13T00:00:00.000Z" };

export const ATTENTION_FIXTURE_A: readonly AttentionFixtureRow[] = [
  // ---- tier 6: idle / backlog. The floor every other row is measured against. ----
  { name: "idle: no field at all", task: {}, withoutGate: 6, withGate: 6 },
  { name: "idle: status queued", task: { status: "queued" }, withoutGate: 6, withGate: 6 },
  { name: "idle: status null", task: { status: null }, withoutGate: 6, withGate: 6 },
  { name: "idle: status done", task: { status: "done" }, withoutGate: 6, withGate: 6 },

  // ---- tier 0: error / failed / blocked. ----
  { name: "error: non-empty", task: { error: "merge failed" }, withoutGate: 0, withGate: 0 },
  { name: "error: empty string", task: { error: "" }, withoutGate: 6, withGate: 6 },
  { name: "error: whitespace only", task: { error: "   " }, withoutGate: 6, withGate: 6 },
  { name: "error: null", task: { error: null }, withoutGate: 6, withGate: 6 },
  { name: "status failed with null error", task: { status: "failed", error: null }, withoutGate: 0, withGate: 0 },
  { name: "status failed with empty error", task: { status: "failed", error: "" }, withoutGate: 0, withGate: 0 },
  { name: "status blocked", task: { status: "blocked" }, withoutGate: 0, withGate: 0 },

  // ---- tier 1: a required pre-merge gate that is failed, pending, or has no row. ----
  {
    name: "gate: latest failed",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }] },
    withoutGate: 6,
    withGate: 1,
  },
  {
    name: "gate: latest pending",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "pending" }] },
    withoutGate: 6,
    withGate: 1,
  },
  {
    name: "gate: zero result rows for an enabled step",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
    withoutGate: 6,
    withGate: 1,
  },
  {
    name: "gate: workflowStepResults absent entirely",
    task: { enabledWorkflowSteps: ["code-review"] },
    withoutGate: 6,
    withGate: 1,
  },
  {
    name: "gate: latest passed",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "gate: latest advisory_failure (non-blocking by contract)",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "advisory_failure" }] },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "gate: latest skipped (often an audited waiver)",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [{ workflowStepId: "code-review", status: "skipped" }] },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "gate: advisory_failure LATEST while another step failed",
    task: {
      enabledWorkflowSteps: ["code-review", "verification"],
      workflowStepResults: [
        { workflowStepId: "code-review", status: "failed" },
        { workflowStepId: "code-review", status: "advisory_failure" },
        { workflowStepId: "verification", status: "failed" },
      ],
    },
    withoutGate: 6,
    // The other step's `failed` is still attention even though this step's own latest row is not.
    withGate: 1,
  },
  {
    name: "gate: latest row wins over an older failed row",
    task: {
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [
        { workflowStepId: "code-review", status: "failed" },
        { workflowStepId: "code-review", status: "passed" },
      ],
    },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "gate: stale workflowStepResults with EMPTY enabledWorkflowSteps",
    task: {
      enabledWorkflowSteps: [],
      workflowStepResults: [{ workflowStepId: "removed-step", status: "failed" }],
    },
    withoutGate: 6,
    withGate: 6,
  },

  // ---- tier 2: a decision the operator owes. ----
  {
    name: "approval: awaitingApprovalReason non-blank",
    task: { awaitingApprovalReason: "human-plan-approval" },
    withoutGate: 2,
    withGate: 2,
  },
  { name: "approval: awaitingApprovalReason empty", task: { awaitingApprovalReason: "" }, withoutGate: 6, withGate: 6 },
  { name: "approval: awaitingApprovalReason whitespace", task: { awaitingApprovalReason: "  " }, withoutGate: 6, withGate: 6 },
  {
    name: "approval: human plan armed, no decision",
    task: { humanPlanApproval: { enabled: true } },
    withoutGate: 2,
    withGate: 2,
  },
  {
    name: "approval: human plan armed AND decided",
    task: { humanPlanApproval: { enabled: true, decision: DECIDED } },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "approval: human plan armed with explicit null decision",
    task: { humanPlanApproval: { enabled: true, decision: null } },
    withoutGate: 6,
    withGate: 6,
  },
  {
    name: "approval: human plan disabled",
    task: { humanPlanApproval: { enabled: false } },
    withoutGate: 6,
    withGate: 6,
  },
  { name: "approval: human merge armed, no decision", task: { humanMergeApproval: { enabled: true } }, withoutGate: 2, withGate: 2 },
  {
    name: "approval: human merge armed and decided",
    task: { humanMergeApproval: { enabled: true, decision: { decidedBy: "operator" } } },
    withoutGate: 6,
    withGate: 6,
  },

  // ---- tier 3: hydrated stall signals. Gate OFF means idle: the server must never see these. ----
  { name: "stall: merge-blocker", task: { stallReason: { code: "merge-blocker" } }, withoutGate: 6, withGate: 3 },
  {
    name: "stall: pre-merge-gate-pending",
    task: { stallReason: { code: "pre-merge-gate-pending" } },
    withoutGate: 6,
    withGate: 3,
  },
  { name: "stall: held-human-review", task: { stallReason: { code: "held-human-review" } }, withoutGate: 6, withGate: 3 },
  {
    name: "stall: dependency-blocker",
    task: { stallReason: { code: "dependency-blocker" } },
    withoutGate: 6,
    withGate: 3,
  },
  {
    name: "stall: wip-admission-throttled",
    task: { stallReason: { code: "wip-admission-throttled" } },
    withoutGate: 6,
    withGate: 3,
  },
  {
    name: "stall: inReviewStall signal alone (no stallReason)",
    task: { inReviewStall: { code: "merge-blocker", reason: "Merge blocked", observedAt: "2026-11-13T00:00:00.000Z" } },
    withoutGate: 6,
    withGate: 3,
  },

  // ---- tier 4: any pause reason. ----
  { name: "paused: branch conflict", task: { pausedReason: "branch-conflict-unrecoverable" }, withoutGate: 4, withGate: 4 },
  /*
  The RUFU-300 shape: the engine's own stall-deadlock pause. The client half reads the hydrated stall
  signal FIRST, so this pair is the ONE declared divergence - client 3, SQL mirror 4 off `pausedReason`.
  `task-attention-parity.test.ts` asserts `mirror >= client` on it rather than excluding it.
  */
  {
    name: "paused: in-review-stall-deadlock beside a hydrated merge-blocker",
    task: { pausedReason: "in-review-stall-deadlock", stallReason: { code: "merge-blocker" } },
    withoutGate: 4,
    withGate: 3,
  },
  { name: "paused: reason without the flag (documented data state)", task: { pausedReason: "plan-admission-stalled" }, withoutGate: 4, withGate: 4 },
  { name: "paused: whitespace reason", task: { pausedReason: "  " }, withoutGate: 6, withGate: 6 },
  { name: "paused: empty reason", task: { pausedReason: "" }, withoutGate: 6, withGate: 6 },

  // ---- tier 5: waiting on another card. ----
  { name: "wait: blockedBy id", task: { blockedBy: "FN-001" }, withoutGate: 5, withGate: 5 },
  { name: "wait: blockedBy empty", task: { blockedBy: "" }, withoutGate: 6, withGate: 6 },
  { name: "wait: blockedBy whitespace", task: { blockedBy: "   " }, withoutGate: 6, withGate: 6 },
  { name: "wait: overlapBlockedBy id", task: { overlapBlockedBy: "FN-002" }, withoutGate: 5, withGate: 5 },
  { name: "wait: overlapBlockedBy whitespace", task: { overlapBlockedBy: " " }, withoutGate: 6, withGate: 6 },
  { name: "wait: dependencies non-empty", task: { dependencies: ["FN-003"] }, withoutGate: 5, withGate: 5 },
  { name: "wait: dependencies empty array", task: { dependencies: [] }, withoutGate: 6, withGate: 6 },

  // ---- first-match-wins precedence, asserted between adjacent tiers. ----
  {
    name: "precedence: error beats approval and dependency",
    task: { status: "failed", awaitingApprovalReason: "human-plan-approval", dependencies: ["FN-001"] },
    withoutGate: 0,
    withGate: 0,
  },
  {
    name: "precedence: gate beats approval",
    task: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [], awaitingApprovalReason: "human-plan-approval" },
    withoutGate: 2,
    withGate: 1,
  },
  {
    name: "precedence: approval beats stall",
    task: { awaitingApprovalReason: "merge-blocked-by-policy", stallReason: { code: "merge-blocker" } },
    withoutGate: 2,
    withGate: 2,
  },
  {
    name: "precedence: approval beats paused",
    task: { awaitingApprovalReason: "human-plan-approval", pausedReason: "branch-conflict-unrecoverable" },
    withoutGate: 2,
    withGate: 2,
  },
  {
    name: "precedence: paused beats dependency wait",
    task: { pausedReason: "branch-conflict-unrecoverable", dependencies: ["FN-001"] },
    withoutGate: 4,
    withGate: 4,
  },
  {
    name: "precedence: stall beats paused and wait",
    task: { stallReason: { code: "merge-blocker" }, pausedReason: "in-review-stall-deadlock", blockedBy: "FN-009" },
    withoutGate: 4,
    withGate: 3,
  },
];
