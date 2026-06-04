import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import { useConfirm } from "../hooks/useConfirm";
import type { Task, TaskDetail, Column as ColumnType, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS, getErrorMessage } from "@fusion/core";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { PluginSlot } from "./PluginSlot";
import { groupByWorktree } from "../utils/worktreeGrouping";
import type { ToastType } from "../hooks/useToast";
import { ChevronDown, ChevronUp, Archive, MoreVertical } from "lucide-react";
import type { ModelInfo } from "../api";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";

const PAGINATED_COLUMN_THRESHOLD = 100;
const VISIBLE_TASKS_INITIAL = 50;
const VISIBLE_TASKS_INCREMENT = 25;

interface ColumnProps {
  column: ColumnType;
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  onMoveTask: (id: string, column: ColumnType, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask?: () => void;
  autoMerge?: boolean;
  onToggleAutoMerge?: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onArchiveAllDone?: () => Promise<Task[]>;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  allTasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string) => void;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /** When true, search is active — bypass pagination so all matching tasks are visible. */
  isSearchActive?: boolean;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Lookup of workflow step IDs to display names, fetched once at board level. */
  workflowStepNameLookup?: ReadonlyMap<string, string>;
  /** Precomputed blocker fanout keyed by blocker task ID. */
  blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry>;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
}

function ColumnComponent({ column, tasks, projectId, maxConcurrent, onMoveTask, onPauseTask, onOpenDetail, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, onToggleAutoMerge, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onDeleteTask, onArchiveAllDone, collapsed, onToggleCollapse, allTasks, availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, taskStuckTimeoutMs, onOpenMission, lastFetchTimeMs, workflowStepNameLookup, blockerFanoutMap, prAuthAvailable }: ColumnProps) {
  const { t } = useTranslation("app");
  const [dragOver, setDragOver] = useState(false);
  const [visibleTaskCount, setVisibleTaskCount] = useState(VISIBLE_TASKS_INITIAL);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  const [isMovingAllToTodo, setIsMovingAllToTodo] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const countFlashing = useFlashOnIncrease(tasks.length);
  const { confirm } = useConfirm();

  // Close the column dropdown menu when the user clicks anywhere else.
  useEffect(() => {
    if (!isMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isMenuOpen]);

  // Archived column is collapsed by default - don't show drag state when collapsed
  const isArchived = column === "archived";
  const isCollapsed = isArchived && collapsed;
  // When search is active, skip pagination so all matching tasks are visible
  const shouldPaginate = !isArchived && !isSearchActive && column !== "in-progress" && tasks.length > PAGINATED_COLUMN_THRESHOLD;

  useEffect(() => {
    setVisibleTaskCount((current) => {
      if (column === "in-progress" || isArchived || tasks.length <= PAGINATED_COLUMN_THRESHOLD) {
        return VISIBLE_TASKS_INITIAL;
      }

      return Math.min(Math.max(current, VISIBLE_TASKS_INITIAL), tasks.length);
    });
  }, [column, isArchived, tasks.length]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Don't allow dropping into archived column via drag-drop
    if (isArchived) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, [isArchived]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;

    // Check if task is already in this column - if so, skip the API call
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.column === column) {
      return; // No-op: task is already in this column
    }

    try {
      const sourceTask = allTasks?.find((t) => t.id === taskId) ?? task;
      const hasStepProgress = sourceTask?.steps.some((step) => step.status !== "pending") ?? false;
      const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;
      let moveOptions: { preserveProgress?: boolean } | undefined;

      if (shouldPrompt) {
        const keepProgress = await confirm({
          title: t("column.preserveProgressTitle", "Preserve Progress?"),
          message: t("column.preserveProgressMessage", "This task has completed steps. Keep progress before moving?"),
          confirmLabel: t("column.keepProgress", "Keep Progress"),
          cancelLabel: t("column.resetProgress", "Reset Progress"),
        });

        if (keepProgress) {
          moveOptions = { preserveProgress: true };
        } else {
          const resetProgress = await confirm({
            title: t("column.resetProgressTitle", "Reset Progress?"),
            message: t("column.resetProgressMessage", "Reset all step progress before moving this task?"),
            confirmLabel: t("column.resetProgressConfirm", "Reset Progress"),
            cancelLabel: t("column.cancelMove", "Cancel Move"),
            danger: true,
          });
          if (!resetProgress) {
            return;
          }
        }
      }

      await onMoveTask(taskId, column, moveOptions);
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [addToast, allTasks, column, confirm, onMoveTask, tasks]);

  const worktreeGroups = useMemo(() => {
    if (column !== "in-progress") return [];
    return groupByWorktree(tasks, tasks, maxConcurrent);
  }, [column, tasks, maxConcurrent]);

  const visibleTasks = useMemo(() => {
    if (!shouldPaginate) return tasks;
    return tasks.slice(0, visibleTaskCount);
  }, [shouldPaginate, tasks, visibleTaskCount]);

  const hiddenTaskCount = Math.max(0, tasks.length - visibleTasks.length);

  const handleLoadMore = useCallback(() => {
    setVisibleTaskCount((current) => Math.min(current + VISIBLE_TASKS_INCREMENT, tasks.length));
  }, [tasks.length]);

  const handleReplanAll = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.replanAllTitle", "Replan All Tasks"),
      message: t("column.replanAllMessage", "Move all {{count}} todo task{{plural}} back to planning to be replanned?", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" }),
    });
    if (!confirmed) return;

    setIsReplanning(true);
    try {
      // Issue moves in parallel — onMoveTask is per-task, no bulk endpoint.
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "triage" as ColumnType)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(t("column.movedToPlanning", "Moved {{count}} task{{plural}} to planning for replanning", { count: moved, plural: moved === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.movePartialFailure", "Moved {{moved}} of {{total}} tasks; {{failed}} failed", { moved, total: results.length, failed }), "error");
      }
    } finally {
      setIsReplanning(false);
    }
  }, [tasks, onMoveTask, addToast, confirm]);

  const pauseEligibleTasks = useMemo(
    () => tasks.filter((task) => !task.paused && !task.assignedAgentId),
    [tasks],
  );
  const pauseEligibleCount = pauseEligibleTasks.length;
  const hasColumnBulkActions = column === "todo" || column === "in-progress" || column === "in-review";
  const isMenuBusy = isReplanning || isPausingAll || isMovingAllToTodo;

  const handlePauseAll = useCallback(async () => {
    if (!onPauseTask) return;

    setIsMenuOpen(false);
    if (pauseEligibleCount === 0) return;

    const confirmed = await confirm({
      title: t("column.stopAllTitle", "Stop All Tasks"),
      message: t("column.stopAllMessage", "Stop all {{count}} {{columnLabel}} task{{plural}}?", { count: pauseEligibleCount, columnLabel: COLUMN_LABELS[column].toLowerCase(), plural: pauseEligibleCount === 1 ? "" : "s" }),
      danger: true,
    });
    if (!confirmed) return;

    setIsPausingAll(true);
    try {
      const results = await Promise.allSettled(
        pauseEligibleTasks.map((task) => onPauseTask(task.id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const paused = results.length - failed;
      if (failed === 0) {
        addToast(t("column.stoppedTasks", "Stopped {{count}} task{{plural}}", { count: paused, plural: paused === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.stopPartialFailure", "Stopped {{paused}} of {{total}} tasks; {{failed}} failed", { paused, total: results.length, failed }), "error");
      }
    } finally {
      setIsPausingAll(false);
    }
  }, [onPauseTask, pauseEligibleCount, column, pauseEligibleTasks, addToast, confirm]);

  const handleMoveAllToTodo = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.moveAllToTodoTitle", "Move All to Todo"),
      message: t("column.moveAllToTodoMessage", "Move all {{count}} {{columnLabel}} task{{plural}} to Todo?", { count: tasks.length, columnLabel: COLUMN_LABELS[column].toLowerCase(), plural: tasks.length === 1 ? "" : "s" }),
    });
    if (!confirmed) return;

    const hasAnyProgress = tasks.some((task) => task.steps.some((step) => step.status !== "pending"));
    let preserveProgress = false;
    if (hasAnyProgress) {
      const keepProgress = await confirm({
        title: t("column.preserveProgressTitle", "Preserve Progress?"),
        message: t("column.preserveProgressMoveTodoMessage", "Some tasks have completed steps. Keep progress before moving to Todo?"),
        confirmLabel: t("column.keepProgress", "Keep Progress"),
        cancelLabel: t("column.resetProgress", "Reset Progress"),
      });

      if (keepProgress) {
        preserveProgress = true;
      } else {
        const resetProgress = await confirm({
          title: t("column.resetProgressTitle", "Reset Progress?"),
          message: t("column.resetProgressMoveTodoMessage", "Reset step progress for tasks before moving to Todo?"),
          confirmLabel: t("column.resetProgressConfirm", "Reset Progress"),
          cancelLabel: t("column.cancelMove", "Cancel Move"),
          danger: true,
        });
        if (!resetProgress) {
          return;
        }
      }
    }

    setIsMovingAllToTodo(true);
    try {
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "todo", preserveProgress ? { preserveProgress: true } : undefined)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(t("column.movedToTodo", "Moved {{count}} task{{plural}} to Todo", { count: moved, plural: moved === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.moveToTodoPartialFailure", "Moved {{moved}} of {{total}} tasks to Todo; {{failed}} failed", { moved, total: results.length, failed }), "error");
      }
    } finally {
      setIsMovingAllToTodo(false);
    }
  }, [tasks, column, onMoveTask, addToast, confirm]);

  const handleArchiveAll = useCallback(async () => {
    if (!onArchiveAllDone) return;
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.archiveAllTitle", "Archive All Done"),
      message: t("column.archiveAllMessage", "Archive all {{count}} done tasks?", { count: tasks.length }),
      danger: true,
    });
    if (!confirmed) return;

    try {
      const archived = await onArchiveAllDone();
      addToast(t("column.archivedTasks", "Archived {{count}} tasks", { count: archived.length }), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("column.failedToArchive", "Failed to archive tasks"), "error");
    }
  }, [onArchiveAllDone, tasks.length, addToast, confirm, t]);

  return (
    <div
      className={`column${dragOver ? " drag-over" : ""}${isArchived ? " column-archived" : ""}${isCollapsed ? " column-collapsed" : ""}`}
      data-column={column}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{COLUMN_LABELS[column]}</h2>
        <span className={`column-count${countFlashing ? " count-flash" : ""}`}>{tasks.length}</span>
        {column === "in-review" && onToggleAutoMerge && (
          <label className="auto-merge-toggle" title={autoMerge ? t("column.autoMergeEnabled", "Auto-merge enabled") : t("column.autoMergeDisabled", "Auto-merge disabled")}>
            <input
              type="checkbox"
              checked={!!autoMerge}
              onChange={onToggleAutoMerge}
            />
            <span className="toggle-slider" />
            <span className="toggle-label">{t("column.autoMerge", "Auto-merge")}</span>
          </label>
        )}
        {onNewTask && (
          <button className="btn btn-task-create btn-sm" onClick={onNewTask}>
            + {t("column.newTask", "New Task")}
          </button>
        )}
        {column === "done" && onArchiveAllDone && (
          <button
            className="btn btn-icon btn-sm"
            onClick={handleArchiveAll}
            disabled={tasks.length === 0}
            title={t("column.archiveAllDoneTitle", "Archive all done tasks")}
            aria-label={t("column.archiveAllDoneAriaLabel", "Archive all done tasks")}
          >
            <Archive />
          </button>
        )}
        {isArchived && onToggleCollapse && (
          <button
            className="btn btn-icon btn-sm"
            onClick={onToggleCollapse}
            title={collapsed ? t("column.expandArchivedTitle", "Expand archived tasks") : t("column.collapseArchivedTitle", "Collapse archived tasks")}
            aria-label={collapsed ? t("column.expandArchivedLabel", "Expand archived tasks") : t("column.collapseArchivedLabel", "Collapse archived tasks")}
          >
            {/* Directional chevrons stay explicit for clearer collapsed-state affordance in compact headers. */}
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        )}
        {hasColumnBulkActions && (
          <div className="column-menu" ref={menuRef}>
            <button
              type="button"
              className="btn btn-icon btn-sm"
              onClick={() => setIsMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-label={t("column.actionsAriaLabel", "{{columnLabel}} column actions", { columnLabel: COLUMN_LABELS[column] })}
              title={t("column.actionsTitle", "Column actions")}
              disabled={isMenuBusy}
            >
              <MoreVertical />
            </button>
            {isMenuOpen && (
              <div className="column-menu-popover" role="menu">
                {column === "todo" && (
                  <button
                    type="button"
                    role="menuitem"
                    className="column-menu-item"
                    onClick={() => void handleReplanAll()}
                    disabled={tasks.length === 0 || isReplanning}
                  >
                    {t("column.replanAll", "Replan All")}
                    <span className="column-menu-item-hint">
                      {t("column.replanAllHint", "Move {{count}} task{{plural}} to Planning", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                    </span>
                  </button>
                )}
                {(column === "in-progress" || column === "in-review") && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handlePauseAll()}
                      disabled={pauseEligibleCount === 0 || isPausingAll || !onPauseTask}
                    >
                      {t("column.stopAll", "Stop All")}
                      <span className="column-menu-item-hint">
                        {tasks.length === 0
                          ? t("column.noTasksInColumn", "No tasks in this column")
                          : pauseEligibleCount === 0
                            ? t("column.noManuallyPausableTasks", "No manually pausable tasks")
                            : t("column.pauseHint", "Pause {{count}} active unassigned task{{plural}}", { count: pauseEligibleCount, plural: pauseEligibleCount === 1 ? "" : "s" })}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handleMoveAllToTodo()}
                      disabled={tasks.length === 0 || isMovingAllToTodo}
                    >
                      {t("column.moveAllToTodo", "Move All to Todo")}
                      <span className="column-menu-item-hint">
                        {t("column.moveToTodoHint", "Move {{count}} task{{plural}} to Todo", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {!isCollapsed && <p className="column-desc">{COLUMN_DESCRIPTIONS[column]}</p>}
      {!isCollapsed && (
        <div className="column-body">
          {column === "triage" && onQuickCreate && (
            <QuickEntryBox 
              onCreate={onQuickCreate} 
              addToast={addToast} 
              tasks={allTasks ?? []}
              availableModels={availableModels}
              onPlanningMode={onPlanningMode}
              onSubtaskBreakdown={onSubtaskBreakdown}
              projectId={projectId}
              autoExpand={false}
              favoriteProviders={favoriteProviders}
              favoriteModels={favoriteModels}
              onToggleFavorite={onToggleFavorite}
              onToggleModelFavorite={onToggleModelFavorite}
              onOpenTask={(taskId) => {
                const matchingTask = (allTasks ?? []).find((candidate) => candidate.id === taskId);
                if (matchingTask) {
                  onOpenDetail(matchingTask);
                  return;
                }
                if (typeof window !== "undefined") {
                  window.location.hash = `#/tasks/${taskId}`;
                }
              }}
            />
          )}
          {column === "in-progress" ? (
            worktreeGroups.length === 0 ? (
              <div className="empty-column">{t("column.noTasks", "No tasks")}</div>
            ) : (
              worktreeGroups.map((group) => (
                <WorktreeGroup
                  key={group.label}
                  label={group.label}
                  activeTasks={group.activeTasks}
                  queuedTasks={group.queuedTasks}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onRetryTask={onRetryTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                  lastFetchTimeMs={lastFetchTimeMs}
                  workflowStepNameLookup={workflowStepNameLookup}
                  blockerFanoutMap={blockerFanoutMap}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={Boolean(autoMerge)}
                />
              ))
            )
          ) : tasks.length === 0 ? (
            <div className="empty-column">{t("column.noTasks", "No tasks")}</div>
          ) : (
            <>
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  onOpenGroupModal={onOpenGroupModal}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onRetryTask={onRetryTask}
                  onArchiveTask={onArchiveTask}
                  onUnarchiveTask={onUnarchiveTask}
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                  onMoveTask={onMoveTask}
                  lastFetchTimeMs={lastFetchTimeMs}
                  workflowStepNameLookup={workflowStepNameLookup}
                  fanout={blockerFanoutMap?.get(task.id)}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={Boolean(autoMerge)}
                />
              ))}
              {shouldPaginate && hiddenTaskCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleLoadMore}
                >
                  {t("column.loadMore", "Load {{count}} more ({{remaining}} remaining)", { count: Math.min(VISIBLE_TASKS_INCREMENT, hiddenTaskCount), remaining: hiddenTaskCount })}
                </button>
              )}
            </>
          )}
          <PluginSlot slotId="board-column-footer" projectId={projectId} />
        </div>
      )}
    </div>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
