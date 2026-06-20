import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power } from "lucide-react";
import type { ColorTheme, ThemeMode } from "@fusion/core";
import { fetchConfig, fetchSettings, updateSettings } from "../../api/legacy";
import { useAppSettings } from "../../hooks/useAppSettings";
import { ThemeDropdown } from "../ThemeDropdown";
import "./CommandCenterControls.css";

export interface CommandCenterControlsProps {
  projectId?: string;
  colorTheme: ColorTheme;
  themeMode: ThemeMode;
  onColorThemeChange: (theme: ColorTheme) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
}

type AsyncState<T> =
  | { status: "loading"; data: T | null; error: null }
  | { status: "loaded"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

type ConcurrencyValues = {
  maxConcurrent: number;
  maxTriageConcurrent: number;
  maxWorktrees: number;
};

const CONCURRENCY_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_CONCURRENCY_VALUES: ConcurrencyValues = {
  maxConcurrent: 2,
  maxTriageConcurrent: 1,
  maxWorktrees: 5,
};

/*
FNXC:CommandCenter 2026-06-19-13:45:
Overview controls keep only global AI engine, Theme, and Concurrency controls. Agent org chart and Heartbeat control belong to the Team tab so team-specific hierarchy and scheduler heartbeat affordances are not duplicated across Command Center sections.
*/
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function StatusPill({ paused, label }: { paused: boolean; label: string }) {
  return (
    <span className="cc-controls-status-pill">
      <span className={`status-dot ${paused ? "status-dot--pending" : "status-dot--online"}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function CommandCenterControls({ projectId, colorTheme, themeMode, onColorThemeChange, onThemeModeChange }: CommandCenterControlsProps) {
  const { t } = useTranslation("app");
  const {
    globalPaused,
    toggleGlobalPause,
    refresh,
  } = useAppSettings(projectId);
  const [concurrencyState, setConcurrencyState] = useState<AsyncState<ConcurrencyValues>>({ status: "loading", data: null, error: null });
  const [concurrencyDirty, setConcurrencyDirty] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    setConcurrencyDirty(false);
    setConcurrencySaveState("idle");
    setConcurrencyState({ status: "loading", data: null, error: null });
    void (async () => {
      try {
        const [config, settings] = await Promise.all([fetchConfig(projectId), fetchSettings(projectId)]);
        if (!cancelled) {
          setConcurrencyState({
            status: "loaded",
            data: {
              maxConcurrent: clamp(settings.maxConcurrent ?? config.maxConcurrent ?? DEFAULT_CONCURRENCY_VALUES.maxConcurrent, 1, 10),
              maxTriageConcurrent: clamp(settings.maxTriageConcurrent ?? DEFAULT_CONCURRENCY_VALUES.maxTriageConcurrent, 1, 10),
              maxWorktrees: clamp(settings.maxWorktrees ?? DEFAULT_CONCURRENCY_VALUES.maxWorktrees, 1, 20),
            },
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setConcurrencyState({
            status: "error",
            data: DEFAULT_CONCURRENCY_VALUES,
            error: error instanceof Error ? error.message : t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings"),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  useEffect(() => {
    if (!concurrencyDirty || !concurrencyState.data) return;
    const values = concurrencyState.data;
    const timeoutId = setTimeout(() => {
      setConcurrencySaveState("saving");
      void updateSettings(values, projectId)
        .then(async () => {
          await refresh();
          setConcurrencyDirty(false);
          setConcurrencySaveState("saved");
        })
        .catch(() => {
          setConcurrencySaveState("error");
        });
    }, CONCURRENCY_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [concurrencyDirty, concurrencyState.data, projectId, refresh]);

  const updateConcurrencyValue = (key: keyof ConcurrencyValues, rawValue: string, min: number, max: number) => {
    const nextValue = clamp(Number(rawValue), min, max);
    setConcurrencyState((current) => ({
      status: "loaded",
      data: { ...(current.data ?? DEFAULT_CONCURRENCY_VALUES), [key]: nextValue },
      error: null,
    }));
    setConcurrencyDirty(true);
    setConcurrencySaveState("idle");
  };

  const effectiveGlobalPaused = globalPaused;
  const concurrencyValues = concurrencyState.data ?? DEFAULT_CONCURRENCY_VALUES;

  /*
  FNXC:CommandCenter 2026-06-19-12:35:
  The Command Center concurrency sliders mutate live scheduler limits through the existing /api/settings path; after each debounced save, refresh useAppSettings so the running dashboard reflects the new scheduler capacity without local shadow state drifting.

  FNXC:CommandCenter 2026-06-19-12:30:
  Engine controls stop/start all AI work via globalPause. Heartbeat pause/resume moved to TeamArea but still reuses useAppSettings there so Command Center does not add backend routes or competing scheduler state.
  */
  return (
    <section className="cc-controls" data-testid="command-center-controls" aria-label={t("commandCenter.controls.title", "Operator controls")}>
      <div className="cc-controls-grid">
        <section className="card cc-controls-card" data-testid="cc-controls-engine">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.engine.title", "AI engine")}</h3>
              <p>{t("commandCenter.controls.engine.description", "Stopping the engine halts all AI work.")}</p>
            </div>
            <StatusPill
              paused={effectiveGlobalPaused}
              label={effectiveGlobalPaused ? t("commandCenter.controls.status.stopped", "Stopped") : t("commandCenter.controls.status.running", "Running")}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary cc-controls-action"
            onClick={() => void toggleGlobalPause()}
          >
            <Power size={16} aria-hidden="true" />
            <span>
              {effectiveGlobalPaused
                ? t("header.startAiEngine", "Start AI Engine")
                : t("header.stopAiEngine", "Stop AI Engine")}
            </span>
          </button>
        </section>

        <section className="card cc-controls-card" data-testid="cc-controls-theme">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.theme.title", "Theme")}</h3>
              <p>{t("commandCenter.controls.theme.description", "Switch the dashboard theme with live color previews.")}</p>
            </div>
          </div>
          <ThemeDropdown
            colorTheme={colorTheme}
            themeMode={themeMode}
            onColorThemeChange={onColorThemeChange}
            onThemeModeChange={onThemeModeChange}
          />
        </section>

        <section className="card cc-controls-card cc-controls-card--concurrency" data-testid="cc-controls-concurrency">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.concurrency.title", "Concurrency")}</h3>
              <p>{t("commandCenter.controls.concurrency.description", "Tune live scheduler capacity.")}</p>
            </div>
            <span className={`cc-controls-save-state cc-controls-save-state--${concurrencySaveState}`} aria-live="polite">
              {concurrencyState.status === "loading"
                ? t("commandCenter.controls.status.loading", "Loading…")
                : concurrencySaveState === "saving"
                  ? t("commandCenter.controls.status.saving", "Saving…")
                  : concurrencySaveState === "saved"
                    ? t("commandCenter.controls.status.saved", "Saved")
                    : concurrencySaveState === "error"
                      ? t("commandCenter.controls.status.saveError", "Save failed")
                      : t("commandCenter.controls.status.ready", "Ready")}
            </span>
          </div>
          <div className="cc-controls-sliders">
            <label className="cc-controls-slider" htmlFor="cc-max-concurrent">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxConcurrent", "Max concurrent tasks")}
                <strong>{concurrencyValues.maxConcurrent}</strong>
              </span>
              <input
                id="cc-max-concurrent"
                type="range"
                min={1}
                max={10}
                value={concurrencyValues.maxConcurrent}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue("maxConcurrent", event.target.value, 1, 10)}
              />
            </label>
            <label className="cc-controls-slider" htmlFor="cc-max-triage-concurrent">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxTriageConcurrent", "Max triage concurrent")}
                <strong>{concurrencyValues.maxTriageConcurrent}</strong>
              </span>
              <input
                id="cc-max-triage-concurrent"
                type="range"
                min={1}
                max={10}
                value={concurrencyValues.maxTriageConcurrent}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue("maxTriageConcurrent", event.target.value, 1, 10)}
              />
            </label>
            <label className="cc-controls-slider" htmlFor="cc-max-worktrees">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxWorktrees", "Max worktrees")}
                <strong>{concurrencyValues.maxWorktrees}</strong>
              </span>
              <input
                id="cc-max-worktrees"
                type="range"
                min={1}
                max={20}
                value={concurrencyValues.maxWorktrees}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue("maxWorktrees", event.target.value, 1, 20)}
              />
            </label>
          </div>
          {concurrencyState.status === "error" ? <p className="cc-controls-error" role="alert">{concurrencyState.error}</p> : null}
        </section>
      </div>
    </section>
  );
}
