import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, RegisteredProject } from "@fusion/core";
import {
  HybridExecutor,
  resolveHybridExecutorReadiness,
} from "../concurrency/hybrid-executor.js";

/*
FNXC:HybridExecutorBoot 2026-09-26-02:26:
RUFU-322 boot-lifecycle contract. `HybridExecutor.initialize()` is now backgrounded by every boot
surface, so four properties became load-bearing and are pinned here: concurrent callers share one
boot, a failed boot is not cached, the per-project capacity probe is bounded, and shutdown drains an
in-flight boot on a bound instead of returning a false success. `@fusion/core` is spread-mocked so
`resolveEffectiveConcurrency` stays real — the capacity assertions only mean anything if the real
resolver runs.
*/
const hoisted = vi.hoisted(() => ({
  createTaskStoreForBackend: vi.fn(),
  hybridExecutorLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createTaskStoreForBackend: (options: unknown) =>
      hoisted.createTaskStoreForBackend(options) as Promise<unknown>,
  };
});

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return { ...actual, hybridExecutorLog: hoisted.hybridExecutorLog };
});

const managerCalls = vi.hoisted(() => ({
  addProject: vi.fn(),
  removeProject: vi.fn(),
  getProjectIds: vi.fn(),
  stopAll: vi.fn(),
}));

const healthMonitorCalls = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../project/project-manager.js", () => ({
  ProjectManager: vi.fn().mockImplementation(function () {
    return {
      addProject: managerCalls.addProject,
      removeProject: managerCalls.removeProject,
      getProjectIds: managerCalls.getProjectIds,
      getRuntime: vi.fn().mockReturnValue(undefined),
      listRuntimes: vi.fn().mockReturnValue([]),
      stopAll: managerCalls.stopAll,
      on: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock("../project/node-health-monitor.js", () => ({
  NodeHealthMonitor: vi.fn().mockImplementation(function () {
    return {
      start: healthMonitorCalls.start,
      stop: healthMonitorCalls.stop,
    };
  }),
}));

type BootedStore = { taskStore: { getSettingsFast: () => Promise<Record<string, unknown>> }; shutdown: () => Promise<void> };

/** A capacity probe that resolves only when the test releases it, with a spy on its store teardown. */
function deferredProbe(settings: Record<string, unknown>) {
  let release: (boot: BootedStore) => void = () => {};
  const storeShutdown = vi.fn().mockResolvedValue(undefined);
  hoisted.createTaskStoreForBackend.mockReturnValue(
    new Promise<BootedStore>((resolve) => {
      release = resolve;
    }),
  );
  return {
    storeShutdown,
    release: () => release({ taskStore: { getSettingsFast: async () => settings }, shutdown: storeShutdown }),
  };
}

async function waitUntil(assertion: () => void, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("HybridExecutor boot lifecycle (RUFU-322)", () => {
  const liveSettings = { maxConcurrent: 7, maxWorktrees: 9 };
  const project: RegisteredProject = {
    id: "proj_boot",
    name: "Boot Project",
    path: "/tmp/proj_boot",
    status: "active",
    isolationMode: "in-process",
    // Registry snapshot: distinct from the live settings so a fallback is observable.
    settings: { maxConcurrent: 3, maxWorktrees: 4 } as RegisteredProject["settings"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let central: CentralCore;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so a previous test's store stub would leak into this one.
    hoisted.createTaskStoreForBackend.mockReset();
    // process.cwd() always exists, so the capacity probe path is taken (the missing-directory
    // branch returns the registry snapshot without ever touching the store seam).
    central = {
      listProjects: vi.fn().mockResolvedValue([project]),
      getProject: vi.fn().mockResolvedValue(project),
      resolveLocalProjectWorkingDirectory: vi.fn().mockResolvedValue(process.cwd()),
      updateProject: vi.fn().mockResolvedValue(project),
      transitionProjectIsolation: vi.fn().mockResolvedValue({ ok: true }),
      updateProjectHealth: vi.fn().mockResolvedValue(undefined),
      removeAllListeners: vi.fn(),
      on: vi.fn().mockReturnThis(),
    } as unknown as CentralCore;

    managerCalls.removeProject.mockResolvedValue(undefined);
    const added: string[] = [];
    managerCalls.addProject.mockImplementation((config: { projectId: string }) => {
      added.push(config.projectId);
      return Promise.resolve({ stop: vi.fn().mockResolvedValue(undefined) });
    });
    managerCalls.getProjectIds.mockImplementation(() => [...added]);
    managerCalls.stopAll.mockResolvedValue(undefined);
    healthMonitorCalls.start.mockResolvedValue(undefined);
    healthMonitorCalls.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares a single boot across concurrent initialize() calls and hands the same completion to whenReady()", async () => {
    const probe = deferredProbe(liveSettings);
    const executor = new HybridExecutor(central);

    const first = executor.initialize();
    const second = executor.initialize();
    const ready = executor.whenReady();

    await waitUntil(() => expect(hoisted.createTaskStoreForBackend).toHaveBeenCalledTimes(1));
    expect(executor.isInitialized()).toBe(false);

    probe.release();
    await Promise.all([first, second, ready]);

    expect(central.listProjects).toHaveBeenCalledTimes(1);
    expect(managerCalls.addProject).toHaveBeenCalledTimes(1);
    expect(executor.isInitialized()).toBe(true);
    // The probe never leaks: whoever settles it closes the store it booted.
    await waitUntil(() => expect(probe.storeShutdown).toHaveBeenCalledTimes(1));
    await executor.shutdown();
  });

  it("does not cache a failed startup — a later initialize() retries and whenReady() stops reporting it", async () => {
    hoisted.createTaskStoreForBackend.mockResolvedValue({
      taskStore: { getSettingsFast: async () => liveSettings },
      shutdown: async () => {},
    });
    (central.listProjects as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValue([project]);
    const executor = new HybridExecutor(central);

    await expect(executor.initialize()).rejects.toThrow("registry unavailable");
    expect(executor.isInitialized()).toBe(false);
    await expect(executor.whenReady()).rejects.toThrow(/not ready/);

    await executor.initialize();
    await expect(executor.whenReady()).resolves.toBeUndefined();
    expect(executor.isInitialized()).toBe(true);
    await executor.shutdown();
  });

  it("reads startup capacity from the project's live settings through a bounded probe", async () => {
    hoisted.createTaskStoreForBackend.mockResolvedValue({
      taskStore: { getSettingsFast: async () => liveSettings },
      shutdown: async () => {},
    });
    const executor = new HybridExecutor(central, { startupCapacityProbeTimeoutMs: 500 });

    await executor.initialize();

    expect(managerCalls.addProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj_boot", maxConcurrent: 7, maxWorktrees: 9 }),
    );
    expect(hoisted.hybridExecutorLog.warn).not.toHaveBeenCalled();
    await executor.shutdown();
  });

  it("falls back to the registry snapshot when the probe outlives its bound, names the reason, and never leaks the late store", async () => {
    const probe = deferredProbe(liveSettings);
    const executor = new HybridExecutor(central, { startupCapacityProbeTimeoutMs: 20 });

    const boot = executor.initialize();
    await waitUntil(() => expect(hoisted.createTaskStoreForBackend).toHaveBeenCalledTimes(1));

    await boot;

    expect(managerCalls.addProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj_boot", maxConcurrent: 3, maxWorktrees: 4 }),
    );
    const warning = hoisted.hybridExecutorLog.warn.mock.calls.map(([message]) => message).join("\n");
    expect(warning).toContain("proj_boot");
    expect(warning).toContain("registry concurrency snapshot");
    expect(warning).toContain("capacity probe exceeded 20ms");

    // The probe still lands later; its store must be closed by the probe chain, not abandoned.
    probe.release();
    await waitUntil(() => expect(probe.storeShutdown).toHaveBeenCalledTimes(1));
    await executor.shutdown();
  });

  it("logs a greppable completion marker naming the loaded runtime count and boot duration", async () => {
    hoisted.createTaskStoreForBackend.mockResolvedValue({
      taskStore: { getSettingsFast: async () => liveSettings },
      shutdown: async () => {},
    });
    const executor = new HybridExecutor(central);

    await executor.initialize();

    const marker = hoisted.hybridExecutorLog.log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("HybridExecutor initialized:"));
    expect(marker).toMatch(/^HybridExecutor initialized: 1 project runtimes in \d+ms$/);
    await executor.shutdown();
  });

  it("records projects that fail to load instead of counting them into the completion marker", async () => {
    hoisted.createTaskStoreForBackend.mockResolvedValue({
      taskStore: { getSettingsFast: async () => liveSettings },
      shutdown: async () => {},
    });
    managerCalls.addProject.mockRejectedValue(new Error("runtime start refused"));
    const executor = new HybridExecutor(central);

    await executor.initialize();

    const marker = hoisted.hybridExecutorLog.log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("HybridExecutor initialized:"));
    expect(marker).toMatch(/^HybridExecutor initialized: 0 project runtimes in \d+ms$/);
    expect(hoisted.hybridExecutorLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 project(s) failing to load"),
    );
    // A partially-loaded executor is still ready: it must not claim an unstarted state.
    await expect(executor.whenReady()).resolves.toBeUndefined();
    await executor.shutdown();
  });

  it("drains an in-flight boot on shutdown, then stops the health monitor and every runtime", async () => {
    const probe = deferredProbe(liveSettings);
    const executor = new HybridExecutor(central);

    const boot = executor.initialize();
    await waitUntil(() => expect(hoisted.createTaskStoreForBackend).toHaveBeenCalledTimes(1));

    let shutdownDone = false;
    const shutdown = executor.shutdown().then(() => {
      shutdownDone = true;
    });

    // The boot is still pending, so shutdown must not have completed yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownDone).toBe(false);
    expect(managerCalls.stopAll).not.toHaveBeenCalled();

    probe.release();
    await boot;
    await shutdown;

    expect(executor.isInitialized()).toBe(false);
    expect(healthMonitorCalls.stop).toHaveBeenCalledTimes(1);
    expect(managerCalls.stopAll).toHaveBeenCalledTimes(1);
  });

  it("gives up on a hung boot after shutdownInitWaitTimeoutMs, stops what exists, and refuses to report success", async () => {
    const probe = deferredProbe(liveSettings);
    const executor = new HybridExecutor(central, {
      startupCapacityProbeTimeoutMs: 60_000,
      shutdownInitWaitTimeoutMs: 20,
    });

    const boot = executor.initialize();
    let bootSettled = false;
    boot.then(
      () => {
        bootSettled = true;
      },
      () => {
        bootSettled = true;
      },
    );
    await waitUntil(() => expect(hoisted.createTaskStoreForBackend).toHaveBeenCalledTimes(1));

    await expect(executor.shutdown()).rejects.toThrow(/shutdown incomplete/);

    expect(bootSettled).toBe(false);
    expect(executor.isInitialized()).toBe(false);
    expect(managerCalls.stopAll).toHaveBeenCalledTimes(1);
    const warning = hoisted.hybridExecutorLog.warn.mock.calls.map(([message]) => message).join("\n");
    expect(warning).toContain("proj_boot");
    expect(warning).toContain("still in flight after 20ms");

    // A runtime that finishes loading after shutdown already gave up must not survive it.
    probe.release();
    await boot;
    expect(managerCalls.removeProject).toHaveBeenCalledWith("proj_boot");
    expect(executor.isInitialized()).toBe(false);
  });
});

/*
FNXC:HybridExecutorBoot 2026-09-26-03:20:
RUFU-322 readiness classification. `resolveHybridExecutorReadiness` is what the live
isolation-transition route depends on to answer truthfully while the backgrounded boot is still
walking projects. The three outcomes are the operator-visible contract (`starting` is retryable,
`failed` is not), and the bound floor is the difference between a 503 and a hung HTTP request when a
caller mis-sets the knob.
*/
describe("resolveHybridExecutorReadiness", () => {
  it("reports ready once project runtime loading has completed", async () => {
    const executor = { whenReady: () => Promise.resolve() };
    await expect(resolveHybridExecutorReadiness(executor as never, 20)).resolves.toBe("ready");
  });

  it("reports starting while an in-flight boot has not finished within the bound", async () => {
    const executor = { whenReady: () => new Promise<void>(() => {}) };
    await expect(resolveHybridExecutorReadiness(executor as never, 10)).resolves.toBe("starting");
  });

  it("reports failed when boot was never started or its last attempt rejected", async () => {
    const executor = {
      whenReady: () =>
        Promise.reject(new Error("HybridExecutor is not ready: project runtime loading has not completed")),
    };
    await expect(resolveHybridExecutorReadiness(executor as never, 20)).resolves.toBe("failed");
  });

  it("answers immediately for a zero bound instead of waiting forever", async () => {
    const executor = { whenReady: () => new Promise<void>(() => {}) };
    const startedAt = Date.now();
    await expect(resolveHybridExecutorReadiness(executor as never, 0)).resolves.toBe("starting");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("still classifies a boot that finishes after the bound as ready on the next question", async () => {
    let releaseReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const executor = { whenReady: () => ready };
    await expect(resolveHybridExecutorReadiness(executor as never, 10)).resolves.toBe("starting");
    releaseReady();
    await expect(resolveHybridExecutorReadiness(executor as never, 20)).resolves.toBe("ready");
  });
});
