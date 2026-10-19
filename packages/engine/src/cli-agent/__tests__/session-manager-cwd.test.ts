/**
 * Working-directory contract of the cli-agent PTY lane (RUFU-334).
 *
 * The incident this file guards: a chat-bound CLI session reached this seam with no `worktreePath`, the
 * spawn option fell through `options.worktreePath ?? process.cwd()`, and an interactive write-capable CLI
 * started inside the checkout the dashboard server itself was launched from — with no task or agent id in
 * its environment to blame. These tests pin the replacement contract on both legs:
 *
 *   1. an explicit root is forwarded to the PTY verbatim and recorded on the durable row;
 *   2. a missing or blank root is a named refusal raised before any PTY exists and before any durable
 *      record is minted, on the fresh-spawn leg AND the resume leg;
 *   3. a root inside an operator-declared protected checkout is refused by the shared core policy before
 *      the PTY starts.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-12:59 (RUFU-334):
 * The fake PTY factory records its spawn options instead of starting a process, so the assertions read the
 * exact cwd the child would have received rather than a proxy for it.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSession, CliSessionStore } from "@fusion/core";
import { ProtectedCheckoutError } from "@fusion/core";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import { CliMissingWorktreeError, CliSessionManager } from "../session-manager.js";
import type { IPty } from "node-pty";

interface RecordedSpawn {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

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
    listByChatSession: vi.fn((chatSessionId: string) =>
      [...sessions.values()]
        .filter((s) => s.chatSessionId === chatSessionId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ),
    deleteSession: vi.fn((id: string) => sessions.delete(id)),
  }) as unknown as CliSessionStore;
  return { store, sessions };
}

function readCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

interface World {
  manager: CliSessionManager;
  store: CliSessionStore;
  sessions: Map<string, CliSession>;
  spawns: RecordedSpawn[];
}

function makeWorld(): World {
  const registry = new CliAdapterRegistry();
  registry.register(makeAdapter());
  const { store, sessions } = makeStore();
  const spawns: RecordedSpawn[] = [];
  const pty = {
    pid: 4242,
    onData: () => {},
    onExit: () => {},
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
  const manager = new CliSessionManager({
    registry,
    store,
    // Cast at the loader seam (the pattern the sibling cli-agent tests use): the fake records the exact
    // spawn arguments, and node-pty's real `spawn` signature is wider than anything a fake needs to match.
    loadPty: vi.fn(async () => ({
      spawn: (command: string, args: string | string[], options: Record<string, unknown>) => {
        spawns.push({ command, args: Array.isArray(args) ? args : [args], options });
        return pty as unknown as IPty;
      },
    })) as unknown as () => Promise<{ spawn: () => IPty }>,
    launchSettingsProvider: vi.fn(async () => null),
  });
  return {
    manager,
    store,
    sessions,
    spawns,
  };
}

const TEMP_ROOTS: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_ROOTS.push(dir);
  return dir;
}

describe("CliSessionManager — working-directory contract", () => {
  const priorProtected = process.env.FUSION_PROTECTED_CHECKOUTS;
  let world: World;

  beforeEach(() => {
    world = makeWorld();
    delete process.env.FUSION_PROTECTED_CHECKOUTS;
  });

  afterEach(() => {
    if (priorProtected === undefined) delete process.env.FUSION_PROTECTED_CHECKOUTS;
    else process.env.FUSION_PROTECTED_CHECKOUTS = priorProtected;
    while (TEMP_ROOTS.length) {
      const dir = TEMP_ROOTS.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function spawnOptions(overrides: Record<string, unknown> = {}) {
    return {
      adapterId: "test",
      projectId: "proj-1",
      purpose: "chat" as const,
      chatSessionId: "chat-1",
      cols: 80,
      rows: 24,
      ...overrides,
    };
  }

  it("forwards an explicit worktreePath verbatim as the PTY cwd and records it", async () => {
    const worktree = tempRoot("fusion-cli-cwd-");
    await world.manager.spawn(spawnOptions({ worktreePath: worktree }) as never);

    expect(world.spawns).toHaveLength(1);
    expect(world.spawns[0].options.cwd).toBe(worktree);
    expect([...world.sessions.values()][0].worktreePath).toBe(worktree);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["blank", "   "],
  ])("refuses a %s worktreePath by name before spawning or minting a record", async (_label, value) => {
    await expect(
      world.manager.spawn(spawnOptions({ worktreePath: value }) as never),
    ).rejects.toMatchObject({ code: "CLI_MISSING_WORKTREE", name: "CliMissingWorktreeError" });

    expect(world.spawns).toEqual([]);
    expect(world.sessions.size).toBe(0);
    expect(readCalls(world.store.createSession)).toEqual([]);
  });

  it("does not name the process working directory in the refusal", async () => {
    const err = await world.manager
      .spawn(spawnOptions({ worktreePath: null }) as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliMissingWorktreeError);
    expect((err as Error).message).toContain("without an explicit working directory");
    expect((err as Error).message).not.toContain(process.cwd());
  });

  it("refuses a resume whose durable record carries no root, on the resume leg", async () => {
    const record = world.store.createSession({
      adapterId: "test",
      projectId: "proj-1",
      purpose: "chat",
      chatSessionId: "chat-9",
      worktreePath: null,
      nativeSessionId: "native-1",
    } as never);

    await expect(
      world.manager.spawn(
        spawnOptions({
          chatSessionId: "chat-9",
          worktreePath: null,
          resume: { sessionId: record.id, nativeSessionId: "native-1" },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: "CLI_MISSING_WORKTREE" });

    expect(world.spawns).toEqual([]);
  });

  it("refuses a protected parent before any PTY exists", async () => {
    const protectedRoot = tempRoot("fusion-protected-");
    const nested = join(protectedRoot, ".fusion", "scratch");
    mkdirSync(nested, { recursive: true });
    process.env.FUSION_PROTECTED_CHECKOUTS = protectedRoot;

    const err = await world.manager
      .spawn(spawnOptions({ worktreePath: nested }) as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProtectedCheckoutError);
    const message = (err as Error).message;
    expect(message).toContain(nested);
    expect(message).toContain(protectedRoot);
    expect(message).toContain("FUSION_PROTECTED_CHECKOUTS");

    expect(world.spawns).toEqual([]);
    expect(world.sessions.size).toBe(0);
  });

  it("refuses a protected root that is the supplied path itself", async () => {
    const protectedRoot = tempRoot("fusion-protected-self-");
    process.env.FUSION_PROTECTED_CHECKOUTS = protectedRoot;

    await expect(
      world.manager.spawn(spawnOptions({ worktreePath: protectedRoot }) as never),
    ).rejects.toMatchObject({ name: "ProtectedCheckoutError" });

    expect(world.spawns).toEqual([]);
  });

  it("leaves an unprotected root untouched when the variable is unset", async () => {
    const project = tempRoot("fusion-project-");
    await expect(world.manager.spawn(spawnOptions({ worktreePath: project }) as never)).resolves.toBeTruthy();
    expect(world.spawns[0].options.cwd).toBe(project);
  });
});
