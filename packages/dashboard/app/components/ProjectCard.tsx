import { memo, useCallback, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Play, Power, Square, Trash2, Folder, ArrowRight, PowerOff } from "lucide-react";
import "./ProjectCard.css";
import type { RegisteredProject, ProjectHealth } from "@fusion/core";
import type { ProjectNodeAvailability } from "../api";
import { getProjectStatusConfig, isInitializingStatus } from "../utils/projectStatusConfig";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

/*
FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
The projects projection gained `runtimeEnabled` beside `status`; the core registry row predates it, so
the card widens the type locally instead of pushing a route projection into the domain model.
Absent means enabled, which is `isProjectRuntimeEnabled`'s own default.
*/
export type ProjectCardEntry = RegisteredProject & { runtimeEnabled?: boolean };

export interface ProjectCardProps {
  project: ProjectCardEntry;
  health: ProjectHealth | null;
  onSelect: (project: ProjectCardEntry) => void;
  onPause: (project: ProjectCardEntry) => void;
  onResume: (project: ProjectCardEntry) => void;
  onRemove: (project: ProjectCardEntry) => void;
  /**
   * Writes the project's engine-runtime switch to the requested state.
   *
   * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
   * Optional so every existing host compiles unchanged, but it is the reason a turned-off project is
   * still listed anywhere: without a turn-on affordance on the surface that names the state, the only
   * way back on was the footer menu of the project you were already inside.
   *
   * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
   * The card control is a real TOGGLE now: `enabled` carries the desired state, `false` unloads the
   * runtime and `true` re-arms it. It stays ONE callback rather than a second disable pipeline, so the
   * card cannot hold two owners that disagree about which request a press sends. `enabled` is optional
   * (and defaults to `true` in the handler) only so a host written before the toggle era keeps its
   * meaning; this card always passes an explicit direction. The name keeps the historical
   * `onEnableRuntime` spelling because the host-side prop names (`onEnableProjectRuntime`) are owned
   * outside this slice.
   */
  onEnableRuntime?: (project: ProjectCardEntry, enabled?: boolean) => void | Promise<void>;
  availabilityMappings?: Array<ProjectNodeAvailability & { displayName: string }>;
  /** Health is being fetched, while project navigation and controls remain available. */
  healthLoading?: boolean;
  isLoading?: boolean;
}

function formatRelativeTime(timestamp: string | undefined, t: TFunction<"app">): string {
  if (!timestamp) return t("projectCard.never", "Never");

  /*
   * FNXC:RelativeTime 2026-06-17-20:48:
   * FN-6618 reuses shared relative-time buckets while preserving ProjectCard's Never guard, projectCard.* i18n keys, future-as-Just-now behavior, and no-options date fallback.
   */
  const bucket = getRelativeTimeBucket(timestamp);
  if (!bucket) {
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && Date.now() - timestampMs < 0) return t("projectCard.justNow", "Just now");
    return new Date(timestamp).toLocaleDateString();
  }

  switch (bucket.bucket) {
    case "just-now":
      return t("projectCard.justNow", "Just now");
    case "minutes":
      return t("projectCard.minutesAgo", "{{count}}m ago", { count: bucket.count });
    case "hours":
      return t("projectCard.hoursAgo", "{{count}}h ago", { count: bucket.count });
    case "days":
      return t("projectCard.daysAgo", "{{count}}d ago", { count: bucket.count });
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString();
  }
}

function truncatePath(path: string, maxLength: number = 40): string {
  if (path.length <= maxLength) return path;
  const start = path.slice(0, Math.floor(maxLength / 2) - 2);
  const end = path.slice(-Math.floor(maxLength / 2) + 2);
  return `${start}...${end}`;
}

function areProjectCardPropsEqual(previous: ProjectCardProps, next: ProjectCardProps): boolean {
  if (previous.project.id !== next.project.id) return false;
  if (previous.project.status !== next.project.status) return false;
  if (previous.project.name !== next.project.name) return false;
  if (previous.project.path !== next.project.path) return false;
  if (previous.project.lastActivityAt !== next.project.lastActivityAt) return false;
  /*
  FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
  The runtime gate is its own comparison on purpose. This memo comparator is why a card can keep
  showing a stale label: turning the runtime back on changes ONLY this field, and without this line
  the memo would swallow the refresh and the operator would still see "Runtime off".
  */
  if (previous.project.runtimeEnabled !== next.project.runtimeEnabled) return false;
  if (previous.isLoading !== next.isLoading) return false;
  if (previous.healthLoading !== next.healthLoading) return false;

  // Compare health
  const prevHealth = previous.health;
  const nextHealth = next.health;
  if (!prevHealth && !nextHealth) return true;
  if (!prevHealth || !nextHealth) return false;
  
  if (
    prevHealth.activeTaskCount !== nextHealth.activeTaskCount ||
    prevHealth.inFlightAgentCount !== nextHealth.inFlightAgentCount ||
    prevHealth.totalTasksCompleted !== nextHealth.totalTasksCompleted ||
    prevHealth.totalTasksFailed !== nextHealth.totalTasksFailed ||
    prevHealth.status !== nextHealth.status
  ) {
    return false;
  }

  const prevMappings = previous.availabilityMappings ?? [];
  const nextMappings = next.availabilityMappings ?? [];
  if (prevMappings.length !== nextMappings.length) return false;

  return prevMappings.every((mapping, index) => {
    const nextMapping = nextMappings[index];
    return Boolean(nextMapping)
      && mapping.nodeId === nextMapping.nodeId
      && mapping.path === nextMapping.path
      && mapping.displayName === nextMapping.displayName
      && mapping.available === nextMapping.available;
  });
}

function ProjectCardInner({
  project,
  health,
  onSelect,
  onPause,
  onResume,
  onRemove,
  onEnableRuntime,
  availabilityMappings = [],
  healthLoading = false,
  isLoading = false,
}: ProjectCardProps) {
  const { t } = useTranslation("app");
  const [removeArmed, setRemoveArmed] = useState(false);
  /*
   * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
   * Which direction the in-flight runtime request is heading, or null when none is. It is a direction
   * rather than a boolean because the pending label must read "Turning runtime off…" on the off-
   * affordance and "…on…" on the on-affordance, and the card must never show a spinner on a control
   * the operator did not press. Cleared when the host's promise settles; the refreshed `runtimeEnabled`
   * prop is what actually changes the card, this only covers the window before it arrives.
   */
  const [runtimePending, setRuntimePending] = useState<"on" | "off" | null>(null);
  const statusConfig = getProjectStatusConfig(project.status);
  const StatusIcon = statusConfig.icon;

  const handleSelect = useCallback(() => {
    onSelect(project);
  }, [onSelect, project]);

  const handlePause = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPause(project);
  }, [onPause, project]);

  const handleResume = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onResume(project);
  }, [onResume, project]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }

    onRemove(project);
    setRemoveArmed(false);
  }, [removeArmed, onRemove, project]);

  /*
   * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
   * One press, one direction, one request. The runtime toggle never routes through `onPause` /
   * `onResume`: `status` (paused/active) and `runtimeEnabled` (loaded/unloaded) are different axes and
   * unloading an engine must not pause the project row. The pending flag is set only for hosts that
   * actually report a promise, so a synchronous host leaves no stuck spinner.
   */
  const requestRuntimeState = useCallback((e: React.MouseEvent, enabled: boolean) => {
    e.stopPropagation();
    if (!onEnableRuntime) return;
    const outcome = onEnableRuntime(project, enabled);
    if (!outcome || typeof outcome.then !== "function") return;
    setRuntimePending(enabled ? "on" : "off");
    void outcome.then(
      () => setRuntimePending(null),
      () => setRuntimePending(null),
    );
  }, [onEnableRuntime, project]);

  /*
   * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
   * The runtime gate is a SECOND axis beside `status`. `status: "paused"` means the operator paused the
   * project row; `runtimeEnabled: false` means they unloaded the engine runtime so the project does no
   * engine work at all — the switch that stops the minute-long passes. Production had 5 of 25 projects
   * in that state with nothing on any list surface saying so.
   */
  const isRuntimeOff = project.runtimeEnabled === false;

  /*
   * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
   * The affordance is the exact inverse of the badge condition above, so the label and the state can
   * never disagree: an unloaded card offers to load, a loaded card offers to unload. Pressing always
   * requests the opposite of what the card shows. `runtimeState: "unknown"` is not treated as off here,
   * because nothing on this surface may claim to unload a runtime it never confirmed running — it reads
   * as enabled, which is the gate's own default.
   */
  const requestedRuntimeState = isRuntimeOff;
  const runtimePendingHere = runtimePending !== null && runtimePending === (isRuntimeOff ? "on" : "off");
  /* The pressed control relabels itself; label and accessible name must be the same words. */
  const runtimeLabel = runtimePendingHere
    ? (isRuntimeOff
      ? t("projectCard.runtimeEnabling", "Turning runtime on…")
      : t("projectCard.runtimeDisabling", "Turning runtime off…"))
    : (isRuntimeOff
      ? t("projectCard.enableRuntime", "Turn runtime on")
      : t("projectCard.disableRuntime", "Turn runtime off"));

  const isPaused = project.status === "paused";
  const isErrored = project.status === "errored";
  const isInitializing = isInitializingStatus(project.status);

  return (
    <div
      className={`project-card ${isLoading ? "project-card-loading" : ""} ${isErrored ? "project-card-errored" : ""}`}
      onClick={handleSelect}
      data-project-id={project.id}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="project-card-header">
        <div className="project-card-icon">
          <Folder size={20} />
        </div>
        <div className="project-card-title-section">
          <h3 className="project-card-name" title={project.name}>
            {project.name}
          </h3>
          {availabilityMappings.length > 0 && (
            <div className="project-card-availability" aria-label={t("projectCard.nodeAvailability", "Project node availability")}>
              {availabilityMappings.slice(0, 3).map((mapping) => (
                <div key={`${mapping.nodeId}-${mapping.path}`} className="project-card-availability__row" title={`${mapping.displayName} → ${mapping.path}`}>
                  <span className="project-card-availability__node">{mapping.displayName}</span>
                  <span className="project-card-availability__arrow">→</span>
                  <code className="project-card-availability__path">{truncatePath(mapping.path, 28)}</code>
                </div>
              ))}
              {availabilityMappings.length > 3 && (
                <span className="project-card-availability__more">{t("projectCard.moreItems", "+{{count}} more", { count: availabilityMappings.length - 3 })}</span>
              )}
            </div>
          )}
          <span className="project-card-path" title={project.path}>
            {truncatePath(project.path)}
          </span>
        </div>
        <div
          className="project-card-status-badge"
          style={{ color: statusConfig.color, borderColor: statusConfig.color }}
        >
          <StatusIcon size={12} className={isInitializing ? "animate-spin" : ""} />
          <span>{statusConfig.label}</span>
        </div>
        {/*
         * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
         * A second instance of the SAME badge primitive (`.project-card-status-badge`), tinted with the
         * muted text token rather than a new badge class, so the runtime axis is readable at a glance
         * without forking a parallel style. Absent for a loaded project: silence means running here.
         */}
        {isRuntimeOff && (
          <div
            className="project-card-status-badge"
            style={{ color: "var(--text-muted)", borderColor: "var(--text-muted)" }}
            title={t("projectCard.runtimeOffTitle", "Engine runtime unloaded — this project does no engine work")}
            data-project-state="off"
            data-testid="project-runtime-state"
          >
            <PowerOff size={12} />
            <span>{t("projectCard.runtimeOff", "Runtime off")}</span>
          </div>
        )}
      </div>

      <div className="project-card-health">
        {health && (
          <>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.activeTaskCount}</span>
              <span className="project-card-metric-label">{t("projectCard.activeTasks", "Active Tasks")}</span>
            </div>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.inFlightAgentCount}</span>
              <span className="project-card-metric-label">{t("projectCard.agents", "Agents")}</span>
            </div>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.totalTasksCompleted}</span>
              <span className="project-card-metric-label">{t("projectCard.completed", "Completed")}</span>
            </div>
          </>
        )}
        {!health && (
          <div className="project-card-metric project-card-metric-empty">
            <span className="project-card-metric-label">
              {healthLoading
                ? t("projectCard.healthLoading", "Loading health metrics")
                : t("projectCard.noHealthData", "No health data available")}
            </span>
          </div>
        )}
      </div>

      <div className="project-card-footer">
        <div className="project-card-activity">
          <span className="project-card-activity-label">{t("projectCard.lastActivity", "Last activity:")} </span>
          <span className="project-card-activity-time">
            {formatRelativeTime(project.lastActivityAt || health?.lastActivityAt, t)}
          </span>
        </div>

        <div className="project-card-actions">
          {/*
           * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
           * It appears only when the host can act, and it reuses the card's existing action-button
           * classes — no new button variant. The action name says RUNTIME, never "start engine": the
           * pause control below is a different switch and the two must not be confusable.
           *
           * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
           * The same control now runs BOTH ways, which is what the measured gap was: the operator could
           * read "Runtime off" and re-arm a project from the card, but unloading one meant leaving the
           * card and finding the footer engine menu of the project you were already inside. One button,
           * one request shape, direction carried by `requestedRuntimeState`. The off direction is
           * deliberately NOT armed behind a confirmation and is NOT styled as destructive: unloading the
           * runtime stops engine work from the next pass, aborts nothing, and leaves board, cards and
           * history readable, so it keeps the neutral base colour rather than the remove/pause tints.
           * While its own request is in flight it is disabled and announces `aria-busy` with a pending
           * label, so the press is never double-fired and never looks ignored.
           */}
          {onEnableRuntime && (
            <button
              className={`project-card-action ${isRuntimeOff ? "project-card-action-resume" : ""}`}
              onClick={(e) => requestRuntimeState(e, requestedRuntimeState)}
              disabled={isLoading || runtimePendingHere}
              aria-busy={runtimePendingHere || undefined}
              data-runtime-pending={runtimePendingHere ? "true" : undefined}
              data-runtime-direction={isRuntimeOff ? "on" : "off"}
              title={isRuntimeOff
                ? t("projectCard.enableRuntime", "Turn runtime on")
                : t("projectCard.disableRuntimeTitle", "Turn runtime off: the engine stops working on this project from the next pass. Nothing is aborted, and the board, cards and history stay readable.")}
              aria-label={runtimeLabel}
              data-testid={isRuntimeOff ? "project-runtime-enable" : "project-runtime-disable"}
            >
              {isRuntimeOff ? <Power size={14} /> : <PowerOff size={14} />}
              <span>{runtimeLabel}</span>
            </button>
          )}
          {/*
           * FNXC:ProjectCardEngineControls 2026-06-27-00:00:
           * ProjectEngineManager.pauseProject already calls engine.stop(), so the card action names the engine-lifecycle action as Stop engine/Start engine while preserving the active/paused project status model and pauseProject/resumeProject wiring.
           */}
          {isPaused ? (
            <button
              className="project-card-action project-card-action-resume"
              onClick={handleResume}
              disabled={isLoading}
              title={t("projectCard.resumeProject", "Start engine")}
              aria-label={t("projectCard.resumeProject", "Start engine")}
            >
              <Play size={14} />
              <span>{t("projectCard.resume", "Start engine")}</span>
            </button>
          ) : (
            <button
              className="project-card-action project-card-action-pause"
              onClick={handlePause}
              disabled={isLoading || isInitializing}
              title={isInitializing ? t("projectCard.cannotPauseWhileInitializing", "Cannot stop engine while initializing") : t("projectCard.pauseProject", "Stop engine")}
              aria-label={t("projectCard.pauseProject", "Stop engine")}
            >
              <Square size={14} />
              <span>{t("projectCard.pause", "Stop engine")}</span>
            </button>
          )}
          
          <button
            className="project-card-action project-card-action-open"
            onClick={handleSelect}
            disabled={isLoading}
            title={t("projectCard.openProject", "Open project")}
            aria-label={t("projectCard.openProject", "Open project")}
          >
            <ArrowRight size={14} />
            <span>{t("projectCard.open", "Open")}</span>
          </button>

          <button
            className={`project-card-action project-card-action-remove ${removeArmed ? "is-armed" : ""}`}
            onClick={handleRemove}
            disabled={isLoading}
            title={removeArmed ? t("projectCard.confirmRemove", "Confirm remove") : t("projectCard.removeProject", "Remove project")}
            aria-label={removeArmed ? t("projectCard.confirmRemoveProject", "Confirm remove project") : t("projectCard.removeProject", "Remove project")}
          >
            <Trash2 size={14} />
            <span>{removeArmed ? t("projectCard.confirm", "Confirm") : ""}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export const ProjectCard = memo(ProjectCardInner, areProjectCardPropsEqual);
