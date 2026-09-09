/*
FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
Transfer helper mirroring `runDuplicateTaskAction`: consumers inject the same toast/translation
surface plus a modal opener, and this module owns the API call and the toast vocabulary. Cancel is
the null resolution of `openTransferModal` and performs ZERO fetches — the modal is the only place
target-project discovery happens.

Toast contract: success names the target project and minted id; a `deduped` replay (the idempotent
retry) says the card was ALREADY transferred rather than pretending a second copy was made; and a
409 `target-unresolvable` shows the named reason (the registry-missage privilege guard) instead of a
raw server sentence.

FNXC:CrossProjectHandoff 2026-09-09-12:37 (RUFU-203):
`projectId` (the SOURCE card's project scope) is load-bearing, not decoration. The server resolves
the source project as `request projectId ?? engine.getProjectId()` — the daemon's LAUNCH project — so
an unscoped transfer of a card viewed in another project reads the id against the wrong store and
answers 404 (or, on an id collision, copies and stamps the WRONG card). That is precisely the
motivating scenario (a STASH card handed to Fusion from a dashboard launched on Fusion), so the
helper forwards the host's project scope as the request's third argument exactly like the badge's
`fetchHandoffStatus(task.id, projectId)`.
*/
import type { TFunction } from "i18next";
import { getErrorMessage } from "@fusion/core";
import { ApiRequestError } from "../api/client/client.js";
import type { TaskTransferDisposition, TaskTransferResult } from "../api/tasks/tasks-lifecycle";
import type { ToastType } from "../hooks/useToast";

/** Structured 409 reason the server pins for a target outside the local registry. */
export const TARGET_UNRESOLVABLE_REASON = "target-unresolvable";

export interface TransferSelection {
  targetProjectId: string;
  disposition: TaskTransferDisposition;
}

export interface RunTransferTaskActionInput {
  taskId: string;
  /**
   * The SOURCE card's project scope, forwarded to the request so the server binds the source store
   * to the project the operator is looking at instead of the daemon's launch project.
   */
  projectId: string | undefined;
  t: TFunction<"app">;
  addToast: (message: string, type?: ToastType) => void;
  /** Opens the transfer modal; resolves to the operator's selection, or null on cancel. */
  openTransferModal: () => Promise<TransferSelection | null>;
  transferTask: (
    id: string,
    options: { targetProjectId: string; disposition?: TaskTransferDisposition },
    projectId?: string,
  ) => Promise<TaskTransferResult>;
}

export async function runTransferTaskAction({
  taskId,
  projectId,
  t,
  addToast,
  openTransferModal,
  transferTask,
}: RunTransferTaskActionInput): Promise<TaskTransferResult | undefined> {
  const selection = await openTransferModal();
  if (!selection) return undefined;

  try {
    const result = await transferTask(taskId, selection, projectId);
    if (result.deduped) {
      addToast(
        t(
          "taskDetail.transfer.deduped",
          "{{id}} was already transferred to {{project}} as {{targetId}} — replayed the existing card",
          { id: taskId, project: result.targetProjectName, targetId: result.targetTaskId },
        ),
        "info",
      );
    } else {
      addToast(
        t(
          "taskDetail.transfer.success",
          "Transferred {{id}} to {{project}} as {{targetId}}",
          { id: taskId, project: result.targetProjectName, targetId: result.targetTaskId },
        ),
        "success",
      );
    }
    if (result.skippedAttachmentCount > 0) {
      addToast(
        t(
          "taskDetail.transfer.attachmentsSkipped",
          "{{count}} attachment(s) could not be copied to the target project",
          { count: result.skippedAttachmentCount },
        ),
        "warning",
      );
    }
    return result;
  } catch (error) {
    const details = error instanceof ApiRequestError ? error.details : undefined;
    if (details?.reason === TARGET_UNRESOLVABLE_REASON) {
      addToast(
        t(
          "taskDetail.transfer.reason.targetUnresolvable",
          "Target project is not available on this install — cross-project transfers only reach locally registered projects.",
        ),
        "error",
      );
    } else {
      addToast(getErrorMessage(error), "error");
    }
    return undefined;
  }
}
