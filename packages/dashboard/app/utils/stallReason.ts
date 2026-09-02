import type { TFunction } from "i18next";
import type { Task, TaskExternalBlock } from "@fusion/core";
import { formatTaskExternalBlockReason } from "@fusion/core";
import { elapsedSinceMs } from "./dataFreshness";
import { getInReviewStallCopy } from "./inReviewStallCopy";
import { getStalePausedReviewCopy } from "./stalePausedReviewCopy";

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Before this module every dashboard surface (TaskCard, ListView, TaskDetailModal, the agent-health
pill) carried its OWN copy of "why is this card not moving". The card inferred it from a chain of
inline ternaries over task.paused / pausedReason / pausedByAgentId / status; the list carried a
different one; the detail modal carried a third. That meant:
  (a) a plain queued card surfaced a stall banner it should never have shown (queued is a normal
      resting state, not a stall),
  (b) an unexplained paused todo-column card showed a bare "paused" badge and nothing on its face
      naming WHY it was paused,
  (c) a dependency-blocked card named the blocking task only in a hover tooltip, never on the face,
  (d) a paused card in the detail view had no column-independent banner (the existing review banners
      are keyed to the review lane),
  (e) a paused-by-agent card with no reason string showed the bare word "paused".
This module is the single classifier for the question "why isn't this card moving?". It is a PURE,
browser-safe function: no engine import, no node builtin, no Date.now() (age flows through
elapsedSinceMs with the caller's dataAsOfMs so every surface agrees on "now"). Given a subject plus a
context (which carries the surface's `t`, so copy stays localized per-surface), it returns the first
stall that applies, or `undefined` when the card is flowing. Surfaces keep their own gating for WHICH
stalls they render and whether a dedicated affordance already covers a code — the resolver is the
authority for WHAT the reason is and its human-readable copy, not for the visibility decision.

Precedence (first match wins) is deliberately ordered by "most externally-forced / most operator-
actionable" so a card that is simultaneously, say, externally blocked AND paused reports the
external block (the thing that actually must be fixed) rather than the incidental pause the block
itself wrote:
  external-block -> duplicate-decision -> agent-paused -> user-paused -> engine-paused
  -> agent-approval -> wedge -> dependency-block -> overlap-block -> merge-blocker
  -> completion-blocker -> in-review-stall -> stalled-review -> stale-paused-review -> failed -> queued

NOTE: an external block WRITES paused:true + pausedReason:"external-block" onto the task
(buildTaskExternalBlockPatch), so external-block MUST be evaluated before the paused family or the
card would misreport a freeze as a pause. That ordering is load-bearing, not stylistic.
*/

/** Every stall classification the resolver can emit. */
export type StallReasonCode =
  | "external-block"
  | "duplicate-decision"
  | "agent-paused"
  | "user-paused"
  | "engine-paused"
  | "agent-approval"
  | "wedge"
  | "dependency-block"
  | "overlap-block"
  | "merge-blocker"
  | "completion-blocker"
  | "in-review-stall"
  | "stalled-review"
  | "stale-paused-review"
  | "failed"
  | "queued";

export interface StallReason {
  code: StallReasonCode;
  /** Short label for a badge/pill. Resolves through the caller's `t` so it stays per-surface
   *  (the card and the list use different pause keys on purpose — see `pausedBadgeKeys`). */
  badgeLabel: string;
  /** One-line headline for a visible reason line/banner. */
  headline: string;
  /** Longer explanation. */
  description: string;
  /** What the operator can do to unstick it. */
  suggestedAction: string;
  /** Column the freeze can be resumed to (external blocks carry this; otherwise undefined). */
  resumeTo?: string;
  /** How long the card has sat in this state, in ms, measured against `context.dataAsOfMs`. */
  ageMs?: number;
}

/**
 * The task fields the resolver reads. Fields that exist on `Task` are picked so a plain `Task`
 * satisfies it structurally; the remainder are OPTIONAL extras that individual surfaces can supply
 * (they are not persisted on the task row). A `Task` therefore passes directly with the extras
 * simply absent (undefined), which the classifier handles gracefully.
 */
export interface StallSubject
  extends Pick<
    Task,
    | "paused"
    | "pausedReason"
    | "pausedByAgentId"
    | "userPaused"
    | "sourceMetadata"
    | "externalBlock"
    | "blockedBy"
    | "overlapBlockedBy"
    | "wedgeNotification"
    | "status"
    | "column"
    | "inReviewStall"
    | "stalePausedReview"
    | "stalledReview"
    | "updatedAt"
    | "error"
  > {
  /** Caller-supplied queue reason; the `queued` code fires only when a caller asserts one, so a
   *  plain flowing/queued card never produces a stall by default. */
  queuedReason?: string;
  /** Caller-resolved column role, used only when a surface has resolved it; not required. */
  columnRole?: string;
  /** Classified failure reason (present on some entities; `error` is the task's own field). */
  failureReason?: string;
  /** Last agent-run error string, if the surface has it. */
  lastError?: string;
  /** Transient merge retry exhaustion flag, if the surface has it. */
  transientMergeExhausted?: boolean;
  /** Non-retryable provider error flag, if the surface has it. */
  nonRetryableProviderError?: boolean;
}

/**
 * A minimal view of the agent that owns the card, mirroring `agentHealth.tsx`'s input shape so the
 * same object can feed both the health pill and this resolver. Either `pauseReason === "awaiting-approval"`
 * (what the engine's approval gate writes) or a non-zero `pendingApprovalCount` (what the agent API
 * routes enrich) drives the `agent-approval` classification; the other fields are carried for
 * parity/inspection.
 */
export interface StallAgent {
  state?: string;
  pauseReason?: string;
  lastError?: string;
  pendingApprovalCount?: number;
}

/** Per-surface overrides for the paused badge key, so each surface keeps its OWN localized label. */
export interface StallPausedBadgeKeys {
  /** Key for a card paused by an agent (ListView uses `listView.pausedByAgent`; default `tasks.pausedByAgent`). */
  agentPaused?: string;
  /** Key for a paused card that is not agent-caused (default `tasks.paused`). */
  userPaused?: string;
  /** Key for a duplicate-decision pause (default `tasks.needsUserFeedback`). */
  needsDecision?: string;
}

export interface StallContext {
  /**
   * The surface's `t` scoped to the "app" namespace. REQUIRED: every stall string this module renders
   * goes through it, so the caller — not this module — decides namespace and key. This is what lets
   * the card's badge stay byte-identical (`tasks.*`) while the list reuses its own (`listView.*`).
   */
  t: TFunction<"app">;
  /** Last board-fetch timestamp; age is measured against it (never `Date.now()` here). */
  dataAsOfMs?: number;
  /*
  FNXC:StallReason 2026-09-01-19:15 (RUFU-175):
  Forward-compat seam for the server-derived blocker field RUFU-174 was specced to add
  (`task.stallReason: { code, reason, observedAt }`). RUFU-174 is NOT implemented on this branch
  (grep for `stallReason` across packages/core/src/types returns nothing; no derived field in
  task-store/reads.ts), so these stay plain optional reason STRINGS that no consumer wires today —
  they exist so the merge-blocker/completion-blocker codes are already in the precedence chain and
  the copy is already localized. When RUFU-174 lands its canonical code enum, a follow-up maps those
  server codes through this seam (and, per the interface-contract, lets a present `task.stallReason`
  win verbatim ahead of the client-side classifier) rather than minting a second parallel authority.
  Building that wiring here would be re-adding the dual-authority this feature exists to remove.
  */
  /** A pre-merge blocker reason, when the surface has resolved one (see RUFU-174 seam note above). */
  mergeBlockerReason?: string;
  /** A completion-blocker reason, when the surface has resolved one (see RUFU-174 seam note above). */
  completionBlockerReason?: string;
  /** The owning agent, when the surface knows it. Enables the `agent-approval` code. */
  agent?: StallAgent;
  /** Per-surface pause badge key overrides (see `StallPausedBadgeKeys`). */
  pausedBadgeKeys?: StallPausedBadgeKeys;
}

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Shared t-free table of human pause-reason words. Exported here as the single source so the agent-health
pill (which has no `t`) and the resolver (whose localized `stall.pausedReason.<code>.*` defaults
reuse these exact strings) cannot drift. The values double as the English defaults for the resolver's
enumerated keys AND as the interpolated `{{reason}}` word for unenumerated codes, so an unknown code
still shows its raw string rather than an empty label — the same honest fallback on both surfaces.
*/
export const PAUSE_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "error-unrecoverable": "Paused with an unrecoverable error",
  "error-retry-exhausted": "Automatic retries exhausted",
  "awaiting-approval": "Awaiting approval",
  "heartbeat-model-unavailable": "Heartbeat model unavailable",
  "heartbeat-unresponsive": "Heartbeat unresponsive",
  "budget-exhausted": "Output budget exhausted",
  "migrated-from-terminated": "Recovered from a terminated runtime",
  manual: "Paused by an operator",
  "user-requested": "Paused at your request",
  testing: "Paused for testing",
  "duplicate-decision-required": "Awaiting a duplicate decision",
});

/** Pause-family codes whose badge reuses the caller's existing pause keys (byte-identity). */
const PAUSED_FAMILY_CODES: ReadonlySet<StallReasonCode> = new Set<StallReasonCode>([
  "duplicate-decision",
  "agent-paused",
  "user-paused",
  "engine-paused",
]);

/** Parse an ISO timestamp to epoch ms, or `undefined` when unparseable. Never returns "now". */
function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether the task carries a duplicate-candidate provenance marker. */
function hasDuplicateSource(sourceMetadata: StallSubject["sourceMetadata"]): boolean {
  if (!sourceMetadata || typeof sourceMetadata !== "object") return false;
  const meta = sourceMetadata as Record<string, unknown>;
  return Boolean(meta.duplicateSource || meta.nearDuplicateOf);
}

/**
 * Resolve the paused badge label through the caller's key so each surface keeps its OWN localized
 * label. The English defaults match the existing inline strings EXACTLY, which is what preserves
 * byte-identity on TaskCard while letting ListView swap in `listView.pausedByAgent`.
 */
function pausedBadgeLabel(code: StallReasonCode, context: StallContext): string {
  const { t, pausedBadgeKeys } = context;
  if (code === "duplicate-decision") {
    return t(pausedBadgeKeys?.needsDecision ?? "tasks.needsUserFeedback", "Needs your decision");
  }
  if (code === "agent-paused") {
    return t(pausedBadgeKeys?.agentPaused ?? "tasks.pausedByAgent", "paused by agent");
  }
  // user-paused and engine-paused both render the plain "paused" word, matching TaskCard's inline.
  return t(pausedBadgeKeys?.userPaused ?? "tasks.paused", "paused");
}

/**
 * Headline naming the specific pause reason when it is one of the enumerated codes; otherwise a
 * generic headline whose interpolation carries the humanized word (known code) or the raw code
 * (unknown). The `error`/unknown path therefore still "names the raw code" as required.
 */
function pausedHeadline(subject: StallSubject, context: StallContext): string {
  const { t } = context;
  const reason = subject.pausedReason;
  switch (reason) {
    // Token-budget (task-level) and budget-exhausted (agent-level) share one budget key + default.
    case "budget-exhausted":
    case "token_budget_exceeded":
      return t("stall.pausedReason.budget-exhausted.headline", PAUSE_REASON_LABELS["budget-exhausted"]);
    case "awaiting-approval":
      return t("stall.pausedReason.awaiting-approval.headline", PAUSE_REASON_LABELS["awaiting-approval"]);
    case "heartbeat-unresponsive":
      return t("stall.pausedReason.heartbeat-unresponsive.headline", PAUSE_REASON_LABELS["heartbeat-unresponsive"]);
    case "error-retry-exhausted":
      return t("stall.pausedReason.error-retry-exhausted.headline", PAUSE_REASON_LABELS["error-retry-exhausted"]);
    case "error-unrecoverable":
      return t("stall.pausedReason.error-unrecoverable.headline", PAUSE_REASON_LABELS["error-unrecoverable"]);
    case "migrated-from-terminated":
      return t("stall.pausedReason.migrated-from-terminated.headline", PAUSE_REASON_LABELS["migrated-from-terminated"]);
    case undefined:
    case null:
    case "":
      // A pause with no reason word at all — the plain "This card is paused" banner.
      return t("stall.paused.headline", "This card is paused");
    default:
      return t("stall.pausedReason.generic.headline", "Paused — {{reason}}", {
        reason: PAUSE_REASON_LABELS[reason] ?? reason,
      });
  }
}

/** Build a paused-family StallReason once its `code` has been chosen. */
function pausedReason(
  subject: StallSubject,
  context: StallContext,
  code: Extract<StallReasonCode, "agent-paused" | "user-paused" | "engine-paused">,
): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(subject.updatedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  return {
    code,
    badgeLabel: pausedBadgeLabel(code, context),
    headline: pausedHeadline(subject, context),
    description: t("stall.paused.description", "This card is paused and will not move until it is resumed."),
    suggestedAction: t("stall.paused.suggestedAction", "Resume the card, or open its detail to read the pause reason."),
    // A paused family member always carries a visible reason word when we know one, so the surface
    // can suppress a bare "paused" with no explanation (symptom (e)) by checking this.
    ageMs,
  };
}

function externalBlockReason(block: TaskExternalBlock, context: StallContext): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(block.blockedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  return {
    code: "external-block",
    badgeLabel: t("stall.external-block.badgeLabel", "Blocked"),
    headline: t("stall.external-block.headline", "Blocked outside the worktree"),
    // The formatted reason is raw operator-facing diagnostic data (origin/code/message), not prose
    // the translator owns — it is passed through verbatim, exactly as the detail notice renders it.
    description: formatTaskExternalBlockReason(block),
    suggestedAction: t("stall.external-block.suggestedAction", "Repair the external obstacle, then resume this card."),
    resumeTo: block.resume?.column,
    ageMs,
  };
}

function wedgeReason(
  wedge: NonNullable<StallSubject["wedgeNotification"]>,
  context: StallContext,
): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(wedge.transitionedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  // A supplied self-healing descriptor carries operator-facing prose; prefer it when present.
  const descriptor = wedge.pending?.reason ? wedge.pending : undefined;
  return {
    code: "wedge",
    badgeLabel: t("stall.wedge.badgeLabel", "Stuck"),
    headline: t("stall.wedge.headline", "This card is stuck waiting for a decision"),
    description: descriptor?.reason ?? t("stall.wedge.description", "A durable stuck-state hold is in place on this card."),
    suggestedAction: descriptor?.action
      ?? t("stall.wedge.suggestedAction", "Review the stuck-state notice and take its suggested action, or let recovery retry."),
    ageMs,
  };
}

function dependencyReason(subject: StallSubject, context: StallContext, overlap: boolean): StallReason {
  const { t } = context;
  const blockerId = overlap ? subject.overlapBlockedBy! : subject.blockedBy!;
  return {
    code: overlap ? "overlap-block" : "dependency-block",
    badgeLabel: overlap
      ? t("stall.overlap-block.badgeLabel", "File overlap")
      : t("stall.dependency-block.badgeLabel", "Blocked"),
    // The headline interpolates the blocking task id so the card FACE names the blocker, not only a
    // tooltip (symptom (c)).
    headline: overlap
      ? t("stall.overlap-block.headline", "Waiting on file overlap with {{taskId}}", { taskId: blockerId })
      : t("stall.dependency-block.headline", "Waiting on dependency {{taskId}}", { taskId: blockerId }),
    description: overlap
      ? t("stall.overlap-block.description", "Another active card is editing the same files, so this card is held to avoid a conflict.")
      : t("stall.dependency-block.description", "This card depends on another card that has not finished yet."),
    suggestedAction: overlap
      ? t("stall.overlap-block.suggestedAction", "Let the overlapping card land, or narrow this card's file scope.")
      : t("stall.dependency-block.suggestedAction", "Finish the blocking card, or remove the dependency."),
  };
}

function blockerReason(
  reason: string,
  code: Extract<StallReasonCode, "merge-blocker" | "completion-blocker">,
  context: StallContext,
): StallReason {
  const { t } = context;
  if (code === "merge-blocker") {
    return {
      code,
      badgeLabel: t("stall.merge-blocker.badgeLabel", "Merge blocked"),
      headline: t("stall.merge-blocker.headline", "Merge is blocked"),
      description: reason,
      suggestedAction: t("stall.merge-blocker.suggestedAction", "Open the Review tab to resolve the merge blocker."),
    };
  }
  return {
    code,
    badgeLabel: t("stall.completion-blocker.badgeLabel", "Completion blocked"),
    headline: t("stall.completion-blocker.headline", "Completion is blocked"),
    description: reason,
    suggestedAction: t("stall.completion-blocker.suggestedAction", "Open the detail to resolve the completion blocker."),
  };
}

function failedReason(subject: StallSubject, context: StallContext): StallReason {
  const { t } = context;
  const detail = subject.error ?? subject.failureReason ?? subject.lastError;
  return {
    code: "failed",
    badgeLabel: t("stall.failed.badgeLabel", "Failed"),
    headline: t("stall.failed.headline", "This card failed"),
    description: detail ?? t("stall.failed.description", "The last run ended in a failure without a captured error message."),
    suggestedAction: t("stall.failed.suggestedAction", "Retry the card, or open the detail to read the failure."),
  };
}

/**
 * Classify why a card is not moving. Returns the first stall that applies by the precedence chain
 * documented at the top of this file, or `undefined` when the card is flowing (actively running,
 * done, or otherwise not stalled). Callers keep their own gating for whether to actually RENDER the
 * result and whether a dedicated affordance (a review badge, an external-block notice) already covers
 * the returned code.
 */
export function resolveStallReason(subject: StallSubject, context: StallContext): StallReason | undefined {
  const { t } = context;

  // 1. external-block — an operator-recoverable freeze outside the worktree; outranks the pause it
  //    itself wrote onto the task.
  if (subject.status === "blocked" && subject.externalBlock) {
    return externalBlockReason(subject.externalBlock, context);
  }

  // 2. duplicate-decision — a paused duplicate candidate awaiting the operator's keep/merge call.
  if (subject.paused === true && subject.pausedReason === "duplicate-decision-required" && hasDuplicateSource(subject.sourceMetadata)) {
    return {
      code: "duplicate-decision",
      badgeLabel: pausedBadgeLabel("duplicate-decision", context),
      headline: t("stall.duplicate-decision.headline", "This card may be a duplicate"),
      description: t("stall.duplicate-decision.description", "A planner or another agent flagged it as a possible duplicate; it needs your decision before it can move."),
      suggestedAction: t("stall.duplicate-decision.suggestedAction", "Open the duplicate decision and keep the earliest canonical card."),
    };
  }

  // 3. agent-paused — some agent paused this card (carries a pausedByAgentId). A userPaused overlay
  //    that still carries the agent owner is an agent pause first (matches TaskCard's badge precedence).
  if (subject.pausedByAgentId && (subject.paused === true || subject.userPaused === true)) {
    return pausedReason(subject, context, "agent-paused");
  }

  // 4. user-paused — an explicit operator pause (userPaused), distinct from an engine park. The
  //    dashboard also sets userPaused WITHOUT paused, so it is accepted as its own paused-subject here.
  if (subject.userPaused === true) {
    return pausedReason(subject, context, "user-paused");
  }

  // 5. engine-paused — a paused card with neither an agent owner nor an operator pause: an engine park.
  if (subject.paused === true) {
    return pausedReason(subject, context, "engine-paused");
  }

  /*
  FNXC:StallReason 2026-09-02-15:52 (RUFU-175):
  The approval park has two independent signals and a surface may carry only one of them. The engine's
  tool-approval gate (`build-action-gate-context.ts` markApprovalRequired) parks the AGENT with
  `pauseReason: "awaiting-approval"` and never writes an approval count; `pendingApprovalCount` is a
  separate read-path enrichment (`withPendingApprovalCounts` on the agent API routes) that a board or
  list payload need not carry. Testing only the count would therefore miss the one field the pausing code
  actually writes, leaving a card whose agent is parked on an approval to fall through to `undefined`
  (flowing) instead of naming the wait. Either signal is sufficient.
  */
  if (
    context.agent &&
    (context.agent.pauseReason === "awaiting-approval" || (context.agent.pendingApprovalCount ?? 0) > 0)
  ) {
    return {
      code: "agent-approval",
      badgeLabel: t("stall.agent-approval.badgeLabel", "Awaiting approval"),
      headline: t("stall.agent-approval.headline", "A tool call is waiting for your approval"),
      description: t("stall.agent-approval.description", "The agent paused itself until a person approves the pending permission request."),
      suggestedAction: t("stall.agent-approval.suggestedAction", "Open the approvals inbox to approve or deny."),
    };
  }

  // 7. wedge — a durable stuck-state hold is active on the card.
  if (subject.wedgeNotification && subject.wedgeNotification.status === "active") {
    return wedgeReason(subject.wedgeNotification, context);
  }

  // 8/9. dependency-block / overlap-block — an explicit unmet edge names the blocking card.
  if (subject.blockedBy) {
    return dependencyReason(subject, context, false);
  }
  if (subject.overlapBlockedBy) {
    return dependencyReason(subject, context, true);
  }

  // 10/11. merge-blocker / completion-blocker — resolved blockers the surface handed in via context.
  if (context.mergeBlockerReason) {
    return blockerReason(context.mergeBlockerReason, "merge-blocker", context);
  }
  if (context.completionBlockerReason) {
    return blockerReason(context.completionBlockerReason, "completion-blocker", context);
  }

  // 12. in-review-stall — delegate to the existing copy module so the card badge, the detail review
  //     banner, and this resolver all agree byte-for-byte (one authority: getInReviewStallCopy).
  if (subject.inReviewStall) {
    const copy = getInReviewStallCopy(subject.inReviewStall);
    return {
      code: "in-review-stall",
      badgeLabel: copy.badgeLabel,
      headline: copy.headline,
      description: copy.description,
      suggestedAction: copy.suggestedAction,
    };
  }

  // 13. stalled-review — a review that keeps re-cycling without progress.
  if (subject.stalledReview) {
    return {
      code: "stalled-review",
      badgeLabel: t("stall.stalled-review.badgeLabel", "Stalled review"),
      headline: t("stall.stalled-review.headline", "Review appears stalled"),
      // The signal's `reason` is engine-authored diagnostic text, shown verbatim like the card does today.
      description: subject.stalledReview.reason,
      suggestedAction: t("stall.stalled-review.suggestedAction", "Re-dispatch the review or open the activity log for detail."),
    };
  }

  // 14. stale-paused-review — delegate to the existing copy module (same one-authority reason).
  if (subject.stalePausedReview) {
    const copy = getStalePausedReviewCopy(subject.stalePausedReview);
    return {
      code: "stale-paused-review",
      badgeLabel: copy.badgeLabel,
      headline: copy.headline,
      description: copy.description,
      suggestedAction: copy.suggestedAction,
    };
  }

  // 15. failed — a terminal failure with no higher-priority stall.
  if (subject.status === "failed") {
    return failedReason(subject, context);
  }

  // 16. queued — ONLY when a caller asserts a queue reason. A plain resting/queued card must NOT read
  //     as a stall (symptom (a)); surfaces that want a queued affordance pass `queuedReason`.
  if (subject.queuedReason) {
    return {
      code: "queued",
      badgeLabel: t("tasks.queued", "Queued"),
      headline: t("stall.queued.headline", "Waiting to be picked up"),
      description: subject.queuedReason,
      suggestedAction: t("stall.queued.suggestedAction", "No action needed; reorder or assign the card if a different one should run first."),
    };
  }

  // Flowing — actively running, done, or simply not stalled.
  return undefined;
}

/** True when the code belongs to the pause family (used by surfaces to align suppression). */
export function isPausedFamilyCode(code: StallReasonCode): boolean {
  return PAUSED_FAMILY_CODES.has(code);
}

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Single predicate for the generic face-visible stall chip shared by TaskCard and ListView, so the two
card surfaces agree on which codes get a visible reason (previously hover-only or absent — symptoms b/c)
and which keep only their dedicated affordance. Codes NOT listed here are deliberately excluded because
a richer affordance already speaks for them on those surfaces: external-block (ExternalBlockNotice),
in-review-stall / stalled-review / stale-paused-review (dedicated review badges/lines), failed (the
card-error line), queued (the plain Queued badge), and duplicate-decision (the Needs-your-decision /
paused badge). A pause only earns the chip when it carries a reason word — a bare pause has nothing to
add beyond its badge. Surfaces may still suppress further (TaskCard also drops the chip while an
external block is present). `subject` is read for `pausedReason` only.
*/
export function stallReasonVisibleOnFace(subject: StallSubject, stall: StallReason | undefined): boolean {
  if (!stall) return false;
  switch (stall.code) {
    case "wedge":
    case "dependency-block":
    case "overlap-block":
      return true;
    case "agent-paused":
    case "user-paused":
    case "engine-paused":
      return Boolean(subject.pausedReason);
    default:
      return false;
  }
}
