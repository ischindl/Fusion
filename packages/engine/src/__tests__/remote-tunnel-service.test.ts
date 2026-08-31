import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  __resetRemoteTunnelServicesForTests,
  getRemoteTunnelService,
  peekRemoteTunnelService,
  remoteTunnelScopeKey,
  shutdownAllRemoteTunnels,
  shutdownRemoteTunnelService,
} from "../remote-access/remote-tunnel-service.js";

/*
FNXC:RemoteAccess 2026-08-31-07:08:
Original symptom: "Stop engine" / "Restart engine" took the Tailscale tunnel down with the engine,
because TunnelProcessManager was owned by ProjectEngine. Remote access is the operator's route to the
box, so the failure removed the means of repair.

These tests pin the ownership invariant at the seam that now holds it: the process-lifetime registry.
No engine is involved anywhere in this file — that is the point.
*/

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    remoteAccess: {
      activeProvider: "cloudflare" as const,
      providers: {
        tailscale: { enabled: false, hostname: "", targetPort: 4040, acceptRoutes: false },
        cloudflare: {
          enabled: true,
          quickTunnel: false,
          tunnelName: "demo",
          tunnelToken: "token",
          ingressUrl: "https://remote.example.com",
        },
      },
      tokenStrategy: {
        persistent: { enabled: false, token: null },
        shortLived: { enabled: false, ttlMs: 1000, maxTtlMs: 2000 },
      },
      lifecycle: {
        rememberLastRunning: true,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      },
      ...overrides,
    },
  };
}

function createStore(settings = createSettings()): TaskStore & { updateSettings: ReturnType<typeof vi.fn> } {
  const state = { ...settings };
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(state, patch);
  });
  return {
    getSettings: vi.fn(async () => state),
    updateSettings,
    getRootDir: vi.fn(() => "/fake/root"),
  } as unknown as TaskStore & { updateSettings: ReturnType<typeof vi.fn> };
}

describe("remote tunnel service registry", () => {
  beforeEach(() => {
    __resetRemoteTunnelServicesForTests();
  });

  it("returns the same service — and the same manager — for repeated lookups of one project", () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const first = getRemoteTunnelService(key);
    const second = getRemoteTunnelService(key);

    // This identity IS the fix: an engine restart re-looks-up and finds the live tunnel.
    expect(second).toBe(first);
    expect(second.getManager()).toBe(first.getManager());
  });

  it("keeps per-project scoping — different projects never share a tunnel", () => {
    const a = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-a" }));
    const b = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-b" }));
    expect(a).not.toBe(b);
  });

  it("derives one key per project regardless of which surface asks", () => {
    // Registered project: the central id wins even when a root dir is also known, so the engine path
    // and the engine-less route path cannot land on two services (which would mean two tunnels).
    expect(remoteTunnelScopeKey({ projectId: "proj-1", rootDir: "/a" }))
      .toBe(remoteTunnelScopeKey({ projectId: "proj-1", rootDir: "/b" }));
    // Unregistered launch directory: both surfaces fall back to the same root dir.
    expect(remoteTunnelScopeKey({ rootDir: "/fake/root" }))
      .toBe(remoteTunnelScopeKey({ projectId: null, rootDir: "/fake/root" }));
    expect(remoteTunnelScopeKey({ projectId: "proj-1" }))
      .not.toBe(remoteTunnelScopeKey({ rootDir: "proj-1" }));
  });

  it("peek never creates a service as a side effect", () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-peek" });
    expect(peekRemoteTunnelService(key)).toBeUndefined();
    getRemoteTunnelService(key);
    expect(peekRemoteTunnelService(key)).toBeDefined();
  });

  it("leaves an already-running tunnel alone when restore re-runs on an engine restart", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: "cloudflare",
      state: "running",
      pid: 11,
      startedAt: null,
      stoppedAt: null,
      url: "https://live.example.com",
      lastError: null,
    });
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const store = createStore(createSettings({
      lifecycle: { rememberLastRunning: true, wasRunningOnShutdown: true, lastRunningProvider: "cloudflare" },
    }));

    await service.restoreIfNeeded(store);

    expect(startSpy).not.toHaveBeenCalled();
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "already_running",
    });
  });

  it("persists the running marker and stops the process only on shutdown", async () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const service = getRemoteTunnelService(key);
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: "cloudflare",
      state: "running",
      pid: 11,
      startedAt: null,
      stoppedAt: null,
      url: "https://live.example.com",
      lastError: null,
    });
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    const store = createStore();

    await shutdownRemoteTunnelService(key, store);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    // The marker is what lets restore-on-start bring the tunnel back next boot.
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare",
        }),
      }),
    }));
    // The registry entry is gone, so a later lookup does not resurrect a dead manager.
    expect(peekRemoteTunnelService(key)).toBeUndefined();
  });

  it("sweeps tunnels whose engine is already gone on process shutdown", async () => {
    const orphan = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "paused-project" }));
    const stopSpy = vi.spyOn(orphan.getManager(), "stop").mockResolvedValue(undefined);

    await shutdownAllRemoteTunnels();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(peekRemoteTunnelService(remoteTunnelScopeKey({ projectId: "paused-project" }))).toBeUndefined();
  });

  it("starts and stops without an engine, driving the manager from the store alone", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ rootDir: "/fake/root" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: null,
      state: "stopped",
      pid: null,
      startedAt: null,
      stoppedAt: null,
      url: null,
      lastError: null,
    });
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "cloudflare",
      config: { provider: "cloudflare", executablePath: "cloudflared", args: ["tunnel"] },
    });
    const store = createStore();

    await service.start(store);
    expect(startSpy).toHaveBeenCalledWith("cloudflare", expect.objectContaining({ provider: "cloudflare" }));

    await service.stop(store);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(store.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({ wasRunningOnShutdown: false, lastRunningProvider: null }),
      }),
    }));
  });
});
