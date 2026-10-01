import type { Task } from "@fusion/core";
import {
  HANDOFF_FROM_METADATA_KEY,
  TRANSFERRED_TO_METADATA_KEY,
  type TaskHandoffPointer,
} from "@fusion/core";

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02:
RUFU-203 copy-with-cross-reference transfer. The pointer payloads live ONLY in the already
persisted `sourceMetadata` JSONB carrier (no new `tasks` column): the source card gains
`transferredTo` = TaskHandoffPointer[] (one per target project, deduped per target on write) and
the target card gains `handoffFrom` = one TaskHandoffPointer. These helpers are the client-side
readers mirroring `parseTransferredTo`/`parseHandoffFrom` in the server route
(`packages/dashboard/src/routes/task-transfer.ts`) — same defensive shape so a hand-edited or
corrupted metadata blob degrades to "no pointer" instead of a broken card.
*/

function asHandoffPointer(value: unknown): TaskHandoffPointer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.projectId !== "string" || rec.projectId.length === 0) return null;
  if (typeof rec.taskId !== "string" || rec.taskId.length === 0) return null;
  return {
    projectId: rec.projectId,
    projectName: typeof rec.projectName === "string" && rec.projectName.length > 0 ? rec.projectName : rec.projectId,
    taskId: rec.taskId,
    transferredAt: typeof rec.transferredAt === "string" ? rec.transferredAt : "",
  };
}

/** Defensive read of the source card's `transferredTo` pointer array (invalid entries dropped). */
export function getTransferPointers(sourceMetadata: Task["sourceMetadata"] | undefined | null): TaskHandoffPointer[] {
  const raw = (sourceMetadata as Record<string, unknown> | undefined)?.[TRANSFERRED_TO_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map(asHandoffPointer).filter((p): p is TaskHandoffPointer => p !== null);
}

/** True when this card carries at least one valid `transferredTo` pointer (source side). */
export function isTaskTransferred(sourceMetadata: Task["sourceMetadata"] | undefined | null): boolean {
  return getTransferPointers(sourceMetadata).length > 0;
}

/** Defensive read of the target card's `handoffFrom` pointer (target side provenance). */
export function getHandoffFromPointer(sourceMetadata: Task["sourceMetadata"] | undefined | null): TaskHandoffPointer | null {
  return asHandoffPointer((sourceMetadata as Record<string, unknown> | undefined)?.[HANDOFF_FROM_METADATA_KEY]);
}

/**
 * FNXC:CrossProjectHandoff 2026-09-09-09:02:
 * Badge click on a `transferredTo` chip navigates to the TARGET project and opens the target
 * card through the app's existing deep-link contract (`?project=` switches the active project,
 * `?task=` opens the card — both handled by `useDeepLink`). Board surfaces have no prop path to
 * App's `handleSelectProject`, and `history.replaceState` would not notify the live app, so the
 * click performs a real navigation; the boot deep-link then owns the switch with its existing
 * "project not found" grace window (a since-removed target project explains itself instead of
 * dead-clicking).
 */
export function openTransferredTarget(projectId: string, taskId: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("project", projectId);
  url.searchParams.set("task", taskId);
  url.hash = "";
  window.location.assign(url.toString());
}
