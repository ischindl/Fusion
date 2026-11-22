/**
 * RUFU-834 Steps 1 + 5 — the inert-merge-node owner: candidacy, admission, and the ownership table.
 *
 * These are the two coverage halves the spec requires of a new recovery seam:
 *  1. the CANDIDACY SHAPES that were previously unowned, one test per shape, including the negative
 *     control that distinguishes this card from every row another owner already re-drives;
 *  2. the OWNERSHIP TABLE stated as executable assertions, so a future reader who widens one filter
 *     finds a failing test rather than a second owner for the same card.
 *
 * `resolveInertMergeReentryCandidate` and `classifyInertMergeReentry` are pure, so every verdict here is
 * reached without a store — which is the point: the sweep's coverage cannot drift from the predicate it
 * applies, and a verdict that needs a real worktree to test is a verdict nobody will test.
 */
import { describe, expect, it } from "vitest";
import { buildManualRetryResetPatch, MERGE_REARM_EPISODE_METADATA_KEY } from "@fusion/core";
import { resolveInertMergeReentryCandidate } from "../executor/merge-rearm-candidate.js";
import {
  MERGE_REARM_EXHAUSTED_PREFIX,
  MERGE_REARM_GRACE_MS,
  classifyInertMergeReentry,
  mergeRarmSignature,
  readMergeRarmMarker,
} from "../executor/merge-rearm.js";
import { applyTaskPatch } from "./fixtures/task-patch-store.js";

const REVIEW = "in-review";
const WIP = "in-progress";
const STALE = "2026-10-16T00:00:00.000Z";
const NOW = Date.parse("2026-10-30T00:00:00.000Z");

/*
A two-gate review workflow whose merge is expressed the way the linear built-ins and custom seam
workflows express it — a `prompt` node with `config.seam === "merge"`, NOT a `merge-attempt` kind. A
hardcoded node-name list or kind-only test would classify every card on this workflow as "not at a merge
node", which is one of the two ways RUFU-834's own premise says this freeze could have been written off.
*/
const MERGE_IR = {
  version: "v2",
  columns: [
    { id: "todo", name: "Todo", role: "todo", traits: [{ trait: "intake" }] },
    { id: REVIEW, name: "Review", role: "review", traits: [{ trait: "merge-blocker" }] },
    { id: "done", name: "Done", role: "done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan-review", kind: "optional-group", column: REVIEW, config: { name: "Plan Review", defaultOn: true } },
    { id: "code-review", kind: "optional-group", column: REVIEW, config: { name: "Code Review", defaultOn: true } },
    { id: "merge", kind: "prompt", column: REVIEW, config: { seam: "merge" } },
    { id: "cleanup", kind: "end", column: "done" },
  ],
  edges: [],
} as any;

const REVIEW_COLUMNS = new Set([REVIEW]);
const MERGE_NODE_IDS = new Set(["merge"]);
const REQUIRED_GATES = new Set(["plan-review", "code-review"]);

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    runId: "run-1",
    taskId: "RUFU-834",
    nodeId: "merge",
    kind: "task",
    state: "failed",
    attempt: 1,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: "merge failed",
    blockedReason: null,
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  } as any;
}

/** The RUFU-293 shape: review lane, both gates approved, one dead merge row, nothing active. */
function inertTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-834",
    title: "inert failed merge node",
    column: REVIEW,
    status: null as string | null,
    error: null as string | null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    worktree: ".fusion/worktrees/rufu-834",
    branch: "fusion/rufu-834",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    steps: [{ id: "0", title: "Preflight", status: "done" }, { id: "1", title: "Implementation", status: "done" }],
    workflowStepResults: [
      { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
    ],
    dependencies: [],
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  } as any;
}

function classify(task: any, overrides: Record<string, unknown> = {}) {
  return classifyInertMergeReentry({
    task,
    workItems: overrides.workItems ?? [item()],
    irMergeNodeIds: MERGE_NODE_IDS,
    reviewColumns: REVIEW_COLUMNS,
    requiredPreMergeStepIds: REQUIRED_GATES,
    nowMs: NOW,
    autoMergeAllowed: true,
    mergeBlocker: null,
    ...overrides,
  });
}

describe("RUFU-834 Step 1: candidacy over work-item state and node id (no writes)", () => {
  it("names the dead merge row as a candidate for a review-lane card with zero active rows", () => {
    const result = resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [item()],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    });
    expect(result).toMatchObject({ eligible: true, mergeNodeId: "merge", reason: "eligible" });
    expect(result.failedRow?.state).toBe("failed");
  });

  it("refuses a card whose lane its own workflow does not resolve as a review lane", () => {
    // The renamed-board lesson (RUFU-272): the test is over the resolved vocabulary, so a card in `todo`
    // is refused even though `todo` is a perfectly ordinary lane name, and a review lane named something
    // else is accepted by the same code path.
    expect(resolveInertMergeReentryCandidate({
      task: inertTask({ column: "todo" }),
      workItems: [item()],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    }).reason).toBe("not-review-lane");

    const renamed = new Set(["qamax-review"]);
    expect(resolveInertMergeReentryCandidate({
      task: inertTask({ column: "qamax-review" }),
      workItems: [item({ nodeId: "merge" })],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: renamed,
    }).eligible).toBe(true);
  });

  it.each([
    ["runnable", "the due-poll drains it itself", "active-work-exists"],
    // A `running` row is a live claim, which is a stronger statement than "someone owns it".
    ["running", "a live claim owns it", "live-session"],
    ["held", "a gate or hold releaser owns it", "active-work-exists"],
    ["retrying", "the due-poll drains it when its rung expires", "active-work-exists"],
  ] as const)("refuses while another owner holds the row (%s)", (state, _owner, expected) => {
    expect(resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [item({ state })],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    }).reason).toBe(expected);
  });

  it("names the owner of an active held row instead of reporting a bare 'something is active'", () => {
    const owned = (blockedReason: string) => resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [item({ state: "held", blockedReason })],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    }).reason;

    // Each of these has a due-gated releaser already in the runtime; hiding the row would strand it.
    expect(owned("workflow-principal-role:executor")).toBe("active-work-exists");
    expect(owned("workflow-named-principal-agent-xyz")).toBe("active-work-exists");
    expect(owned("workflow-role-pool:executor")).toBe("active-work-exists");
    expect(owned("workflow-human-merge-approval:abc")).toBe("human-merge-hold");
    expect(owned("file-scope:RUFU-281")).toBe("lease-held-by-other");
  });

  it("classifies a failed row on a node outside the merge region as another owner's, never as a candidate", () => {
    const reasonFor = (nodeId: string) => resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [item({ nodeId, runId: `run-${nodeId}` })],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    }).reason;

    // RUFU-308's own card: WIP lane + step-execute, owned by `attemptExecutionRearm`.
    expect(reasonFor("step-execute")).toBe("failure-belongs-to-gate");
    expect(reasonFor("steps#1:step-execute")).toBe("failure-belongs-to-gate");
    // The verdict-less-gate family: FN-8492 / FN-9243 / FN-279 re-seed the GATE, never a merge.
    expect(reasonFor("code-review")).toBe("failure-belongs-to-gate");
    expect(reasonFor("plan-review")).toBe("failure-belongs-to-gate");
    expect(reasonFor("post-merge-verification")).toBe("failure-belongs-to-gate");
    // A node this seam has no owner for at all.
    expect(reasonFor("parse-steps")).toBe("no-failed-merge-item");
  });

  it("picks ONE target node from the newest failed row when several historical failures exist", () => {
    const result = resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [
        item({ runId: "old", updatedAt: "2026-09-01T00:00:00.000Z" }),
        item({ runId: "new", updatedAt: "2026-10-20T00:00:00.000Z", nodeId: "merge" }),
        item({ runId: "older", nodeId: "code-review", updatedAt: "2026-08-01T00:00:00.000Z", state: "failed" }),
      ],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    });
    expect(result.mergeNodeId).toBe("merge");
    expect(result.failedRow?.runId).toBe("new");
  });

  it("reports no candidate when the card has no failed row at all", () => {
    expect(resolveInertMergeReentryCandidate({
      task: inertTask(),
      workItems: [],
      irMergeNodeIds: MERGE_NODE_IDS,
      reviewColumns: REVIEW_COLUMNS,
    }).reason).toBe("no-failed-merge-item");
  });
});

describe("RUFU-834 Step 1: the admission classifier names a reason for every refusal", () => {
  it("accepts the RUFU-293 shape and nothing else about it", () => {
    const verdict = classify(inertTask());
    expect(verdict.verdict).toBe("eligible");
    expect(verdict.nodeId).toBe("merge");
  });

  it("answers an operator hold before it measures anything", () => {
    expect(classify(inertTask({ paused: true })).verdict).toBe("suppressed-paused");
    expect(classify(inertTask({ userPaused: true })).verdict).toBe("suppressed-paused");
    expect(classify(inertTask({ deletedAt: STALE })).verdict).toBe("suppressed-paused");
  });

  it("is idempotent about its own terminal park: a standing `terminalAt` refuses with no write", () => {
    const parked = inertTask({
      status: "failed",
      error: `${MERGE_REARM_EXHAUSTED_PREFIX}: 4 merge re-arms delivered nothing`,
      sourceMetadata: {
        [MERGE_REARM_EPISODE_METADATA_KEY]: {
          signature: "merge-rearm:RUFU-834:custom:merge:merge:plan-review-satisfied:2",
          attempt: 4, refusal: 0, firstAt: STALE, at: STALE, heldAt: STALE, terminalAt: STALE,
        },
      },
    });
    expect(classify(parked).verdict).toBe("sentinel-already-parked");
    // The proof is the DURABLE EPISODE, not the badge: RUFU-1028 measured a park keyed on `status`/
    // `error` releasing itself the moment `cleanupMergeStateForReverification` nulled both.
    const badgeCleared = applyTaskPatch(parked, { status: null, error: null });
    expect(readMergeRarmMarker(badgeCleared)?.terminalAt).toBe(STALE);
    expect(classify(badgeCleared).verdict).toBe("sentinel-already-parked");
  });

  it("leaves a row that the in-graph merge retry still owns alone", () => {
    const fresh = item({ updatedAt: new Date(NOW - 1_000).toISOString() });
    expect(classify(inertTask(), { workItems: [fresh] }).verdict).toBe("too-young");
    // Past the horizon it is this seam's — the horizon bounds the race, it does not exempt the card.
    expect(classify(inertTask(), {
      workItems: [item({ updatedAt: new Date(NOW - MERGE_REARM_GRACE_MS - 1_000).toISOString() })],
    }).verdict).toBe("eligible");
  });

  it("refuses a card whose live session still owns it", () => {
    expect(classify(inertTask(), { hasLiveExecutionSurface: true }).verdict).toBe("live-session");
    expect(classify(inertTask(), { workItems: [item({ state: "running" })] }).verdict).toBe("live-session");
  });

  it("refuses when the merge door is closed, quoting the door rather than inventing a reason", () => {
    const verdict = classify(inertTask(), { mergeBlocker: "Task has enabled pre-merge workflow steps without a current approval" });
    expect(verdict.verdict).toBe("merge-blocker-present");
    expect(verdict.detail).toContain("enabled pre-merge workflow steps");
  });

  it("honours FN-5147: with auto-merge withheld, `in-review` is terminal until a human merges", () => {
    expect(classify(inertTask(), { autoMergeAllowed: false }).verdict).toBe("auto-merge-withheld");
  });

  it("refuses an unapproved required gate and says which one, because a gate is another seam's row", () => {
    const unapproved = inertTask({
      workflowStepResults: [
        { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
        { workflowStepId: "code-review", status: "failed", verdict: "REVISE" },
      ],
    });
    const verdict = classify(unapproved);
    expect(verdict.verdict).toBe("gate-not-approved");
    expect(verdict.detail).toContain("code-review:failed");
    // A gate with no result row at all is equally not approved (FN-9243 owns that row).
    expect(classify(inertTask({ workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" }] })).verdict)
      .toBe("gate-not-approved");
    // An audited operator waiver IS approved — the same exception the merge door makes (FN-7720).
    expect(classify(inertTask({
      workflowStepResults: [
        { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
        { workflowStepId: "code-review", status: "skipped", bypassedBy: "operator" },
      ],
    })).verdict).toBe("eligible");
  });

  it("refuses an already-landed card: RUFU-396 owns the close-out of delivered work", () => {
    expect(classify(inertTask({ mergeDetails: { mergeConfirmed: true, commitSha: "abc123" } })).verdict)
      .toBe("already-landed");
  });

  it("refuses a workspace card outright: its land is a per-repository transaction (FN-9056 / FN-9058)", () => {
    expect(classify(inertTask({
      worktree: null,
      workspaceWorktrees: { "packages/a": { worktreePath: ".fusion/worktrees/a", branch: "fusion/rufu-834" } },
    })).verdict).toBe("workspace-owned-elsewhere");
    // A singular card is unaffected by that boundary.
    expect(classify(inertTask()).verdict).toBe("eligible");
  });
});

describe("RUFU-834 Step 5: the budget may not be erased by a legitimate cleanup", () => {
  it("keeps the ladder out of `mergeDetails`, where the stale-merge cleanup writes null", () => {
    // RUFU-1027's measured defect: 327 re-arms in 24 h, every one `attempt: 1`, because the writer of
    // the counter and the writer that nulls it are not one transaction. The episode lives in
    // `sourceMetadata` and `cleanupMergeStateForReverification` never names that key.
    const marker = { signature: "sig", attempt: 3, refusal: 0, firstAt: STALE, at: STALE, heldAt: null };
    const row = { id: "x", sourceMetadata: { [MERGE_REARM_EPISODE_METADATA_KEY]: marker }, mergeDetails: { mergeRetries: 2 } };
    const afterCleanup = applyTaskPatch(row, { mergeDetails: null, mergeRetries: 0, status: null, error: null });
    expect(afterCleanup.mergeDetails).toBeNull();
    expect(readMergeRarmMarker(afterCleanup)?.attempt).toBe(3);
  });

  it("computes an episode identity from fields the bounded loop does not rewrite", () => {
    const base = { taskId: "RUFU-834", workflowId: "custom:mergeflow", mergeFrontierNodeIds: ["merge"], nodeId: "merge" };
    const first = mergeRarmSignature({ ...base, task: inertTask() });

    // A row id must never enter the identity: the re-entry deletes the colliding terminal row and mints
    // a fresh uuid, so an id-keyed ladder restarts on every grant.
    expect(mergeRarmSignature({ ...base, task: inertTask() })).toBe(first);
    // Neither may a branch tip or a worktree path.
    expect(mergeRarmSignature({ ...base, task: inertTask({ branch: "fusion/moved", worktree: "/tmp/other" }) })).toBe(first);
    // And not anything from `mergeDetails`, which the cleanup nulls.
    expect(mergeRarmSignature({ ...base, task: inertTask({ mergeDetails: { mergeConfirmed: true } }) })).toBe(first);
    // The post-execution ledger half that `preservePreExecutionWorkflowStepResults` DROPS must not be in
    // it either — RUFU-1028's own test caught a stamp that read it.
    expect(mergeRarmSignature({
      ...base,
      task: inertTask({ workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" }] }),
    })).toBe(first);

    // Genuinely different questions get genuinely different identities.
    expect(mergeRarmSignature({ ...base, nodeId: "merge-attempt", task: inertTask() })).not.toBe(first);
    expect(mergeRarmSignature({ ...base, workflowId: "custom:other", task: inertTask() })).not.toBe(first);
    expect(mergeRarmSignature({ ...base, task: inertTask({ steps: [{ id: "0", status: "done" }] }) })).not.toBe(first);
  });

  it("gives operator Retry a door: the shared reset clears this episode and nothing else", () => {
    const patch = buildManualRetryResetPatch();
    expect(patch.sourceMetadataPatch).toBeDefined();
    const keys = Object.keys(patch.sourceMetadataPatch ?? {});
    expect(keys).toContain(MERGE_REARM_EPISODE_METADATA_KEY);
    expect((patch.sourceMetadataPatch as Record<string, unknown>)[MERGE_REARM_EPISODE_METADATA_KEY]).toBeNull();
  });
});

/*
The classifier is exercised through a store-shaped object at least once so a signature mismatch between
what `attemptMergeRearm` passes and what the pure function reads cannot hide behind a mock. The full
grant/park path is `merge-rearm-budget.test.ts`; this one line only proves the seam's entry compiles
against a store double that behaves like the real store's `sourceMetadataPatch` merge.
*/
describe("RUFU-834 Step 1: the seam is wired to the store contract it claims", () => {
  it("reads its episode back from a row that received a key-level patch", () => {
    const row = inertTask();
    const patched = applyTaskPatch(row, {
      sourceMetadataPatch: { [MERGE_REARM_EPISODE_METADATA_KEY]: { signature: "s", attempt: 1, refusal: 0, firstAt: STALE, at: STALE, heldAt: null } },
    });
    expect(readMergeRarmMarker(patched)?.attempt).toBe(1);
    expect(patched.sourceMetadataPatch).toBeUndefined();
  });
});
