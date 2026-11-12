import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEngineSingleton,
  computeEngineLockFilePath,
  computeEngineSocketPath,
  EngineAlreadyRunningError,
  probeEngineSingletonPresence,
  type EngineSingletonLock,
} from "../project/engine-singleton-lock.js";

function uniqueProjectId(label: string): string {
  return `proj_${label}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stand in for a live engine's loopback listener, built the same way `bindLoopback` builds the real
 * one, so a presence probe is exercised against the address shape it will meet in production.
 */
async function bindLoopbackStandIn(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end());
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(socketPath);
  });
  return server;
}

function closeLoopback(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("engine-singleton-lock", () => {
  let workDir: string;
  let acquired: EngineSingletonLock[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "fusion-engine-lock-test-"));
    acquired = [];
  });

  afterEach(async () => {
    for (const lock of acquired) {
      await lock.release().catch(() => {});
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("computes a deterministic socket path per projectId", () => {
    const id = "proj_deterministic";
    expect(computeEngineSocketPath(id)).toBe(computeEngineSocketPath(id));
    expect(computeEngineSocketPath(id)).not.toBe(
      computeEngineSocketPath("proj_other"),
    );
  });

  it("places the lockfile under <workingDir>/.fusion/engine.lock", () => {
    expect(computeEngineLockFilePath(workDir)).toBe(
      join(workDir, ".fusion", "engine.lock"),
    );
  });

  it("acquires successfully on first call and creates .fusion/engine.lock", async () => {
    const id = uniqueProjectId("first");
    const lock = await acquireEngineSingleton(id, workDir);
    acquired.push(lock);
    expect(existsSync(lock.lockFilePath)).toBe(true);
  });

  it("rejects a second acquisition for the same project + workingDir", async () => {
    const id = uniqueProjectId("double");
    const first = await acquireEngineSingleton(id, workDir);
    acquired.push(first);
    await expect(acquireEngineSingleton(id, workDir)).rejects.toBeInstanceOf(
      EngineAlreadyRunningError,
    );
  });

  it("allows re-acquisition after release", async () => {
    const id = uniqueProjectId("cycle");
    const first = await acquireEngineSingleton(id, workDir);
    await first.release();
    // Double-release must be a no-op.
    await first.release();

    const second = await acquireEngineSingleton(id, workDir);
    acquired.push(second);
    expect(existsSync(second.lockFilePath)).toBe(true);
  });

  it("recovers from a stale socket file (POSIX only)", async () => {
    if (platform() === "win32") return;

    const id = uniqueProjectId("stale");
    const socketPath = computeEngineSocketPath(id);

    // Simulate a stale socket file from a crashed engine.
    const stale = net.createServer();
    stale.unref();
    await new Promise<void>((resolve, reject) => {
      stale.once("error", reject);
      stale.once("listening", () => resolve());
      stale.listen(socketPath);
    });
    await new Promise<void>((resolve) => stale.close(() => resolve()));

    const lock = await acquireEngineSingleton(id, workDir);
    acquired.push(lock);
    expect(existsSync(lock.lockFilePath)).toBe(true);
  });

  it("releases the lockfile so a fresh process could re-acquire", async () => {
    const id = uniqueProjectId("release-lockfile");
    const lock = await acquireEngineSingleton(id, workDir);
    await lock.release();
    // proper-lockfile uses `<path>.lock` as the actual mutex dir.
    expect(existsSync(`${lock.lockFilePath}.lock`)).toBe(false);
  });

  it("different projects don't block each other", async () => {
    const a = await acquireEngineSingleton(uniqueProjectId("a"), workDir);
    acquired.push(a);
    const otherWork = mkdtempSync(join(tmpdir(), "fusion-engine-lock-test-b-"));
    try {
      const b = await acquireEngineSingleton(uniqueProjectId("b"), otherWork);
      acquired.push(b);
      expect(existsSync(a.lockFilePath)).toBe(true);
      expect(existsSync(b.lockFilePath)).toBe(true);
    } finally {
      rmSync(otherWork, { recursive: true, force: true });
    }
  });
});

/**
 * RUFU-938 — the read-only half of the singleton question.
 *
 * A dashboard started with `--no-engine` beside a real engine host has no `ProjectEngineManager`, so
 * `hasRunningEngine()` — which only learns of a foreign engine as a side effect of a start attempt
 * this kind of host never makes — reported "no engine" while the engine was running. The presence
 * probe is the manager-free answer, and its whole contract is that it OBSERVES without ever becoming
 * the owner: every case below asserts one direction of that.
 */
describe("probeEngineSingletonPresence", () => {
  let openStandIns: net.Server[] = [];
  let probeLocks: EngineSingletonLock[] = [];
  let workDir: string;

  beforeEach(() => {
    openStandIns = [];
    probeLocks = [];
    workDir = mkdtempSync(join(tmpdir(), "fusion-engine-probe-test-"));
  });

  afterEach(async () => {
    for (const lock of probeLocks) {
      await lock.release().catch(() => {});
    }
    while (openStandIns.length > 0) {
      const server = openStandIns.pop();
      if (server) await closeLoopback(server).catch(() => {});
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reports live while another process holds the project's loopback address", async () => {
    const id = uniqueProjectId("probe-live");
    openStandIns.push(await bindLoopbackStandIn(computeEngineSocketPath(id)));

    await expect(probeEngineSingletonPresence(id)).resolves.toBe(true);
  });

  it("reports not-live once the owning process releases the address", async () => {
    const id = uniqueProjectId("probe-released");
    const server = await bindLoopbackStandIn(computeEngineSocketPath(id));
    await expect(probeEngineSingletonPresence(id)).resolves.toBe(true);

    await closeLoopback(server);
    await expect(probeEngineSingletonPresence(id)).resolves.toBe(false);
  });

  it("answers not-live rather than an error for a project nobody serves", async () => {
    // A liveness answer must never fail the request that asked for it.
    await expect(probeEngineSingletonPresence(uniqueProjectId("probe-absent"))).resolves.toBe(false);
  });

  it("takes neither guard, so the owner can still acquire after a probe", async () => {
    const id = uniqueProjectId("probe-nonacquiring");
    await expect(probeEngineSingletonPresence(id)).resolves.toBe(false);

    // If the probe had acquired either guard, this would reject with EngineAlreadyRunningError.
    const lock = await acquireEngineSingleton(id, workDir);
    probeLocks.push(lock);
    expect(existsSync(lock.lockFilePath)).toBe(true);
  });

  it("binds nothing while probing an absent project", async () => {
    if (platform() === "win32") return; // Named pipes have no filesystem presence to inspect.
    const id = uniqueProjectId("probe-no-bind");
    const socketPath = computeEngineSocketPath(id);

    await expect(probeEngineSingletonPresence(id)).resolves.toBe(false);

    // A UI-only host that left a socket file behind would be one step from stealing the address.
    expect(existsSync(socketPath)).toBe(false);
  });

  it("names no address at all for an empty project id", async () => {
    await expect(probeEngineSingletonPresence("")).resolves.toBe(false);
  });
});
