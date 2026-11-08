import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useEngineStatus } from "../hooks/useEngineStatus";
import { Banner } from "./Banner";
import { formatDurationMs } from "../utils/taskTiming";
import "./EngineStatusBanner.css";

interface EngineStatusBannerProps {
  projectId: string;
}

/*
 * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
 * A start attempt is reported against a 10-second poll, so an attempt with no stage is not evidence
 * that nothing is happening - it is evidence that the attempt is still queued. These are the stages an
 * attempt can be observed at, and the two boundaries past which the panel stops saying "starting" and
 * starts naming the wait. Below the stall floor the panel keeps the plain starting copy; above it the
 * operator sees the awaited boundary, because a stalled start is otherwise indistinguishable from a
 * slow one.
 */
const START_STALL_FLOOR_MS = 30_000;
const START_TIMEOUT_FLOOR_MS = 10_000;

const START_STAGE_KEYS: Record<string, string> = {
  "registry-read": "engineBanner.stageRegistryRead",
  "working-directory": "engineBanner.stageWorkingDirectory",
  "startup-concurrency": "engineBanner.stageStartupConcurrency",
  "singleton-acquire": "engineBanner.stageSingletonAcquire",
  "runtime-start": "engineBanner.stageRuntimeStart",
  "started-hook": "engineBanner.stageStartedHook",
  complete: "engineBanner.stageComplete",
};

/*
 * FNXC:EngineStatusBanner 2026-06-22-00:00:
 * The project banner stack needs a single visible remediation when the dashboard is loaded but the current project's engine is absent. Hide the entire component once `connected` is true so no empty wrapper, button shell, or stale aria surface remains in the DOM.
 */
export function EngineStatusBanner({ projectId }: EngineStatusBannerProps) {
  const { t } = useTranslation("app");
  const { status, canStart, canResume, starting, error, start } = useEngineStatus(projectId);

  if (!status || status.connected) return null;

  const isDashboardOnly = status.reason === "dashboard-only" || status.reason === "unreachable";
  const isExternallyOwned = status.reason === "externally-owned";
  const isPaused = status.reason === "paused";
  const startFailed = status.reason === "start-failed" ? status.lastStartFailure : undefined;

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
   * An engine owned by another process is positive proof of life, not an outage, so it must not read
   * with the error dot. The dot now tracks the state: connecting while an attempt is in flight or
   * another process owns the engine, error only when the project genuinely is not running.
   */
  const statusDotClass = starting || isExternallyOwned
    ? "status-dot status-dot--connecting"
    : "status-dot status-dot--error";

  const body = (() => {
    if (isDashboardOnly) {
      return t("engineBanner.dashboardOnly", "This dashboard cannot start engines from the current process. Run `fn serve` for this project to enable task execution and live automation.");
    }
    if (isExternallyOwned) {
      return t("engineBanner.otherProcess", "Another fusion process is running this project's engine. This dashboard is connected to the API but does not own the engine.");
    }
    if (isPaused) {
      return t("engineBanner.paused", "This project is paused, so its engine is not running. Resume it to restore task automation.");
    }
    if (starting) {
      const ageMs = status.startingAgeMs ?? 0;
      if (ageMs >= START_STALL_FLOOR_MS && status.startingStage) {
        return t("engineBanner.startingWithAge", "Starting for {{age}}… ({{stage}})", {
          age: formatDurationMs(ageMs),
          stage: t(START_STAGE_KEYS[status.startingStage] ?? "engineBanner.stageRuntimeStart", "starting the engine runtime"),
        });
      }
      if (ageMs >= START_TIMEOUT_FLOOR_MS) {
        // Past the configured deadline with no stage recorded: still an attempt, but a nameless one.
        return t("engineBanner.stalledNoReason", "The last engine start did not complete, and no reason was recorded.");
      }
      return t("engineBanner.starting", "Starting…");
    }
    if (canStart) {
      return t("engineBanner.body", "The engine for this project is not running, so task automation and live updates may be paused. Start it now to reconnect the dashboard.");
    }
    return t("engineBanner.dashboardOnly", "This dashboard cannot start engines from the current process. Run `fn serve` for this project to enable task execution and live automation.");
  })();

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
   * `canStart: true` used to be a constant, so the panel could offer "Start engine" for a project that
   * was already starting, already owned elsewhere, or simply working. The action now appears only when
   * the server says starting is possible, and a deliberately paused project gets its own verb: the
   * route resumes a paused project rather than starting it, and that recovery path has to stay
   * reachable now that `canStart` is honest about paused projects.
   */
  const action = canStart || starting || canResume
    ? (
      <button
        type="button"
        className="btn btn-primary btn-sm engine-status-banner__start"
        onClick={() => void start()}
        disabled={starting}
        data-testid="engine-status-start-button"
      >
        {starting ? <Loader2 className="spinner" aria-hidden="true" /> : null}
        {starting
          ? t("engineBanner.starting", "Starting…")
          : canResume && !canStart
            ? t("engineBanner.startResume", "Resume engine")
            : t("engineBanner.startCta", "Start engine")}
      </button>
    )
    : null;

  return (
    <Banner
      as="section"
      className="engine-status-banner"
      tone="warning"
      icon={<div className="engine-status-banner__indicator" aria-hidden="true"><span className={statusDotClass} /></div>}
      title={<div className="engine-status-banner__title">{t("engineBanner.title", "Project engine is not connected")}</div>}
      role="status"
      aria-live="polite"
      data-testid="engine-status-banner"
      actions={action}
    >
      <p className="engine-status-banner__body">
        {isDashboardOnly ? (
          <>
            {t("engineBanner.dashboardOnlyPrefix", "This dashboard cannot start engines from the current process. Run")} <code>fn serve</code> {t("engineBanner.dashboardOnlySuffix", "for this project to enable task execution and live automation.")}
          </>
        ) : body}
      </p>
      {startFailed && (
        <p className="engine-status-banner__error" role="status">
          {t("engineBanner.stalled", "Last start failed {{when}}: {{reason}}", {
            when: formatDurationMs(Math.max(0, Date.now() - Date.parse(startFailed.at))),
            reason: startFailed.message,
          })}
        </p>
      )}
      {error && <p className="engine-status-banner__error" role="alert">{t("engineBanner.error", "Start failed: {{message}}", { message: error })}</p>}
    </Banner>
  );
}
