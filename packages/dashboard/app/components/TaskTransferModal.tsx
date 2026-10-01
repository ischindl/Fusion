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
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS } from "../utils/swrCache";
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

/*
FNXC:CrossProjectHandoff 2026-09-10-18:25 (RUFU-211):
The operator-facing invariant this modal must never break again: project discovery TERMINATES in a
state the operator can act on. The server can stall before it ever answers a project-list read
(`withCentralCore` awaits init + reconcile + close), so the wait gets an explicit bound here rather
than inheriting `api()`, which deliberately has no global timeout (it would bound every dashboard
request). One tunable, colocated with the flow that owns the promise.
*/
export const PROJECT_DISCOVERY_TIMEOUT_MS = 10_000;

/*
FNXC:CrossProjectHandoff 2026-09-10-18:25 (RUFU-211):
The timeout and a genuine request rejection share one rejection path (the abort rejects the fetch),
but they need different sentences: "the list could not be loaded: <error>" would blame the operator
for what is really "we gave up waiting". A unique symbol marks the abort as self-inflicted so the
render can name the timeout without parsing error messages.
*/
const DISCOVERY_TIMED_OUT = Symbol("project-discovery-timeout");

/** Discovery failure as a NAMED condition, translated at render so a language switch re-renders it. */
type DiscoveryFailure = { kind: "timeout" } | { kind: "failed"; message: string };

/**
 * Seed candidates from the header switcher's SWR snapshot.
 *
 * `useProjects` is the only writer of this key, so reading it here cannot make the transfer flow a
 * cache writer; a miss (cold browser, stale snapshot, malformed payload) is simply "no seed". The
 * 6 h bound is deliberately `SWR_DEFAULT_MAX_AGE_MS` — the same bound the header switcher applies to
 * its own seed, so the two surfaces agree on what counts as usable.
 *
 * Unlike `useProjects` this seed is NOT run through its `normalizeProjects` helper: that helper only
 * derives the per-node `nodeMappings` array, which neither `ProjectSelector` nor this modal reads (the
 * picker's only cross-node signal is `_sourceNodeName`, which the cache already carries).
 *
 * One accepted deviation, visible to the operator: the local-vs-remote `_sourceNodeName` correction
 * needs BOTH discovery legs, so a seed-only row can briefly carry a provisional remote label until the
 * refresh settles. The alternative — hiding candidates until the legs answer — is the stall this fix
 * removes, so the stale-but-actionable label wins.
 */
function readProjectSeed(): ProjectInfoWithSource[] {
  const cached = readCache<ProjectInfoWithSource[]>(SWR_CACHE_KEYS.PROJECTS, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
  return Array.isArray(cached) ? cached : [];
}

export function TaskTransferModal({ task, currentProjectId, open, onClose, onConfirm }: TaskTransferModalProps) {
  const { t } = useTranslation("app");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [projects, setProjects] = useState<ProjectInfoWithSource[]>([]);
  /** True while a discovery round-trip is outstanding (the spinner row additionally needs "nothing to show"). */
  const [discovering, setDiscovering] = useState(false);
  const [loadError, setLoadError] = useState<DiscoveryFailure | null>(null);
  /** Bumped by Retry: re-runs discovery and marks the request as operator-forced-fresh. */
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  const [selected, setSelected] = useState<ProjectInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disposition, setDisposition] = useState<TaskTransferDisposition>("keep-transferred");

  /*
  FNXC:CrossProjectHandoff 2026-09-10-18:25 (RUFU-211):
  Discovery is bounded, seeded, and re-runnable. Three defects made the operator's "iba tam svietilo
  Loading projects" permanent, and each is closed here:
  1. The `Promise.all` render gate had no bound — a stalled server read (which never answers, so it
     never rejects) held `loading` true forever. An `AbortController` + `PROJECT_DISCOVERY_TIMEOUT_MS`
     turns "never settles" into a settled rejection, so the wait always ends.
  2. The shared `/projects/across-nodes` dedupe entry only un-registers when its inner fetch settles,
     so the hung request was joined by every reopen until a page reload. Aborting now settles it (see
     the `projects.ts` FNXC note); Retry additionally passes `forceFresh` so an operator-initiated
     retry can never re-join an entry this component did not create (a header-initiated read has no
     signal of ours, so aborting ours cannot settle THAT entry).
  3. The header switcher already hides its own slow refresh by seeding from the SWR projects cache;
     the modal had no seed, so the same stall was fully blocking. Seeding makes targets selectable at
     t=0 and keeps them usable if the refresh then fails.
  */
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setSubmitting(false);
      setDisposition("keep-transferred");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let timeoutCause: typeof DISCOVERY_TIMED_OUT | undefined;

    const seed = readProjectSeed();
    setProjects(seed);
    setDiscovering(true);

    const timeout = setTimeout(() => {
      timeoutCause = DISCOVERY_TIMED_OUT;
      controller.abort();
      // The bound is the UI's own deadline: end the wait even if the request itself never settles
      // (a joined entry owned by a signal-less caller is not ours to abort).
      if (!cancelled) {
        setDiscovering(false);
        setLoadError({ kind: "timeout" });
      }
    }, PROJECT_DISCOVERY_TIMEOUT_MS);

    const forceFresh = discoveryNonce > 0;
    void Promise.all([
      fetchProjectsAcrossNodes({ signal: controller.signal, forceFresh }),
      fetchProjects({ signal: controller.signal }),
    ])
      .then(([all, local]) => {
        if (cancelled) return;
        // Local = present in the LOCAL registry listing. Entries only reachable across nodes are
        // `_sourceNodeName`-stamped remote views of another install's registry.
        const localIds = new Set(local.map((p) => p.id));
        const merged: ProjectInfoWithSource[] = all.map((p) =>
          localIds.has(p.id) ? { ...p, _sourceNodeName: undefined } : p,
        );
        setProjects(merged);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          timeoutCause === DISCOVERY_TIMED_OUT
            ? { kind: "timeout" }
            : { kind: "failed", message: err instanceof Error ? err.message : String(err) },
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) setDiscovering(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [open, discoveryNonce]);

  useEffect(() => {
    if (open) cancelButtonRef.current?.focus();
  }, [open]);

  /*
  FNXC:CrossProjectHandoff 2026-09-10-19:19 (RUFU-211):
  Whether the hosted picker's dropdown is currently open — i.e. whether this dialog must YIELD Escape.
  It lives in a REF, not state: the Escape effect below deliberately keeps its `[open, onClose]` deps,
  and a state value read inside that handler without being added to them would capture the initial
  `false` for the life of the listener and silently restore the one-keystroke collapse this removes.
  A callback writing a ref has nothing to go stale, and `ProjectSelector` reports `false` on unmount so
  the flag can never strand this dialog unclosable.
  */
  const pickerDropdownOpenRef = useRef(false);
  const handlePickerOpenChange = useCallback((dropdownOpen: boolean) => {
    pickerDropdownOpenRef.current = dropdownOpen;
  }, []);

  useEffect(() => {
    if (!open) {
      // A fresh open must never inherit a yield from a previous session of this dialog.
      pickerDropdownOpenRef.current = false;
      return;
    }
    /*
    FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
    CAPTURE phase on purpose. This picker is hosted INSIDE other overlays (task detail keeps its own
    document-level Escape → close-modal listener), and `stopPropagation()` from a second BUBBLE-phase
    listener on the same node cannot preempt a listener the host registered earlier — same node and
    same phase run in registration order, and the host registered first. A capture-phase listener on
    the same node runs before every bubble listener, so Escape collapses exactly one layer: the
    picker closes, the card behind it stays open.

    FNXC:CrossProjectHandoff 2026-09-10-19:19 (RUFU-211):
    That same ordering now runs against this dialog's OWN picker, which claims Escape at document
    capture and registers after us (a dropdown can only open once this dialog is open), so standing
    our ground here would close the dialog with the dropdown. While the dropdown is open we return
    without touching the event — no `preventDefault`, no `stopPropagation` — so the picker's claim is
    the one that consumes the keystroke and the card behind still never sees it.
    */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pickerDropdownOpenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
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

  /*
  FNXC:CrossProjectHandoff 2026-09-10-18:25 (RUFU-211):
  The spinner is derived from "a request is outstanding AND there is nothing to act on", not from a
  bare in-flight flag. That precedence is the actual defect: rendering the spinner (and, behind it,
  an error branch) whenever a request is pending made a never-settling read un-recoverable and — once
  the bound existed — would have hidden the seeded candidates behind a spinner. With a warm cache the
  operator keeps selectable targets while discovery refreshes; without one they get the spinner only
  until the bound, then the named error row plus Retry.
  */
  const loading = discovering && selectableProjects.length === 0;

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
            {/*
            FNXC:CrossProjectHandoff 2026-09-10-18:25 (RUFU-211):
            Render precedence is load-bearing, not cosmetic. A chosen target outranks both transient
            rows (a later retry failure must not hide the target the operator already picked, which is
            what `canSubmit` gates on); the spinner only owns the screen while there is nothing to
            select; and the error row renders *above* the picker instead of replacing it, so a
            discovered-then-failed refresh leaves seeded candidates usable. `loadError` clears on a
            successful load, never when Retry is clicked, so a seeded picker keeps its message and the
            button keeps reporting `aria-busy` through the retry; with nothing to select the spinner
            takes the screen again for the retry's own bounded wait (the re-armed deadline is the same
            `PROJECT_DISCOVERY_TIMEOUT_MS`, so a retry can hang no longer than the first attempt).
            */}
            {selected ? (
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
            ) : loading ? (
              <div className="task-transfer-modal__loading" role="status" data-testid="task-transfer-loading">
                {t("taskDetail.transfer.loadingProjects", "Loading projects…")}
              </div>
            ) : (
              <>
                {loadError ? (
                  <div className="task-transfer-modal__error" role="alert" data-testid="task-transfer-load-error">
                    <span>
                      {loadError.kind === "timeout"
                        ? t(
                            "taskDetail.transfer.loadProjectsTimedOut",
                            "Still waiting on the project list — the server has not answered. Try again.",
                          )
                        : t("taskDetail.transfer.loadProjectsFailed", "Could not load the project list: {{error}}", {
                            error: loadError.message,
                          })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-busy={discovering}
                      onClick={() => setDiscoveryNonce((nonce) => nonce + 1)}
                      data-testid="task-transfer-retry"
                    >
                      {t("common.retry", "Retry")}
                    </button>
                  </div>
                ) : null}
                {selectableProjects.length > 0 || !loadError ? (
                  <ProjectSelector
                    projects={selectableProjects}
                    currentProject={null}
                    onSelect={(project) => setSelected(project)}
                    triggerLabel={t("taskDetail.transfer.selectProject", "Select target project…")}
                    getDisabledReason={getDisabledReason}
                    onOpenChange={handlePickerOpenChange}
                    allowSingleProject
                  />
                ) : null}
              </>
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
