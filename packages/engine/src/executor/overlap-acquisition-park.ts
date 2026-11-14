import { createHash } from "node:crypto";
import type { RunMutationContext, Task, TaskStore } from "@fusion/core";
import { isWorkspaceTask } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { executorLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import type { OverlapRefusalArtifacts, OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import { RemovalReason, removeWorktree, WorktreeContentPreservationError } from "../worktree/worktree-backend.js";

/*
FNXC:OverlapAcquisitionPark 2026-11-04-01:35 (RUFU-373):
The withheld-work record for a file-scope overlap refusal at acquisition time.

SANE-436 (2026-09-27T16:4xZ, project saneca) and ROZV-197 (7 856 / 7 855 todo<->in-progress bounces,
6 939 occurrences of `Delivered file evidence is not yet available for overlap synchronization` across
23 578 activity rows) were invisible in telemetry: the refusal produced no event, and the composed
exhaustion message named no predecessor. One bounded event per (task, episodes, reason) episode now
names the missing artifact. It is emitted through `emitBoundedRunAudit` — an absent, throwing, rejecting
or hanging sink cannot change the refusal, so telemetry never becomes a lifecycle dependency — and stays
outside the curated delivery-pipeline catalogue (documented as prose in docs/run-audit.md), which
`run-audit-catalogue.test.ts` locks table-for-table.

Metadata is ids/counts/fixed enums ONLY: `reason` and `missingEvidence` are the gate's closed vocabularies,
`registrationRelease` is this module's. The refusal sentence, delivered paths, and diffs never enter the row.
*/
export type OverlapRegistrationRelease =
  | "removed"
  | "absent"
  | "preserved"
  | "refused-active"
  | "refused-external-checkout"
  | "refused-workspace-task"
  | "no-registration"
  | "failed";

/** Deduped per (task, reason, episode set) so a repeated wait is countable, not a per-heartbeat flood. */
const announcedEpisodes = new Set<string>();

/** Test seam: the dedup set is process-local, like every other `-no-action` dedup in the engine. */
export function __resetOverlapAcquisitionParkDedup(): void {
  announcedEpisodes.clear();
}

function episodeKey(taskId: string, reason: string, artifacts: OverlapRefusalArtifacts): string {
  return `${taskId}|${reason}|${[...artifacts.episodeIds].sort().join(",")}`;
}

/*
FNXC:OverlapAcquisitionPark 2026-11-04-01:35 (RUFU-373):
The registration a refused acquisition leaves behind is the re-arm half of the wedge. SANE-436 kept its
worktree pointer through the failure, and `reconcile-dependency-blocking-lease` (RUFU-200) rebounds the
HOLDER for a dormant lease — so the waiter's own dead checkout could block the very predecessor it waits on.
The release reuses the proof-gated defensive path (registry guard + `git status --porcelain` + allowlist +
`WorktreeContentPreservationError`), so it can never destroy task-authored content: a checkout that is not
provably empty keeps both the checkout AND its pointers, which is what makes a release safe to attempt
before execution has ever started.
*/
export async function releaseRefusedAcquisitionRegistration(input: {
  store: TaskStore;
  rootDir: string;
  task: Task;
}): Promise<OverlapRegistrationRelease> {
  const { store, rootDir, task } = input;
  if (!task.worktree) return "no-registration";
  // A workspace lane's registration spans per-repo members; only the workspace lane owns that teardown.
  if (isWorkspaceTask(task)) return "refused-workspace-task";
  /*
   * An operator-configured external checkout is never an engine-owned acquisition to roll back. The
   * refusal can be misread when the operator set `enabled:false` while a stale pointer still names their
   * path — the `configured` flag alone is the proof of intent, matching every other release site's guard.
   */
  if ((await resolveExternalExecutionCheckoutRoute(task)).configured) return "refused-external-checkout";
  // Fail closed while anything still holds the path: a live session outranks a refusal that predates it.
  if (activeSessionRegistry.isPathActive(task.worktree)) return "refused-active";

  const settings = await store.getSettings();
  try {
    const outcome = await removeWorktree({
      rootDir,
      worktreePath: task.worktree,
      settings,
      taskId: task.id,
      reason: RemovalReason.AcquisitionRefused,
    });
    // The backend signals preservation by THROWING, so a returned outcome is never a preservation.
    if (outcome.classification === "not-registered-after-prune") {
      // Nothing left to remove but the pointers still named it: clearing them is the whole repair.
      await store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
      return "absent";
    }
    await store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
    return "removed";
  } catch (error) {
    // A preservation refusal keeps the pointers: clearing them over a preserved checkout is how orphans are made.
    if (error instanceof WorktreeContentPreservationError) return "preserved";
    executorLog.warn(`${task.id}: could not release the worktree refused by overlap synchronization: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/**
 * Records one bounded withheld-work episode and releases the leaked registration.
 * Returns the fixed outcomes so the caller's heartbeat run result carries them too.
 */
export async function recordOverlapAcquisitionPark(input: {
  store: TaskStore;
  rootDir: string;
  task: Task;
  agentId: string;
  error: OverlapResumeSynchronizationError;
  nodeId?: string;
}): Promise<{ registrationRelease: OverlapRegistrationRelease; announced: boolean }> {
  const { store, task, agentId, error } = input;
  const artifacts = error.artifacts;
  const registrationRelease = await releaseRegistrationGuarded(input);
  const key = episodeKey(task.id, error.reason, artifacts);
  const announced = !announcedEpisodes.has(key);
  if (announced) {
    announcedEpisodes.add(key);
    await emitBoundedRunAudit(store, {
      taskId: task.id,
      agentId,
      runId: `overlap-acquisition-park:${task.id}:${key}`,
      domain: "database",
      mutationType: "task:overlap-acquisition-parked",
      target: task.id,
      metadata: {
        taskId: task.id,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        reason: error.reason,
        missingEvidence: artifacts.missingEvidence,
        episodeIds: artifacts.episodeIds.slice(0, 20),
        blockerTaskIds: artifacts.blockerTaskIds.slice(0, 20),
        repositories: artifacts.repositories.slice(0, 20),
        episodeCount: artifacts.episodeIds.length,
        // The whole point of the event: a deterministic wait consumed none of the broken-checkout budget.
        strikeBudgetConsumed: 0,
        registrationRelease,
      },
    });
    const blockers = artifacts.blockerTaskIds.length > 0 ? artifacts.blockerTaskIds.join(", ") : "unknown";
    // The action line is what the card face shows, so it names the predecessor rather than the mechanism.
    // A store double that returns nothing must not turn the notice into a second failure path, hence Promise.resolve.
    await Promise.resolve(store.logEntry(
      task.id,
      `Waiting on ${blockers} for file-scope delivery — execution withheld, no retry strike consumed`,
      `Missing artifact: ${artifacts.missingEvidence}; repositories: ${artifacts.repositories.join(", ") || "unknown"}; episodes: ${artifacts.episodeIds.join(", ") || "unknown"}; registration release: ${registrationRelease}`,
    )).catch(() => undefined);
  }
  return { registrationRelease, announced };
}

/*
FNXC:OverlapAcquisitionPark 2026-11-14-11:52 (RUFU-896):
A refused acquisition is a WAIT, so it must be stored as a wait. The arm that caught this refusal used to
write `status: "failed"` plus the refusal prose, and that prose is what kept the loop alive: a `failed`
todo card is re-admitted, re-acquires a worktree, is refused again, and the engine itself logged
`no retry strike consumed` while using a field shape no counter could bound. RUFU-476 measured 17 of those
cycles in three hours and rebuilt its worktree after a daemon restart.

So the refusal now writes the same hold shape the executor's dispatch gate already writes
(`file-scope-lease-dispatch-gate.ts`): `transitionQueuedEpisode` owns `status`, `blockedBy`,
`overlapBlockedBy` and the queue-log edge, and it has NO `error` field — which is the point. The card stays
in `todo`, named by its predecessor, and the already-shipped planning-lane acquisition skip
(`heartbeatPlanningLaneAcquisitionSkip`, RUFU-200) then keeps later heartbeats from touching a checkout at
all. No new counter is introduced here: bounded waiting is owned by `reconcileTaskOverlapWaits` and
`reconcileReleasedOverlapWaits`, and RUFU-673 owns attempt budgets — this file deliberately takes neither.

`overlapBlockedBy` stays a SINGLE id because every live value is one; with several predecessors the
deterministic first (sorted) is used, so one wait cannot oscillate between two names across heartbeats.
*/
export type OverlapHoldWrite = "held" | "fallback-terminal";

/** Why this hold exists; kept in the signature so a typed refusal and a composed cap never share an identity. */
export type OverlapHoldReason = "typed-refusal" | "cap-composed";

/**
 * Names the predecessors from the episode table, for the arm that carries no typed artifacts.
 *
 * FNXC:OverlapAcquisitionPark 2026-11-14-11:52 (RUFU-896):
 * Without this, the cap-composed hold could only write `overlapBlockedBy: null`, and a hold that names nobody
 * does not stop the loop: the planning-lane skip decides from that column, so the next heartbeat would acquire
 * again and rebuild the worktree — the same defect, reached through the other arm. One bounded read on a path
 * that has already failed is the cheaper answer, and the attribution then comes from the same rows every other
 * consumer reads. Best-effort by nature: an unreadable episode table leaves the card held but unattributed,
 * which still beats a prose failure, and `reconcileTaskOverlapWaits` remains the resolver either way.
 */
export async function attributeOverlapBlockers(
  store: Pick<TaskStore, "listTaskOverlapWaits">,
  taskId: string,
): Promise<string[]> {
  const rows = await store.listTaskOverlapWaits(taskId, { pendingOnly: true }).catch(() => []);
  const blockers = new Set<string>();
  for (const row of rows ?? []) {
    const blocker = (row as { blockerTaskId?: string }).blockerTaskId;
    if (blocker && blocker !== taskId) blockers.add(blocker);
  }
  return [...blockers].sort();
}

/*
 * Bounded, deterministic episode identity. An unbounded signature would make every heartbeat a NEW wait,
 * which is exactly how an edge-triggered queue log becomes a flood.
 */
function acquisitionSignature(reason: OverlapHoldReason, episodeIds: string[], blockers: string[]): string {
  const sorted = [...episodeIds].sort().join(",") || [...blockers].sort().join(",") || "unattributed";
  const short = `overlap-acquisition:${reason}:${sorted}`;
  if (sorted.length <= 96) return short;
  return `overlap-acquisition:${reason}:${createHash("sha256").update(sorted).digest("hex").slice(0, 16)}`;
}

export async function holdRefusedAcquisition(input: {
  store: TaskStore;
  task: Task;
  blockers: string[];
  episodeIds?: string[];
  reason: OverlapHoldReason;
  runContext?: RunMutationContext;
}): Promise<OverlapHoldWrite> {
  const { store, task } = input;
  const blockers = [...input.blockers].filter((id) => typeof id === "string" && id.length > 0).sort();
  const named = blockers[0] ?? task.overlapBlockedBy ?? null;
  try {
    await store.transitionQueuedEpisode(task.id, {
      signature: acquisitionSignature(input.reason, input.episodeIds ?? [], blockers),
      blockedBy: task.blockedBy ?? null,
      overlapBlockedBy: named,
      action: `queued — waiting on ${named ?? "unknown"} for file-scope delivery (execution withheld, no retry strike consumed)`,
      outcome: "Acquisition refused by overlap synchronization; the card is held in its queue lane, not failed.",
      runContext: input.runContext,
    });
    return "held";
  } catch (error) {
    // A card that cannot be durably held must not look runnable either: the caller keeps the terminal write.
    executorLog.warn(`${task.id}: overlap hold write refused, falling back to the terminal record: ${error instanceof Error ? error.message : String(error)}`);
    return "fallback-terminal";
  }
}

/** Never let a release failure or a missing pointer turn a refusal into a second failure path. */
async function releaseRegistrationGuarded(input: { store: TaskStore; rootDir: string; task: Task }): Promise<OverlapRegistrationRelease> {
  try {
    return await releaseRefusedAcquisitionRegistration(input);
  } catch (error) {
    executorLog.warn(`${input.task.id}: overlap registration release raised: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
