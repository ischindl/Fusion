import { basename, resolve } from "node:path";
import { columnsWithFlag, resolveWorkflowIrForTask, type TaskStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";

/*
FNXC:CardOwnershipGuard 2026-09-26-05:10:
STAS-273: a task worktree directory and its `fusion/<task>` branch are named deterministically from
the task id, so the name alone answers "which card owns this workspace?" — without the
`task.worktree` metadata column (which a prior reclaim can null out) and without the live-session
registry (which is empty between heartbeats). Every automatic deletion path must consult this one
guard before destroying an artifact that names a card, because ancestry against an integration ref is
NOT a landing proof: measured on STAS-265, the project's local `main` was sitting on that card's own
unmerged tip, so `git merge-base --is-ancestor <tip> main` returned true for a card still
in `todo`, and four sweeps inside eight hours destroyed and re-provisioned its checkout.

Release authority is the card's own lane, resolved from the workflow IR that card actually runs
(unioned with the legacy ids exactly as the pool scans do, so a degraded board cannot hold every
workspace forever): a lane the workflow hands to the merger (`complete`, `humanReview`,
`mergeOrchestration`, `mergeBlocker`, `done`, `in-review`) or an archived card may be released; every
earlier lane is work-in-progress and is refused. A caller that legitimately retires a workspace from
outside those lanes passes an explicit `authorization` — the absence of one is a refusal, never a
default allow.
*/

const LEGACY_RELEASE_LANES = ["done", "in-review"] as const;
const RELEASE_LANE_FLAGS = ["complete", "humanReview", "mergeOrchestration", "mergeBlocker"] as const;

export type CardReleaseAuthorization =
  | "merger-landing"
  | "task-deletion"
  | "operator-release"
  | "step-session-cleanup";

export interface CardOwnershipArtifact {
  worktreePath?: string;
  branch?: string;
}

/** The card facts the guard needs; satisfied by a slim `listTasks` row. */
export interface CardOwnershipRecord {
  id: string;
  /** Absent on a malformed row, which is treated as no release authority. */
  column?: string;
  branch?: string | null;
  archived?: boolean;
  worktree?: string | null;
}

export interface CardRemovalGateOutcome {
  /** True when the artifact names a card whose lane has not reached release authority. */
  refuse: boolean;
  taskId?: string;
  lane?: string;
  authorization?: CardReleaseAuthorization;
}

/**
 * Resolve the card a workspace artifact is named after. Matching follows the committed naming
 * convention (lower-cased task id as directory basename, `fusion/<lower-cased id>` as branch) plus a
 * recorded branch, so a drifted or nulled `worktree` column cannot hide the owner.
 */
export function findCardOwningArtifact<T extends CardOwnershipRecord>(
  tasks: readonly T[],
  artifact: CardOwnershipArtifact,
): T | null {
  const dirName = artifact.worktreePath ? basename(resolve(artifact.worktreePath)).toLowerCase() : null;
  const branch = artifact.branch ?? null;
  for (const task of tasks) {
    const slug = task.id.toLowerCase();
    if (dirName && dirName === slug) return task;
    if (branch && (branch === `fusion/${slug}` || (task.branch && branch === task.branch))) return task;
  }
  return null;
}

/**
 * Whether this card's lane carries authority to release its workspace. Resolved per card because
 * each card may run its own workflow.
 */
export async function cardWorkspaceReleasable(
  store: TaskStore,
  task: CardOwnershipRecord,
  irCache?: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
): Promise<boolean> {
  if (task.archived) return true;
  const lanes = new Set<string>(LEGACY_RELEASE_LANES);
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id, irCache ?? new Map());
    if (ir) {
      for (const flag of RELEASE_LANE_FLAGS) {
        for (const columnId of columnsWithFlag(ir, flag)) lanes.add(columnId);
      }
    }
  } catch {
    // Degraded IR resolution keeps the legacy ids; refusing every lane would strand every workspace.
  }
  return task.column !== undefined && lanes.has(task.column);
}

/**
 * The one gate and the one evidence hook for destroying a card-owned workspace.
 *
 * Refusals are recorded in the run audit and the debug log — never in the card's own log, so a
 * sweep that fires every cadence cannot flood a card with identical lines. A permitted removal of a
 * card-owned workspace writes both a run-audit row and a row on the card's task log naming the path,
 * the removal reason, and the code path responsible, which is what the STAS-265 forensics lacked:
 * four destructions produced no `worktree:remove` row at all.
 */
export async function gateCardOwnedRemoval(input: {
  store: TaskStore;
  tasks: readonly CardOwnershipRecord[];
  artifact: CardOwnershipArtifact;
  /** The removal reason the caller was about to act on. */
  reason: string;
  /** Which code path is asking, so evidence names a real path. */
  triggeredBy: string;
  authorization?: CardReleaseAuthorization;
  audit?: RunAuditor;
  irCache?: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>;
  logger?: { log?: (message: string) => void; debug?: (message: string) => void };
}): Promise<CardRemovalGateOutcome> {
  const owner = findCardOwningArtifact(input.tasks, input.artifact);
  if (!owner) return { refuse: false };

  const target = input.artifact.worktreePath ?? input.artifact.branch ?? "";
  const releasable = await cardWorkspaceReleasable(input.store, owner, input.irCache);
  const metadata = {
    taskId: owner.id,
    lane: owner.column ?? null,
    reason: input.reason,
    triggeredBy: input.triggeredBy,
    worktreePath: input.artifact.worktreePath,
    branch: input.artifact.branch,
  };

  if (!releasable && !input.authorization) {
    await input.audit?.git({
      type: "worktree:removal-preserved",
      target,
      metadata: { ...metadata, preservedBecause: "card-lane-non-terminal" },
    });
    input.logger?.debug?.(
      `preserving ${target}: card ${owner.id} is still in non-terminal lane "${owner.column ?? "(none)"}" (${input.triggeredBy}/${input.reason})`,
    );
    return { refuse: true, taskId: owner.id, lane: owner.column };
  }

  await input.audit?.git({
    type: "worktree:removed-card-owned",
    target,
    metadata: { ...metadata, authorization: input.authorization ?? `release-lane:${owner.column ?? "(none)"}` },
  });
  await input.store.logEntry(
    owner.id,
    `[workspace] removed ${target}: reason=${input.reason} path=${input.triggeredBy}`
      + ` lane=${owner.column ?? "(none)"}${input.authorization ? ` authorized=${input.authorization}` : " (release lane)"}`,
  );
  return { refuse: false, taskId: owner.id, lane: owner.column, authorization: input.authorization };
}
