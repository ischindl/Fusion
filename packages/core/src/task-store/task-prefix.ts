/**
 * FNXC:MissionTaskPrefix 2026-07-26-12:00:
 * Shared minting-prefix resolution for createTask paths. Prefer the per-mission
 * TaskCreateInput.taskPrefix hint (mission triage), then project settings.taskPrefix,
 * then the path-specific fallback. Extracted so FN default (workflow-task-create-ops)
 * and KB default (task-creation) cannot drift (CodeRabbit #2347 / PR #1930).
 */
export function resolveTaskPrefix(
  taskPrefixHint: string | undefined,
  settingsTaskPrefix: string | undefined,
  fallback: string,
): string {
  return (taskPrefixHint?.trim() || settingsTaskPrefix?.trim() || fallback).trim().toUpperCase();
}

/**
 * Named refusal for a create whose minting partition cannot be proven to be the project the row
 * will land in. Surfaced through the create API so a caller gets a reason instead of a card whose
 * identity belongs to somebody else's namespace.
 *
 * @see resolveTaskIdMintingContext
 */
export const TASK_ID_MINTING_PARTITION_MISMATCH = "task-id-minting-partition-mismatch";

/** Raised when the minting partition disagrees with the destination partition, or cannot be proven. */
export class TaskIdMintingPartitionMismatchError extends Error {
  readonly code = TASK_ID_MINTING_PARTITION_MISMATCH;
  constructor(reason: string) {
    super(`${TASK_ID_MINTING_PARTITION_MISMATCH}: ${reason}`);
    this.name = "TaskIdMintingPartitionMismatchError";
  }
}

/** The project partition an id was minted for, plus the namespace that minting produced. */
export interface TaskIdMintingContext {
  /** Project whose settings/allocator partition produced this id; null only for a legacy unbound store. */
  readonly projectId: string | null;
  /** Namespace the mint will use, already normalized (upper-case, trimmed). */
  readonly prefix: string;
}

export interface TaskIdMintingContextInput {
  /**
   * Project the caller wants the card to land in, when the caller states one
   * (`TaskCreateInput.targetProjectId`). A create cannot write a row into a partition other than
   * its own, so a stated destination must EQUAL the minting partition or the create refuses.
   */
  targetProjectId?: string | null;
  /** Project partition the calling store's settings/allocator reads belong to (`asyncLayer.projectId`). */
  mintingProjectId?: string | null;
  /** Transient per-mission minting hint; legal inside the minting project, never a namespace escape. */
  taskPrefixHint?: string;
  /**
   * The `taskPrefix` from the minting project's OWN `project.config` row. This, not the merged
   * settings document, is what may name a bound project's namespace.
   */
  projectConfigPrefix?: string | null;
  /** Merged-settings `taskPrefix`. Consulted only when NO project partition is provable (legacy store). */
  unboundSettingsTaskPrefix?: string | null;
  /** Path-specific default (`FN` for the workflow create path, `KB` for the backend create path). */
  fallback: string;
}

/**
 * Resolve the namespace a new card's id will be minted in, from the project that partition belongs
 * to, and refuse when that agreement cannot be proven.
 *
 * FNXC:TaskIdMintingPartition 2026-11-08-09:19 (RUFU-320):
 * Reported incident: the CEO agent created cards from agent chat with no explicit project; they
 * landed on the `vllm-rocm` board (`proj_ab8b3ac6277e43a0`) carrying the `RUFU` prefix that belongs
 * to the RunFusion project, which already held its own `RUFU-002`/`RUFU-003`. Two live rows, one
 * id string, distinguished only by `project_id`, so `fn task show RUFU-003` opened the wrong card.
 * The minting site read the merged settings document, which layers the daemon-wide
 * `settings.json` under the project's own `project.config`; for a project with no `taskPrefix` of
 * its own that merge handed the launch project's namespace to a row stamped with the destination
 * project's id. Minting partition and row partition are therefore one value decided in two places.
 *
 * The invariant this function enforces:
 *  1. the namespace of a bound create comes from that project's OWN config row — a shared
 *     global-settings tier can never name a partitioned project's ids;
 *  2. a create that states a destination either proves it equals its own partition or refuses with
 *     `task-id-minting-partition-mismatch` and no row;
 *  3. the merged settings tier still names the namespace for a genuinely unbound (legacy
 *     single-project) store, which has no config partition to read;
 *  4. the transient mission hint keeps winning inside the minting project, so mission triage can
 *     mint `ERR-` on an `FN-` board without ever minting into a foreign project.
 */
export function resolveTaskIdMintingContext(input: TaskIdMintingContextInput): TaskIdMintingContext {
  const target = input.targetProjectId?.trim() || null;
  const minting = input.mintingProjectId?.trim() || null;

  if (target && !minting) {
    throw new TaskIdMintingPartitionMismatchError(
      `create names target project "${target}" but the store has no provable project partition to mint from`,
    );
  }
  if (target && minting && target !== minting) {
    throw new TaskIdMintingPartitionMismatchError(
      `create names target project "${target}" while the minting store is partitioned to "${minting}"; create through the target project's store instead`,
    );
  }

  const projectId = target ?? minting;
  const partitionPrefix = projectId ? input.projectConfigPrefix : (input.projectConfigPrefix ?? input.unboundSettingsTaskPrefix);
  return {
    projectId,
    prefix: resolveTaskPrefix(input.taskPrefixHint, partitionPrefix ?? undefined, input.fallback),
  };
}
