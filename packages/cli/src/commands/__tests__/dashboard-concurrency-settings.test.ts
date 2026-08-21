import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  let settings: Record<string, unknown> = {};
  let latestTui: FakeDashboardTui | undefined;

  class FakeDashboardTui {
    settingsPayloads: Array<Record<string, unknown>> = [];
    callbacks: Record<string, unknown> = {};
    boardScopedProjectPath: string | null = null;

    constructor() {
      latestTui = this;
    }

    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    setLoadingStatus = vi.fn();
    setSystemInfo = vi.fn();
    setReady = vi.fn();
    setTaskStats = vi.fn();
    setInteractiveData = vi.fn();
    onBoardScopeChange = vi.fn();
    hydrateVitestKillSettings = vi.fn();
    log = vi.fn();
    setCallbacks = vi.fn((callbacks: Record<string, unknown>) => { this.callbacks = callbacks; });
    setSettings = vi.fn((payload: Record<string, unknown>) => { this.settingsPayloads.push(payload); });
  }

  class FakeLogSink {
    setTUI = vi.fn();
    captureConsole = vi.fn();
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    getRecentEntries = vi.fn(() => []);
  }

  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const store: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return store;
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
  Object.assign(store, {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({})),
    getFusionDir: vi.fn(() => "/repo/.fusion"),
    getRootDir: vi.fn(() => "/repo"),
    getSettings: vi.fn(async () => settings),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})), updateSettings: vi.fn(async () => undefined) })),
    getPluginStore: vi.fn(() => ({ init: vi.fn(async () => undefined) })),
    healthCheck: vi.fn(async () => ({ ok: true })),
    isBackendMode: vi.fn(() => false),
    listTasks: vi.fn(async () => []),
  });

  const appListeners = new Map<string, Array<(...args: any[]) => void>>();
  const app: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
      return app;
    },
  };
  Object.assign(app, {
    listen: vi.fn(() => {
      queueMicrotask(() => appListeners.get("listening")?.forEach((listener) => listener()));
      return app;
    }),
    address: vi.fn(() => ({ port: 0 })),
    close: vi.fn(),
  });

  return {
    FakeDashboardTui,
    FakeLogSink,
    app,
    store,
    getSettings: () => settings,
    latestTui: () => latestTui,
    setSettings: (next: Record<string, unknown>) => { settings = next; },
    reset: () => {
      settings = {};
      latestTui = undefined;
      vi.clearAllMocks();
    },
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  class NoopStore {
    init = vi.fn(async () => undefined);
    on = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return {
    ...actual,
    createTaskStoreForBackend: vi.fn(async () => ({ taskStore: harness.store, shutdown: vi.fn(async () => undefined) })),
    AutomationStore: NoopStore,
    AgentStore: class extends NoopStore { listAgents = vi.fn(async () => []); },
    PluginLoader: class { loadAllPlugins = vi.fn(async () => ({ loaded: 0, errors: 0 })); getPluginSkills = vi.fn(() => []); },
    MissionStore: NoopStore,
    setHostTaskStore: vi.fn(),
    setDiagnosticDbHealthCheck: vi.fn(),
    setDiagnosticStoreListenerCheck: vi.fn(),
  };
});

vi.mock("@fusion/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/dashboard")>()),
  createServer: vi.fn(() => harness.app),
  refreshAllCustomProviderModels: vi.fn(async () => ({ refreshed: 0, failed: 0, skipped: 0 })),
  stopAllDevServers: vi.fn(async () => undefined),
}));

vi.mock("../dashboard-tui/index.js", () => ({
  DashboardTUI: harness.FakeDashboardTui,
  DashboardLogSink: harness.FakeLogSink,
  isTTYAvailable: vi.fn(() => true),
}));

vi.mock("../dashboard-startup-chain.js", () => ({
  DASHBOARD_STARTUP_STATUS: {
    initializingTaskStore: "Initializing task store…",
    initializingAgentStore: "Initializing agent store…",
    startingAgents: "Starting agents…",
    loadingExtensions: "Loading extensions…",
    startingEngine: "Starting engine…",
  },
  runTuiStartupPrelude: vi.fn(async (tui: { start: () => Promise<void>; setLoadingStatus: (status: string) => void }) => {
    await tui.start();
    tui.setLoadingStatus("Initializing task store…");
  }),
}));

const { runDashboard } = await import("../dashboard.js");

/**
 * FNXC:CapacityModel 2026-08-21-17:43:
 * The reported console mismatch was in dashboard startup, not the standalone mapping helper.
 * Run the real TTY branch with a controlled live store and capture DashboardTUI.setSettings so
 * future callback changes cannot reintroduce private defaults or bypass the shared resolver.
 */
describe("dashboard TUI concurrency settings", () => {
  beforeEach(() => harness.reset());

  it.each([
    ["unset", {}, { maxConcurrent: 2, maxWorktrees: 4 }],
    ["configured", { maxConcurrent: 6, maxWorktrees: 9 }, { maxConcurrent: 6, maxWorktrees: 9 }],
    ["worktree-bound", { maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true }, { maxConcurrent: 8, maxWorktrees: 4 }],
  ])("hydrates %s live settings through runDashboard's TUI setter", async (_state, settings, expected) => {
    harness.setSettings(settings);

    await runDashboard(0, { noEngine: true, noAuth: true });
    await new Promise((resolve) => setImmediate(resolve));

    const tui = harness.latestTui();
    expect(harness.store.getSettings).toHaveBeenCalled();
    expect(tui?.setSettings).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});
