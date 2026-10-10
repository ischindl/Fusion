/**
 * FNXC:CodeOrganization 2026-08-03-13:25:
 * routeGraphFailureToExecutionResume peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-29-11:08:
 * Graph failures with unfinished work rebound to todo for execution resume, not review.
 *
 * FNXC:HonestBlockedExit 2026-08-02-23:59:
 * Durable task-dependency BLOCKED parks skip resume bounce.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * Resume-router gate uses resolved lanes, not default-lineage literals.
 *
 * FNXC:WorkflowRemediation 2026-08-09-21:41:
 * FN-8910: completed work + policy-refused remediation stays parked in review.
 *
 * FNXC:WorkflowRemediation 2026-08-28-12:16:
 * This generic resume router must not own review-to-WIP recovery. `sendTaskBackForFix` through `scheduleWorkflowRerun` owns that contained move only after named pending remediation exists; preserving this refusal prevents an unowned backward transition from bypassing lifecycle containment.
 */
import type { Settings, TaskDetail, TaskStore, WorkflowIrNode, WorkflowWorkItem } from "@fusion/core";
import { COMPLETION_SUMMARY_NODE_ID, allowsAutoMergeProcessing, isTaskExternallyBlocked, resolveWorkflowIrForTask } from "@fusion/core";
import { isDurableBlockedTask } from "../execution-block-classifier.js";
import { containmentLiveSignature, shouldLogContainmentRefusal } from "../execution/lifecycle-move.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";
import { formatGraphFailureDiagnostic, isMergeGraphFailure } from "./graph-failure-pure.js";
import { MERGE_BOUNDARY_RECOVERY_VALUE } from "../workflows/workflow-merge-nodes.js";
import type { MergeBoundaryRecoveryEvidence } from "./workflow-merge-boundary.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";
import type { CheckoutEmptinessProver } from "../worktree/checkout-emptiness.js";
import {
  EXECUTION_REARM_STEP_FAILED_REASON,
  attemptExecutionRearm,
  type ExecutionRarmResult,
} from "./execution-rearm.js";

export type RouteGraphFailureToExecutionResumeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (
    taskId: string,
    memo?: { lanes?: ResumeLanes },
  ) => Promise<ResumeLanes>;
  clearTerminalStepFailuresForRetry: (taskId: string, mode: "archive" | "clear") => Promise<void>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  /**
   * FNXC:WorkflowRemediation 2026-08-09-21:41:
   * Detects fire-and-forget remediation / plan-replan nodes (IR action + built-in ids).
   */
  isRemediationGraphNode: (taskId: string, failedNode: string | undefined) => Promise<boolean>;
  /** Shared-branch integration remains the single narrow exception to a human auto-merge hold. */
  isLiveSharedBranchGroupMember?: (live: Pick<TaskDetail, "branchContext" | "autoMerge" | "autoMergeProvenance">) => Promise<boolean>;
  /**
   * FNXC:LifecycleContainment 2026-10-07-14:06 (RUFU-308):
   * An execution re-arm must never race a live step session — the drain would dispatch a second run
   * over a worktree that is still being written. Absent on a store/host without session maps, where the
   * durable continuation fence (`onlyIfNoActiveTaskContinuation`) stays the only contention proof.
   */
  hasLiveTaskSessionSurface?: (taskId: string) => boolean;
  /**
   * Injectable checkout-emptiness prover. Production leaves this unset and the re-arm seam builds the
   * process-wide prover for the store's root; a test injects a fake so evidence assertions never shell out
   * to real git.
   */
  checkoutEmptinessProver?: CheckoutEmptinessProver;
};

/*
FNXC:WorkflowMergeRecovery 2026-09-20-20:12:
Boundary remediation consumes the classified proof captured by the failed graph result.
It may resume only the matching nonterminal node or foreach container that owns every
missing instance; it never guesses from node order or recreates completion evidence.
*/
function isExecutableNode(node: WorkflowIrNode): boolean {
  const seam = (node.config as { seam?: unknown } | undefined)?.seam;
  return node.kind === "foreach" || seam === "execute" || seam === "step-execute";
}

function isTerminalWorkItem(item: WorkflowWorkItem): boolean {
  return item.state === "succeeded" || item.state === "failed" || item.state === "cancelled" || item.state === "exhausted" || item.state === "manual-required";
}

function findBoundaryRecoveryOwners(
  task: TaskDetail,
  nodes: WorkflowIrNode[],
  evidence: MergeBoundaryRecoveryEvidence | undefined,
  workItems: WorkflowWorkItem[],
): string[] | undefined {
  if (!evidence || !["no-node-result", "non-terminal-node-result", "missing-foreach-instances"].includes(evidence.code)) return undefined;
  if (evidence.code === "non-terminal-node-result") {
    const id = evidence.nonTerminalNodeId;
    const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === id && entry.source === "node");
    return id && result && result.status !== "passed" && result.status !== "failed" && result.status !== "skipped"
      && nodes.some((node) => node.id === id && isExecutableNode(node)) ? [id] : undefined;
  }
  if (evidence.code === "missing-foreach-instances") {
    const ids = evidence.missingInstanceIds;
    if (ids.length === 0) return undefined;
    const foreachOwners = nodes.filter((node) => node.kind === "foreach");
    const owners = ids.map((id) =>
      // Prefer the longest prefix so nested/custom node names cannot misclassify an instance.
      foreachOwners.filter((node) => id.startsWith(`${node.id}#`)).sort((left, right) => right.id.length - left.id.length)[0]?.id,
    );
    if (owners.some((owner) => owner === undefined)) return undefined;
    /*
    FNXC:WorkflowMergeRecovery 2026-09-21-10:25:
    A boundary can expose missing instances from more than one foreach region. The
    canonical continuation slot permits one task owner at a time, so preserve every
    proven owner in IR order and seed the first; graph progression/re-evaluation then
    schedules the next region without retiring a concurrent continuation or guessing.
    */
    return foreachOwners.filter((node) => owners.includes(node.id)).map((node) => node.id);
  }
  /*
  FNXC:WorkflowMergeRecovery 2026-09-21-09:32:
  No-node-result evidence does not identify an implementation owner by itself. Derive
  it from durable terminal work-item history and choose it only when exactly one
  executable node remains; selecting the first IR node can replay completed preflight
  work and leave the actual implementation proof gap unchanged.
  */
  if (!hasNonTerminalWorkflowSteps(task)) return undefined;
  const terminalNodes = new Set(workItems.filter(isTerminalWorkItem).map((item) => item.nodeId));
  const candidates = nodes.filter((node) => isExecutableNode(node) && !terminalNodes.has(node.id));
  return candidates.length === 1 && candidates[0] ? [candidates[0].id] : undefined;
}

const BOUNDARY_RECOVERY_CLAIM_STATUS = "merge-boundary-evidence-recovery";
const BOUNDARY_RECOVERY_HELD_STATUS = "merge-boundary-evidence-recovery-held";
const BOUNDARY_RECOVERY_CONCURRENT = Symbol("merge-boundary-recovery-concurrent");
const MAX_BOUNDARY_RECOVERY_ATTEMPTS = 4;
const BOUNDARY_RECOVERY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;

function boundaryRecoverySignature(
  task: TaskDetail,
  failedNode: string,
  evidence: MergeBoundaryRecoveryEvidence | undefined,
): string {
  return JSON.stringify({
    failedNode,
    evidence,
    steps: task.steps.map((step, index) => [index, step.name, step.status]),
    nodeResults: (task.workflowStepResults ?? [])
      .filter((result) => result.source === "node")
      .map((result) => [result.workflowStepId, result.status])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  });
}

export type MergeBoundaryEvidenceRecoveryDeps = Pick<RouteGraphFailureToExecutionResumeDeps, "store" | "getRunContextFor">;

/*
FNXC:WorkflowMergeRecovery 2026-09-21-09:51:
Restart recovery and graph-failure routing must share the same owner classifier,
continuation claim, and fenced lifecycle move. A stale historical boundary failure
may be repaired only by the current IR owner; a failed claim or move leaves its
failure visible rather than converting an unclaimed card into an ambiguous retry.
*/
export async function recoverMergeBoundaryEvidenceGap(
  deps: MergeBoundaryEvidenceRecoveryDeps,
  live: TaskDetail,
  failedNode: string,
  evidence: MergeBoundaryRecoveryEvidence | undefined,
  wipColumn: string,
  autoMergeSettings?: Pick<Settings, "autoMerge">,
  liveSharedBranchMember = false,
): Promise<"recovered" | "concurrent" | "raced" | "deferred" | "held" | "declined"> {
  let claimed = false;
  let deferred = false;
  let held = false;
  const now = Date.now();
  const signature = boundaryRecoverySignature(live, failedNode, evidence);
  await deps.store.updateTaskAtomic(live.id, (current) => {
    if (
      !current || current.deletedAt || current.paused || current.userPaused
      || (autoMergeSettings && !liveSharedBranchMember && (current.autoMerge === false || !allowsAutoMergeProcessing(current, autoMergeSettings)))
      || current.column !== live.column || current.status !== live.status || current.error !== live.error
      || (live.columnMovedAt !== undefined && current.columnMovedAt !== live.columnMovedAt)
    ) return null;
    const prior = current.mergeDetails?.mergeBoundaryRecovery;
    if (prior?.signature === signature) {
      const nextCheckAt = Date.parse(prior.nextCheckAt ?? "");
      if (Number.isFinite(nextCheckAt) && nextCheckAt > now) {
        deferred = true;
        return null;
      }
      if (prior.attempt >= MAX_BOUNDARY_RECOVERY_ATTEMPTS) {
        held = true;
        return {
          status: BOUNDARY_RECOVERY_HELD_STATUS,
          error: "Workflow merge evidence recovery is held after unchanged proof gaps; waiting for durable implementation progress",
          mergeDetails: {
            ...current.mergeDetails,
            mergeBoundaryRecovery: { ...prior, nextCheckAt: null, heldAt: new Date(now).toISOString() },
          },
        } as Parameters<TaskStore["updateTask"]>[1];
      }
    }
    const attempt = prior?.signature === signature ? prior.attempt + 1 : 1;
    const nextCheckAt = new Date(now + BOUNDARY_RECOVERY_BACKOFF_MS[attempt - 1]!).toISOString();
    claimed = true;
    // Preserve the prior failure until the fenced move succeeds so a failed recovery remains actionable.
    return {
      status: BOUNDARY_RECOVERY_CLAIM_STATUS,
      mergeDetails: {
        ...current.mergeDetails,
        mergeBoundaryRecovery: { signature, attempt, nextCheckAt },
      },
    } as Parameters<TaskStore["updateTask"]>[1];
  }, deps.getRunContextFor(live.id));
  if (deferred) {
    await deps.store.logEntry(live.id, "Workflow merge evidence recovery is waiting for its bounded recheck window before retrying unchanged proof", undefined, deps.getRunContextFor(live.id));
    return "deferred";
  }
  if (held) {
    await deps.store.logEntry(live.id, "Workflow merge evidence recovery is held because the same proof gap exhausted its bounded retry budget", undefined, deps.getRunContextFor(live.id));
    return "held";
  }
  if (!claimed) return "declined";
  /*
  FNXC:WorkflowMergeRecovery 2026-09-21-11:07:
  Claiming serializes the original failure, but an operator can disable auto-merge
  before recovery writes its continuation. Re-read the claimed row before seeding so
  a human hold wins without creating a runnable owner that could later move the card.
  */
  const claimedTask = typeof deps.store.getTask === "function"
    ? await deps.store.getTask(live.id)
    : live;
  if (
    !claimedTask
    || claimedTask.column !== live.column
    || (claimedTask !== live && claimedTask.status !== BOUNDARY_RECOVERY_CLAIM_STATUS)
    || (autoMergeSettings && !liveSharedBranchMember && (claimedTask.autoMerge === false || !allowsAutoMergeProcessing(claimedTask, autoMergeSettings)))
  ) {
    await releaseBoundaryRecoveryClaim(deps.store, live, deps.getRunContextFor(live.id));
    return "declined";
  }
  let owner: string | typeof BOUNDARY_RECOVERY_CONCURRENT | undefined;
  try {
    owner = await seedBoundaryRecoveryContinuation(deps.store, live, failedNode, evidence);
  } catch (error) {
    await releaseBoundaryRecoveryClaim(deps.store, live, deps.getRunContextFor(live.id));
    throw error;
  }
  if (!owner) {
    await releaseBoundaryRecoveryClaim(deps.store, live, deps.getRunContextFor(live.id));
    return "declined";
  }
  if (owner === BOUNDARY_RECOVERY_CONCURRENT) {
    await releaseBoundaryRecoveryClaim(deps.store, live, deps.getRunContextFor(live.id));
    return "concurrent";
  }
  const remediation = `Workflow merge evidence recovery: '${owner}' is being resumed after missing proof at '${failedNode}'; returning to '${wipColumn}' before merge proof is rechecked`;
  executorLog.warn(`${live.id}: ${remediation}`);
  await deps.store.logEntry(live.id, remediation, undefined, deps.getRunContextFor(live.id));
  const moveOptions = {
    moveSource: "engine" as const,
    lifecycleReason: "merge-boundary-evidence-recovery",
    preserveProgress: true,
    preserveWorktree: true,
    workflowMoveSource: "workflow-graph",
    workflowMoveMetadata: { reason: "merge-boundary-evidence-recovery", nodeId: failedNode },
  };
  const conditionalMoveStore = deps.store as typeof deps.store & {
    moveTaskIf?: (id: string, column: string, predicate: (current: TaskDetail) => boolean, options: typeof moveOptions) => Promise<{ moved: boolean }>;
  };
  const moved = typeof conditionalMoveStore.moveTaskIf === "function"
    ? (await conditionalMoveStore.moveTaskIf(live.id, wipColumn, (current) =>
        !current.deletedAt && !current.paused && !current.userPaused
        && (!autoMergeSettings || liveSharedBranchMember || (current.autoMerge !== false && allowsAutoMergeProcessing(current, autoMergeSettings)))
        && current.column === live.column && current.status === BOUNDARY_RECOVERY_CLAIM_STATUS,
      moveOptions)).moved
    : (await deps.store.moveTask(live.id, wipColumn, moveOptions), true);
  if (!moved) {
    await releaseBoundaryRecoveryClaim(deps.store, live, deps.getRunContextFor(live.id));
    return "raced";
  }
  let completed = false;
  await deps.store.updateTaskAtomic(live.id, (current) => {
    if (!current || current.deletedAt || current.paused || current.userPaused
      || current.column !== wipColumn || current.status !== BOUNDARY_RECOVERY_CLAIM_STATUS) return null;
    completed = true;
    return { status: null, error: null } as Parameters<TaskStore["updateTask"]>[1];
  }, deps.getRunContextFor(live.id));
  return completed ? "recovered" : "declined";
}

async function releaseBoundaryRecoveryClaim(
  store: TaskStore,
  live: TaskDetail,
  runContext: EngineRunContext | undefined,
): Promise<void> {
  await store.updateTaskAtomic(live.id, (current) => {
    if (
      !current || current.deletedAt || current.paused || current.userPaused
      || current.column !== live.column || current.status !== BOUNDARY_RECOVERY_CLAIM_STATUS
    ) return null;
    return { status: live.status } as Parameters<TaskStore["updateTask"]>[1];
  }, runContext);
}

async function seedBoundaryRecoveryContinuation(
  store: TaskStore,
  task: TaskDetail,
  failedNode: string,
  evidence: MergeBoundaryRecoveryEvidence | undefined,
): Promise<string | typeof BOUNDARY_RECOVERY_CONCURRENT | undefined> {
  const ir = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  const workItems = typeof store.listWorkflowWorkItemsForTask === "function"
    ? await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] }).catch(() => [])
    : [];
  const owners = ir ? findBoundaryRecoveryOwners(task, ir.nodes, evidence, workItems) : undefined;
  const owner = owners?.[0];
  if (!owner || typeof store.replaceActiveTaskWorkflowContinuation !== "function") return undefined;
  /*
  FNXC:WorkflowMergeRecovery 2026-09-20-19:59:
  Missing merge proof is repaired only by re-entering a current executable IR owner.
  The continuation is atomically replaced under the task workflow lock, so a stale
  merge walk cannot fabricate a result or overwrite a concurrent owner.
  */
  const seeded = await Promise.resolve(store.replaceActiveTaskWorkflowContinuation({
    taskId: task.id,
    runId: `${task.id}:merge-boundary-recovery:${owner}`,
    nodeId: owner,
    kind: "task",
    state: "runnable",
    blockedReason: `merge-boundary-evidence-recovery:${failedNode}`,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    onlyIfNoActiveTaskContinuation: true,
  })).catch((error: unknown) => {
    if (error instanceof Error && error.name === "ActiveTaskContinuationError") return null;
    throw error;
  });
  return seeded === null ? BOUNDARY_RECOVERY_CONCURRENT : owner;
}

/**
 * Decides whether a re-arm outcome lets the router claim the card (so the caller does NOT terminalize
 * it) or must fall through to the ordinary containment refusal.
 *
 * FNXC:LifecycleContainment 2026-10-07-14:10 (RUFU-308):
 * Three claims, each for a different reason. `rearmed` is the point: the re-entry is durable, so the
 * graph failure is fully handled. `already-owned` must never escalate either — the sanctioned seed
 * primitive's own contract forbids terminalizing a row another legitimate hold owns, and an active
 * continuation already gives the card its re-entry. `budget-exhausted` is claimed because the re-arm
 * seam already wrote the ONE bounded, operator-visible park; a second park from here would be the
 * duplicate-notice behavior the fix contract forbids. Everything else returns false so the pre-existing
 * refusal line and terminal park stay exactly as they were.
 */
async function claimExecutionRearmOutcome(
  deps: RouteGraphFailureToExecutionResumeDeps,
  live: TaskDetail,
  rearm: ExecutionRarmResult,
  failedNode: string,
  failureValue: string | undefined,
  nodeError: string | undefined,
): Promise<boolean> {
  if (rearm.outcome === "rearmed" || rearm.outcome === "already-owned" || rearm.outcome === "budget-exhausted") {
    executorLog.warn(`${live.id}: ${rearm.detail} (graph failure '${failedNode}'${failureValue ? `/${failureValue}` : ""}${nodeError ? `: ${nodeError}` : ""})`);
    // An `already-owned` claim deliberately writes nothing to the card History: an active hold can
    // outlive several recovery passes, and a repeating entry is the exact noise this task removes.
    await deps.persistTokenUsage(live.id);
    return true;
  }
  // Evidence-less or ineligible: the refusal below stays the single record, the caller parks the card.
  executorLog.warn(`${live.id}: execution re-arm declined for '${failedNode}' — ${rearm.detail}`);
  return false;
}

export async function routeGraphFailureToExecutionResume(
  deps: RouteGraphFailureToExecutionResumeDeps,
  live: TaskDetail,
  failedNode: string,
  failureValue: string | undefined,
  resumeLanesMemo?: { lanes?: ResumeLanes },
  boundaryEvidence?: MergeBoundaryRecoveryEvidence,
  nodeError?: string,
): Promise<boolean> {
    /*
     * FNXC:WorkflowLifecycle 2026-06-29-11:08:
     * A workflow graph failure is not a completion handoff. FN-7228/FN-7229 showed
     * restart-time parse failures and incomplete steps being parked in `in-review`
     * with errors, which blocks the engine from resuming the correct unfinished
     * step. Keep executable work in the executable queue: clear graph failure
     * markers and move review-column rows with unfinished work back to `todo`
     * preserving step progress. Generic graph failures that remain in-progress
     * are left failed in-place by the caller; they must never be handed to review.
     */
    if (live.deletedAt) return false;
    if (isTaskExternallyBlocked(live)) {
      executorLog.log(`${live.id}: graph failure resume skipped — external Blocked freeze honored`);
      return false;
    }
    if (live.paused || live.userPaused === true) return false;
    if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
    /*
    FNXC:HonestBlockedExit 2026-08-02-23:59:
    Durable external (task-dependency) BLOCKED parks must NOT bounce to todo for execution
    resume — the scheduler requeues them when the blocking tasks complete. PR/file-claim
    parks and the session-log BLOCKED promotion are removed (operator decision, FN-8728):
    open PRs are never blockers, so only metadata-classed task-dependency parks are honored.
    */
    if (isDurableBlockedTask(live)) {
      executorLog.log(
        `${live.id}: graph failure resume skipped — durable BLOCKED park honored (task-dependency block)`,
      );
      return false;
    }
    /*
     * FNXC:WorkflowCompletion 2026-07-01-16:26:
     * Backstop for issue #1863. The advisory completion-summary node must never
     * drive the in-review→todo resume loop: it has no failure edge, so a failure
     * here would bounce the task back to execution every run and never stick.
     * The graph executor now degrades summary-node failures to success, so this
     * should be unreachable — but if a summary failure ever reaches this router,
     * let the caller park the task `failed` (a visible terminal state) instead of
     * looping it forever.
     */
    if (failedNode === COMPLETION_SUMMARY_NODE_ID) return false;
    const incompleteSteps = hasNonTerminalWorkflowSteps(live);
    /*
     * FNXC:WorkflowRemediation 2026-08-09-21:41:
     * FN-8910: fire-and-forget remediation nodes have no failure edge. A policy
     * or budget refusal after implementation is complete must park visibly in
     * the resolved review lane, not clear blockers and eject the card to planning.
     * IR workflowAction detection keeps custom renamed remediation nodes covered.
     */
    if (!incompleteSteps
      && (failureValue === "remediation-not-scheduled" || failureValue === "missing-remediation-context")
      && await deps.isRemediationGraphNode(live.id, failedNode)) return false;
    const implementationIncompleteMergeFailure = isMergeGraphFailure(failedNode) && failureValue === "implementation-incomplete";
    const boundaryEvidenceRecovery = isMergeGraphFailure(failedNode) && failureValue === MERGE_BOUNDARY_RECOVERY_VALUE;
    if (implementationIncompleteMergeFailure && !incompleteSteps) return false;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: executor.ts — the REVERSE half-conversion):
    THE DESTINATION WAS ALREADY RESOLVED HERE AND THE GATE WAS NOT. The contained resolver below picks
    the board's rebound column (U7), but this gate compared against three default-lineage literals — so on
    a renamed board the router refused before ever reaching the resolved move. That is the mirror image of
    the dangerous half-conversion: instead of admitting a card and sending it nowhere, it refuses a card
    whose recovery was fully implemented, and nothing is logged as wrong. Same one-decision-two-boards
    defect, opposite direction, and the silent one.
    */
    const resumeRouterLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-14:20:
    A workflow that declares NO implementation lane has nowhere to resume TO, so this router must not
    claim the card — the graph failure has to reach the terminalize branch and be visible.

    Without this, a card resting in such a workflow's HOLD lane with incomplete steps matched the
    second arm above (`incompleteSteps && live.column === lanes.hold`), the router rehomed it and
    returned true, and the failure was swallowed: `status` and `error` both stayed null. The operator
    saw a card that had silently stopped. That is the exact shape the sibling branch below already
    guards with `wipColumn !== undefined` before claiming a card "already advanced"; this is the same
    fail-closed rule on the opposite path, which was failing OPEN.
    */
    if (!resumeRouterLanes.wipDeclared) return false;
    const mayResumeInPlace = live.column === resumeRouterLanes.wip && implementationIncompleteMergeFailure;
    // Evidence recovery is graph-native: a settled legacy checklist does not prove every
    // foreach/node result was persisted, so select and fence the durable IR owner below.
    const mayRepairBoundary = boundaryEvidenceRecovery && live.column === resumeRouterLanes.review;
    if (!mayResumeInPlace && !mayRepairBoundary) {
      /*
      FNXC:LifecycleContainment 2026-10-07-14:10 (RUFU-308):
      Containment refuses a lifecycle MOVE out of the WIP lane, and this router has never owned a
      review-to-WIP recovery (FN-8910's note above). An execution re-arm is neither: it keeps the column,
      keeps the status, and installs a runnable continuation at the node that just failed, which is the
      only thing that gives the card re-entry — the failed `kind:"task"` work item is invisible to the
      due-poll and to stranded-continuation reclaim, so a card left in that shape is dead but unmovable
      while its worktree already holds the step's commits (RUFU-291: 1h42m, four steps committed).

      Admission is deliberately narrower than the resume above, and adds no new lane vocabulary:
      the card must ALREADY sit in the resolved WIP lane, its workflow steps must be non-terminal, the
      failed node must be a `step-execute` owner in the current IR, and the checkout must prove work.
      Merge-classified failures keep their own owners (in-place resume above, boundary recovery below,
      merge-retry in the caller) and revision reasons keep their contained remediation moves — none of
      those route here. Without that evidence this branch behaves exactly as before: refusal line, then
      the caller parks the card `failed`.
      */
      if (incompleteSteps && resumeRouterLanes.wip !== undefined && live.column === resumeRouterLanes.wip
          && !isMergeGraphFailure(failedNode)) {
        const rearm = await attemptExecutionRearm(
          {
            store: deps.store,
            getRunContextFor: deps.getRunContextFor,
            hasLiveExecutionSurface: deps.hasLiveTaskSessionSurface,
            emptinessProver: deps.checkoutEmptinessProver,
          },
          {
            taskId: live.id,
            failedNode,
            wipColumn: resumeRouterLanes.wip,
            reason: EXECUTION_REARM_STEP_FAILED_REASON,
          },
        ).catch((error: unknown) => {
          // A re-arm seam that cannot answer must never widen the failure: today's refusal path is the
          // fallback, so a store without the evidence/continuation surface behaves exactly as before.
          executorLog.warn(`${live.id}: execution re-arm probe errored — ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (rearm && await claimExecutionRearmOutcome(deps, live, rearm, failedNode, failureValue, nodeError)) return true;
      }
      const message = `${formatGraphFailureDiagnostic(failedNode, failureValue, nodeError, "Workflow graph failed")} — automatic recovery cannot move '${live.column}' backward; card remains in place`;
      executorLog.warn(`${live.id}: ${message}`);
      /*
      FNXC:LifecycleContainment 2026-10-07-17:05 (RUFU-308 Step 5):
      The durable History line is a SIGHTING record, so it is bounded by the same first-sighting rule the
      containment seam uses. This is the line RUFU-291's card wrote on every ~45 s pass for over two
      hours while nothing owned its re-entry; the engine log above stays unconditional (an operator
      reading engine logs wants every pass), only the card's History stops repeating itself until the
      card's own state changes. A refusal is never SILENTLY dropped for a new state: the fingerprint
      covers lane, status, pause flags, step rows, and gate rows.
      */
      if (shouldLogContainmentRefusal(deps.store, live.id, `graph-failure-refusal:${failedNode ?? "unknown"}`, containmentLiveSignature(live))) {
        await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
      }
      return false;
    }

    /*
    FNXC:WorkflowMergeRecovery 2026-09-20-18:37:
    A merge-boundary evidence gap is the named remediation that permits this one
    review-to-WIP transition. It remains fail-closed: only an incomplete durable
    checklist, the resolved workflow lanes, and the typed boundary result can
    enter it. The move preserves branch/worktree/progress; it never fabricates
    proof or retries merge against unchanged evidence.
    */
    if (mayRepairBoundary) {
      /*
      FNXC:WorkflowMergeRecovery 2026-09-21-11:00:
      A merge-boundary repair is a review-to-WIP transition, so it must honor the
      same effective auto-merge human-control gate as every other review recovery.
      Only a live shared-branch integration may continue while auto-merge is off;
      otherwise an operator's explicit hold wins before any continuation claim or move.
      */
      const settings = await deps.store.getSettings?.().catch(() => undefined) ?? { autoMerge: true } as Settings;
      if (settings.globalPause === true || settings.enginePaused === true) return false;
      const liveSharedBranchMember = await deps.isLiveSharedBranchGroupMember?.(live) ?? false;
      if ((live.autoMerge === false || !allowsAutoMergeProcessing(live, settings)) && !liveSharedBranchMember) return false;
      const outcome = await recoverMergeBoundaryEvidenceGap(
        deps,
        live,
        failedNode,
        boundaryEvidence,
        resumeRouterLanes.wip,
        settings,
        liveSharedBranchMember,
      );
      if (outcome === "declined") return false;
      if (outcome === "concurrent" || outcome === "raced" || outcome === "deferred" || outcome === "held") return true;
    }
    const message = mayRepairBoundary
      ? `Workflow merge evidence recovery scheduled implementation resume in '${resumeRouterLanes.wip}'`
      : `${formatGraphFailureDiagnostic(failedNode, failureValue, nodeError, "Workflow graph failed")} with incomplete work — resuming in place in '${live.column}'`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    if (!mayRepairBoundary) {
      await deps.store.updateTask(live.id, { status: null, error: null }, deps.getRunContextFor(live.id));
    }
    /*
    FNXC:ReviewConvergence 2026-08-22-05:00:
    Graph-failure recovery is automatic remediation, not an explicit operator retry. Archive its
    failed review result after the remediation-provenanced move so the next reviewer receives the
    durable ledger without opening a merge gate during the move.
    */
    await deps.clearTerminalStepFailuresForRetry(live.id, "archive");
    await deps.persistTokenUsage(live.id);
    return true;
}
