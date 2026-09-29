import "./TaskContextMenu.css";
import { UiMenu, UiMenuItem } from "./ui";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { ColumnId, Task, TaskDetail } from "@fusion/core";
/* FNXC:TaskFollowUp 2026-09-17-18:10: FN-513's eligibility rule is a PURE core helper reachable through the barrel. */
import { isFollowUpEligible } from "@fusion/core";


/*
FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
FN-206 makes dashboard task recovery Retry, Reset, and Delete. Retry repeats the current stage
in place; Reset abandons task state; Delete removes the card.
*/

/*
FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179):
This used to hold a miniature duplicate of core's getLatestFailedPreMergeReviewStep — dashboard app
code imports TYPES only from @fusion/core (Vite aliases it to packages/core/src/types.ts to avoid
bundling the core runtime into the client), so the selection function was not importable here and
"keep this in lockstep" was the only enforcement. REMOVED: the affordance now renders from the
server-derived `task.reviewBypass` capability, hydrated on every read path by the SAME
`deriveReviewBypassTarget` the store's `bypassFailedPreMergeReviewStep` applies to itself. The
duplicate drifted in both directions: its `some(failed)` rule offered the item on a paused card the
store refuses, and stayed silent for a required gate that NEVER RAN — the stranded-card shape this
task fixes. Server answers, UI renders; a stale payload costs at most one poll cycle, which is
cheaper than a second selection authority that can disagree with the store.
*/

export type TaskMenuActionTone = "default" | "danger" | "note";

export interface TaskMenuActionDescriptor {
  id: string;
  label: string;
  tone?: TaskMenuActionTone;
  disabled?: boolean;
  testId?: string;
  pressed?: boolean;
  onSelect?: () => void;
}

/*
FNXC:TaskDetailFooterActions 2026-09-05-23:27:
Task Detail contributes its relocated quick actions as one flat descriptor list. Do not turn those groups into submenus: the desktop footer menu clips horizontal overflow and the mobile menu scrolls vertically, so a lateral flyout would be clipped and difficult to use by touch.
*/

/**
 * A non-action menu parent whose children are the selectable menu items.
 *
 * FNXC:TaskContextMenu 2026-08-27-12:01:
 * FN-198 removed the only in-repository producer, but this host-agnostic renderer stays because
 * submenu support is generic menu infrastructure rather than a task-relocation capability.
 */
export interface TaskMenuSubmenuDescriptor {
  id: string;
  label: string;
  items: TaskMenuActionDescriptor[];
}

export type TaskMenuItemDescriptor = TaskMenuActionDescriptor | TaskMenuSubmenuDescriptor;

export interface TaskContextMenuColumnFlags {
  complete?: boolean;
  hiddenFromBoard?: boolean;
  hold?: boolean;
  intake?: boolean;
  /** Intake WITHOUT auto-triage: the operator promotes the card by hand. */
  manualIntake?: boolean;
  mergeBlocker?: boolean;
  humanReview?: boolean;
  /*
  FNXC:ReviewLaneBypass 2026-09-03-15:11 (RUFU-179 code-review remediation):
  The third review role. The server always sent it (`resolveColumnFlags` emits every declared trait,
  and `BoardWorkflowColumnFlags` declares it) but this client mirror never read it, which is how the
  bypass belt drifted narrower than the store's lane rule — see `isReviewBypassLaneColumn`.
  */
  mergeOrchestration?: boolean;
  /* FNXC:WorkflowResolvedColumns 2026-07-27-15:30 (U10 / R8): surfaced so column-trait consumers
     can tell an implementation lane from a pre-implementation one without naming `in-progress`. */
  countsTowardWip?: boolean;
}

export interface TaskContextMenuColumnMetadata {
  id: ColumnId;
  label: string;
  flags?: TaskContextMenuColumnFlags;
}

export interface TaskReviewActionDescriptor {
  id: "merge" | "start-pr-review" | "check-pr-status" | "pr-automation";
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface TaskActionMenuModel {
  actions: TaskMenuActionDescriptor[];
  reviewAction?: TaskReviewActionDescriptor;
  shouldShowActionsMenu: boolean;
  isTaskPaused: boolean;
}

export interface BuildTaskActionMenuModelOptions {
  task: Task | TaskDetail;
  t: TFunction<"app">;
  currentColumnFlags?: TaskContextMenuColumnFlags;
  hasDuplicateHandler?: boolean;
  hasRetryHandler?: boolean;
  hasResetHandler?: boolean;
  hasAssignedAgent?: boolean;
  hasBypassReviewHandler?: boolean;
  mergeStrategy?: string;
  autoMergeEnabled?: boolean;
  prAutomationLabel?: string;
  isCheckingPrStatus?: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  FN-514 — ONE action that arms or removes the per-card delivery lock, on every shared menu host.
  It is a single toggle rather than two entries because the card is either locked or it is not, and
  the final authorization is the SERVER's: the entry is hidden once delivery has provably started or
  the card is complete, and the server refuses anything the client still offers.
  */
  onToggleMergeApproval?: (enabled: boolean) => void;
  /*
  FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
  "Transfer to project…" copies the card into another LOCAL project with bidirectional pointers.
  Omitted entirely unless the host injects `onTransferToProject` — the same rule as `plan` above:
  dock/plugin/embedded hosts without the transfer route must not render a dead shell, and a
  disabled item would promise an action the host cannot serve.
  */
  onTransferToProject?: () => void;
  /*
  FNXC:TaskContextMenu 2026-09-15-10:40:
  FN-417 removes the `merge` review action from every TASK CONTEXT MENU because the engine drives
  delivery automatically; the single remaining manual merge command is Task Detail's review footer
  button. The descriptor is therefore OPT-IN: hosts that render the model as a popup menu leave this
  flag unset and get `reviewAction === undefined` for merge-shaped verdicts, while `start-pr-review`,
  `check-pr-status`, and the disabled `pr-automation` note are unaffected in every host.
  */
  includeMergeCompletionAction?: boolean;
  onOpenRefine?: () => void;
  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  FN-513 — prepare a SUCCESSOR of a task that is still planning, running, or in review, from its plan
  and its in-flight implementation. Every host wires this the same way and the eligibility rule is
  the shared core one, so Board, List and Task Detail cannot disagree about where it appears.
  */
  onOpenFollowUp?: () => void;
  onRetry?: () => void;
  onReset?: () => void;
  onTogglePause?: () => void;
  onMerge?: () => void;
  onStartPrReview?: () => void;
  onCheckPrStatus?: () => void;
  onEnableGithubTracking?: () => void;
  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator-only bypass of the latest failed pre-merge review step (FN-7720).
  Only TaskDetailModal wires `onBypassReview`, so the action is invisible in
  the Board/List card context menus — kept to the single canonical
  task-detail actions surface intentionally.
  */
  onBypassReview?: () => void;
}

export function getTaskPrAutomationLabel(t: TFunction<"app">, status?: string): string | undefined {
  if (!status) return undefined;
  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": t("taskDetail.pr.creatingPr", "Creating PR…"),
    "awaiting-pr-checks": t("taskDetail.pr.awaitingChecks", "Awaiting PR checks"),
    "merging-pr": t("taskDetail.pr.mergingPr", "Merging PR…"),
    "merging-fix": t("taskDetail.pr.mergingFixes", "Merging fixes…"),
  };
  return prAutomationStatusLabels[status];
}

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only.
Reached when the caller supplies no resolved flags — the pre-load window before the board's
workflows fetch resolves, and a card stranded on an id its workflow no longer declares. Nothing to
resolve from in either state, so deleting the id does not remove a decision, it answers "not a
review column" for every card during first paint.

NOTE, flagged not fixed: the id is currently an UNCONDITIONAL disjunct, so explicit
`{ mergeBlocker: false, humanReview: false }` on a column named `in-review` is still classified as
review. #2664 fixed exactly that shape elsewhere by INVERTING the read — traits first, id only as the
degraded answer when no flags arrive. The same inversion belongs here, but it is a BEHAVIOR CHANGE
and out of scope for a conversion batch.

DELIBERATE-LITERAL: restated adjacent to the disjunct below so the census marker window covers this
site — the debt itself is the NOTE above, not an unreviewed literal.
*/
function isReviewColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "in-review" || flags?.mergeBlocker === true || flags?.humanReview === true;
}

/*
FNXC:ReviewLaneBypass 2026-09-03-15:11 (RUFU-179 code-review remediation):
THE BYPASS BELT MUST MATCH THE STORE'S LANE SET, NOT THE GENERIC REVIEW ROLE.

`isReviewColumnRole` answers `mergeBlocker ∪ humanReview`; the store's acceptance gate
(`resolveReviewBypassLanes` → `resolveReviewColumns`) admits `mergeOrchestration ∪ mergeBlocker ∪
humanReview` — every lane where review happens (#2718: this guard only refuses or permits an
operator action and moves nothing, so the broad set is right there). On a board hosting review
orchestration on a `mergeOrchestration`-only lane, the store ACCEPTED a bypass while this belt HID
the menu item — the "API accepts, menu silent" half of the exact dead-affordance class RUFU-179
exists to delete, and the split its Surface Enumeration ordered this guard and the store to "keep
agreeing".

Why a bypass-local predicate instead of widening `isReviewColumnRole`: that helper has 13 other
callers (stall copy, diff stats, PR feedback, worktree grouping, …) which ask the narrower "is this
card in review?" question; redefining it for the bypass would silently change what a merge/PR chip
or a stall banner thinks a lane is, and the remediation scope forbids unrelated behavior changes.
The tri-role shape already exists once on this side of the wire — `useBlockerFanout`'s review
predicate uses the same union — so this mirrors an established local convention, not a new taxonomy.

DELIBERATE-LITERAL: flags-first with the legacy `in-review` id ONLY as the no-metadata fallback
(first paint / stranded card), unlike `isReviewColumn` above whose id is a flagged unconditional
disjunct — #2664's shape.
*/
function isReviewBypassLaneColumn(flags: TaskContextMenuColumnFlags | undefined, column: string): boolean {
  return flags
    ? flags.mergeOrchestration === true || flags.mergeBlocker === true || flags.humanReview === true
    : column === "in-review";
}

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only, same
reasoning as `isReviewColumn` above — and the same flagged inversion: `column === "done"` is an
unconditional disjunct ahead of the trait read.
*/
function isDoneOrReview(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "done" || isReviewColumn(column, flags) || flags?.complete === true;
}

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only.
Same rule as `isReviewColumn` above: reached when no resolved flags arrive, where answering
"mutable" for a Done card would offer live-work actions on a terminal row.
*/
function isMutableLiveColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  if (flags) return flags.complete !== true;
  return column !== "done";
}

/*
FNXC:TaskContextMenu 2026-09-15-10:40:
FN-417 deleted `isPreExecutionHoldColumn` together with its only production consumer, the `plan`
menu descriptor: the engine plans cards automatically, so a manual Plan affordance in a task context
menu no longer corresponds to anything an operator drives. That predicate carried the LAST `triage`
comparison recorded for this file, so its removal drops the TaskContextMenu.tsx/triage entry from the
lifecycle-column census baseline — `scripts/lib/lifecycle-column-census-baseline.json` must be
re-sealed, otherwise `pnpm check:lifecycle-columns` fails `stale` on the DROP (a fall diverges from
the baseline exactly like a rise). The surviving DELIBERATE-LITERAL fallbacks above
(`isReviewColumn`, `isDoneOrReview`, `isMutableLiveColumn`) are untouched: they are first-paint
degraded answers, not unconverted guards.
*/
export function getTaskReviewAction(
  task: Task | TaskDetail,
  options: Pick<BuildTaskActionMenuModelOptions, "t" | "currentColumnFlags" | "mergeStrategy" | "autoMergeEnabled" | "prAutomationLabel" | "isCheckingPrStatus" | "includeMergeCompletionAction" | "onMerge" | "onStartPrReview" | "onCheckPrStatus">,
): TaskReviewActionDescriptor | undefined {
  const currentColumnFlags = options.currentColumnFlags;
  if (!isReviewColumn(task.column, currentColumnFlags)) {
    return undefined;
  }

  if (options.prAutomationLabel) {
    return { id: "pr-automation", label: options.prAutomationLabel, disabled: true };
  }

  const isManualPrFlow = options.mergeStrategy === "pull-request" && !options.autoMergeEnabled;
  const prStatus = task.prInfo?.status;

  if (isManualPrFlow) {
    if (!task.prInfo) {
      return { id: "start-pr-review", label: options.t("taskDetail.pr.startPrReview", "Start PR Review"), onSelect: options.onStartPrReview };
    }
    if (prStatus === "open") {
      return {
        id: "check-pr-status",
        label: options.t("taskDetail.pr.checkPrStatus", "Check PR Status"),
        disabled: options.isCheckingPrStatus,
        onSelect: options.onCheckPrStatus,
      };
    }
    if (prStatus === "merged") {
      return {
        id: "check-pr-status",
        label: options.t("taskDetail.pr.mergedExternally", "Pull request merged"),
        disabled: true,
      };
    }
    if (prStatus === "closed") {
      return {
        id: "check-pr-status",
        label: options.t("taskDetail.pr.closedWithoutMerge", "Pull request closed without merging"),
        disabled: true,
      };
    }
  }

  /*
  FNXC:TaskContextMenu 2026-09-15-10:40:
  FN-417: the merge-completion verdicts ("Merge & Close" and the manual-PR "Finish & Close") are the
  only opt-in members of this descriptor union. The engine merges automatically, so a context menu
  must not offer the command; Task Detail opts in so its review footer button is unchanged for the
  rare projects that still merge by hand. Returning `undefined` rather than a disabled descriptor is
  deliberate — a disabled shell is the dead affordance this task removes.
  */
  return options.includeMergeCompletionAction
    ? { id: "merge", label: options.t("taskDetail.pr.mergeAndClose", "Merge & Close"), onSelect: options.onMerge }
    : undefined;
}

export function buildTaskActionMenuModel(options: BuildTaskActionMenuModelOptions): TaskActionMenuModel {
  const {
    task,
    t,
    currentColumnFlags,
    hasDuplicateHandler = Boolean(options.onDuplicate),
    hasRetryHandler = Boolean(options.onRetry),
    hasResetHandler = Boolean(options.onReset),
    hasBypassReviewHandler = Boolean(options.onBypassReview),
  } = options;
  const isTaskPaused = Boolean(task.paused || task.userPaused);
  const actions: TaskMenuActionDescriptor[] = [];
  const destructiveActions: TaskMenuActionDescriptor[] = [];

  if (hasDuplicateHandler) {
    actions.push({ id: "duplicate", label: t("taskDetail.duplicate.btn", "Duplicate"), onSelect: options.onDuplicate });
  }

  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  FN-514 — the delivery lock may be changed on any LIVE card before delivery actually starts, which
  includes Ideas, Planning, WIP, review, paused and failed cards. It is hidden only where the answer
  cannot change anything: a terminal card, or one whose delivery has provably begun (a merge status,
  a confirmed merge). Sitting in a merge queue is NOT a started delivery, so those cards keep it.

  This is a presentation filter, not the authorization: the server re-checks under the task advisory
  lock and refuses a change that races a merge owner.
  */
  if (options.onToggleMergeApproval) {
    const deliveryStarted = task.mergeDetails?.mergeConfirmed === true
      || (typeof task.status === "string" && ["merging", "merging-pr", "merging-fix"].includes(task.status));
    const isTerminal = currentColumnFlags?.complete === true || (currentColumnFlags === undefined && task.column === "done");
    if (!deliveryStarted && !isTerminal) {
      const locked = task.humanMergeApproval?.enabled === true;
      actions.push({
        id: "toggle-merge-approval",
        label: locked
          ? t("tasks.humanMergeApproval.menuUnlock", "Remove delivery approval")
          : t("tasks.humanMergeApproval.menuLock", "Require my approval to deliver"),
        onSelect: () => options.onToggleMergeApproval?.(!locked),
      });
    }
  }

  /*
  FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
  Transfer sits beside Duplicate — both mint a new card — but it is handler-gated (see the option
  doc): Board/List/Detail hosts wire it, dock/plugin card embeddings do not.
  */
  if (options.onTransferToProject) {
    actions.push({ id: "transfer-to-project", label: t("taskDetail.transfer.menuItem", "Transfer to project…"), onSelect: options.onTransferToProject });
  }

  /*
  FNXC:TaskContextMenu 2026-09-15-10:40:
  FN-417 removed the `plan` descriptor that used to sit here for intake/hold cards. Planning is driven
  by the engine, so no task context menu offers it on any host or breakpoint; the remaining Planning
  Mode entry points (inline create, quick entry, task form, GitHub import) are untouched.
  */

  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  FOLLOW-UP AND REFINE ARE COMPLEMENTARY, NEVER BOTH.

  Refine asks for MORE WORK ON THIS CARD once it is finished. Follow-up asks for a SEPARATE successor
  card derived from a card that is still going. A review-lane card qualifies for both questions, and
  showing two near-identical entries there is exactly the ambiguity the operator asked to avoid — so
  the eligible follow-up wins that lane and Refine keeps the terminal one.

  The predicate is `isFollowUpEligible` from core, shared with the store mode and the HTTP route. No
  local column reasoning: a renamed board, an explicit trait set, and the strict Planning exception
  (a CURRENT approving plan review) all resolve there, once.

  An unauthorized state renders NOTHING here — no disabled shell, no separator, no empty click
  target. A stale menu is still possible (the source can finish while the menu is open), and that is
  the server's 409 to answer, not a reason to leave a dead control on screen.
  */
  const followUpEligible = Boolean(options.onOpenFollowUp) && isFollowUpEligible({
    column: task.column,
    ...(currentColumnFlags ? { columnFlags: currentColumnFlags } : {}),
    status: task.status ?? null,
    deletedAt: task.deletedAt ?? null,
    workflowStepResults: task.workflowStepResults ?? [],
  });

  if (followUpEligible) {
    actions.push({
      id: "follow-up",
      label: t("taskDetail.followUp.btn", "Follow-up"),
      testId: "task-action-follow-up",
      onSelect: options.onOpenFollowUp,
    });
  } else if (isDoneOrReview(task.column, currentColumnFlags) && options.onOpenRefine) {
    actions.push({ id: "refine", label: t("taskDetail.refine.btn", "Refine"), onSelect: options.onOpenRefine });
  }

  /*
  FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
  Retry is not a failure-only escape hatch: a live intake, implementation, or review card can
  always repeat its current stage. Terminal columns remain immutable through the shared trait/id
  predicate, including first paint before workflow metadata is available.
  */
  if (hasRetryHandler && isMutableLiveColumn(task.column, currentColumnFlags)) {
    actions.push({ id: "retry", label: t("taskDetail.retry.btn", "Retry"), onSelect: options.onRetry });
  }

  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Policy-gated escape hatch (FN-7720) for a card stranded in the review lane by a pre-merge gate
  the operator can honestly clear (leading real-world cause: Runfusion/Fusion#1946's no-verdict
  dispatch defect), so it never renders as an empty/dead affordance for tasks blocked by other
  reasons or already recovered.

  FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179):
  The gate is now the server-derived capability itself. `kind: "failed"` rewrites the latest failed
  gate's verdict; `kind: "absent"` records an audited-operator approval for a required gate that
  never ran. Lane membership, pause state, and gate state are decided once by the store's own
  derivation and shipped on every read path, so the item can neither appear on a card the store
  would refuse nor hide on the unrun-gate shape. Copy branches on kind.

  FNXC:ReviewLaneBypass 2026-09-03-12:58 (RUFU-179):
  The tone must stay actionable (`"default"`, never `"note"`). `tone: "note"` is the informational
  style (see `paused-by-agent` above): it renders a non-interactive `<span role="note">` and
  `selectAction` returns early for it, so the bypass item shipped by FN-7720 could never fire its own
  `onSelect` on ANY host — the affordance rendered as dead text, which is the same operator-visible
  failure SANE-387 reported (a merge-blocked card with no reachable escape from the GUI). Model-level
  assertions cannot catch this; only a click on the rendered item can, which is why
  `TaskDetailModal.bypass-review.test.tsx` and the render-level case in `TaskContextMenu.test.tsx`
  activate it.
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:50 (batch-dashboard-app):
  REVIEW role, resolved from `currentColumnFlags` — which this function already receives and already
  uses for the archived check ~15 lines up. Keyed on the literal, the "Bypass failed review" action
  never appeared on a renamed board. The server capability already encodes the lane; this client
  lane-gate stays as the belt for a payload that predates a move between the last poll and this
  render.
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:50 (batch-dashboard-app):
  REVIEW role, resolved from `currentColumnFlags` — which this function already receives and already
  uses for the archived check ~15 lines up. Keyed on the literal, the "Bypass failed review" action
  never appeared on a renamed board. The server capability already encodes the lane; this client
  lane-gate stays as the belt for a payload that predates a move between the last poll and this
  render.

  FNXC:ReviewLaneBypass 2026-09-03-15:11 (RUFU-179 code-review remediation):
  The belt switched from `isReviewColumnRole` (mergeBlocker ∪ humanReview) to `isReviewBypassLaneColumn`
  (plus mergeOrchestration) so it admits EXACTLY the lanes the store's `resolveReviewBypassLanes`
  admits. A mergeOrchestration-only review lane previously got a server-derived capability that this
  gate hid — the store would have accepted the bypass, so hiding it re-created the unreachable-escape
  bug SANE-387 reported, from the other side. Why the fix is local here rather than a widening of the
  shared role helper is recorded at the predicate.
  */
  const bypassTarget = task.reviewBypass;
  if (hasBypassReviewHandler && isReviewBypassLaneColumn(currentColumnFlags, task.column) && bypassTarget) {
    actions.push({
      id: "bypass-review",
      label:
        bypassTarget.kind === "absent"
          ? t("taskDetail.bypassReview.btnUnrun", "Bypass unrun review gate")
          : t("taskDetail.bypassReview.btn", "Bypass failed review"),
      tone: "default",
      // FNXC:TaskDetailAlpha 2026-09-11-04:19: Bypass is an audited operator action, not explanatory note copy; keep it keyboard- and pointer-selectable in both menu implementations.
      onSelect: options.onBypassReview,
    });
  }

  /*
  FNXC:GitHubTracking 2026-07-01-00:00:
  Board and List task menus mirror Task Detail's GitHub tracking enablement with one shared descriptor. Only hosts that can PATCH and refresh local task state inject the callback, so untracked tasks get a working shortcut and already-enabled/linked tasks never leave an empty disabled shell.
  */
  if (options.onEnableGithubTracking && task.githubTracking?.enabled !== true) {
    actions.push({
      id: "enable-github-tracking",
      label: t("taskDetail.githubTracking.enableCheckboxLabel", "Enable GitHub tracking"),
      onSelect: options.onEnableGithubTracking,
    });
  }

  if (hasResetHandler && isMutableLiveColumn(task.column, currentColumnFlags)) {
    destructiveActions.push({ id: "reset", label: t("taskDetail.reset.btn", "Reset"), tone: "danger", onSelect: options.onReset });
  }

  /*
  FNXC:TaskDetailHeaderActions 2026-09-11-18:16:
  A mutable task exposes Pause or Unpause only when its host wires the matching lifecycle operation. The shared model omits unwired actions rather than producing an interactive-looking no-op in Task Detail, Board, or List menus.
  */
  if (options.onTogglePause && isMutableLiveColumn(task.column, currentColumnFlags)) {
    actions.push({
      id: isTaskPaused ? "unpause" : "pause",
      label: isTaskPaused ? t("taskDetail.pause.unpauseBtn", "Unpause") : t("taskDetail.pause.pauseBtn", "Pause"),
      onSelect: options.onTogglePause,
    });
  }

  if (isMutableLiveColumn(task.column, currentColumnFlags) && task.paused && task.pausedByAgentId) {
    actions.push({ id: "paused-by-agent", label: t("taskDetail.pause.pausedByAgent", "Paused by agent"), tone: "note", disabled: true });
  }

  destructiveActions.push({
    id: "delete",
    label: t("taskDetail.delete.btn", "Delete"),
    tone: "danger",
    onSelect: options.onDelete,
  });
  /*
  FNXC:TaskContextMenu 2026-07-01-00:00:
  Popup context menus intentionally group destructive Reset and Delete actions at the bottom, with Delete last, so Board, List, and Detail hosts share the safer operator action order without forking availability or confirmation behavior.
  */
  actions.push(...destructiveActions);

  return {
    actions,
    reviewAction: getTaskReviewAction(task, options),
    /*
    FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
    A pure intake lane is the planning form of Retry, not a reason to hide recovery. Deriving
    visibility from the produced action list keeps every host reachable and prevents a live card
    from showing neither a recovery action nor an explanation.
    */
    shouldShowActionsMenu: actions.length > 0,
    isTaskPaused,
  };
}

export interface TaskContextMenuProps {
  actions: TaskMenuItemDescriptor[];
  role?: "menu" | "list";
  className?: string;
  itemClassName?: string;
  dangerItemClassName?: string;
  noteItemClassName?: string;
  onActionSelect?: (action: TaskMenuActionDescriptor) => void;
  renderAction?: (action: TaskMenuActionDescriptor, defaultNode: ReactNode) => ReactNode;
  autoFocusFirstItem?: boolean;
}

/*
FNXC:TaskContextMenu 2026-06-29-00:00:
Card, list, and detail task menus must share one action descriptor model so labels and lifecycle availability do not drift between surfaces. Keep destructive handlers injected by the host so existing confirmations, toasts, and API calls remain the source of truth.
*/
export function TaskContextMenu({
  actions,
  role = "menu",
  className = "task-context-menu",
  itemClassName = "task-context-menu__item",
  dangerItemClassName = "task-context-menu__item--danger",
  noteItemClassName = "task-context-menu__item--note",
  onActionSelect,
  renderAction,
  autoFocusFirstItem = true,
}: TaskContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const touchSelectedActionRef = useRef<{ id: string; at: number } | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [submenuOpensLeft, setSubmenuOpensLeft] = useState(false);

  const selectAction = useCallback((action: TaskMenuActionDescriptor) => {
    if (action.disabled || action.tone === "note" || !action.onSelect) return;
    onActionSelect?.(action);
    action.onSelect();
  }, [onActionSelect]);

  /*
  FNXC:TaskContextMenu 2026-07-01-00:00:
  Mobile task menus must commit the selected action on touch/pen pointer release before host popovers can be removed by outside-click or focus retargeting. Desktop mouse keeps click activation, while the click guard prevents synthesized mobile clicks from firing the same task action twice.
  */
  const handleActionPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>, action: TaskMenuActionDescriptor) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    touchSelectedActionRef.current = { id: action.id, at: Date.now() };
    selectAction(action);
  }, [selectAction]);

  const handleActionClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, action: TaskMenuActionDescriptor) => {
    const touchSelection = touchSelectedActionRef.current;
    if (touchSelection?.id === action.id && Date.now() - touchSelection.at < 1000) {
      event.preventDefault();
      event.stopPropagation();
      touchSelectedActionRef.current = null;
      return;
    }
    touchSelectedActionRef.current = null;
    selectAction(action);
  }, [selectAction]);

  /*
  FNXC:TaskContextMenu 2026-07-16-20:50 (FN-8178):
  Menus are portaled while their TaskCard/ListView hosts close on capture-phase board scroll. Focusing
  the first action must not scroll a board ancestor, because that focus-created scroll is not an
  explicit dismissal and previously closed the menu immediately. Preserve keyboard focus while
  `preventScroll` leaves real user scrolling available to close the menu.
  */
  useEffect(() => {
    if (!autoFocusFirstItem) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])');
    firstItem?.focus({ preventScroll: true });
  }, [actions, autoFocusFirstItem]);

  useEffect(() => {
    if (!openSubmenuId) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-task-submenu="${openSubmenuId}"] [role="menuitem"]:not(:disabled):not([aria-disabled="true"])`)?.focus({ preventScroll: true });
  }, [openSubmenuId]);

  /*
  FNXC:TaskCardMovement 2026-08-19-18:52:
  The root menu is clamped to the viewport, but a nested Move to menu can still overflow from a
  rightmost Board lane or dock. Measure its rendered edge before paint and flip it left so every
  legal destination remains reachable with mouse, keyboard, and touch.
  */
  useLayoutEffect(() => {
    if (!openSubmenuId) {
      setSubmenuOpensLeft(false);
      return;
    }
    setSubmenuOpensLeft((submenuRef.current?.getBoundingClientRect().right ?? 0) > window.innerWidth);
  }, [openSubmenuId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const activeSubmenu = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-task-submenu]");
    if (event.key === "Escape" && activeSubmenu) {
      event.preventDefault();
      event.stopPropagation();
      setOpenSubmenuId(null);
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-task-submenu-toggle="${activeSubmenu.dataset.taskSubmenu}"]`)?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && activeSubmenu) {
      event.preventDefault();
      setOpenSubmenuId(null);
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-task-submenu-toggle="${activeSubmenu.dataset.taskSubmenu}"]`)?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const lastIndex = items.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? lastIndex
        : event.key === "ArrowUp"
          ? (activeIndex <= 0 ? lastIndex : activeIndex - 1)
          : (activeIndex >= lastIndex ? 0 : activeIndex + 1);
    items[nextIndex]?.focus();
  };


  /*
  FNXC:NativeUiCollections 2026-09-15-00:20:
  REMOVED: the duplicate in-boundary task-actions menu. With the native presentation there is ONE menu
  implementation, and it is the richer of the two former variants — it keeps `renderAction`, the `role`
  override, left-opening submenu placement and non-focusable note rows, while the shared `UiMenu` now
  provides focus entry and restoration for every caller (card, detail and list) unconditionally.
  */
  return (
    <UiMenu ref={menuRef} className={className} aria-label="Task actions" role={role} onKeyDown={handleKeyDown}>
      {actions.map((item) => {
        if ("items" in item) {
          const isOpen = openSubmenuId === item.id;
          return (
            <div className="task-context-menu__submenu-parent" key={item.id}>
              <UiMenuItem
                id={`${item.id}-submenu`}
                type="button"
                className={`${itemClassName} task-context-menu__submenu-toggle`}
                role={role === "menu" ? "menuitem" : undefined}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                data-task-submenu-toggle={item.id}
                onClick={() => setOpenSubmenuId((current) => current === item.id ? null : item.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setOpenSubmenuId(item.id);
                }}
              >
                {item.label}
              </UiMenuItem>
              {isOpen && (
                <UiMenu
                  ref={submenuRef}
                  className={`task-context-menu__submenu${submenuOpensLeft ? " task-context-menu__submenu--opens-left" : ""}`}
                  aria-label={item.label}
                  data-task-submenu={item.id}
                >
                  {item.items.map((action) => {
                    const classes = [itemClassName, "task-context-menu__submenu-item"];
                    if (action.tone === "danger") classes.push(dangerItemClassName);
                    return (
                      <UiMenuItem
                        key={action.id}
                        id={action.id}
                        type="button"
                        className={classes.join(" ")}
                        role={role === "menu" ? "menuitem" : undefined}
                        disabled={action.disabled}
                        data-testid={action.testId}
                        aria-pressed={action.pressed}
                        onPointerUp={(event) => handleActionPointerUp(event, action)}
                        onClick={(event) => handleActionClick(event, action)}
                      >
                        {action.label}
                      </UiMenuItem>
                    );
                  })}
                </UiMenu>
              )}
            </div>
          );
        }
        const action = item;
        const classes = [itemClassName];
        if (action.tone === "danger") classes.push(dangerItemClassName);
        if (action.tone === "note") classes.push(noteItemClassName);
        const defaultNode = action.tone === "note" ? (
          <span key={action.id} className={classes.join(" ")} role="note" data-testid={action.testId}>{action.label}</span>
        ) : (
          <UiMenuItem key={action.id} id={action.id} type="button" className={classes.join(" ")} role={role === "menu" ? "menuitem" : undefined} disabled={action.disabled} data-testid={action.testId} aria-pressed={action.pressed} onPointerUp={(event) => handleActionPointerUp(event, action)} onClick={(event) => handleActionClick(event, action)}>{action.label}</UiMenuItem>
        );
        return <Fragment key={action.id}>{renderAction ? renderAction(action, defaultNode) : defaultNode}</Fragment>;
      })}
    </UiMenu>
  );
}
