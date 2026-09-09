/*
FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
Project picker for the transfer flow. The MODAL owns what-will-be-copied copy, the disposition
radio, and the Confirm/Cancel decision; the ProjectSelector owns target selection and renders
cross-node remote entries disabled with a named reason (transfer never crosses nodes — the server
refuses with `target-unresolvable`, so the UI refuses visibly first).
*/
import "./TaskTransferModal.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import {
  fetchProjects,
  fetchProjectsAcrossNodes,
  type ProjectInfo,
  type ProjectInfoWithSource,
} from "../api";
import type { TaskTransferDisposition } from "../api/tasks/tasks-lifecycle";
import { ProjectSelector } from "./ProjectSelector";

export interface TaskTransferSelection {
  targetProjectId: string;
  disposition: TaskTransferDisposition;
}

/** The minimum card surface the picker needs; every board host already has it. */
export type TransferableTask = Pick<Task, "id" | "title">;

export interface TaskTransferModalProps {
  /** The card being copied. Only identity + title are shown; the server owns the copy. */
  task: TransferableTask | null;
  /*
  FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
  The board surfaces (card, list row, detail modal) know only the CURRENT project's id, never the
  full ProjectInfo record — threading it would mean editing every host above them. The picker needs
  the id for exactly one thing (excluding the current project) and the origin project's NAME comes
  from the server's transfer response, so an id is the honest prop.
  */
  currentProjectId: string | null;
  open: boolean;
  onClose: () => void;
  onConfirm: (selection: TaskTransferSelection) => void;
}

/*
FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
Remote (non-local-node) projects are listed DISABLED with the reason, not hidden — the operator
sees the target exists and learns why it cannot receive a copy. The server independently refuses
(`409 reason:"target-unresolvable"`), so a stale local view can still not smuggle a cross-node
transfer through. The reason must be a translated SENTENCE, not a machine code: it is rendered
verbatim in the picker row, so an untranslated token would show operators the word "cross-node".
*/
const CROSS_NODE_DISABLED_KEY = "taskDetail.transfer.remoteDisabledReason";
const CROSS_NODE_DISABLED_FALLBACK = "Lives on another machine — transfer only reaches projects on this install";

export function TaskTransferModal({ task, currentProjectId, open, onClose, onConfirm }: TaskTransferModalProps) {
  const { t } = useTranslation("app");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [projects, setProjects] = useState<ProjectInfoWithSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disposition, setDisposition] = useState<TaskTransferDisposition>("keep-transferred");

  // One fresh project discovery per open — a cancel that never submits still fetched zero transfers.
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setSubmitting(false);
      setDisposition("keep-transferred");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([fetchProjectsAcrossNodes(), fetchProjects()])
      .then(([all, local]) => {
        if (cancelled) return;
        // Local = present in the LOCAL registry listing. Entries only reachable across nodes are
        // `_sourceNodeName`-stamped remote views of another install's registry.
        const localIds = new Set(local.map((p) => p.id));
        const merged: ProjectInfoWithSource[] = all.map((p) =>
          localIds.has(p.id) ? { ...p, _sourceNodeName: undefined } : p,
        );
        setProjects(merged);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) cancelButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    /*
    FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
    CAPTURE phase on purpose. This picker is hosted INSIDE other overlays (task detail keeps its own
    document-level Escape → close-modal listener), and `stopPropagation()` from a second BUBBLE-phase
    listener on the same node cannot preempt a listener the host registered earlier — same node and
    same phase run in registration order, and the host registered first. A capture-phase listener on
    the same node runs before every bubble listener, so Escape collapses exactly one layer: the
    picker closes, the card behind it stays open.
    */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const getDisabledReason = useCallback(
    (project: ProjectInfo) =>
      (project as ProjectInfoWithSource)._sourceNodeName
        ? t(CROSS_NODE_DISABLED_KEY, CROSS_NODE_DISABLED_FALLBACK)
        : undefined,
    [t],
  );

  const selectableProjects = useMemo(
    () => projects.filter((p) => p.id !== currentProjectId),
    [projects, currentProjectId],
  );

  const canSubmit = Boolean(selected) && !submitting && !loading;

  if (!open || !task) return null;

  const handleSubmit = () => {
    if (!selected) return;
    setSubmitting(true);
    onConfirm({ targetProjectId: selected.id, disposition });
  };

  return (
    <div
      className="modal-overlay open"
      role="presentation"
      onClick={(event) => {
        // Backdrop click cancels; stopPropagation keeps that click from reaching a hosting overlay's own dismiss handler.
        event.stopPropagation();
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="modal task-transfer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-transfer-modal-title"
        data-testid="task-transfer-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="task-transfer-modal-title">
            {t("taskDetail.transfer.title", "Transfer to project")}
          </h3>
        </div>
        <div className="task-transfer-modal__body">
          <p className="task-transfer-modal__copy">
            {t(
              "taskDetail.transfer.message",
              "Copies {{id}} into another project on this machine. The original stays put and gains a “transferred” pointer to the copy.",
              { id: task.id },
            )}
          </p>

          <ul className="task-transfer-modal__copied" aria-label={t("taskDetail.transfer.copiedAria", "What is copied")}>
            <li>{t("taskDetail.transfer.copied.title", "Title, description, and the transferred spec")}</li>
            <li>{t("taskDetail.transfer.copied.attachments", "Attachments (unreadable ones are skipped, never silently dropped)")}</li>
            <li>{t("taskDetail.transfer.copied.dependencies", "Active dependencies recorded as an informational note")}</li>
            <li data-not-copied="true">{t("taskDetail.transfer.notCopied", "Comments, execution history, worktrees, branches, and missions are NOT copied")}</li>
          </ul>

          <div className="task-transfer-modal__field">
            <span className="task-transfer-modal__label" id="task-transfer-target-label">
              {t("taskDetail.transfer.targetProject", "Target project")}
            </span>
            {loading ? (
              <div className="task-transfer-modal__loading" role="status">
                {t("taskDetail.transfer.loadingProjects", "Loading projects…")}
              </div>
            ) : loadError ? (
              <div className="task-transfer-modal__error" role="alert">
                {t("taskDetail.transfer.loadProjectsFailed", "Could not load the project list: {{error}}", { error: loadError })}
              </div>
            ) : selected ? (
              <div className="task-transfer-modal__selected" aria-live="polite">
                <span>{t("taskDetail.transfer.selectedProject", "Target: {{name}}", { name: selected.name })}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSelected(null)}
                  data-testid="task-transfer-change-project"
                >
                  {t("taskDetail.transfer.changeProject", "Change")}
                </button>
              </div>
            ) : (
              <ProjectSelector
                projects={selectableProjects}
                currentProject={null}
                onSelect={(project) => setSelected(project)}
                triggerLabel={t("taskDetail.transfer.selectProject", "Select target project…")}
                getDisabledReason={getDisabledReason}
                allowSingleProject
              />
            )}
          </div>

          <fieldset className="task-transfer-modal__disposition">
            {/*
            FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
            The legend key is `disposition.legend`, not bare `disposition`: the catalog nests
            `transfer.disposition` as the object holding the two option labels, and a nested-JSON
            resource cannot give `disposition` a string value AND children — `t("…disposition")`
            would resolve to the object and render "[object Object]".
            */}
            <legend>{t("taskDetail.transfer.disposition.legend", "After the copy lands")}</legend>
            <label>
              <input
                type="radio"
                name="task-transfer-disposition"
                value="keep-transferred"
                checked={disposition === "keep-transferred"}
                onChange={() => setDisposition("keep-transferred")}
              />
              {t("taskDetail.transfer.disposition.keepTransferred", "Keep the original, marked as transferred")}
            </label>
            <label>
              <input
                type="radio"
                name="task-transfer-disposition"
                value="keep-unchanged"
                checked={disposition === "keep-unchanged"}
                onChange={() => setDisposition("keep-unchanged")}
              />
              {t("taskDetail.transfer.disposition.keepUnchanged", "Keep the original unchanged")}
            </label>
          </fieldset>
        </div>
        <div className="modal-actions">
          <div className="modal-actions-left">
            <button ref={cancelButtonRef} type="button" className="btn" onClick={onClose} disabled={submitting} data-testid="task-transfer-cancel">
              {t("common.cancel", "Cancel")}
            </button>
          </div>
          <div className="modal-actions-right">
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit} data-testid="task-transfer-confirm">
              {submitting
                ? t("taskDetail.transfer.transferring", "Transferring…")
                : t("taskDetail.transfer.confirm", "Transfer")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
