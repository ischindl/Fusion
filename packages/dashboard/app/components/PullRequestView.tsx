import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitPullRequest,
  GitMerge,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ExternalLink,
  RotateCcw,
  ThumbsUp,
  MessageSquare,
} from "lucide-react";
import { api } from "../api";
import { ViewHeader } from "./ViewHeader";
import "./PullRequestView.css";

// Mirrors the route's serialized entity (register-pull-requests-routes.ts).
export type PrThread = {
  prEntityId: string;
  threadId: string;
  headOid: string;
  outcome: "fixed" | "disagreed" | "pending";
  fixCommitSha?: string;
  updatedAt: number;
};

export type PrSummary = {
  mergeable: string;
  reviewDecision: string | null;
  checksRollup: string;
  conflicting: boolean;
  autoMerge: boolean;
  autoMergeReason: string;
  autoMergeReady: boolean;
  actionable: boolean;
  active: boolean;
  pendingThreads: number;
  disagreedThreads: number;
};

export type PrDetail = {
  id: string;
  sourceType: "task" | "branch-group";
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch?: string;
  state: "creating" | "open" | "responding" | "merged" | "closed" | "failed";
  prNumber?: number;
  prUrl?: string;
  mergeable?: string;
  checksRollup?: string;
  reviewDecision?: string | null;
  autoMerge: boolean;
  unverified: boolean;
  failureReason?: string;
  responseRounds: number;
  threads: PrThread[];
  summary: PrSummary;
};

type ActionKind = "approve" | "merge" | "retry" | "close" | "automerge" | "retry-create";

export interface PullRequestViewProps {
  /** When provided, render this detail directly (tests / parent-supplied data). */
  detail?: PrDetail | null;
  /** Entity id to self-fetch when `detail` is not provided. */
  pullRequestId?: string;
  projectId?: string;
  /** Override the action dispatcher (tests). Defaults to the POST routes. */
  onAction?: (kind: ActionKind, id: string, body?: Record<string, unknown>) => Promise<PrDetail>;
  /** Override the fetcher (tests). */
  loadPullRequest?: (id: string) => Promise<PrDetail>;
}

function defaultLoad(projectId?: string) {
  return async (id: string): Promise<PrDetail> => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const res = await api<{ pullRequest: PrDetail }>(`/pull-requests/${id}${q}`);
    return res.pullRequest;
  };
}

function defaultAction(projectId?: string) {
  return async (kind: ActionKind, id: string, body?: Record<string, unknown>): Promise<PrDetail> => {
    const path = kind === "automerge" ? "automerge" : kind;
    const res = await api<{ pullRequest: PrDetail }>(`/pull-requests/${id}/${path}`, {
      method: "POST",
      body: JSON.stringify({ ...(body ?? {}), ...(projectId ? { projectId } : {}) }),
      headers: { "content-type": "application/json" },
    });
    return res.pullRequest;
  };
}

function ChecksIcon({ rollup }: { rollup: string }) {
  if (rollup === "success") return <CheckCircle size={14} className="pr-icon-success" />;
  if (rollup === "failure") return <XCircle size={14} className="pr-icon-failure" />;
  if (rollup === "pending") return <Clock size={14} className="pr-icon-pending" />;
  return <span className="pr-icon-none">—</span>;
}

export function PullRequestView(props: PullRequestViewProps) {
  const { t } = useTranslation("app");
  const { detail: detailProp, pullRequestId, projectId, onAction, loadPullRequest } = props;
  const [detail, setDetail] = useState<PrDetail | null>(detailProp ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  // FNXC:PullRequests 2026-06-23-00:45: `loading` is true ONLY while a fetch is in flight. Previously detail===null always rendered the spinner, so with no pullRequestId (nothing to load) the view hung on "Loading PR…" forever. Now no-id → empty state, and the fetch is time-bounded so a hung request surfaces an error instead of spinning indefinitely.
  const [loading, setLoading] = useState(false);

  const load = loadPullRequest ?? defaultLoad(projectId);
  const dispatch = onAction ?? defaultAction(projectId);

  const refresh = useCallback(async () => {
    if (detailProp) {
      setDetail(detailProp);
      return;
    }
    if (!pullRequestId) {
      // Nothing to load — show the empty state, never an indefinite spinner.
      setError(null);
      setLoading(false);
      setDetail(null);
      return;
    }
    try {
      setError(null);
      setLoading(true);
      // Time-bound the fetch (15s) so a hung request resolves into an error state.
      const PR_LOAD_TIMEOUT_MS = 15000;
      const timeout = new Promise<PrDetail>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out loading pull request")), PR_LOAD_TIMEOUT_MS),
      );
      setDetail(await Promise.race([load(pullRequestId), timeout]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PR");
    } finally {
      setLoading(false);
    }
  }, [detailProp, pullRequestId, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates: re-poll on the store-event / SSE channel the rest of the app
  // uses. We listen for the lightweight "store-changed" window event the SSE
  // bridge dispatches; each tick re-reads authoritative state from the route.
  useEffect(() => {
    if (detailProp || !pullRequestId) return;
    const handler = () => void refresh();
    window.addEventListener("fusion:store-changed", handler);
    return () => window.removeEventListener("fusion:store-changed", handler);
  }, [detailProp, pullRequestId, refresh]);

  const runAction = useCallback(
    async (kind: ActionKind, body?: Record<string, unknown>) => {
      if (!detail) return;
      try {
        setBusy(kind);
        setError(null);
        const fresh = await dispatch(kind, detail.id, body);
        setDetail(fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Action ${kind} failed`);
      } finally {
        setBusy(null);
        setConfirmingMerge(false);
      }
    },
    [detail, dispatch],
  );

  if (error && !detail) {
    return (
      <div className="pr-view pr-view--error" data-testid="pr-view-error">
        <AlertTriangle size={16} /> {error}
      </div>
    );
  }
  if (!detail) {
    // FNXC:PullRequests 2026-06-23-00:45: Only show the spinner while actually fetching; otherwise (no PR id / nothing to load / timed out) show the empty state so the view never hangs on an endless "Loading PR…".
    if (loading) {
      return (
        <div className="pr-view pr-view--loading" data-testid="pr-view-loading">
          {t("pr.view.loading", "Loading PR…")}
        </div>
      );
    }
    return (
      <div className="pr-view pr-view--empty" data-testid="pr-view-empty">
        <GitPullRequest size={16} /> {t("pr.view.empty", "No pull request to show.")}
      </div>
    );
  }

  const { state, summary } = detail;

  /*
  FNXC:PullRequests 2026-06-22-01:00:
  Added the shared ViewHeader (GitPullRequest icon, matching the left-sidebar nav) at the top of every populated PR state so the view reads consistently with other main-content views. The PR-specific identity row (repo/number/branch/state) stays below it. ViewHeader supplies the standard --space-lg top/side padding; the view body must not repeat the top padding.
  */
  const viewHeader = <ViewHeader icon={GitPullRequest} title={t("pr.view.title", "Pull Requests")} />;

  // ── creating ───────────────────────────────────────────────────────────────
  if (state === "creating") {
    return (
      <div className="pr-view" data-testid="pr-view" data-state="creating">
        {viewHeader}
        <PrIdentityHeader detail={detail} />
        <div className="pr-placeholder" data-testid="pr-creating">
          <Clock size={16} /> {t("pr.view.creating", "Creating PR…")}
        </div>
      </div>
    );
  }

  // ── failed ───────────────────────────────────────────────────────────────
  if (state === "failed") {
    return (
      <div className="pr-view" data-testid="pr-view" data-state="failed">
        {viewHeader}
        <PrIdentityHeader detail={detail} />
        <div className="pr-error-reason" data-testid="pr-failed">
          <AlertTriangle size={16} className="pr-icon-failure" />
          <span>{detail.failureReason ?? t("pr.view.creationFailed", "PR creation failed")}</span>
        </div>
        <div className="pr-action-bar">
          <button
            type="button"
            className="pr-action pr-action--retry"
            data-testid="pr-retry-create"
            disabled={busy === "retry-create"}
            onClick={() => void runAction("retry-create")}
          >
            <RotateCcw size={14} /> {t("pr.view.retryCreation", "Retry PR creation")}
          </button>
        </div>
        {error && <div className="pr-inline-error">{error}</div>}
      </div>
    );
  }

  // ── unverified ─────────────────────────────────────────────────────────────
  if (detail.unverified) {
    return (
      <div className="pr-view" data-testid="pr-view" data-state="unverified">
        {viewHeader}
        <PrIdentityHeader detail={detail} />
        <div className="pr-notice pr-notice--unverified" data-testid="pr-unverified">
          <Clock size={16} /> {t("pr.view.verifyingGithub", "Verifying with GitHub…")}
        </div>
        <div className="pr-action-bar">
          <button
            type="button"
            className="pr-action"
            data-testid="pr-merge"
            disabled
            title={t("pr.view.mergeDisabledUntilVerified", "Merge is disabled until GitHub verifies this PR")}
          >
            <GitMerge size={14} /> {t("pr.view.merge", "Merge")}
          </button>
        </div>
        {/* checks/threads hidden while unverified */}
      </div>
    );
  }

  const conflicting = summary.conflicting;

  return (
    <div className="pr-view" data-testid="pr-view" data-state={state}>
      {viewHeader}
      <PrIdentityHeader detail={detail} />

      {/* responding banner */}
      {state === "responding" && (
        <div className="pr-banner pr-banner--responding" data-testid="pr-responding">
          <MessageSquare size={16} /> {t("pr.view.responsePending", "Response run in progress — {{count}} threads pending", { count: summary.pendingThreads })}
        </div>
      )}

      {/* ── action bar ──────────────────────────────────────────────────── */}
      <div className="pr-action-bar" data-testid="pr-action-bar">
        <button
          type="button"
          className="pr-action pr-action--approve"
          data-testid="pr-approve"
          disabled={state === "responding" || busy === "approve"}
          onClick={() => void runAction("approve")}
        >
          <ThumbsUp size={14} /> {t("pr.view.approve", "Approve")}
        </button>
        <button
          type="button"
          className="pr-action pr-action--retry"
          data-testid="pr-retry"
          disabled={state === "responding" || busy === "retry"}
          title={state === "responding" ? t("pr.view.responseAlreadyInProgress", "A response run is already in progress") : undefined}
          onClick={() => void runAction("retry")}
        >
          <RotateCcw size={14} /> {t("pr.view.requestRetry", "Request retry")}
        </button>
        {!confirmingMerge ? (
          <button
            type="button"
            className="pr-action pr-action--merge"
            data-testid="pr-merge"
            disabled={conflicting || state === "responding" || busy === "merge"}
            title={conflicting ? t("pr.view.resolveConflictsBeforeMerge", "Resolve conflicts on GitHub before merging") : undefined}
            onClick={() => setConfirmingMerge(true)}
          >
            <GitMerge size={14} /> {t("pr.view.merge", "Merge")}
          </button>
        ) : (
          <button
            type="button"
            className="pr-action pr-action--merge-confirm"
            data-testid="pr-merge-confirm"
            disabled={busy === "merge"}
            onClick={() => void runAction("merge")}
          >
            <GitMerge size={14} /> {t("pr.view.confirmMerge", "Confirm merge")}
          </button>
        )}
        <button
          type="button"
          className="pr-action pr-action--close"
          data-testid="pr-close"
          disabled={busy === "close"}
          onClick={() => void runAction("close")}
        >
          <XCircle size={14} /> {t("pr.view.close", "Close")}
        </button>

        <label className="pr-automerge-toggle" data-testid="pr-automerge">
          <input
            type="checkbox"
            checked={detail.autoMerge}
            disabled={busy === "automerge"}
            onChange={(e) => void runAction("automerge", { enabled: e.target.checked })}
          />
          <span>{t("pr.view.autoMerge", "Auto-merge")}</span>
          <span className="pr-automerge-gate" data-testid="pr-automerge-gate">
            {summary.autoMergeReason}
          </span>
        </label>
      </div>

      {/* conflict link */}
      {conflicting && detail.prUrl && (
        <a
          className="pr-conflict-link"
          data-testid="pr-conflict-link"
          href={detail.prUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("pr.view.resolveConflictsOnGithub", "Resolve conflicts on GitHub")} <ExternalLink size={12} />
        </a>
      )}

      {/* ── merge-readiness summary ─────────────────────────────────────── */}
      <div className="pr-summary" data-testid="pr-summary">
        <span className="pr-summary-item" data-testid="pr-summary-mergeable">
          {t("pr.view.mergeableLabel", "Mergeable:")} {summary.mergeable}
        </span>
        <span className="pr-summary-item" data-testid="pr-summary-review">
          {t("pr.view.reviewLabel", "Review:")} {summary.reviewDecision ?? t("pr.view.none", "none")}
        </span>
        <span className="pr-summary-item" data-testid="pr-summary-checks">
          <ChecksIcon rollup={summary.checksRollup} /> {summary.checksRollup}
        </span>
      </div>

      {/* ── threads (agent replies nested) ───────────────────────────────── */}
      <div className="pr-threads" data-testid="pr-threads">
        {detail.threads.length === 0 ? (
          <div className="pr-threads-empty">{t("pr.view.noReviewThreads", "No review threads.")}</div>
        ) : (
          detail.threads.map((thread) => (
            <div
              key={`${thread.threadId}:${thread.headOid}`}
              className={`pr-thread pr-thread--${thread.outcome} ${
                thread.outcome === "disagreed" ? "pr-thread--agent-disagreement" : ""
              }`}
              data-testid={`pr-thread-${thread.outcome}`}
              data-agent-disagreement={thread.outcome === "disagreed" ? "true" : "false"}
            >
              <div className="pr-thread-head">
                {thread.outcome === "pending" && (
                  <span className="pr-thread-pending">
                    <Clock size={12} /> {t("pr.view.threadPending", "pending")}
                  </span>
                )}
                {thread.outcome === "disagreed" && (
                  <span className="pr-thread-disagreed">
                    <AlertTriangle size={12} /> {t("pr.view.agentDisagreed", "agent disagreed")}
                  </span>
                )}
                {thread.outcome === "fixed" && (
                  <span className="pr-thread-fixed">
                    <CheckCircle size={12} /> {t("pr.view.threadFixed", "fixed")}
                  </span>
                )}
                <span className="pr-thread-id">{thread.threadId}</span>
              </div>
              {thread.fixCommitSha && (
                <div className="pr-thread-reply" data-testid="pr-thread-reply">
                  {t("pr.view.agentReplyFix", "Agent reply — fix {{sha}}", { sha: thread.fixCommitSha.slice(0, 8) })}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {error && <div className="pr-inline-error">{error}</div>}
    </div>
  );
}

function PrIdentityHeader({ detail }: { detail: PrDetail }) {
  return (
    <div className="pr-identity" data-testid="pr-identity">
      <GitPullRequest size={16} />
      <span className="pr-identity-repo">{detail.repo}</span>
      {detail.prNumber != null ? (
        detail.prUrl ? (
          <a className="pr-identity-number" href={detail.prUrl} target="_blank" rel="noopener noreferrer">
            #{detail.prNumber} <ExternalLink size={12} />
          </a>
        ) : (
          <span className="pr-identity-number">#{detail.prNumber}</span>
        )
      ) : null}
      <span className="pr-identity-branch">{detail.headBranch}</span>
      <span className={`pr-identity-state pr-identity-state--${detail.state}`}>{detail.state}</span>
    </div>
  );
}
