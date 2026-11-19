import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyDashboardFatalExit,
  hasLiveSupervisingParent,
  resolveDashboardRestartMode,
  resolveSelfRespawnCommand,
  resolveSupervisorLivenessAction,
  resolveSupervisorRespawnCommand,
  runDashboardSupervised,
  signalExitCode,
  shouldSuperviseDashboard,
  SUPERVISOR_EXIT_CODE_NO_SERVICE,
  type AttachedChildExit,
  type SupervisedChildHandle,
} from "../dashboard.js";
import { FUSION_NON_RETRYABLE_EXIT_CODE, FUSION_RESTART_EXIT_CODE } from "@fusion/core";

/*
FNXC:SystemPanel 2026-07-12-14:25:
Supervision must be the DEFAULT for the dashboard across install shapes (bare
`fn`/`fusion`, npx, packaged binary) so the System panel restart works out of
the box, while never nesting supervisors (FUSION_RESTART_SUPERVISED=1 set by
the supervisor itself and by scripts/dev-with-memory.mjs), never fighting an
attached debugger, and honoring the --no-supervise opt-out.
*/
describe("shouldSuperviseDashboard", () => {
  it("defaults to supervised for a plain dashboard invocation", () => {
    expect(shouldSuperviseDashboard(["dashboard"], {}, [])).toBe(true);
  });

  it("defaults to supervised for a bare invocation (no explicit command)", () => {
    expect(shouldSuperviseDashboard([], {}, [])).toBe(true);
  });

  it("is disabled by --no-supervise", () => {
    expect(shouldSuperviseDashboard(["dashboard", "--no-supervise"], {}, [])).toBe(false);
  });

  it("never nests: disabled when a supervising parent already exists", () => {
    expect(shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1" }, [])).toBe(false);
  });

  /*
  FNXC:SystemPanel 2026-07-25-10:05:
  FUSION_RESTART_SUPERVISED is inherited by every process the dashboard spawns
  (agent terminals, dev servers). Running `fn dashboard` from one of those must
  still start a real supervisor — otherwise the new dashboard advertises restart
  support it does not have and a restart request kills it for good. The pid stamp
  distinguishes a real parent from an inherited copy.
  */
  it("never nests under the real supervising parent (pid matches)", () => {
    expect(
      shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "4242" }, [], 4242),
    ).toBe(false);
  });

  it("supervises itself when the supervised flag was merely inherited from a non-parent", () => {
    expect(
      shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "4242" }, [], 99),
    ).toBe(true);
  });
});

/*
FNXC:SystemPanel 2026-11-13-02:10 (RUFU-513):
The restart-capability matrix. Measured on the production host: the launch shape
`node --inspect=... packages/cli/bin.mjs dashboard --port 4040 --host 0.0.0.0` (ppid 1, zero `supervis` log
lines) answered `POST /api/system/restart` with 409, and the remedy that sentence named (`--supervise`) is a
compatibility no-op that cannot override the inspector skip, so an operator following it got the same 409 on
the next deploy. The rows below are the shapes that measurement produced: an unsupervised host that CAN
build a replacement is `self-respawn`, and only an explicit opt-out or an unresolvable entry point is `none`.

Note what these rows do NOT say: none of them changes `supervised`. The first row is the same input the
inspector-suppression case above asserts for supervision (`--inspect` in execArgv, no live parent) and both
verdicts must hold at once — that process must not become a supervisor AND it must be able to restart itself.
*/
describe("resolveDashboardRestartMode", () => {
  const PRODUCTION_LAUNCH_ARGS = ["node", "packages/cli/bin.mjs", "dashboard", "--port", "4040", "--host", "0.0.0.0"];

  it("routes a live-parent host to the supervisor path", () => {
    expect(
      resolveDashboardRestartMode({ supervised: true, cliArgs: PRODUCTION_LAUNCH_ARGS, respawnAvailable: true }),
    ).toBe("supervisor");
  });

  it("gives the reported production launch shape (inspect flag, no supervisor, no flag) a self-restart", () => {
    expect(
      resolveDashboardRestartMode({ supervised: false, cliArgs: PRODUCTION_LAUNCH_ARGS, respawnAvailable: true }),
    ).toBe("self-respawn");
  });

  it("gives a plain unsupervised launch the same self-restart", () => {
    expect(
      resolveDashboardRestartMode({ supervised: false, cliArgs: ["node", "bin.mjs", "dashboard"], respawnAvailable: true }),
    ).toBe("self-respawn");
  });

  it("honors the explicit --no-supervise opt-out even when a replacement could be built", () => {
    expect(
      resolveDashboardRestartMode({
        supervised: false,
        cliArgs: [...PRODUCTION_LAUNCH_ARGS, "--no-supervise"],
        respawnAvailable: true,
      }),
    ).toBe("none");
  });

  it("refuses when no replacement command can be resolved", () => {
    expect(
      resolveDashboardRestartMode({ supervised: false, cliArgs: PRODUCTION_LAUNCH_ARGS, respawnAvailable: false }),
    ).toBe("none");
  });

  it("prefers the live parent over the opt-out, so a supervisor child never self-respawns over its parent", () => {
    expect(
      resolveDashboardRestartMode({
        supervised: true,
        cliArgs: [...PRODUCTION_LAUNCH_ARGS, "--no-supervise"],
        respawnAvailable: true,
      }),
    ).toBe("supervisor");
  });
});

/*
FNXC:SystemPanel 2026-11-13-02:10 (RUFU-513):
The replacement for a self-restart must be the SAME process the operator launched, not a reconstruction.
This host needs `--inspect` (OOM forensics) plus `NODE_OPTIONS`/`FUSION_PG_POOL_MAX` (see the heap-growth
runbook), and `argv` carries `--port 4040 --host 0.0.0.0`; a replacement built from anything else reboots the
dashboard somewhere the operator is not looking. The ordering claim is the one a comment cannot carry: a V8
flag after the script name is a program argument, so execArgv must sit AHEAD of the entry script.
*/
describe("resolveSelfRespawnCommand", () => {
  it("re-execs the production launch with execArgv ahead of the entry script and argv preserved verbatim", () => {
    const command = resolveSelfRespawnCommand(
      "/usr/bin/node",
      ["node", "packages/cli/bin.mjs", "dashboard", "--port", "4040", "--host", "0.0.0.0"],
      ["--inspect=0.0.0.0:9229", "--max-old-space-size=16384"],
      false,
    );

    expect(command).toEqual({
      command: "/usr/bin/node",
      args: [
        "--inspect=0.0.0.0:9229",
        "--max-old-space-size=16384",
        "packages/cli/bin.mjs",
        "dashboard",
        "--port",
        "4040",
        "--host",
        "0.0.0.0",
      ],
    });
    expect(command!.args.indexOf("--inspect=0.0.0.0:9229")).toBeLessThan(command!.args.indexOf("packages/cli/bin.mjs"));
  });

  it("refuses to build a replacement when the entry script is missing", () => {
    expect(resolveSelfRespawnCommand("/usr/bin/node", ["node"], [], false)).toBeNull();
  });

  it("re-execs a bun-compiled binary with the user arguments only (no virtual embedded path)", () => {
    expect(
      resolveSelfRespawnCommand("/usr/local/bin/fn", ["/usr/local/bin/fn", "__embedded", "dashboard", "--port", "4040"], [], true),
    ).toEqual({ command: "/usr/local/bin/fn", args: ["dashboard", "--port", "4040"] });
  });
});

describe("hasLiveSupervisingParent", () => {
  it("requires the supervised flag", () => {
    expect(hasLiveSupervisingParent({}, 1)).toBe(false);
  });

  it("accepts a parent that predates the pid stamp (legacy dev wrapper)", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1" }, 1)).toBe(true);
  });

  it("accepts the stamped supervisor when it is our actual parent", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "77" }, 77)).toBe(true);
  });

  it("rejects a stamped pid that is not our parent (leaked env / dead supervisor)", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "77" }, 1)).toBe(false);
  });

  it("rejects an unparseable pid stamp", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "nope" }, 1)).toBe(false);
  });

  it("is disabled when an inspector is attached (child would fight over the port)", () => {
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect=9230"])).toBe(false);
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect-brk"])).toBe(false);
  });
});

/*
FNXC:HeartbeatOwnership 2026-11-11-00:07:
The dashboard host composes no agent runtime at all. It used to build a `HeartbeatMonitor` +
`HeartbeatTriggerScheduler` inline for `--no-engine`, so a UI process and the engine host sharing one
database both drove the same durable agents: measured 2026-11-10/11, six RunFusion agents were woken by
both in the same hour and 10 of the UI process's 17 runs ended `terminated` because each host reaped the
other's live run at the 120 s stale threshold. Wakes are DATABASE rows (assignment, comment, schedule);
the process that owns the project's engine consumes them, so a UI-only host has nothing to drive.

This is a composition-root invariant, and the only honest way to hold it is structurally: `runDashboard`
is a 3k-line boot sequence with no seam that a fake could exercise without booting a server and a
database (and a test that boots both is exactly the slow-test class this repo refuses).
`register-agent-runtime-routes.ts` covers the caller-visible half — a host with no executor refuses with
`agent-runtime-not-hosted-here` instead of fabricating a run row.
*/
describe("UI-only host owns no agent runtime", () => {
  const source = readFileSync(fileURLToPath(new URL("../dashboard.ts", import.meta.url)), "utf8");

  it("never constructs a heartbeat runtime in the dashboard host", () => {
    expect(source).not.toMatch(/new\s+HeartbeatMonitor\s*\(/);
    expect(source).not.toMatch(/new\s+HeartbeatTriggerScheduler\s*\(/);
  });

  it("leaves the monitor absent rather than a proxy over an unassigned reference", () => {
    expect(source).toContain("heartbeatMonitor: undefined");
  });
});

describe("classifyDashboardFatalExit", () => {
  it("stops unique-constraint failures without consuming restart attempts", () => {
    expect(classifyDashboardFatalExit({ cause: { code: "23505" } })).toEqual({
      exitCode: FUSION_NON_RETRYABLE_EXIT_CODE,
      nonRetryable: true,
    });
  });

  it("leaves ordinary startup failures retryable", () => {
    expect(classifyDashboardFatalExit(new Error("port unavailable"))).toEqual({ exitCode: 1, nonRetryable: false });
  });
});

/*
FNXC:SystemPanel 2026-11-13-08:45 (RUFU-513 Invariant 7):
A parent must not present as healthy while its child does not serve.

Measured on the production host: a manual `SIGTERM` to a supervised child reached the `stopping` latch or the
`SIGINT`/`SIGTERM`/`exitCode === 0` leg and BOTH merely returned, so the parent kept a live pid over a service
that had stopped existing. A pid-based liveness check therefore reported health across a ~90 s invisible
outage — a live pid is exactly what an external watchdog reads as "up". Service is HTTP 200 from
`/api/health` on the REQUESTED port (never an ephemeral port a process silently rebinded to, never inferred
from a pid), so the criterion below is that probe and nothing else.

What the rows must NOT do: turn a stop into a respawn. The operator-stop contract survives by the parent
DYING, not by restarting the child, and `128 + signum` keeps an operator stop reading as a stop.
*/
describe("resolveSupervisorLivenessAction", () => {
  const served = (over: Partial<Parameters<typeof resolveSupervisorLivenessAction>[0]>) =>
    resolveSupervisorLivenessAction({
      childExitedWithoutRestartIntent: true,
      servedRequestedPort: false,
      childSignal: null,
      childExitCode: 0,
      ...over,
    });

  it("honours an operator restart request as a respawn", () => {
    expect(served({ childExitedWithoutRestartIntent: false })).toEqual({ action: "respawn", exitCode: 0 });
  });

  it("a child killed by SIGTERM sends the parent out at 143, not into a respawn", () => {
    expect(served({ childSignal: "SIGTERM", childExitCode: 1 })).toEqual({ action: "exit-honest", exitCode: 143 });
  });

  it("a child killed by SIGINT sends the parent out at 130", () => {
    expect(served({ childSignal: "SIGINT", childExitCode: 1 })).toEqual({ action: "exit-honest", exitCode: 130 });
  });

  it("the operator's own signal stays honest when the child handled the forwarded TERM and exited 0", () => {
    expect(served({ operatorStopSignal: "SIGTERM" })).toEqual({ action: "exit-honest", exitCode: 143 });
  });

  it("propagates a child's own failure code instead of masking it", () => {
    expect(served({ childExitCode: 5 })).toEqual({ action: "exit-honest", exitCode: 5 });
  });

  it("a clean exit over a dark requested port is NOT a clean shutdown", () => {
    const decision = served({});
    expect(decision.action).toBe("exit-honest");
    expect(decision.exitCode).not.toBe(0);
    expect(decision.exitCode).toBe(SUPERVISOR_EXIT_CODE_NO_SERVICE);
  });

  it("a clean exit is only clean when the requested port verifiably still serves", () => {
    expect(served({ servedRequestedPort: true })).toEqual({ action: "exit-clean", exitCode: 0 });
  });

  it("signal exit codes follow the 128 + signum convention the parent's handlers already use", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode("SIGSTKFLT" as NodeJS.Signals)).toBe(1);
  });
});

/*
FNXC:SystemPanel 2026-11-13-08:45 (RUFU-513 Invariant 7):
The same contract driven through the real loop, because the shipped defect lived in the ordering of these
branches and not in any helper: a test of the pure matrix alone would pass on a loop that still `return`ed.
No processes, no sockets, no real timers — the child close, the health probe, the signal registration, the
sleep and the exit are all injected.

The legs this harness must keep green are the ones the spec names as unchanged: the non-retryable 87 exit,
the FUSION_RESTART_EXIT_CODE respawn that does not consume the crash budget, the bounded crash backoff, and
a child that is alive and serving — which nothing may disturb.
*/
describe("runDashboardSupervised post-child-exit decision", () => {
  interface FakeChild {
    close: (exit: AttachedChildExit) => void;
  }

  async function driveSupervisor(opts: {
    serve: boolean;
    script: AttachedChildExit[];
  }): Promise<{
    exits: number[];
    errors: string[];
    spawned: FakeChild[];
    probeCount: () => number;
    sleepCount: () => number;
    sendSignal: (signal: NodeJS.Signals) => void;
    run: Promise<void>;
  }> {
    const exits: number[] = [];
    const errors: string[] = [];
    const spawned: FakeChild[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    let probes = 0;
    let sleeps = 0;

    const run = runDashboardSupervised(4040, {}, {
      attachChild: (): SupervisedChildHandle => {
        let settle!: (exit: AttachedChildExit) => void;
        const waitExit = new Promise<AttachedChildExit>((resolve) => { settle = resolve; });
        spawned.push({ close: (exit) => settle(exit) });
        return { child: { kill: () => true }, waitExit };
      },
      probeService: async () => { probes += 1; return opts.serve; },
      registerSignal: (signal, handler) => { signals.set(signal, handler); },
      registerExitHandler: () => {},
      exit: (code) => { exits.push(code); },
      sleep: async () => { sleeps += 1; },
      log: () => {},
      error: (message) => { errors.push(message); },
    });

    // The loop attaches its first child synchronously; wait for whichever child the script expects.
    await vi.waitFor(() => expect(spawned.length).toBeGreaterThan(0));
    for (const exit of opts.script) {
      const pendingIndex = spawned.length - 1;
      spawned[pendingIndex].close(exit);
      // The loop either reached an exit or attached the next child; wait for one of the two before stepping.
      await vi.waitFor(() => expect(exits.length > 0 || spawned.length > pendingIndex + 1).toBe(true));
    }

    return {
      exits,
      errors,
      spawned,
      probeCount: () => probes,
      sleepCount: () => sleeps,
      sendSignal: (signal) => signals.get(signal)?.(),
      run,
    };
  }

  it("a child killed by SIGTERM ends the parent at 143 with no second spawn", async () => {
    const h = await driveSupervisor({ serve: false, script: [{ code: null, signal: "SIGTERM" }] });

    expect(h.exits).toEqual([143]);
    expect(h.spawned).toHaveLength(1);
    expect(h.probeCount()).toBe(1);
    expect(h.errors.join("\n")).toContain("127.0.0.1:4040/api/health");
    await expect(h.run).resolves.toBeUndefined();
  });

  it("a clean child exit over a port that never serves exits non-zero and names the port", async () => {
    const h = await driveSupervisor({ serve: false, script: [{ code: 0, signal: null }] });

    expect(h.exits).toEqual([SUPERVISOR_EXIT_CODE_NO_SERVICE]);
    expect(h.exits[0]).not.toBe(0);
    expect(h.errors.join("\n")).toContain("nothing serves http://127.0.0.1:4040/api/health");
  });

  it("a clean child exit is only reported clean when the requested port verifiably serves", async () => {
    const h = await driveSupervisor({ serve: true, script: [{ code: 0, signal: null }] });

    expect(h.exits).toEqual([0]);
    expect(h.errors.join("\n")).toContain("answers 200");
  });

  it("an operator SIGTERM never respawns, and the parent dies honestly (143)", async () => {
    const h = await driveSupervisor({ serve: false, script: [] });

    h.sendSignal("SIGTERM");
    expect(h.exits).toEqual([]); // a live child still owns the shutdown; the loop must wait for it
    h.spawned[0].close({ code: 0, signal: null });

    await vi.waitFor(() => expect(h.exits).toEqual([143]));
    expect(h.spawned).toHaveLength(1);
  });

  it("a healthy, still-serving child is not disturbed while it runs", async () => {
    const h = await driveSupervisor({ serve: true, script: [] });

    await vi.waitFor(() => expect(h.spawned).toHaveLength(1));
    expect(h.exits).toEqual([]);
    expect(h.probeCount()).toBe(0);

    h.spawned[0].close({ code: null, signal: "SIGTERM" });
    await vi.waitFor(() => expect(h.exits).toEqual([143]));
  });

  it("the non-retryable arm still exits 87 with no respawn", async () => {
    const h = await driveSupervisor({ serve: false, script: [{ code: FUSION_NON_RETRYABLE_EXIT_CODE, signal: null }] });

    expect(h.exits).toEqual([FUSION_NON_RETRYABLE_EXIT_CODE]);
    expect(h.spawned).toHaveLength(1);
    expect(h.probeCount()).toBe(0);
  });

  it("a restart request respawns immediately without consuming the crash budget", async () => {
    const h = await driveSupervisor({
      serve: false,
      script: [
        { code: FUSION_RESTART_EXIT_CODE, signal: null },
        { code: null, signal: "SIGTERM" },
      ],
    });

    expect(h.spawned).toHaveLength(2);
    expect(h.sleepCount()).toBe(0);
    expect(h.exits).toEqual([143]);
  });

  it("the bounded crash backoff is unchanged: 4 crashes gives up with exit 1", async () => {
    const h = await driveSupervisor({
      serve: false,
      script: [
        { code: 2, signal: null },
        { code: 2, signal: null },
        { code: 2, signal: null },
        { code: 2, signal: null },
      ],
    });

    expect(h.spawned).toHaveLength(4);
    expect(h.sleepCount()).toBe(3);
    expect(h.exits).toEqual([1]);
    expect(h.errors.join("\n")).toContain("exited unexpectedly 4 times");
  });
});

describe("resolveSupervisorRespawnCommand", () => {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("re-execs the node entry script with execArgv preserved outside a compiled binary", () => {
    const respawn = resolveSupervisorRespawnCommand();
    expect(respawn).not.toBeNull();
    expect(respawn!.command).toBe(process.execPath);
    // Under a plain-node/vitest run, argv[1] is the entry script and must be
    // the last respawn arg, after any loader flags from execArgv.
    expect(respawn!.args[respawn!.args.length - 1]).toBe(process.argv[1]);
    expect(respawn!.args.slice(0, -1)).toEqual(process.execArgv);
  });

  /*
  FNXC:HeapCeilingObservability 2026-10-01-12:44 (RUFU-462):
  The ceiling a supervisor must not lose. An operator's `--max-old-space-size` reaches a child ONLY because the
  rebuild splices `execArgv` in AHEAD of the entry script — after it, V8 would read the flag as a program
  argument and the child would come up on the default ceiling while the supervisor's own log still claimed the
  host value. This is the crash-loop shape this host lived through (28 restarts at a 4.09 GiB default under a
  16 GiB launch environment), so the ordering claim is pinned as data rather than left in a comment.
  */
  it("carries a heap-ceiling execArgv flag ahead of the entry script", () => {
    const respawn = resolveSupervisorRespawnCommand(["--max-old-space-size=16384", "--experimental-loader=tsx"], "/opt/fusion/cli.mjs");

    expect(respawn).not.toBeNull();
    expect(respawn!.args).toEqual(["--max-old-space-size=16384", "--experimental-loader=tsx", "/opt/fusion/cli.mjs"]);
    expect(respawn!.args.indexOf("--max-old-space-size=16384")).toBeLessThan(respawn!.args.indexOf("/opt/fusion/cli.mjs"));
  });

  /*
  FNXC:HeapCeilingObservability 2026-10-01-12:44 (RUFU-462):
  The one install shape where the ceiling genuinely cannot ride: a bun-compiled single-file binary re-execs
  itself with no arguments at all, so only a NODE_OPTIONS ceiling survives a restart there. The supervisor's
  per-attempt line names the site precisely so an operator on that shape is not hunting for a lost execArgv
  flag that was never carrying anything.
  */
  it("carries no execArgv ceiling under a bun-compiled build", () => {
    (globalThis as { Bun?: { embeddedFiles: unknown[] } }).Bun = { embeddedFiles: [{}] };

    expect(resolveSupervisorRespawnCommand(["--max-old-space-size=16384"], "/opt/fusion/cli.mjs")).toEqual({
      command: process.execPath,
      args: [],
    });
  });

  it("re-execs the compiled binary itself (no args) under a bun-compiled build", () => {
    // A bun-compiled single-file `fn` binary exposes `Bun.embeddedFiles`; argv[1]
    // is then a virtual embedded path, so the binary must re-exec process.execPath
    // alone (empty args) rather than passing a bogus entry script.
    (globalThis as { Bun?: { embeddedFiles: unknown[] } }).Bun = { embeddedFiles: [{}] };
    const respawn = resolveSupervisorRespawnCommand();
    expect(respawn).toEqual({ command: process.execPath, args: [] });
  });
});
