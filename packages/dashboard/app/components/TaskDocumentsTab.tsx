import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FileText, ChevronDown, ChevronUp, Plus, Trash2, History } from "lucide-react";
import "./DocumentsView.css";
import "./TaskDocumentsTab.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArtifactWithTask, Task, TaskDocument, TaskDocumentRevision } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import {
  fetchTaskDocuments,
  fetchTaskDocumentRevisions,
  putTaskDocument,
  deleteTaskDocument,
  artifactMediaUrlWithToken,
} from "../api";
import { useArtifacts } from "../hooks/useArtifacts";
import { LoadingSpinner } from "./LoadingSpinner";
import { ArtifactMedia, getArtifactTypeLabel } from "./ArtifactMedia";
import { ArtifactImageViewer } from "./ArtifactImageViewer";

// Document key validation: alphanumeric, hyphens, underscores, 1-64 chars
const DOCUMENT_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONTENT_PREVIEW = 200;
const TASK_DOCUMENTS_MARKDOWN_TOGGLE_STORAGE_KEY = "fusion.taskDocuments.renderMarkdown";

function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore storage failures (quota, private mode, etc.)
  }
}

interface TaskDocumentsTabProps {
  taskId: string;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
  projectId?: string;
  canEdit?: boolean;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function getContentPreview(content: string, maxLength: number = MAX_CONTENT_PREVIEW): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + "…";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TaskArtifactCardProps {
  artifact: ArtifactWithTask;
  projectId?: string;
  onExpandImage: (artifact: ArtifactWithTask) => void;
}

function TaskArtifactCard({ artifact, projectId, onExpandImage }: TaskArtifactCardProps) {
  const { t } = useTranslation("app");
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");

  const typeLabel = getArtifactTypeLabel(t, artifact.type);

  /*
  FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): a retracted artifact renders as a VOID tile, and the
  tile deliberately renders LESS than a live one.

  - No media element and no media URL at all. The URL helper is called BELOW this branch rather than above it:
    computing it here would hand a tokenized URL for the withdrawn bytes to a component that only declines to
    use it, and that URL is exactly the artifact of this feature - reachable, cacheable, and screencappable.
    A broken `img` would also read as a rendering bug rather than a withdrawal.
  - The `description` is NOT shown. For a review artifact the description is claim text - the same kind of text
    that got the artifact retracted - and a VOID label is a thin defence against reading it as live evidence. The
    author is required to supply a reason, so the reason replaces the claim rather than sitting beside it. This
    matches what the agent-facing VOID view returns: header, reason, nothing else.
  - The retract line names the artifact's own author, not the retracting principal. The operator may retract any
    artifact, so "retracted by" would often name someone other than the party that withdrew the claim, which is
    the fact an operator is trying to read.

  The tile stays in the grid rather than disappearing, because the operator turned the filter on precisely to find
  tombstones: a VOID tile that rendered nothing would be indistinguishable from the hiding applied by default.
  */
  if (artifact.retractedAt) {
    return (
      <article
        className="document-card documents-artifact-card documents-artifact-card--void"
        aria-label={t("documents.voidArtifactLabel", "Retracted artifact {{title}}", { title })}
      >
        <div className="documents-artifact-preview documents-artifact-preview--void" aria-hidden="true">
          <span className="documents-artifact-void-mark">{t("documents.voidBadge", "VOID")}</span>
        </div>
        <div className="documents-artifact-body">
          <div className="documents-artifact-header">
            <span className="documents-artifact-void-badge">{t("documents.voidBadge", "VOID")}</span>
            <span className="documents-artifact-author">{artifact.authorId}</span>
          </div>
          <h5 className="documents-artifact-title documents-artifact-title--void">{title}</h5>
          <p className="documents-artifact-void-reason">
            {artifact.retractReason || t("documents.voidReasonMissing", "Retracted, with no reason recorded.")}
          </p>
          <div className="documents-artifact-meta">
            <span>{t("documents.voidRetractedOn", "Retracted {{when}}", { when: formatTimestamp(artifact.retractedAt) })}</span>
            <span>{typeLabel}</span>
          </div>
        </div>
      </article>
    );
  }

  const mediaUrl = artifactMediaUrlWithToken(artifact.id, projectId);
  const preview = artifact.content ? getContentPreview(artifact.content, 320) : artifact.description;

  return (
    <article className="document-card documents-artifact-card" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      {artifact.type === "image" ? (
        <button
          type="button"
          className="documents-artifact-preview documents-artifact-preview--expandable"
          onClick={() => onExpandImage(artifact)}
          aria-label={t("documents.expandImageArtifact", "Expand image artifact {{title}}", { title })}
        >
          <ArtifactMedia artifact={artifact} mediaUrl={mediaUrl} projectId={projectId} title={title} preview={preview} t={t} />
          <span className="documents-artifact-expand-hint">{t("documents.expandArtifactHint", "Click to expand")}</span>
        </button>
      ) : (
        <div className="documents-artifact-preview">
          <ArtifactMedia artifact={artifact} mediaUrl={mediaUrl} projectId={projectId} title={title} preview={preview} t={t} />
        </div>
      )}
      <div className="documents-artifact-body">
        <div className="documents-artifact-header">
          <span className="documents-artifact-type-badge">{typeLabel}</span>
          <span className="documents-artifact-author">{artifact.authorId}</span>
        </div>
        <h5 className="documents-artifact-title">{title}</h5>
        {artifact.description && <p className="documents-artifact-description">{artifact.description}</p>}
        <div className="documents-artifact-meta">
          <span>{formatTimestamp(artifact.createdAt)}</span>
          {artifact.sizeBytes !== undefined && <span>{formatFileSize(artifact.sizeBytes)}</span>}
        </div>
      </div>
    </article>
  );
}

interface RetractionFilterProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  t: TFunction<"app">;
}

/*
FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the retraction filter, hoisted to module scope because it is
rendered from two places - the artifacts section header, and the state where there is no artifacts section at all.

The second placement is what makes a tombstone discoverable on the card that most needs it: the card whose only
artifact was retracted has an empty visible list, so a control that lived only inside a list-populated section
would be unreachable exactly when the operator is wondering where an artifact went. Default-hidden must not
quietly become undiscoverable.

It is a component rather than duplicated markup, and it is module-scope rather than nested, because a component
declared inside the render would remount this checkbox on every parent update and lose focus mid-interaction.

A real checkbox, not a chip: the filter's state has to be legible to screen readers and keyboard users, and the
label repeats the word the tile carries (VOID) so control and badge tie together on wording alone.
*/
function RetractionFilter({ checked, onChange, t }: RetractionFilterProps) {
  return (
    <label className="task-artifacts-show-retracted">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{t("taskDocuments.showRetracted", "Show retracted (VOID)")}</span>
    </label>
  );
}

export function TaskDocumentsTab({
  taskId,
  addToast,
  onTaskUpdated: _onTaskUpdated,
  projectId,
  canEdit = false,
}: TaskDocumentsTabProps) {
  const { t } = useTranslation("app");
  const [documents, setDocuments] = useState<TaskDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDocKeys, setExpandedDocKeys] = useState<Set<string>>(() => new Set());
  const [revisionContentByKey, setRevisionContentByKey] = useState<Record<string, string>>({});
  /*
  FNXC:TaskDocumentCAS 2026-07-20-11:06:
  Task Detail captures the loaded revision/hash when editing begins and never replaces that baseline behind the draft. A 409 refreshes visible server state while retaining the editor and exact user draft on desktop and mobile; Save never silently retries a stale overwrite. New-document saves use revision zero so duplicate-key races are visible conflicts.

  FNXC:TaskDocumentCAS 2026-07-20-15:42:
  After a conflict, keep the refreshed revision/hash pending until the operator explicitly rebases the preserved draft. Disable Save during that decision so repeated clicks cannot resubmit the stale baseline or silently adopt a newer baseline.
  */
  const [editingDocKey, setEditingDocKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editPrecondition, setEditPrecondition] = useState<{ revision: number; contentHash: string } | null>(null);
  const [pendingEditRebase, setPendingEditRebase] = useState<{ revision: number; contentHash: string } | null>(null);
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<TaskDocumentRevision[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDocKey, setNewDocKey] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /*
   * FNXC:ArtifactRegistry 2026-07-11-00:00:
   * FN-7833 makes task Artifacts-tab documents readable without extra clicks: render Markdown by default and persist the operator's Markdown/Plain preference for future task document views.
   */
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(() => readBooleanPref(TASK_DOCUMENTS_MARKDOWN_TOGGLE_STORAGE_KEY, true));
  /*
   * FNXC:ArtifactRegistry 2026-06-29-00:00:
   * Task detail image artifacts must be viewable in-place from the task modal. Keep the expand target image-only so document, audio, video, and generic cards retain their current non-lightbox behavior without empty controls.
   */
  const [lightboxArtifact, setLightboxArtifact] = useState<ArtifactWithTask | null>(null);
  /*
  FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the gallery's retraction filter, deliberately OFF by
  default and deliberately not remembered between mounts. A retracted review artifact is merge-grade input that
  executors, reviewers and the operator read before deciding to merge, so the safe default is the one that hides
  it, and persisting an opted-in view would carry findable tombstones into the next session's merge decision.
  */
  const [showRetracted, setShowRetracted] = useState(false);
  const loadedTaskIdRef = useRef(taskId);
  const documentKeysRef = useRef<Set<string>>(new Set());
  const { artifacts, loading: artifactsLoading, error: artifactsError } = useArtifacts({ projectId, taskId, includeRetracted: showRetracted });

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await fetchTaskDocuments(taskId, projectId);
      const previousKeys = loadedTaskIdRef.current === taskId ? documentKeysRef.current : new Set<string>();
      const nextKeys = new Set(docs.map((doc) => doc.key));
      loadedTaskIdRef.current = taskId;
      documentKeysRef.current = nextKeys;
      setDocuments(docs);
      setExpandedDocKeys((current) => {
        const next = new Set<string>();
        for (const doc of docs) {
          if (current.has(doc.key) || !previousKeys.has(doc.key)) {
            next.add(doc.key);
          }
        }
        return next;
      });
      setRevisionContentByKey((current) => Object.fromEntries(Object.entries(current).filter(([key]) => nextKeys.has(key))));
      return docs;
    } catch (error) {
      addToast(getErrorMessage(error) || t("taskDocuments.failedToLoad", "Failed to load documents"), "error");
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [taskId, projectId, addToast]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    if (artifactsError) {
      addToast(artifactsError || t("taskDocuments.failedToLoadArtifacts", "Failed to load artifacts"), "error");
    }
  }, [addToast, artifactsError, t]);

  useEffect(() => {
    writeBooleanPref(TASK_DOCUMENTS_MARKDOWN_TOGGLE_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

  function handleExpandDocument(doc: TaskDocument) {
    const isExpanded = expandedDocKeys.has(doc.key);
    setExpandedDocKeys((current) => {
      const next = new Set(current);
      if (isExpanded) {
        next.delete(doc.key);
      } else {
        next.add(doc.key);
      }
      return next;
    });
    if (isExpanded) {
      if (editingDocKey === doc.key) {
        setEditingDocKey(null);
        setEditContent("");
        setEditPrecondition(null);
        setPendingEditRebase(null);
      }
      if (showHistory === doc.key) {
        setShowHistory(null);
        setRevisions([]);
      }
    }
  }

  async function handleToggleHistory(docKey: string) {
    if (showHistory === docKey) {
      setShowHistory(null);
      setRevisions([]);
    } else {
      setShowHistory(docKey);
      setLoadingRevisions(true);
      try {
        const revs = await fetchTaskDocumentRevisions(taskId, docKey, projectId);
        setRevisions(revs);
      } catch (error) {
        addToast(getErrorMessage(error) || t("taskDocuments.failedToLoadRevisions", "Failed to load revisions"), "error");
      } finally {
        setLoadingRevisions(false);
      }
    }
  }

  function handleStartEdit(doc: TaskDocument) {
    setEditingDocKey(doc.key);
    setEditContent(revisionContentByKey[doc.key] ?? doc.content);
    setEditPrecondition({ revision: doc.revision, contentHash: doc.contentHash });
    setPendingEditRebase(null);
  }

  function handleCancelEdit() {
    setEditingDocKey(null);
    setEditContent("");
    setEditPrecondition(null);
    setPendingEditRebase(null);
  }

  function handleRebaseEdit() {
    if (!pendingEditRebase) return;
    setEditPrecondition(pendingEditRebase);
    setPendingEditRebase(null);
  }

  async function handleSaveEdit() {
    if (!editingDocKey || !editContent.trim() || !editPrecondition || pendingEditRebase) return;
    setSaving(true);
    try {
      await putTaskDocument(taskId, editingDocKey, editContent, {
        expectedRevision: editPrecondition.revision,
        expectedContentHash: editPrecondition.contentHash,
      }, projectId);
      setEditingDocKey(null);
      setEditContent("");
      setEditPrecondition(null);
      setPendingEditRebase(null);
      setRevisionContentByKey((current) => {
        const next = { ...current };
        delete next[editingDocKey];
        return next;
      });
      await loadDocuments();
      addToast(t("taskDocuments.saved", "Document saved"), "success");
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 409) {
        const latestDocuments = await loadDocuments();
        const latest = latestDocuments?.find((doc) => doc.key === editingDocKey);
        if (latest) {
          setPendingEditRebase({ revision: latest.revision, contentHash: latest.contentHash });
          addToast(t("taskDocuments.staleCopy", "This document changed since you opened it. Your draft is preserved; review the latest revision, then choose Rebase draft before saving."), "error");
        }
      } else {
        addToast(getErrorMessage(error) || t("taskDocuments.failedToSave", "Failed to save document"), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDocument() {
    const key = newDocKey.trim();
    const content = newDocContent.trim();

    // Validate key
    if (!key) {
      addToast(t("taskDocuments.keyRequired", "Document key is required"), "error");
      return;
    }
    if (!DOCUMENT_KEY_REGEX.test(key)) {
      addToast(t("taskDocuments.invalidKeyFormat", "Invalid key format. Use 1-64 alphanumeric characters, hyphens, or underscores."), "error");
      return;
    }
    if (!content) {
      addToast(t("taskDocuments.contentRequired", "Content is required"), "error");
      return;
    }

    setSaving(true);
    try {
      await putTaskDocument(taskId, key, content, { expectedRevision: 0 }, projectId);
      setShowCreateForm(false);
      setNewDocKey("");
      setNewDocContent("");
      await loadDocuments();
      addToast(t("taskDocuments.created", "Document created"), "success");
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 409) {
        await loadDocuments();
        addToast(t("taskDocuments.keyAlreadyCreated", "A document with this key was created elsewhere. Your draft is preserved; choose a new key or rebase onto the current document."), "error");
      } else {
        addToast(getErrorMessage(error) || t("taskDocuments.failedToCreate", "Failed to create document"), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDocument(key: string) {
    setDeletingKey(key);
    try {
      await deleteTaskDocument(taskId, key, projectId);
      setConfirmDelete(null);
      setDeletingKey(null);
      setExpandedDocKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setRevisionContentByKey((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (showHistory === key) {
        setShowHistory(null);
        setRevisions([]);
      }
      await loadDocuments();
      addToast(t("taskDocuments.deleted", "Document deleted"), "success");
    } catch (error) {
      addToast(getErrorMessage(error) || t("taskDocuments.failedToDelete", "Failed to delete document"), "error");
    } finally {
      setDeletingKey(null);
    }
  }

  function handleViewRevision(docKey: string, revision: TaskDocumentRevision) {
    setRevisionContentByKey((current) => ({ ...current, [docKey]: revision.content }));
    setEditingDocKey(null);
    setEditContent("");
  }

  const handleExpandArtifactImage = useCallback((artifact: ArtifactWithTask) => setLightboxArtifact(artifact), []);
  const handleCloseLightbox = useCallback(() => setLightboxArtifact(null), []);

  if (loading || artifactsLoading) {
    return (
      <div className="detail-section">
        <h4>{t("taskDocuments.heading", "Artifacts")}</h4>
        <div className="detail-log-empty"><LoadingSpinner label={t("taskDocuments.loading", "Loading documents and artifacts…")} /></div>
      </div>
    );
  }

  /*
  FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): `!showRetracted` keeps the generic "nothing yet" line out
  of the way once the operator has asked to look for tombstones. With the filter on, an empty result is an answer
  to the question they just asked ("this card has no withdrawn artifacts"), and the generic line would answer a
  different question while looking like it answered that one.
  */
  const isEmpty = documents.length === 0 && artifacts.length === 0 && !showCreateForm && !showRetracted;

  return (
    <div className="detail-section">
      <h4>{t("taskDocuments.heading", "Artifacts")}</h4>

      {isEmpty && (
        <div className="detail-log-empty task-documents-empty-state">
          <span>{t("taskDocuments.noDocuments", "No documents or artifacts yet.")}</span>
          <RetractionFilter checked={showRetracted} onChange={setShowRetracted} t={t} />
        </div>
      )}

      {/*
       * FNXC:ArtifactRegistry 2026-06-21-21:44:
       * The per-task Artifacts tab must surface both traditional task documents and agent-created media artifacts so users can inspect all task-scoped outputs without leaving the task modal.
       *
       * FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the section stays gated on having something to
       * show - an empty "Media artifacts" block on every documents-only card would be noise - and the retraction
       * filter reaches that card through the empty state above instead, so hiding the section never hides the
       * control.
       */}
      {(artifacts.length > 0 || showRetracted) && (
        <section className="task-artifacts-section" aria-labelledby="task-artifacts-heading">
          <div className="task-artifacts-section-header">
            <h5 id="task-artifacts-heading">{t("taskDocuments.artifactsSubheading", "Media artifacts")}</h5>
            <div className="task-artifacts-section-tools">
              <span className="task-artifacts-section-count">{t("taskDocuments.artifactCount", "{{count}} artifact{{plural}}", { count: artifacts.length, plural: artifacts.length === 1 ? "" : "s" })}</span>
              <RetractionFilter checked={showRetracted} onChange={setShowRetracted} t={t} />
            </div>
          </div>
          <div className="documents-artifact-gallery documents-artifact-gallery--mobile task-artifacts-gallery">
            {/*
            FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the section only renders with a populated list or
            with the filter on, so an empty list here always means "looked, found none" - and the line says that
            rather than the generic "nothing yet", which would erase the retraction the operator just asked about.
            */}
            {artifacts.length === 0 && (
              <div className="detail-log-empty">
                {t("taskDocuments.noRetractedArtifacts", "No retracted artifacts on this task.")}
              </div>
            )}
            {artifacts.map((artifact) => (
              <TaskArtifactCard key={artifact.id} artifact={artifact} projectId={projectId} onExpandImage={handleExpandArtifactImage} />
            ))}
          </div>
        </section>
      )}

      <section className="task-documents-section" aria-labelledby="task-documents-heading">
        <div className="task-artifacts-section-header">
          <h5 id="task-documents-heading">{t("taskDocuments.documentsSubheading", "Task documents")}</h5>
          {documents.length > 0 && (
            <span className="task-artifacts-section-count">{t("taskDocuments.documentCount", "{{count}} document{{plural}}", { count: documents.length, plural: documents.length === 1 ? "" : "s" })}</span>
          )}
        </div>

      {/* Create Form */}
      {showCreateForm && (
        <div className="task-document-create-form">
          <h5>{t("taskDocuments.newDocumentTitle", "New Document")}</h5>
          <div className="form-group">
            <label htmlFor="doc-key">{t("taskDocuments.keyLabel", "Key")}</label>
            <input
              id="doc-key"
              type="text"
              className="task-document-key-input"
              value={newDocKey}
              onChange={(e) => setNewDocKey(e.target.value)}
              placeholder={t("taskDocuments.keyPlaceholder", "e.g., plan, notes, research")}
              disabled={saving}
            />
            <span className="form-hint">{t("taskDocuments.keyHint", "Alphanumeric, hyphens, underscores (1-64 chars)")}</span>
          </div>
          <div className="form-group">
            <label htmlFor="doc-content">{t("taskDocuments.contentLabel", "Content")}</label>
            <textarea
              id="doc-content"
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              rows={6}
              placeholder={t("taskDocuments.contentPlaceholder", "Enter document content…")}
              disabled={saving}
            />
          </div>
          <div className="form-actions">
            <button
              className="btn btn-sm"
              onClick={() => {
                setShowCreateForm(false);
                setNewDocKey("");
                setNewDocContent("");
              }}
              disabled={saving}
            >
              {t("taskDocuments.cancel", "Cancel")}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleCreateDocument()}
              disabled={saving || !newDocKey.trim() || !newDocContent.trim()}
            >
              {saving ? t("taskDocuments.creating", "Creating…") : t("taskDocuments.create", "Create")}
            </button>
          </div>
        </div>
      )}

      {/* Document List */}
      {documents.length === 0 && !showCreateForm ? (
        !isEmpty && (
          <div className="detail-log-empty">
            {t("taskDocuments.noTaskDocuments", "No task documents yet.")}
          </div>
        )
      ) : (
        <div className="task-documents-list">
          {documents.map((doc) => {
            const isExpanded = expandedDocKeys.has(doc.key);
            const displayedContent = revisionContentByKey[doc.key] ?? doc.content;

            return (
            <div key={doc.key} className="task-document-card">
              <div className="task-document-card-header">
                <div className="task-document-card-title">
                  <FileText size={14} />
                  <span className="task-document-key">{doc.key}</span>
                  <span className="task-document-revision-badge">v{doc.revision}</span>
                </div>
                <div className="task-document-meta">
                  <span className="task-document-author">{doc.author}</span>
                  <span className="task-document-timestamp">{formatTimestamp(doc.updatedAt || doc.createdAt)}</span>
                </div>
              </div>

              {/* Expanded Content View */}
              {isExpanded && editingDocKey !== doc.key && (
                <>
                  <div className="task-document-content-header">
                    <button
                      className="btn btn-sm document-mode-toggle"
                      onClick={() => setRenderMarkdown((prev) => !prev)}
                      aria-label={renderMarkdown ? t("taskDocuments.switchToPlainText", "Switch to plain text") : t("taskDocuments.switchToMarkdown", "Switch to markdown")}
                      aria-pressed={renderMarkdown}
                      title={renderMarkdown ? t("taskDocuments.switchToPlainText", "Switch to plain text") : t("taskDocuments.switchToMarkdown", "Switch to markdown")}
                    >
                      {renderMarkdown ? t("taskDocuments.modeMarkdown", "Markdown") : t("taskDocuments.modePlain", "Plain")}
                    </button>
                  </div>
                  <div className="task-document-content">
                    {renderMarkdown ? (
                      <div className="task-document-content-markdown">
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayedContent}</ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <pre className="task-document-content-text">{displayedContent}</pre>
                    )}
                  </div>

                  {/* Revision History */}
                  {showHistory === doc.key && (
                    <div className="task-document-revisions">
                      <h5>{t("taskDocuments.revisionHistory", "Revision History")}</h5>
                      {loadingRevisions ? (
                        <div className="detail-log-empty"><LoadingSpinner label={t("taskDocuments.loadingRevisions", "Loading…")} /></div>
                      ) : revisions.length <= 1 ? (
                        <div className="detail-log-empty">{t("taskDocuments.noPreviousRevisions", "No previous revisions.")}</div>
                      ) : (
                        <div className="task-document-revision-list">
                          {revisions
                            .filter((r) => r.revision < doc.revision)
                            .sort((a, b) => b.revision - a.revision)
                            .map((revision) => (
                              <div
                                key={revision.id}
                                className="task-document-revision-item"
                                onClick={() => handleViewRevision(doc.key, revision)}
                              >
                                <div className="revision-header">
                                  <span className="revision-badge">v{revision.revision}</span>
                                  <span className="revision-author">{revision.author}</span>
                                  <span className="revision-timestamp">{formatTimestamp(revision.createdAt)}</span>
                                </div>
                                <div className="revision-preview">{getContentPreview(revision.content, 100)}</div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Editing View */}
              {editingDocKey === doc.key && (
                <div className="task-document-edit-form">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={10}
                    disabled={saving}
                  />
                  <div className="form-actions">
                    <button className="btn btn-sm" onClick={handleCancelEdit} disabled={saving}>
                      {t("taskDocuments.cancel", "Cancel")}
                    </button>
                    {pendingEditRebase && (
                      <button className="btn btn-sm" onClick={handleRebaseEdit} disabled={saving}>
                        {t("taskDocuments.rebaseDraft", "Rebase draft")}
                      </button>
                    )}
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleSaveEdit()}
                      disabled={saving || !editContent.trim() || pendingEditRebase !== null}
                    >
                      {saving ? t("taskDocuments.saving", "Saving…") : t("taskDocuments.save", "Save")}
                    </button>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="task-document-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => handleExpandDocument(doc)}
                >
                  {isExpanded ? (
                    <>
                      <ChevronUp size={14} /> {t("taskDocuments.collapse", "Collapse")}
                    </>
                  ) : (
                    <>
                      <ChevronDown size={14} /> {t("taskDocuments.expand", "Expand")}
                    </>
                  )}
                </button>

                {isExpanded && (
                  <>
                    <button
                      className="btn btn-sm"
                      onClick={() => void handleToggleHistory(doc.key)}
                    >
                      <History size={14} /> {t("taskDocuments.history", "History")}
                    </button>

                    {canEdit && editingDocKey !== doc.key && (
                      <button className="btn btn-sm" onClick={() => handleStartEdit(doc)}>
                        {t("taskDocuments.edit", "Edit")}
                      </button>
                    )}

                    {canEdit && (
                      confirmDelete === doc.key ? (
                        <div className="confirm-delete-actions">
                          <span>{t("taskDocuments.deleteConfirm", "Delete?")}</span>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void handleDeleteDocument(doc.key)}
                            disabled={deletingKey === doc.key}
                          >
                            {deletingKey === doc.key ? "…" : t("taskDocuments.yes", "Yes")}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => setConfirmDelete(null)}
                            disabled={deletingKey === doc.key}
                          >
                            {t("taskDocuments.no", "No")}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmDelete(doc.key)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* New Document Button */}
      {canEdit && !showCreateForm && (
        <button
          className="btn btn-sm task-document-new-btn"
          onClick={() => setShowCreateForm(true)}
        >
          <Plus size={14} /> {t("taskDocuments.newDocumentButton", "New Document")}
        </button>
      )}
      </section>

      {lightboxArtifact && <ArtifactImageViewer artifactId={lightboxArtifact.id} title={lightboxArtifact.title || t("documents.untitledArtifact", "Untitled artifact")} projectId={projectId} onClose={handleCloseLightbox} />}
    </div>
  );
}
