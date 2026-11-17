/*
FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583):
Requirement this file exists to satisfy, stated by the operator: "include an explicit lifecycle state
in the list projection (deleted/archived at minimum) so absence of the field cannot read as 'alive'."

The measured defect: `rowToTask` maps `deletedAt: row.deletedAt ?? undefined`
(`task-store/serialization.ts:365`), so on a live row the key is `undefined` and `JSON.stringify`
omits it entirely. A consumer therefore cannot tell "this card is live" from "this projection never
told me anything about deletion", and the reflex filter `deletedAt is falsy` is blind by construction.
That is not hypothetical: on saneca five soft-deleted cards were listed with live-looking columns and
a verification built on that filter reported "0 of the deleted cards still present" while one of the
five had never been deleted at all (its delete was REFUSED for lineage references). The filter could
see neither the tombstones nor the survivor.

So the HTTP task projection states lifecycle on EVERY row, derived here by one total function that
answers for every row shape, and no consumer is permitted to reconstruct the state by filtering ids.

Two boundaries that keep this helper narrow:
 - This is a per-row LIFECYCLE state, not a workflow-lane fact. `Task.column` says where a card sits
   on a board; this says whether the card is still a live record at all. Lane resolution
   (`project-lane-vocabulary.ts`, workflow IR roles) stays a separate authority and is not consulted
   beyond the one sentinel-lane test named below.
 - It is a PROJECTION field. It is derived at the HTTP boundary and never persisted by a write path;
   stamping it inside `rowToTask` is deliberately NOT done, because that would push a derived key
   into engine-internal Task objects, SSE payloads, and exact-equality engine tests that are outside
   this contract.

Exactly TWO archival facts are admissible as evidence here, and no third may be invented:
 1. `Task.archivedAt` (`types/task/task-core.ts:2440`) — documented as present only on payloads
    hydrated from archived entries.
 2. `task.column` ∈ `ARCHIVED_SENTINEL_LANES` (`project-lane-vocabulary.ts:187`) — the physical
    archive sentinel a soft delete stamps, which is a return sentinel and not a board lane.
An earlier draft of this card claimed `getTaskImpl` stamps `archivedAt`; that was wrong (it throws
`TaskNotFoundError` for a tombstone), which is why the second fact is listed explicitly rather than
trusting the first to always arrive.
*/
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";
import type { Task } from "../types.js";

/**
 * The lifecycle state every projected task row carries.
 *
 * - `live` — a live record; the only state a default (non-forensic) board read may contain.
 * - `deleted` — a soft-deleted tombstone: `deletedAt` is set. Reachable only on a forensic read
 *   (`includeDeleted`), which RUFU-583 made genuinely reachable at the SQL layer.
 * - `archived` — archival evidence without a deletion timestamp: an archive-hydrated payload
 *   (`archivedAt`) or a row resting in the historical sentinel lane.
 */
export type TaskLifecycleState = "live" | "deleted" | "archived";

/** The key the HTTP projection carries the state under. Named once so routes cannot drift. */
export const TASK_LIFECYCLE_FIELD = "lifecycle" as const;

/**
 * Total derivation: every Task answers, and the answer is one of three literals.
 *
 * Precedence is deliberate: `deletedAt` WINS over any archival evidence, because a soft delete stamps
 * the sentinel lane too (`async-persistence.ts:667`), so a tombstone would otherwise read as merely
 * `archived` and a caller asking "was this deleted?" would get a wrong answer for exactly the rows
 * they asked about.
 */
export function deriveTaskLifecycle(task: Pick<Task, "deletedAt"> & Partial<Pick<Task, "archivedAt" | "column">>): TaskLifecycleState {
  if (task.deletedAt) return "deleted";
  if (task.archivedAt) return "archived";
  if (task.column && ARCHIVED_SENTINEL_LANES.has(task.column)) return "archived";
  return "live";
}

/**
 * The stamp a projection applies, so a route cannot apply half the contract: it always sets
 * `lifecycle`, derived, never guessed, and never mutates the caller's row.
 *
 * Applied at the HTTP boundary AFTER the store call and after the route's best-effort enrichments
 * (`branchProgress`, `plannerOverseerState`, `awaitingPlanning`), all of which spread `{...task}` —
 * the stamp therefore survives their spreads regardless of row shape, which is what makes it
 * independent of the RUFU-902 board-feed projection and the RUFU-615/RUFU-627 `fields` declaration.
 */
export function withTaskLifecycle<T extends Task>(task: T): T & { [TASK_LIFECYCLE_FIELD]: TaskLifecycleState } {
  return { ...task, [TASK_LIFECYCLE_FIELD]: deriveTaskLifecycle(task) };
}

/** List-shaped form of {@link withTaskLifecycle}; stamps every row, preserving order. */
export function withTaskLifecycleAll<T extends Task>(tasks: readonly T[]): Array<T & { [TASK_LIFECYCLE_FIELD]: TaskLifecycleState }> {
  return tasks.map((task) => withTaskLifecycle(task));
}

/**
 * Reads the stamped field back off a projected row. Returns `undefined` when the row never passed
 * through the projection, which lets a consumer distinguish "the server said this is live" from
 * "this payload predates the contract" instead of defaulting to `live` silently.
 */
export function readTaskLifecycle(row: unknown): TaskLifecycleState | undefined {
  const value = (row as { [TASK_LIFECYCLE_FIELD]?: unknown } | null | undefined)?.[TASK_LIFECYCLE_FIELD];
  return value === "live" || value === "deleted" || value === "archived" ? value : undefined;
}
