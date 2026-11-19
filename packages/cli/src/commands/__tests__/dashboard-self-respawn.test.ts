/**
 * RUFU-513 — the self-restart spawn seam, the restart-intent listener release, and the bind-collision
 * matrix.
 *
 * The spawn is anchored at the process-exit choke point because this host already lived through a
 * four-engine-process / two-listener incident: every additional route into "start another dashboard" is
 * another way to get split-brain. These tests drive the handler DIRECTLY, which is how each terminating
 * route (graceful tail, hard-exit watchdog, second signal) reaches the same one body.
 */

import { describe, expect, it, vi } from "vitest";
import {
  closeDashboardListener,
  createSelfRespawnOnExit,
  registerSelfRespawnForMode,
  resolveAddressInUseAction,
  resolveSelfRespawnCommand,
  RESTART_RESPAWN_BIND_MAX_ATTEMPTS,
  RESTART_RESPAWN_BIND_RETRY_MS,
  FUSION_RESTART_RESPAWN_CHILD_ENV,
  DASHBOARD_LISTENER_CLOSE_TIMEOUT_MS,
} from "../dashboard.js";

type SpawnOptions = { env: NodeJS.ProcessEnv; stdio: "inherit"; detached: true };

interface SpawnRecorder {
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>;
  unrefCount: () => number;
  spawn: (command: string, args: string[], options: SpawnOptions) => { unref: () => void };
}

function recorder(behavior?: (command: string, args: string[]) => void): SpawnRecorder {
  const calls: SpawnRecorder["calls"] = [];
  let unrefs = 0;
  return {
    calls,
    unrefCount: () => unrefs,
    spawn: (command, args, options) => {
      behavior?.(command, args);
      calls.push({ command, args, options });
      return { unref: () => { unrefs += 1; } };
    },
  };
}

const productionIdentity = {
  execPath: "/usr/bin/node",
  argv: [
    "/usr/bin/node",
    "/home/fusion/git/Fusion/packages/cli/bin.mjs",
    "dashboard",
    "--port",
    "4040",
    "--host",
    "0.0.0.0",
  ],
  execArgv: ["--max-old-space-size=4096", "--inspect=0.0.0.0:9229"],
};

function identityEnv(): NodeJS.ProcessEnv {
  return {
    HOME: "/home/fusion",
    NODE_OPTIONS: "--max-old-space-size=4096",
    FUSION_PG_POOL_MAX: "10",
    FUSION_HOME: "/home/fusion/.fusion",
  };
}

describe("createSelfRespawnOnExit", () => {
  it("does not spawn at registration or at request time — only when the exit handler runs", () => {
    const spawnRecorder = recorder();
    const registered: Array<() => void> = [];
    let restartIntended = false;

    const handle = createSelfRespawnOnExit({
      spawn: spawnRecorder.spawn,
      command: resolveSelfRespawnCommand(
        productionIdentity.execPath,
        productionIdentity.argv,
        productionIdentity.execArgv,
        false,
      )!,
      env: identityEnv(),
      restartIntended: () => restartIntended,
      log: () => {},
      registerExitHandler: (handler) => { registered.push(handler); },
    });

    // Registering created no process, and a restart request that has not exited yet creates none either.
    expect(spawnRecorder.calls).toHaveLength(0);
    restartIntended = true;
    expect(spawnRecorder.calls).toHaveLength(0);

    // The exit is what hands off.
    expect(registered).toHaveLength(1);
    registered[0]();
    expect(spawnRecorder.calls).toHaveLength(1);
    expect(handle.spawned()).toBe(true);
  });

  it("spawns the identity verbatim — same execPath, execArgv and argv, environment passed through plus the marker", () => {
    const spawnRecorder = recorder();
    const log = vi.fn();

    createSelfRespawnOnExit({
      spawn: spawnRecorder.spawn,
      command: resolveSelfRespawnCommand(
        productionIdentity.execPath,
        productionIdentity.argv,
        productionIdentity.execArgv,
        false,
      )!,
      env: identityEnv(),
      restartIntended: () => true,
      log,
      registerExitHandler: () => {},
    }).handleExit();

    expect(spawnRecorder.calls).toHaveLength(1);
    const call = spawnRecorder.calls[0];
    expect(call.command).toBe("/usr/bin/node");
    // execArgv survives (the inspector flag lives there) and the user arguments keep their order.
    expect(call.args).toEqual([
      "--max-old-space-size=4096",
      "--inspect=0.0.0.0:9229",
      "/home/fusion/git/Fusion/packages/cli/bin.mjs",
      "dashboard",
      "--port",
      "4040",
      "--host",
      "0.0.0.0",
    ]);
    // The environment is spread verbatim: an environment rebuilt from a template is how this host lost its
    // memory ceiling once already, so nothing may be filtered out of it.
    expect(call.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(call.options.env.FUSION_PG_POOL_MAX).toBe("10");
    expect(call.options.env.FUSION_HOME).toBe("/home/fusion/.fusion");
    // The marker is the ONLY addition.
    expect(call.options.env[FUSION_RESTART_RESPAWN_CHILD_ENV]).toBe("1");
    // And the supervision stamps stay absent: they are what makes `supervised` a claim, and a
    // self-restart host has no parent to answer to.
    expect(call.options.env.FUSION_RESTART_SUPERVISED).toBeUndefined();
    expect(call.options.env.FUSION_SUPERVISOR_PID).toBeUndefined();
    // Detached + unref is what lets the replacement outlive this exit; inherit keeps the operator's
    // log redirection one continuous file.
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe("inherit");
    expect(spawnRecorder.unrefCount()).toBe(1);
    expect(log.mock.calls.join(" ")).toContain("spawning replacement");
  });

  it("spawns nothing on a plain shutdown, whatever exit route arrives", () => {
    const spawnRecorder = recorder();
    const handle = createSelfRespawnOnExit({
      spawn: spawnRecorder.spawn,
      command: { command: "node", args: ["bin.mjs", "dashboard"] },
      env: identityEnv(),
      // No restart intent: a SIGTERM, a crash, or a startup failure.
      restartIntended: () => false,
      log: () => {},
      registerExitHandler: () => {},
    });

    handle.handleExit();
    expect(handle.spawned()).toBe(false);
    expect(spawnRecorder.calls).toHaveLength(0);
  });

  it("waits out the request-handling grace window without touching spawn", () => {
    // The 202 branch answers inside a 300 ms setTimeout and the shutdown runs behind it. Advancing that
    // window is how this proves the request path itself spawns nothing: a handler that spawned for
    // responsiveness would race the graceful teardown and produce two listeners on one port.
    vi.useFakeTimers();
    try {
      const spawnRecorder = recorder();
      const registered: Array<() => void> = [];
      createSelfRespawnOnExit({
        spawn: spawnRecorder.spawn,
        command: { command: "node", args: ["bin.mjs", "dashboard"] },
        env: identityEnv(),
        restartIntended: () => true,
        log: () => {},
        registerExitHandler: (handler) => { registered.push(handler); },
      });

      vi.advanceTimersByTime(300);
      expect(spawnRecorder.calls).toHaveLength(0);

      registered[0]();
      expect(spawnRecorder.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns exactly one replacement when every terminating route reaches the exit", () => {
    const spawnRecorder = recorder();
    const handle = createSelfRespawnOnExit({
      spawn: spawnRecorder.spawn,
      command: { command: "node", args: ["bin.mjs", "dashboard"] },
      env: identityEnv(),
      restartIntended: () => true,
      log: () => {},
      registerExitHandler: () => {},
    });

    // Graceful tail, then the hard-exit watchdog, then a second SIGTERM: three routes, one child.
    handle.handleExit();
    handle.handleExit();
    handle.handleExit();
    expect(spawnRecorder.calls).toHaveLength(1);
  });

  it("survives a failing spawn — the exit this process is performing must not be sabotaged", () => {
    const log = vi.fn();
    let attempts = 0;
    const handle = createSelfRespawnOnExit({
      spawn: () => { attempts += 1; throw new Error("EACCES: operation not permitted"); },
      command: { command: "node", args: ["bin.mjs", "dashboard"] },
      env: identityEnv(),
      restartIntended: () => true,
      log,
      registerExitHandler: () => {},
    });

    expect(() => handle.handleExit()).not.toThrow();
    handle.handleExit();
    expect(attempts).toBe(1);
    expect(log.mock.calls.join(" ")).toContain("replacement spawn failed");
  });

  it("releases the listener before spawning, and a throwing release does not cost the restart", () => {
    const order: string[] = [];
    const spawnRecorder = recorder(() => order.push("spawn"));
    createSelfRespawnOnExit({
      spawn: spawnRecorder.spawn,
      command: { command: "node", args: ["bin.mjs", "dashboard"] },
      env: identityEnv(),
      restartIntended: () => true,
      closeListener: () => { order.push("close"); throw new Error("socket already gone"); },
      log: () => {},
      registerExitHandler: () => {},
    }).handleExit();

    expect(order).toEqual(["close", "spawn"]);
    expect(spawnRecorder.calls).toHaveLength(1);
  });
});

describe("registerSelfRespawnForMode", () => {
  const deps = (spawn: SpawnRecorder["spawn"]) => ({
    spawn,
    command: { command: "node", args: ["bin.mjs", "dashboard"] },
    env: identityEnv(),
    restartIntended: () => true,
    log: () => {},
    registerExitHandler: () => {},
  });

  it("registers for a self-respawn host and for nobody else", () => {
    const selfRespawn = recorder();
    expect(registerSelfRespawnForMode("self-respawn", deps(selfRespawn.spawn))).not.toBeNull();
    expect(selfRespawn.calls).toHaveLength(0);

    // A supervised host's parent owns the respawn; --no-supervise is an explicit operator opt-out.
    // Registering for either would put two starters on one port.
    const supervised = recorder();
    expect(registerSelfRespawnForMode("supervisor", deps(supervised.spawn))).toBeNull();
    const refused = recorder();
    expect(registerSelfRespawnForMode("none", deps(refused.spawn))).toBeNull();
    expect(supervised.calls).toHaveLength(0);
    expect(refused.calls).toHaveLength(0);
  });
});

describe("closeDashboardListener", () => {
  it("closes the listener and drops live connections so close() can actually finish", async () => {
    const calls: string[] = [];
    const server = {
      close: (callback?: (error?: Error) => void) => { calls.push("close"); callback?.(); },
      closeAllConnections: () => { calls.push("closeAllConnections"); },
    };

    await expect(closeDashboardListener(server, { timeoutMs: 50 })).resolves.toBe(true);
    // close() alone never finishes while an SSE or keep-alive socket is open, and the dashboard is full of
    // them; closeAllConnections is what makes the callback arrive.
    expect(calls).toEqual(["close", "closeAllConnections"]);
  });

  it("gives up on a wedged socket inside its budget instead of hanging shutdown", async () => {
    const server = {
      close: () => { /* the callback never arrives: a hung SSE stream */ },
      closeAllConnections: () => {},
    };

    await expect(closeDashboardListener(server, { timeoutMs: 5 })).resolves.toBe(false);
  });

  it("is a no-op for a shutdown that began before the bind", async () => {
    await expect(closeDashboardListener(null, { timeoutMs: 5 })).resolves.toBe(false);
  });

  it("waits no longer than its published budget", () => {
    // The budget has to stay well inside the 3 s hard-exit watchdog, or a wedged socket would decide the
    // exit path instead of the graceful one.
    expect(DASHBOARD_LISTENER_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("resolveAddressInUseAction", () => {
  it("keeps the shipped ephemeral rebind for an ordinary launch", () => {
    expect(resolveAddressInUseAction({ isRespawnChild: false, attempt: 0 })).toBe("silent-rebind");
    expect(resolveAddressInUseAction({
      isRespawnChild: false,
      attempt: RESTART_RESPAWN_BIND_MAX_ATTEMPTS,
    })).toBe("silent-rebind");
  });

  it("defends the requested port as a restart replacement: retry under the cap", () => {
    expect(resolveAddressInUseAction({ isRespawnChild: true, attempt: 0 })).toBe("retry");
    expect(resolveAddressInUseAction({
      isRespawnChild: true,
      attempt: RESTART_RESPAWN_BIND_MAX_ATTEMPTS - 1,
    })).toBe("retry");
  });

  it("fails loudly at the cap and can NEVER silently rebind", () => {
    expect(resolveAddressInUseAction({
      isRespawnChild: true,
      attempt: RESTART_RESPAWN_BIND_MAX_ATTEMPTS,
    })).toBe("fail-loud");
    expect(resolveAddressInUseAction({
      isRespawnChild: true,
      attempt: RESTART_RESPAWN_BIND_MAX_ATTEMPTS + 25,
    })).toBe("fail-loud");
    // The whole point of the marker: for a replacement there is no reachable action that serves a port
    // nobody configured.
    for (let attempt = 0; attempt <= RESTART_RESPAWN_BIND_MAX_ATTEMPTS + 1; attempt += 1) {
      expect(resolveAddressInUseAction({ isRespawnChild: true, attempt })).not.toBe("silent-rebind");
    }
  });

  it("keeps the bounded budget short enough to restart inside a browser reload", () => {
    expect(RESTART_RESPAWN_BIND_RETRY_MS * RESTART_RESPAWN_BIND_MAX_ATTEMPTS).toBeLessThanOrEqual(10_000);
  });
});
