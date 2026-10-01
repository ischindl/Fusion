/**
 * RUFU-212 Step 2 — resource-bound module tests.
 *
 * FNXC:VerificationResourceBound 2026-09-10-03:38:
 * Symptom assertions live here for the resolver/registry/probe/wrapper contract: with no operator
 * setting the bound is ~half the core count supplied to the resolver; the probe runs exactly once
 * per process; a disabled rung degrades to byte-for-byte today's command. Every test injects fake
 * capabilities/probe runners — CI has no systemd user manager and must fake each rung.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { RunAuditEventInput } from "@fusion/core";
import {
  BUILTIN_CPU_IO_WEIGHT,
  applyVerificationResourceBound,
  builtinCpuQuotaPercent,
  describeAppliedVerificationResourceBound,
  getVerificationResourceCapabilities,
  isVerificationResourceProfileEnabled,
  registerProjectVerificationResourceProfile,
  resetVerificationResourceProbeForTests,
  resetVerificationResourceProfileRegistryForTests,
  resolveEffectiveVerificationResourceProfile,
  resolveVerificationResourceProfile,
  setVerificationResourceCapabilitiesForTests,
  setVerificationResourceProbeRunnerForTests,
  unregisterProjectVerificationResourceProfile,
  wrapVerificationCommandForBound,
  VERIFICATION_BOUND_ENGAGED,
  VERIFICATION_BOUND_SUSTAINED,
  type ProbeRunner,
  type VerificationResourceCapabilities,
} from "../verification-resource-bound.js";

const SCOPE_CAPS: VerificationResourceCapabilities = {
  rung: "scope",
  niceAvailable: true,
  ioniceAvailable: true,
};
const NICE_IONICE_CAPS: VerificationResourceCapabilities = {
  rung: "priority",
  niceAvailable: true,
  ioniceAvailable: true,
};
const NICE_ONLY_CAPS: VerificationResourceCapabilities = {
  rung: "priority",
  niceAvailable: true,
  ioniceAvailable: false,
};
const BARE_CAPS: VerificationResourceCapabilities = {
  rung: "bare",
  niceAvailable: false,
  ioniceAvailable: false,
};

afterEach(() => {
  resetVerificationResourceProbeForTests();
  resetVerificationResourceProfileRegistryForTests();
  setVerificationResourceProbeRunnerForTests(null);
});

describe("resolveVerificationResourceProfile — built-in defaults", () => {
  it("derives roughly half the supplied core count when no operator value exists (symptom item 5)", () => {
    // 24 cores -> 12 cores' worth as percent-of-one-core.
    expect(resolveVerificationResourceProfile({ coreCount: 24 })).toEqual({
      cpuQuotaPercent: 1200,
      cpuIoWeight: BUILTIN_CPU_IO_WEIGHT,
    });
    // 12 cores -> 6 cores' worth (the reporting host's observed shape).
    expect(resolveVerificationResourceProfile({ coreCount: 12 }).cpuQuotaPercent).toBe(600);
    // 4 cores -> 2 cores' worth (the checklist's small-workstation case).
    expect(resolveVerificationResourceProfile({ coreCount: 4 }).cpuQuotaPercent).toBe(200);
    expect(builtinCpuQuotaPercent(24)).toBe(1200);
  });

  it("floors the quota at one full core", () => {
    expect(resolveVerificationResourceProfile({ coreCount: 1 }).cpuQuotaPercent).toBe(100);
    expect(resolveVerificationResourceProfile({ coreCount: 2 }).cpuQuotaPercent).toBe(100);
  });

  it("keeps the built-in memory ceiling UNSET so no legitimate build is OOM-killed", () => {
    expect(resolveVerificationResourceProfile({ coreCount: 8 }).memoryMaxMb).toBeUndefined();
  });

  it("picks a weight below the scheduler-neutral 100 so verification yields to interactive work", () => {
    const profile = resolveVerificationResourceProfile({ coreCount: 8 });
    expect(profile.cpuIoWeight).toBeLessThan(100);
    expect(profile.cpuIoWeight).toBe(BUILTIN_CPU_IO_WEIGHT);
  });
});

describe("resolveVerificationResourceProfile — precedence, disable, clamps", () => {
  it("applies project-then-global-then-default per key independently", () => {
    const profile = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 300 },
      global: { cpuIoWeight: 20, memoryMaxMb: 4096 },
      coreCount: 24,
    });
    expect(profile).toEqual({ cpuQuotaPercent: 300, cpuIoWeight: 20, memoryMaxMb: 4096 });
  });

  it("treats 0 as the operator-disable signal per dimension, overriding an inherited value", () => {
    const profile = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 0 },
      global: { cpuQuotaPercent: 500 },
      coreCount: 24,
    });
    expect(profile.cpuQuotaPercent).toBeUndefined();
    // Other dimensions keep their own precedence chain.
    expect(profile.cpuIoWeight).toBe(BUILTIN_CPU_IO_WEIGHT);
  });

  it("a fully-disabled profile is not enabled (all three 0 -> bare spawn)", () => {
    const profile = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 0, cpuIoWeight: 0, memoryMaxMb: 0 },
      coreCount: 24,
    });
    expect(isVerificationResourceProfileEnabled(profile)).toBe(false);
  });

  it("clamps operator values into the enforceable range", () => {
    const clamped = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 99_999, cpuIoWeight: 99_999, memoryMaxMb: 1 },
      coreCount: 4,
    });
    expect(clamped.cpuQuotaPercent).toBe(400); // never more than the machine
    expect(clamped.cpuIoWeight).toBe(10_000);
    expect(clamped.memoryMaxMb).toBe(128); // floor, not zero

    const lowQuota = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 1 },
      coreCount: 4,
    });
    expect(lowQuota.cpuQuotaPercent).toBe(10); // sub-core floor
  });

  it("treats non-finite or negative stored values as unset, not as a bound removal", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const profile = resolveVerificationResourceProfile({
        project: { cpuQuotaPercent: bad, cpuIoWeight: bad },
        coreCount: 8,
      });
      expect(profile.cpuQuotaPercent).toBe(400);
      expect(profile.cpuIoWeight).toBe(BUILTIN_CPU_IO_WEIGHT);
    }
  });
});

describe("machine registry — most-conservative-of-registered", () => {
  it("takes the smallest enabled value per dimension across registered projects", () => {
    registerProjectVerificationResourceProfile("proj-a", { cpuQuotaPercent: 1200, cpuIoWeight: 10 });
    registerProjectVerificationResourceProfile("proj-b", { cpuQuotaPercent: 600, cpuIoWeight: 20 });
    expect(resolveEffectiveVerificationResourceProfile({})).toEqual({
      cpuQuotaPercent: 600,
      cpuIoWeight: 10,
    });
  });

  it("a project that disables the bound cannot unbind the shared machine (count-cap lesson)", () => {
    registerProjectVerificationResourceProfile("proj-a", { cpuQuotaPercent: 1200, cpuIoWeight: 10 });
    registerProjectVerificationResourceProfile("proj-disabled", {
      cpuQuotaPercent: undefined,
      cpuIoWeight: undefined,
    });
    const own = resolveVerificationResourceProfile({
      project: { cpuQuotaPercent: 0, cpuIoWeight: 0 },
      coreCount: 24,
    });
    expect(isVerificationResourceProfileEnabled(own)).toBe(false);
    expect(resolveEffectiveVerificationResourceProfile(own)).toEqual({
      cpuQuotaPercent: 1200,
      cpuIoWeight: 10,
    });
  });

  it("recomputes upward when a project unregisters (no last-write-wins)", () => {
    registerProjectVerificationResourceProfile("proj-a", { cpuQuotaPercent: 1200 });
    registerProjectVerificationResourceProfile("proj-b", { cpuQuotaPercent: 600 });
    unregisterProjectVerificationResourceProfile("proj-b");
    expect(resolveEffectiveVerificationResourceProfile({})).toEqual({ cpuQuotaPercent: 1200 });
  });

  it("with an empty registry the caller's own profile stands", () => {
    expect(
      resolveEffectiveVerificationResourceProfile({ cpuQuotaPercent: 300, cpuIoWeight: 5 }),
    ).toEqual({ cpuQuotaPercent: 300, cpuIoWeight: 5 });
  });
});

describe("capability probe — cached once per process, injectable, tiny", () => {
  it("probes exactly once across many calls (symptom item 3)", async () => {
    const commands: string[] = [];
    const runner: ProbeRunner = async (command) => {
      commands.push(command);
      return command === SYSTEMD_OK;
    };
    setVerificationResourceProbeRunnerForTests(runner);
    const first = await getVerificationResourceCapabilities();
    const second = await getVerificationResourceCapabilities();
    const third = await getVerificationResourceCapabilities();
    expect(first).toBe(second);
    expect(second).toBe(third);
    // One probe SET (three trivial commands), never one per call.
    expect(commands).toHaveLength(3);
    expect(first.rung).toBe("scope");
  });

  it("the probe only spawns trivial `true` payloads — no heavy work", async () => {
    const commands: string[] = [];
    setVerificationResourceProbeRunnerForTests(async (command) => {
      commands.push(command);
      return false;
    });
    await getVerificationResourceCapabilities();
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.endsWith(" true")).toBe(true);
    }
  });

  it("maps probe outcomes to rungs: scope > nice > bare", async () => {
    setVerificationResourceProbeRunnerForTests(async (command) => {
      if (command.startsWith("systemd-run")) return false;
      if (command.startsWith("nice")) return true;
      return false; // ionice absent
    });
    const caps = await getVerificationResourceCapabilities();
    expect(caps).toEqual({ rung: "priority", niceAvailable: true, ioniceAvailable: false });

    resetVerificationResourceProbeForTests();
    setVerificationResourceProbeRunnerForTests(async () => false);
    expect(await getVerificationResourceCapabilities()).toEqual(BARE_CAPS);
  });

  it("a throwing probe runner caches as bare — a probe can never fail a verification", async () => {
    setVerificationResourceProbeRunnerForTests(async () => {
      throw new Error("probe exploded");
    });
    const caps = await getVerificationResourceCapabilities();
    expect(caps.rung).toBe("bare");
    // Cached: a second call still resolves bare without re-invoking the throwing runner.
    expect((await getVerificationResourceCapabilities()).rung).toBe("bare");
  });
});

// Which probe command the fake runner above answers "yes" to (scope probe only).
const SYSTEMD_OK = "systemd-run --user --scope -p CPUQuota=100% -p CPUWeight=10 -p IOWeight=10 true";

describe("wrapVerificationCommandForBound — exact shapes", () => {
  it("scope rung: exec-prefixed systemd-run --scope carrying only probed-accepted properties", () => {
    const wrapped = wrapVerificationCommandForBound(
      "pnpm lint",
      SCOPE_CAPS,
      { cpuQuotaPercent: 1200, cpuIoWeight: 10, memoryMaxMb: 2048 },
    );
    expect(wrapped).toBe(
      "exec systemd-run --user --scope -p CPUQuota=1200% -p CPUWeight=10 -p IOWeight=10 -p MemoryMax=2048M sh -c 'pnpm lint'",
    );
  });

  it("scope rung: each dimension is optional; no Nice= or IoWeight= (systemd rejects them)", () => {
    const quotaOnly = wrapVerificationCommandForBound("echo hi", SCOPE_CAPS, { cpuQuotaPercent: 600 });
    expect(quotaOnly).toBe("exec systemd-run --user --scope -p CPUQuota=600% sh -c 'echo hi'");
    expect(quotaOnly).not.toContain("Nice=");
    expect(quotaOnly).not.toContain("IoWeight=");
  });

  it("priority rung: nice 10 + ionice -c3, or bare nice when ionice is absent", () => {
    expect(wrapVerificationCommandForBound("pnpm build", NICE_IONICE_CAPS, { cpuIoWeight: 10 })).toBe(
      "exec nice -n 10 ionice -c3 sh -c 'pnpm build'",
    );
    expect(wrapVerificationCommandForBound("pnpm build", NICE_ONLY_CAPS, { cpuIoWeight: 10 })).toBe(
      "exec nice -n 10 sh -c 'pnpm build'",
    );
  });

  it("bare rung returns byte-for-byte today's command", () => {
    const command = "pnpm --filter @fusion/core exec vitest run src/x.test.ts --reporter=dot";
    expect(wrapVerificationCommandForBound(command, BARE_CAPS, { cpuQuotaPercent: 600 })).toBe(command);
  });

  it("a disabled profile returns the command unchanged even at the scope rung", () => {
    const command = "pnpm test:gate";
    expect(wrapVerificationCommandForBound(command, SCOPE_CAPS, {})).toBe(command);
  });

  it("quotes the inner payload so shell metacharacters and single quotes cannot break out", () => {
    const nasty = "echo 'it works' && grep -R \"a && b\" src | tee out$HOME";
    const wrapped = wrapVerificationCommandForBound(nasty, SCOPE_CAPS, { cpuQuotaPercent: 100 });
    expect(wrapped.endsWith(`sh -c ${quoteNasty(nasty)}`)).toBe(true);
  });
});

function quoteNasty(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

describe("applyVerificationResourceBound — audit + degradation", () => {
  function makeSink() {
    const events: RunAuditEventInput[] = [];
    return {
      events,
      host: {
        recordRunAuditEvent: (input: unknown) => {
          events.push(input as RunAuditEventInput);
          return Promise.resolve();
        },
      },
    };
  }

  it("emits the engaged event once with bucketed metadata and no command text or paths", async () => {
    const { events, host } = makeSink();
    const applied = await applyVerificationResourceBound({
      command: "pnpm --filter @fusion/core test /secret/path",
      settings: {},
      lane: "tool",
      taskId: "FN-TEST",
      auditHost: host,
      capabilities: SCOPE_CAPS,
      coreCount: 24,
    });
    expect(applied.applied).toBe(true);
    expect(applied.command).toContain("systemd-run --user --scope");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.mutationType).toBe(VERIFICATION_BOUND_ENGAGED);
    expect(event.taskId).toBe("FN-TEST");
    expect(event.metadata).toMatchObject({ lane: "tool", rung: "scope", quotaBucket: "50-75" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("pnpm");
    expect(serialized).not.toContain("/secret/path");
  });

  it("emits sustained only past the threshold, with a duration bucket", async () => {
    const { events, host } = makeSink();
    const applied = await applyVerificationResourceBound({
      command: "pnpm test",
      settings: {},
      lane: "deterministic",
      auditHost: host,
      capabilities: SCOPE_CAPS,
      coreCount: 24,
    });
    applied.reportCompletion(119_000);
    expect(events.filter((e) => e.mutationType === VERIFICATION_BOUND_SUSTAINED)).toHaveLength(0);
    applied.reportCompletion(121_000);
    const sustained = events.find((e) => e.mutationType === VERIFICATION_BOUND_SUSTAINED);
    expect(sustained?.metadata).toMatchObject({ durationBucket: "2-5m" });
  });

  it("a disabled profile emits nothing and returns the bare command byte-for-byte (symptom item 2)", async () => {
    const { events, host } = makeSink();
    const applied = await applyVerificationResourceBound({
      command: "pnpm lint",
      settings: { cpuQuotaPercent: 0, cpuIoWeight: 0 },
      lane: "tool",
      auditHost: host,
      capabilities: SCOPE_CAPS,
      coreCount: 24,
    });
    expect(applied.command).toBe("pnpm lint");
    expect(applied.applied).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("the bare rung emits nothing — a disabled rung emits no event", async () => {
    const { events, host } = makeSink();
    const applied = await applyVerificationResourceBound({
      command: "pnpm lint",
      settings: {},
      lane: "tool",
      auditHost: host,
      capabilities: BARE_CAPS,
      coreCount: 24,
    });
    expect(applied.applied).toBe(false);
    expect(applied.command).toBe("pnpm lint");
    expect(events).toHaveLength(0);
  });

  it("a hostile audit sink cannot alter or fail the bound", async () => {
    const applied = await applyVerificationResourceBound({
      command: "pnpm lint",
      settings: {},
      lane: "tool",
      auditHost: {
        recordRunAuditEvent: () => {
          throw new Error("sink down");
        },
      },
      capabilities: SCOPE_CAPS,
      coreCount: 24,
    });
    expect(applied.applied).toBe(true);
    expect(applied.command).toContain("systemd-run");
    expect(() => applied.reportCompletion(300_000)).not.toThrow();
  });

  it("describes the bound for operator-visible results", async () => {
    const applied = await applyVerificationResourceBound({
      command: "pnpm lint",
      settings: { memoryMaxMb: 4096 },
      lane: "tool",
      capabilities: NICE_IONICE_CAPS,
      coreCount: 12,
    });
    expect(describeAppliedVerificationResourceBound(applied)).toBe(
      "resource bound: CPUQuota=600% weight=10 MemoryMax=4096M (nice/ionice)",
    );
    expect(
      describeAppliedVerificationResourceBound({ ...applied, applied: false }),
    ).toBeUndefined();
  });
});

/*
FNXC:VerificationResourceBound 2026-09-10-12:13 (RUFU-212 Step 4):
Lane-level spawn contract. The resolver being correct is not enough — the symptom the
operator reported (a throttled lane spawning bare `pnpm test`) lives at the SPAWN seam.
These tests import the lane modules (fn_run_verification tool + the deterministic seam in
verification-utils) with a FRESH copy of this module per test (vi.resetModules + dynamic
import) so the module-level probe cache and profile registry are isolated from the static
import above, and so a doMocked @fusion/core (fake superviseSpawn) only affects the dynamic
graph. Each lane must deliver: bound applied when it can be, an explicit bypass when the
backend already confines (double-wrapping would fight the jail), degraded-but-running when
resolution fails, and exactly ONE real probe per process even across repeated verifications.
*/
describe("verification lanes bind their spawn (RUFU-212 Step 4)", () => {
  type FreshBoundModule = typeof import("../verification-resource-bound.js");

  async function freshBoundModule(options?: {
    superviseSpawn?: (command: string, args: readonly string[], spawnOptions: Record<string, unknown>) => unknown;
  }): Promise<FreshBoundModule> {
    vi.resetModules();
    vi.doUnmock("@fusion/core");
    if (options?.superviseSpawn) {
      const fake = options.superviseSpawn;
      vi.doMock("@fusion/core", async (importOriginal) => ({
        ...((await importOriginal()) as Record<string, unknown>),
        superviseSpawn: fake,
      }));
    }
    return await import("../verification-resource-bound.js");
  }

  afterEach(() => {
    vi.doUnmock("@fusion/core");
    vi.resetModules();
  });

  function makeFakeSupervisedChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kill = vi.fn();
    const supervised = {
      pid: 411111,
      pgid: 411111,
      child: child as unknown as ChildProcess,
      kill,
      waitExit: () => new Promise<never>(() => {}),
    };
    return { child, kill, supervised };
  }

  function makeFakeBackend(id: "native" | "bubblewrap") {
    const calls: Array<{ command: string; options: { signal?: AbortSignal } }> = [];
    let nextOutcome: Record<string, unknown> = { outcome: "success", stdout: "", stderr: "", bufferOverflow: false };
    const backend = {
      capabilities: () => ({
        id,
        supportsNetworkPolicy: true,
        supportsFilesystemPolicy: true,
        supportsStreaming: true,
        platform: "any" as const,
      }),
      prepare: vi.fn(async () => {}),
      run: vi.fn(async () => {
        throw new Error("run() must not be used by the verification lanes");
      }),
      runStreaming: vi.fn(async (command: string, options: { signal?: AbortSignal }) => {
        calls.push({ command, options });
        return nextOutcome;
      }),
    };
    return {
      backend: backend as unknown as import("../../sandbox/types.js").SandboxBackend,
      calls,
      setNextOutcome: (outcome: Record<string, unknown>) => {
        nextOutcome = outcome;
      },
    };
  }

  function makeFakeStore(settings: Record<string, unknown> | "throw") {
    const logMessages: string[] = [];
    const store = {
      getSettings: vi.fn(async () => {
        if (settings === "throw") throw new Error("settings store unavailable");
        return settings;
      }),
      recordRunAuditEvent: vi.fn(async () => {}),
      logEntry: vi.fn(async (_taskId: string, message: string) => {
        logMessages.push(message);
      }),
      appendAgentLog: vi.fn(async () => {}),
    };
    return {
      store: store as unknown as import("@fusion/core").TaskStore,
      logMessages,
    };
  }

  const RESOURCE_SETTINGS = {
    verificationCpuQuotaPercent: 400,
    verificationCpuIoWeight: 25,
    verificationMemoryMaxMb: 1024,
  };
  const TOOL_BOUND_CONFIG = { cpuQuotaPercent: 600, cpuIoWeight: 10, memoryMaxMb: 512 };

  // ── fn_run_verification tool lane ─────────────────────────────────────────

  it("tool lane (native supervisor path): spawns the wrapped command and reports the ORIGINAL command", async () => {
    const spawnCalls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const fake = makeFakeSupervisedChild();
    const bound = await freshBoundModule({
      superviseSpawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return fake.supervised;
      },
    });
    // Capabilities injected = mock discipline: the probe runner must never execute anything real.
    const probeSpy = vi.fn<ProbeRunner>(async () => true);
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    bound.setVerificationResourceProbeRunnerForTests(probeSpy);
    const tool = await import("../run-verification-tool.js");

    const promise = tool.runVerificationCommand({
      command: "pnpm test",
      cwd: process.cwd(),
      timeoutMs: 60_000,
      onHeartbeat: vi.fn(),
      bypassVerificationSlot: true,
      resourceBound: TOOL_BOUND_CONFIG,
      resourceLane: "tool",
      auditHost: { recordRunAuditEvent: vi.fn(async () => {}) },
      taskId: "RUFU-212",
    });

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1), { timeout: 2_000 });
    const spawned = spawnCalls[0]!;
    expect(spawned.command).toMatch(/^exec systemd-run --user --scope/);
    expect(spawned.command).toContain("-p CPUQuota=600%");
    expect(spawned.command).toContain("-p CPUWeight=10");
    expect(spawned.command).toContain("-p IOWeight=10");
    expect(spawned.command).toContain("-p MemoryMax=512M");
    // The ORIGINAL command survives the wrapper quoting verbatim.
    expect(spawned.command).toContain("sh -c 'pnpm test'");
    // Supervision contract stays intact: shell wrapper, pipes for output, grace + lifetime caps.
    expect(spawned.args).toEqual([]);
    expect(spawned.options.shell).toBe(true);
    expect(spawned.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spawned.options.killGraceMs).toBe(10_000);
    expect(spawned.options.maxLifetimeMs).toBe(60_000 + 10_000 + 1_000);

    fake.child.emit("close", 0, null);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("pnpm test");
    expect(result.resourceBoundNote).toBe("resource bound: CPUQuota=600% weight=10 MemoryMax=512M (systemd scope)");
    // Injected capabilities mean the probe was never consulted — CI without a systemd user
    // manager (and test-mode hosts) spawn nothing real.
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("tool lane (native supervisor path): timeout escalation SIGTERM→SIGKILL hits the WRAPPED supervised child", async () => {
    const fake = makeFakeSupervisedChild();
    const spawnCalls: number[] = [];
    const bound = await freshBoundModule({
      superviseSpawn: () => {
        spawnCalls.push(1);
        return fake.supervised;
      },
    });
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    bound.setVerificationResourceProbeRunnerForTests(async () => false);
    const tool = await import("../run-verification-tool.js");

    vi.useFakeTimers();
    try {
      const promise = tool.runVerificationCommand({
        command: "pnpm build",
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onHeartbeat: vi.fn(),
        bypassVerificationSlot: true,
        resourceBound: TOOL_BOUND_CONFIG,
        resourceLane: "tool",
        taskId: "RUFU-212",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnCalls).toHaveLength(1);
      expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.kill).toHaveBeenLastCalledWith("SIGKILL");
      fake.child.emit("close", null, "SIGKILL");
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.command).toBe("pnpm build");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tool lane (sandbox, pass-through backend): wraps the streamed command, probes exactly once across repeated runs", async () => {
    const bound = await freshBoundModule();
    const probeCommands: string[] = [];
    bound.setVerificationResourceProbeRunnerForTests(async (command) => {
      probeCommands.push(command);
      return command.startsWith("systemd-run");
    });
    const tool = await import("../run-verification-tool.js");
    const fake = makeFakeBackend("native");

    const runOnce = () =>
      tool.runVerificationCommand({
        command: "pnpm test",
        cwd: process.cwd(),
        timeoutMs: 60_000,
        onHeartbeat: vi.fn(),
        bypassVerificationSlot: true,
        sandboxBackend: fake.backend,
        resourceBound: TOOL_BOUND_CONFIG,
        resourceLane: "tool",
        taskId: "RUFU-212",
      });

    const first = await runOnce();
    const second = await runOnce();
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.command).toMatch(/^exec systemd-run --user --scope/);
      expect(call.command).toContain("-p CPUQuota=600%");
      expect(call.command).toContain("sh -c 'pnpm test'");
    }
    // Probe runs exactly once per process: three probe commands total for two verifications.
    expect(probeCommands).toHaveLength(3);
    expect(first.resourceBoundNote).toContain("CPUQuota=600%");
    expect(second.resourceBoundNote).toContain("CPUQuota=600%");
    expect(first.command).toBe("pnpm test");
  });

  it("tool lane (sandbox, confining backend): never double-wrapped — original command, no probe, no bound note", async () => {
    const bound = await freshBoundModule();
    const probeSpy = vi.fn<ProbeRunner>(async () => true);
    bound.setVerificationResourceProbeRunnerForTests(probeSpy);
    const tool = await import("../run-verification-tool.js");
    const fake = makeFakeBackend("bubblewrap");

    const result = await tool.runVerificationCommand({
      command: "pnpm test",
      cwd: process.cwd(),
      timeoutMs: 60_000,
      onHeartbeat: vi.fn(),
      bypassVerificationSlot: true,
      sandboxBackend: fake.backend,
      resourceBound: TOOL_BOUND_CONFIG,
      resourceLane: "tool",
      taskId: "RUFU-212",
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe("pnpm test");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.resourceBoundNote).toBeUndefined();
  });

  it("tool lane (sandbox): abort mid-flight still terminates the wrapped child", async () => {
    const bound = await freshBoundModule();
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    const tool = await import("../run-verification-tool.js");
    const ac = new AbortController();
    let streamingOptions: { signal?: AbortSignal } | undefined;
    const backend = {
      capabilities: () => ({
        id: "native",
        supportsNetworkPolicy: true,
        supportsFilesystemPolicy: true,
        supportsStreaming: true,
        platform: "any" as const,
      }),
      prepare: vi.fn(async () => {}),
      run: vi.fn(async () => {
        throw new Error("unused");
      }),
      runStreaming: (_command: string, options: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          streamingOptions = options;
          options.signal!.addEventListener("abort", () =>
            resolve({ outcome: "aborted", stdout: "", stderr: "", phase: "mid-flight" }),
          );
        }),
    };

    const promise = tool.runVerificationCommand({
      command: "pnpm test",
      cwd: process.cwd(),
      timeoutMs: 60_000,
      onHeartbeat: vi.fn(),
      bypassVerificationSlot: true,
      signal: ac.signal,
      sandboxBackend: backend as unknown as import("../../sandbox/types.js").SandboxBackend,
      resourceBound: TOOL_BOUND_CONFIG,
      resourceLane: "tool",
      taskId: "RUFU-212",
    });

    await vi.waitFor(() => expect(streamingOptions).toBeDefined(), { timeout: 2_000 });
    expect(streamingOptions!.signal).toBe(ac.signal);
    ac.abort();
    const result = await promise;
    expect(result.killed).toBe(true);
    expect(result.warnings).toContain("verification aborted");
    expect(result.command).toBe("pnpm test");
  });

  // ── deterministic seam (verification-utils) ────────────────────────────────

  async function runSeamOnce(
    utils: typeof import("../verification-utils.js"),
    store: import("@fusion/core").TaskStore,
    backend: import("../../sandbox/types.js").SandboxBackend,
  ) {
    return utils.runVerificationCommand(
      store,
      process.cwd(),
      "RUFU-212",
      "pnpm test",
      "test",
      undefined,
      { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
      undefined,
      undefined,
      undefined,
      backend,
      "deterministic",
    );
  }

  it("deterministic seam (native backend): wraps with settings-resolved values and consults no probe when capabilities are injected", async () => {
    const bound = await freshBoundModule();
    const probeSpy = vi.fn<ProbeRunner>(async () => true);
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    bound.setVerificationResourceProbeRunnerForTests(probeSpy);
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore(RESOURCE_SETTINGS);
    const fake = makeFakeBackend("native");

    const result = await runSeamOnce(utils, store.store, fake.backend);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toMatch(/^exec systemd-run --user --scope/);
    expect(fake.calls[0]!.command).toContain("-p CPUQuota=400%");
    expect(fake.calls[0]!.command).toContain("-p CPUWeight=25");
    expect(fake.calls[0]!.command).toContain("-p IOWeight=25");
    expect(fake.calls[0]!.command).toContain("-p MemoryMax=1024M");
    expect(fake.calls[0]!.command).toContain("sh -c 'pnpm test'");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.command).toBe("pnpm test");
  });

  it("deterministic seam (confining backend): skips the bound, the probe, AND the settings read", async () => {
    const bound = await freshBoundModule();
    const probeSpy = vi.fn<ProbeRunner>(async () => true);
    bound.setVerificationResourceProbeRunnerForTests(probeSpy);
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore(RESOURCE_SETTINGS);
    const fake = makeFakeBackend("bubblewrap");

    const result = await runSeamOnce(utils, store.store, fake.backend);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe("pnpm test");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(store.store.getSettings).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("deterministic seam (resolution failure): degrades to the bare command and never fails the verification", async () => {
    const bound = await freshBoundModule();
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore("throw");
    const fake = makeFakeBackend("native");
    const debug = vi.fn();
    // Hoisted out of the call-site literal: the seam duck-types `debug` on the injected
    // logger (typeof logger.debug === "function"), but its declared param type omits it.
    const seamLogger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug };

    const result = await utils.runVerificationCommand(
      store.store,
      process.cwd(),
      "RUFU-212",
      "pnpm test",
      "test",
      undefined,
      seamLogger,
      undefined,
      undefined,
      undefined,
      fake.backend,
      "deterministic",
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe("pnpm test");
    expect(result.success).toBe(true);
    expect(debug.mock.calls.map((call) => String(call[0])).join("\n")).toContain("resource-bound resolution failed");
  });

  it("deterministic seam: probe resolves exactly once across repeated seam runs", async () => {
    const bound = await freshBoundModule();
    const probeCommands: string[] = [];
    bound.setVerificationResourceProbeRunnerForTests(async (command) => {
      probeCommands.push(command);
      return command.startsWith("systemd-run");
    });
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore(RESOURCE_SETTINGS);
    const fake = makeFakeBackend("native");

    await runSeamOnce(utils, store.store, fake.backend);
    await runSeamOnce(utils, store.store, fake.backend);

    expect(fake.calls).toHaveLength(2);
    expect(probeCommands).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call.command).toMatch(/^exec systemd-run --user --scope/);
      expect(call.command).toContain("-p CPUQuota=400%");
    }
  });

  it("deterministic seam: failure reporting shows the ORIGINAL command, never the wrapper (displayCommand contract)", async () => {
    const bound = await freshBoundModule();
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore(RESOURCE_SETTINGS);
    const fake = makeFakeBackend("native");
    fake.setNextOutcome({ outcome: "non-zero-exit", stdout: "", stderr: "", bufferOverflow: false, exitCode: 1, signal: null });

    const result = await runSeamOnce(utils, store.store, fake.backend);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toContain("systemd-run");
    // The task log summarized the error built from displayCommand — which embeds the
    // ORIGINAL command. A missing displayCommand wiring would leak the wrapper here.
    await vi.waitFor(() => expect(store.logMessages.join("\n")).toContain("command failed"), { timeout: 2_000 });
    expect(store.logMessages.join("\n")).toContain("Command failed (exit 1): pnpm test");
    expect(store.logMessages.join("\n")).not.toContain("systemd-run");
  });

  it("deterministic seam: mid-flight abort reaches the backend signal and rejects with the ORIGINAL command", async () => {
    const bound = await freshBoundModule();
    bound.setVerificationResourceCapabilitiesForTests(SCOPE_CAPS);
    const utils = await import("../verification-utils.js");
    const store = makeFakeStore(RESOURCE_SETTINGS);
    const ac = new AbortController();
    const fakeBackend = {
      capabilities: () => ({
        id: "native",
        supportsNetworkPolicy: true,
        supportsFilesystemPolicy: true,
        supportsStreaming: true,
        platform: "any" as const,
      }),
      prepare: vi.fn(async () => {}),
      run: vi.fn(async () => {
        throw new Error("unused");
      }),
      runStreaming: vi.fn(
        (_command: string, options: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            options.signal!.addEventListener("abort", () =>
              resolve({ outcome: "aborted", stdout: "", stderr: "", phase: "mid-flight" }),
            );
          }),
      ),
    };

    const promise = utils.runVerificationCommand(
      store.store,
      process.cwd(),
      "RUFU-212",
      "pnpm test",
      "test",
      ac.signal,
      { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
      undefined,
      undefined,
      undefined,
      fakeBackend as unknown as import("../../sandbox/types.js").SandboxBackend,
      "deterministic",
    );

    await vi.waitFor(() => expect(fakeBackend.runStreaming).toHaveBeenCalled(), { timeout: 2_000 });
    // Termination wiring: the backend's streaming owns the kill, driven by this signal.
    expect((fakeBackend.runStreaming.mock.calls[0]![1] as { signal?: AbortSignal }).signal).toBe(ac.signal);
    ac.abort();
    // The seam re-throws aborts with the ORIGINAL command — wrapper text must never reach callers.
    await expect(promise).rejects.toThrow("Command aborted: pnpm test");
    expect(fakeBackend.runStreaming.mock.calls[0]![0] as string).toContain("systemd-run");
  });
});
