import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import { fetchHandoffStatus, type HandoffTargetStatus } from "../api";
import { getTransferPointers, openTransferredTarget } from "../utils/taskTransfer";
import "./TransferredToBadge.css";

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02:
Source-side "Transferred → <project> <TARGET-ID>" badge, mounted on ALL board surfaces (TaskCard
footer, ListView card + row variants, TaskDetailModal metadata zone) wherever the card carries a
`transferredTo` pointer.

Contract:
- One on-demand `GET /tasks/:id/handoff-status` fetch per card — the response covers every pointer,
  so a multi-entry source still costs a single request. The one-shot marker is keyed by the
  (source project scope, card id) pair, not a boolean: a host that keeps one badge mounted while
  navigating between cards (TaskDetailModal re-renders the same badge in place for the newly opened
  card) must re-arm, or the new card's chips would key their lookups into the previous card's status
  map and never show a pill.
- The chip itself renders IMMEDIATELY from the pointer alone (project name + target id are
  captured at transfer time); the live status only ADDS a column pill. An unresolvable pointer —
  `targetAvailable:false` (registry removal, cross-node pointer, deleted card) or a failed fetch —
  keeps the static chip, shows no pill, and never raises an error toast: the pointer is durable
  provenance, its darkness is explained by the server-side status, not by interrupting the board.
- Clicking invokes the existing deep-link project-switch path (`openTransferredTarget`), not an
  in-memory board lookup — the target lives behind a different project's store.
*/

type TransferBadgeTask = Pick<Task, "id" | "sourceMetadata">;

function pointerKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

export interface TransferredToBadgeProps {
  task: TransferBadgeTask;
  /** Current project scope for the status fetch (server resolves the SOURCE store by it). */
  projectId?: string;
  /** Extra class for host-specific placement (list chips vs board chips vs detail). */
  className?: string;
}

export function TransferredToBadge({ task, projectId, className }: TransferredToBadgeProps) {
  const { t } = useTranslation("app");
  const pointers = getTransferPointers(task.sourceMetadata);
  const [statusByKey, setStatusByKey] = useState<Map<string, HandoffTargetStatus> | null>(null);
  /*
  FNXC:CrossProjectHandoff 2026-09-09-12:37 (RUFU-203):
  Task-scoped rather than boolean: the detail modal mounts ONE badge and re-renders it with a
  different `task` when the operator navigates, so a boolean "already fetched" marker would
  short-circuit the new card's fetch and leave its chips reading a map keyed by the old card. The
  marker carries the same identity as the effect deps (source project scope + card id).
  */
  const fetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    const fetchKey = `${projectId ?? ""}\u0000${task.id}`;
    if (pointers.length === 0 || fetchedForRef.current === fetchKey) return;
    const reusedForOtherCard = fetchedForRef.current !== null;
    fetchedForRef.current = fetchKey;
    // A different card needs a clean map, else its chips resolve against the previous card's rows.
    if (reusedForOtherCard) setStatusByKey(null);
    let cancelled = false;
    fetchHandoffStatus(task.id, projectId)
      .then((res) => {
        if (cancelled) return;
        setStatusByKey(new Map(res.handoffs.map((h) => [pointerKey(h.projectId, h.taskId), h])));
      })
      .catch(() => {
        // Static-chip fallback: a dark status channel must not toast (see FNXC block above).
      });
    return () => {
      cancelled = true;
    };
    // The refresh boundary is the (source project scope, card id) pair the `fetchKey` above encodes;
    // `pointers` derives from the task's own metadata row.
    // (This repo does not enable react-hooks/exhaustive-deps — do not add a disable comment for it.)
  }, [task.id, projectId]);

  if (pointers.length === 0) return null;

  return (
    <>
      {pointers.map((pointer) => {
        const status = statusByKey?.get(pointerKey(pointer.projectId, pointer.taskId));
        const showPill = status?.targetAvailable === true && typeof status.column === "string" && status.column.length > 0;
        const label = t("tasks.transferredTo", "Transferred \u2192 {{project}} {{id}}", {
          project: pointer.projectName,
          id: pointer.taskId,
        });
        return (
          <button
            key={pointerKey(pointer.projectId, pointer.taskId)}
            type="button"
            className={`transferred-chip${className ? ` ${className}` : ""}`}
            data-testid={`transferred-badge-${pointer.taskId}`}
            title={showPill
              ? t("tasks.transferredToLiveTitle", "Copied to {{project}} as {{id}}; currently {{column}}. Click to open.", { project: pointer.projectName, id: pointer.taskId, column: status?.column })
              : t("tasks.transferredToTitle", "Copied to {{project}} as {{id}}. Click to open.", { project: pointer.projectName, id: pointer.taskId })}
            aria-label={t("tasks.transferredToTitle", "Copied to {{project}} as {{id}}. Click to open.", { project: pointer.projectName, id: pointer.taskId })}
            onClick={(event) => {
              event.stopPropagation();
              openTransferredTarget(pointer.projectId, pointer.taskId);
            }}
          >
            <span className="transferred-chip-label">{label}</span>
            {showPill && <span className="transferred-chip-status">{status?.column}</span>}
          </button>
        );
      })}
    </>
  );
}
