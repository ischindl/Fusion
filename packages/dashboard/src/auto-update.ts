import { resolveGlobalDir, resolveUpdateAutomationSettings, resolveUpdatesExternallyManaged } from "@fusion/core";
import type { UpdateChannel } from "@fusion/core";
import { performUpdateCheck, performUpdateInstall } from "./update-check.js";
import type { UpdateCheckResult, UpdateInstallResult } from "./update-check.js";
import { UpdateInstallCoordinator, processUpdateInstallCoordinator } from "./update-install-coordinator.js";

/*
FNXC:AutoUpdate 2026-07-25-10:05:
Unattended update watcher behind the global `autoUpdateAndRestart` setting
(default OFF, Settings → General → Updates, next to the release channel).

Requirement: "add option to auto update and restart on update". When enabled the
host installs an available update by itself — the same channel-aware check and
`npm install -g` path the Settings "Update now" button uses — and then requests
the supervised in-place restart so the newly installed version is the one that
is actually running.

Deliberate constraints:
  - Server-side, not browser-driven: an unattended update must not depend on a
    dashboard tab being open.
  - Hosts that can restart themselves only. Installing replaces the running program's files on
    disk; with nothing to bring the process back, the still-running process would keep lazily
    importing modules from a tree that no longer matches its loaded code. "Nothing to bring it back"
    is now the honest test: since RUFU-513 a launch with no supervising parent can still restart
    itself in-process, so the gate reads the effective capability, not `supervised`.
    No restart path -> skip the install and say so once.
  - Honors `updateCheckEnabled`: an operator who turned update checks off must
    not get network calls (or installs) from this watcher.
  - Never restarts without a successful install, and never installs twice for
    the same version once a restart is already scheduled.
*/

/** Initial delay before the first cycle — keeps boot free of an npm round-trip. */
const DEFAULT_INITIAL_DELAY_MS = 60_000;
/** Steady-state cadence. Independent of `updateCheckFrequency`, which is the cache TTL for *display* surfaces. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

type AutoUpdateSettings = {
  autoUpdateAndRestart?: boolean;
  autoUpdateEnabled?: boolean;
  autoRestartAfterUpdate?: boolean;
  updateCheckEnabled?: boolean;
  updateChannel?: UpdateChannel;
};

export type AutoUpdateOutcome =
  | "disabled"
  | "checks-disabled"
  | "externally-managed"
  /*
  FNXC:AutoUpdate 2026-11-13-09:55 (RUFU-513):
  Renamed from `unsupervised`, which stopped being the reason: a launch with no supervising parent can
  restart itself in-process, so the refusal means NO respawn owner exists at all (no parent, and
  self-restart refused or unavailable), not "no parent". The name carried the old premise.
  */
  | "restart-unsupported"
  | "up-to-date"
  | "check-failed"
  | "install-failed"
  | "unsupported-install-method"
  | "restart-unavailable"
  | "restart-waiting"
  | "restarting";

export interface AutoUpdateLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface AutoUpdateDeps {
  /** Reads the current global settings; failures are treated as "leave it off". */
  getSettings: () => Promise<AutoUpdateSettings>;
  currentVersion: string;
  /*
  FNXC:AutoUpdate 2026-11-13-09:55 (RUFU-513):
  Same contract as the System panel's `restartSupported`: would a restart request actually bring this
  process back? Before this field the lane read `supervised`, so the measured production launch
  (`node --inspect=... dashboard --port 4040 --host 0.0.0.0`, ppid 1) skipped the whole auto-update path
  even though its restart request would have been accepted: the setting was silently inert on the host
  most operators run.
  */
  restartSupported: boolean;
  /** Same contract as the System panel: false when this host refuses the restart request. */
  requestRestart: (reason: string) => boolean;
  log: AutoUpdateLogger;
  fusionDir?: string;
  /** Host-injected checkout root: global npm cannot update this running program. */
  sourceWorkspaceRoot?: string;
  /** Optional deterministic override for the deployment-owned update declaration. */
  externallyManaged?: boolean;
  /** Test seams. */
  checkForUpdate?: typeof performUpdateCheck;
  installUpdate?: typeof performUpdateInstall;
  coordinator?: UpdateInstallCoordinator;
}

/*
FNXC:AutoUpdate 2026-08-14-19:31:
Only the dashboard host knows whether Fusion runs from a source checkout. Keep
that context in this exported builder so unattended installs cannot restart a
program that a global npm install could never change.
*/
export function buildAutoUpdateDeps(input: {
  getSettings: () => Promise<AutoUpdateSettings>;
  currentVersion: string;
  systemControl: { supervised: boolean; restartSupported?: boolean; requestRestart: (reason: string) => boolean; sourceWorkspaceRoot?: string };
  log: AutoUpdateLogger;
  fusionDir?: string;
}): AutoUpdateDeps {
  // `?? supervised` keeps hosts that predate the field (the Electron relaunch host) on the legacy meaning.
  return { getSettings: input.getSettings, currentVersion: input.currentVersion, restartSupported: input.systemControl.restartSupported ?? input.systemControl.supervised, requestRestart: input.systemControl.requestRestart, sourceWorkspaceRoot: input.systemControl.sourceWorkspaceRoot, log: input.log, fusionDir: input.fusionDir, coordinator: processUpdateInstallCoordinator };
}

/**
 * Run one auto-update cycle. Exported for tests and for callers that want a
 * single deterministic pass instead of the timer loop.
 */
export async function runAutoUpdateCycle(deps: AutoUpdateDeps): Promise<AutoUpdateOutcome> {
  let settings: AutoUpdateSettings;
  try {
    settings = await deps.getSettings();
  } catch {
    // Unreadable settings must never be read as "opted in".
    return "disabled";
  }

  const automation = resolveUpdateAutomationSettings(settings);
  if (!automation.autoUpdateEnabled) return "disabled";
  if (settings.updateCheckEnabled === false) return "checks-disabled";
  if (deps.externallyManaged ?? resolveUpdatesExternallyManaged()) {
    deps.log.info("Auto-update skipped: updates are externally managed");
    return "externally-managed";
  }

  if (!deps.restartSupported) {
    deps.log.warn("Auto-update skipped: this host cannot restart itself", {
      message: "autoUpdateAndRestart is on but nothing would bring the new version up. Relaunch without --no-supervise to enable it.",
    });
    return "restart-unsupported";
  }

  const coordinator = deps.coordinator ?? new UpdateInstallCoordinator();

  /*
   * FNXC:AutoUpdate 2026-08-21-06:28:
   * A manual install retained by this old process is authoritative until restart.
   * The watcher must wait for that restart before its forced registry check, so
   * background automation cannot re-check or reinstall an already-installed target.
   */
  if (coordinator.getPendingInstall()) return "restart-waiting";

  const fusionDir = deps.fusionDir ?? resolveGlobalDir();
  const check = deps.checkForUpdate ?? performUpdateCheck;
  const install = deps.installUpdate ?? performUpdateInstall;

  let result: UpdateCheckResult;
  try {
    result = await check(fusionDir, deps.currentVersion, {
      force: true,
      channel: settings.updateChannel,
    });
  } catch (error) {
    deps.log.warn("Auto-update check failed", { message: errorMessage(error) });
    return "check-failed";
  }

  if (result.error) {
    deps.log.warn("Auto-update check failed", { message: result.error });
    return "check-failed";
  }
  if (!result.updateAvailable || !result.latestVersion) return "up-to-date";

  deps.log.info("Auto-update installing", {
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    channel: result.channel ?? settings.updateChannel ?? "stable",
  });

  let installed: UpdateInstallResult;
  try {
    installed = await coordinator.install(result.latestVersion, () => install(result.currentVersion, result.latestVersion, {
      fusionDir,
      installMethod: { sourceWorkspaceRoot: deps.sourceWorkspaceRoot },
    }));
  } catch (error) {
    deps.log.error("Auto-update install failed", { message: errorMessage(error) });
    return "install-failed";
  }

  if (installed.outcome === "unsupported-install-method") {
    deps.log.warn("Auto-update skipped: this host cannot be updated by a global npm install", { message: installed.message });
    return "unsupported-install-method";
  }
  if (installed.outcome === "no-update-available") return "up-to-date";
  if ((installed.outcome && installed.outcome !== "installed") || !installed.updated) {
    deps.log.error("Auto-update install failed", { message: installed.error ?? installed.message ?? "unknown install failure" });
    return "install-failed";
  }

  // Re-read after npm completes: an operator may opt out while it was running.
  let latestSettings: AutoUpdateSettings;
  try { latestSettings = await deps.getSettings(); } catch { latestSettings = {}; }
  if (!resolveUpdateAutomationSettings(latestSettings).autoRestartAfterUpdate) return "up-to-date";
  const scheduled = coordinator.requestRestart(() => deps.requestRestart("auto-update"));
  if (!scheduled) {
    deps.log.warn("Auto-update installed but restart was not scheduled", {
      message: `v${installed.latestVersion} is installed; restart Fusion manually to run it.`,
    });
    return "restart-unavailable";
  }

  deps.log.info("Auto-update installed — restarting", { latestVersion: installed.latestVersion });
  return "restarting";
}

/**
 * Start the periodic auto-update loop. Returns a stop function. Timers are
 * unref'd so the watcher never keeps the process alive on its own.
 */
export function startAutoUpdateWatcher(
  deps: AutoUpdateDeps,
  options: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  let stopped = false;
  let running = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const tick = async () => {
    // A cycle can outlive its interval (npm installs are slow) — never overlap:
    // two concurrent `npm install -g` runs would fight over the same prefix.
    if (stopped || running) return;
    running = true;
    try {
      const outcome = await runAutoUpdateCycle(deps);
      // A restart is already shutting the process down; stop scheduling work.
      if (outcome === "restarting") stop();
    } catch (error) {
      deps.log.error("Auto-update cycle failed", { message: errorMessage(error) });
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => {
    void tick();
    if (stopped) return;
    interval = setInterval(() => void tick(), intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  initial.unref?.();

  function stop(): void {
    stopped = true;
    clearTimeout(initial);
    if (interval) clearInterval(interval);
  }

  return stop;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
