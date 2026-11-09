/**
 * Agent-lane CPU priority at the one seam where every lane child is born (RUFU-901).
 *
 * Measured on a 24-core fleet host at load average 16-27 with 113 event-loop-stall episodes in a day: a lane
 * sat at 118 % CPU against a 124 % dashboard, while the two largest tenants were not Fusion at all (`java`
 * 382 %, `kasm` 133 % / 111 %) — the goal is that Fusion's own batch work stops queuing ahead of the UI, not
 * that this knob fixes the host. The operator chose to lower lane CPU priority
 * while keeping lane concurrency, so the contract here is three-sided:
 *
 *   1. with the opt-in set, an automatic lane child is demoted — asserted through the real wiring, by
 *      reading the value back from the kernel for a real process, by exactly the configured amount;
 *   2. an interactive `chat` session is never routed to the mechanism, and the process hosting the UI keeps
 *      its own priority;
 *   3. WITHOUT the opt-in nothing happens at all — the ratchet that keeps every existing deployment
 *      byte-identical after upgrade.
 *
 * FNXC:AgentCpuPriority 2026-11-08-17:31 (RUFU-901):
 * The fake PTY reports the pid of a REAL short-lived child, so the demotion the manager performs is a real
 * `setpriority()` and `getPriority` answers what the kernel recorded rather than what a mock remembers. Two
 * consequences of that choice are load-bearing: every PTY pid used here is a child this test owns (the
 * manager's scoped SIGKILL would otherwise signal a pid belonging to somebody else), and each manager is
 * disposed so its `process.on("exit")` kill sweep is removed. Windows maps a niceness value onto a priority
 * class, where the round-trip is lossy and `sleep` does not exist, so the kernel-readback group is
 * POSIX-only; the routing group asserts the same discrimination through the seam and runs everywhere.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { getPriority, platform } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CPU_NICENESS_ENV,
  type AgentCpuPriorityOutcome,
  type CliSession,
  type CliSessionPurpose,
  type CliSessionStore,
} from "@fusion/core";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import { CliSessionManager } from "../session-manager.js";

/** `setpriority`/`getPriority` round-trip exactly on POSIX; Windows answers with a priority class. */
const POSIX = platform() !== "win32";

const LANE_PURPOSES: CliSessionPurpose[] = ["execute", "planning", "validator", "ce"];

function makeAdapter(): CliAgentAdapter {
  return {
    id: "test",
    name: "Test",
    capabilities: {
      nativeDone: false,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: true,
    },
    buildLaunch: vi.fn(() => ({ command: "test-agent", args: ["--launch"] })),
    buildResume: vi.fn(() => ({ command: "test-agent", args: ["--resume"] })),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text: string) => ({ payload: text }),
  } as unknown as CliAgentAdapter;
}

function makeStore() {
  const sessions = new Map<string, CliSession>();
  let counter = 0;
  const store = Object.assign(new EventEmitter(), {
    flush: vi.fn(async () => {}),
    createSession: vi.fn((input: Partial<CliSession>) => {
      counter += 1;
      const now = new Date().toISOString();
      const session: CliSession = {
        id: `cli-${String(counter).padStart(4, "0")}`,
        taskId: null,
        chatSessionId: null,
        purpose: "chat",
        projectId: "proj-1",
        adapterId: "test",
        agentState: "starting",
        terminationReason: null,
        nativeSessionId: null,
        resumeAttempts: 0,
        autonomyPosture: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        ...input,
      } as CliSession;
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    updateSession: vi.fn((id: string, input: Partial<CliSession>) => {
      const existing = sessions.get(id);
      if (!existing) return undefined;
      const updated: CliSession = { ...existing, ...input, updatedAt: new Date().toISOString() };
      sessions.set(id, updated);
      return updated;
    }),
    listSessions: vi.fn(() => [...sessions.values()]),
    deleteSession: vi.fn((id: string) => sessions.delete(id)),
  }) as unknown as CliSessionStore;
  return store;
}

interface WorldOptions {
  /**
   * pid the fake PTY reports as its child. MUST be a pid this test owns: the manager registers it and its
   * teardown signals it. Omit and one is spawned for you.
   */
  ptyPid?: number;
  /** Observe/replace the priority seam. Omit to exercise the real default wiring. */
  applyCpuPriority?: (pid: number | undefined) => AgentCpuPriorityOutcome;
}

const REAL_CHILDREN: Array<{ kill(): void }> = [];

/**
 * A real OS process to receive the demotion, so `getPriority` reports what the kernel actually recorded.
 * `sleep` suffices: the pid only has to exist while `setpriority()` lands.
 */
function realChildPid(): number {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  REAL_CHILDREN.push(child);
  if (typeof child.pid !== "number") throw new Error("test child failed to start");
  return child.pid;
}

const MANAGERS: CliSessionManager[] = [];

function makeWorld(options: WorldOptions = {}) {
  const registry = new CliAdapterRegistry();
  registry.register(makeAdapter());
  const pidCalls: Array<number | undefined> = [];
  const pty = {
    pid: options.ptyPid ?? realChildPid(),
    onData: () => {},
    onExit: () => {},
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
  const manager = new CliSessionManager({
    registry,
    store: makeStore(),
    loadPty: vi.fn(async () => ({
      spawn: () => pty as unknown as IPty,
    })) as unknown as () => Promise<{ spawn: () => IPty }>,
    ...(options.applyCpuPriority
      ? {
          applyCpuPriority: (pid: number | undefined) => {
            pidCalls.push(pid);
            return (options.applyCpuPriority as (p: number | undefined) => AgentCpuPriorityOutcome)(pid);
          },
        }
      : {}),
  });
  MANAGERS.push(manager);
  return { manager, pidCalls, ptyPid: pty.pid };
}

const TEMP_ROOTS: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fusion-cpu-prio-"));
  TEMP_ROOTS.push(dir);
  return dir;
}

function spawnOptions(purpose: CliSessionPurpose, overrides: Record<string, unknown> = {}) {
  return {
    adapterId: "test",
    projectId: "proj-1",
    purpose,
    worktreePath: tempRoot(),
    taskId: purpose === "chat" ? null : "task-1",
    chatSessionId: purpose === "chat" ? "chat-1" : null,
    ...overrides,
  };
}

/*
FNXC:AgentCpuPriority 2026-11-08-17:31 (RUFU-901):
The baseline is MEASURED, never assumed to be 0. Verification runs the suite under `nice -n 10` (the fleet
host carries load average 16-27 and far more while other runs overlap), so the test worker already sits at
niceness 10 and every `sleep` child it forks inherits that value.
Hardcoding `0` made the inert tests fail against a correct implementation AND made a "demoted to 10"
assertion pass while the mechanism did nothing — a false positive in both directions. Every kernel-readback
assertion therefore compares against this measured baseline, and the configured value is chosen relative to
it so a demotion is always observable.
*/
let measuredSpawnBaseline: number | null = null;
function spawnBaselinePriority(): number {
  if (measuredSpawnBaseline === null) measuredSpawnBaseline = getPriority(realChildPid());
  return measuredSpawnBaseline;
}

/** A configured niceness strictly greater than the baseline, so a demotion is observable. */
function demotionTarget(baseline: number): number {
  return Math.min(baseline + 3, 19);
}

/** A seam that records the request and reports success, for the platform-portable routing assertions. */
function recordingSeam(): (pid: number | undefined) => AgentCpuPriorityOutcome {
  return (pid) => ({ applied: true, pid: pid ?? -1, niceness: 10 });
}

const serverPriorityAtLoad = getPriority(process.pid);

function cleanup() {
  for (const manager of MANAGERS.splice(0)) manager.dispose();
  for (const child of REAL_CHILDREN.splice(0)) child.kill();
  while (TEMP_ROOTS.length) rmSync(TEMP_ROOTS.pop()!, { recursive: true, force: true });
}

describe("CliSessionManager — agent-lane CPU priority routing", () => {
  let priorValue: string | undefined;

  beforeEach(() => {
    priorValue = process.env[AGENT_CPU_NICENESS_ENV];
  });

  afterEach(() => {
    if (priorValue === undefined) delete process.env[AGENT_CPU_NICENESS_ENV];
    else process.env[AGENT_CPU_NICENESS_ENV] = priorValue;
    cleanup();
  });

  it("asks the priority seam for exactly the pid the PTY reported, once per lane spawn", async () => {
    process.env[AGENT_CPU_NICENESS_ENV] = String(demotionTarget(spawnBaselinePriority()));
    const world = makeWorld({ applyCpuPriority: recordingSeam() });
    await world.manager.spawn(spawnOptions("execute") as never);
    expect(world.pidCalls).toEqual([world.ptyPid]);
  });

  it("routes every automatic lane purpose and refuses to route the interactive chat purpose", async () => {
    process.env[AGENT_CPU_NICENESS_ENV] = String(demotionTarget(spawnBaselinePriority()));
    const world = makeWorld({ applyCpuPriority: recordingSeam() });
    for (const purpose of [...LANE_PURPOSES, "chat"] as CliSessionPurpose[]) {
      await world.manager.spawn(spawnOptions(purpose) as never);
    }
    // Four lane spawns reached the seam; the chat spawn did not.
    expect(world.pidCalls).toEqual([
      world.ptyPid,
      world.ptyPid,
      world.ptyPid,
      world.ptyPid,
    ]);
  });

  it.each(LANE_PURPOSES)(
    "routes a %s lane to the seam even without the opt-in, so core owns the decision",
    async (purpose) => {
      delete process.env[AGENT_CPU_NICENESS_ENV];
      const world = makeWorld({
        applyCpuPriority: () => ({ applied: false, reason: "disabled" }),
      });
      await world.manager.spawn(spawnOptions(purpose) as never);
      expect(world.pidCalls).toEqual([world.ptyPid]);
    },
  );

  it("leaves the priority of the process hosting the UI exactly where it was", async () => {
    // Lanes run through the DEFAULT wiring with the opt-in set; the server's own niceness must not move by
    // any amount. The refusal of a self pid is asserted directly, with its exact reason value, in
    // packages/core/src/__tests__/agent-cpu-priority.test.ts — this assertion is the end-to-end half.
    process.env[AGENT_CPU_NICENESS_ENV] = String(demotionTarget(spawnBaselinePriority()));
    const world = makeWorld();
    for (const purpose of [...LANE_PURPOSES, "chat"] as CliSessionPurpose[]) {
      await world.manager.spawn(spawnOptions(purpose) as never);
    }
    expect(getPriority(process.pid)).toBe(serverPriorityAtLoad);
  });
});

describe("CliSessionManager — agent-lane CPU priority applied to a real process", () => {
  let priorValue: string | undefined;

  beforeEach(() => {
    priorValue = process.env[AGENT_CPU_NICENESS_ENV];
  });

  afterEach(() => {
    if (priorValue === undefined) delete process.env[AGENT_CPU_NICENESS_ENV];
    else process.env[AGENT_CPU_NICENESS_ENV] = priorValue;
    cleanup();
  });

  // POSIX-only: Windows has no `sleep` and maps niceness to a lossy priority class.
  it.each(LANE_PURPOSES)(
    "demotes a real %s lane child by exactly the configured amount through the default wiring",
    async (purpose) => {
      if (!POSIX) return;
      const baseline = spawnBaselinePriority();
      const target = demotionTarget(baseline);
      if (target === baseline) return; // Already at the niceness ceiling; no demotion is observable.
      process.env[AGENT_CPU_NICENESS_ENV] = String(target);
      const pid = realChildPid();
      expect(getPriority(pid)).toBe(baseline);
      const world = makeWorld({ ptyPid: pid });

      await world.manager.spawn(spawnOptions(purpose) as never);

      expect(getPriority(pid)).toBe(target);
    },
  );

  it("leaves a real interactive chat child at its baseline priority with the opt-in set", async () => {
    if (!POSIX) return;
    const baseline = spawnBaselinePriority();
    const target = demotionTarget(baseline);
    if (target === baseline) return;
    process.env[AGENT_CPU_NICENESS_ENV] = String(target);
    const pid = realChildPid();
    const world = makeWorld({ ptyPid: pid });

    await world.manager.spawn(spawnOptions("chat") as never);

    expect(getPriority(pid)).toBe(baseline);
  });

  it("leaves a real lane child untouched when the opt-in is unset — the unchanged-default ratchet", async () => {
    if (!POSIX) return;
    const baseline = spawnBaselinePriority();
    const target = demotionTarget(baseline);
    if (target === baseline) return;
    // The same value the demotion arm above proves is applied, only left unset here: a green pair means the
    // opt-in causes the change, not the spawn.
    delete process.env[AGENT_CPU_NICENESS_ENV];
    const pid = realChildPid();
    expect(getPriority(pid)).toBe(baseline);
    const world = makeWorld({ ptyPid: pid });

    await world.manager.spawn(spawnOptions("execute") as never);

    expect(getPriority(pid)).toBe(baseline);
  });

  it("keeps an invalid opt-in inert and still spawns the lane", async () => {
    if (!POSIX) return;
    const baseline = spawnBaselinePriority();
    const target = demotionTarget(baseline);
    if (target === baseline) return;
    // A negative value is the specific typo that would promote a lane above the UI.
    process.env[AGENT_CPU_NICENESS_ENV] = String(-target);
    const pid = realChildPid();
    const world = makeWorld({ ptyPid: pid });

    await expect(world.manager.spawn(spawnOptions("execute") as never)).resolves.toBeDefined();
    expect(getPriority(pid)).toBe(baseline);
  });
});
