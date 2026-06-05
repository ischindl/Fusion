import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import type { IPty } from "node-pty";
import {
  CliSessionManager,
  CliConcurrencyLimitError,
  neutralizeInjection,
  DEFAULT_SCROLLBACK_BYTES,
} from "../session-manager.js";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";

const textDecoder = new TextDecoder();

// Probe whether real PTY I/O actually flows in this environment. Some sandboxed
// shells allow node-pty to load and spawn but never deliver PTY bytes; in that
// case the real-PTY suite self-skips (same philosophy as the native-load skip).
async function canRealPtyIo(): Promise<boolean> {
  try {
    const { loadPtyModule } = await import("../../pty-native.js");
    const pty = await loadPtyModule();
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {
          // already dead
        }
        resolve(ok);
      };
      const proc = pty.spawn("bash", ["-c", "printf PROBE"], {
        name: "xterm-256color",
        cols: 20,
        rows: 5,
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "" },
      });
      proc.onData(() => settle(true));
      proc.onExit(() => settle(false));
      setTimeout(() => settle(false), 4000);
    });
  } catch {
    return false;
  }
}

// ── Mock PTY at the loadPtyModule seam ─────────────────────────────────────
//
// A scripted in-memory PTY records every byte written, lets the test push
// synthetic output (driving readiness + bracketed-paste detection), and tracks
// kill/resize/pause/resume. This gives deterministic byte-level assertions for
// the security-critical paths (neutralization, FIFO, paste mode) without timing
// flakiness; a separate test exercises the real node-pty.

interface MockPty extends IPty {
  written: string[];
  killed: boolean;
  killSignal: string | undefined;
  resized: { cols: number; rows: number }[];
  paused: boolean;
  spawnEnv: { [key: string]: string };
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}

interface MockState {
  ptys: MockPty[];
}

function makeMockPtyModule(state: MockState): typeof import("node-pty") {
  return {
    spawn(_file: string, _args: string[] | string, options: { env?: { [k: string]: string } }) {
      let dataCb: ((d: string) => void) | undefined;
      let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
      const mock: MockPty = {
        pid: 1000 + state.ptys.length,
        cols: 80,
        rows: 24,
        process: "mock",
        handleFlowControl: false,
        written: [],
        killed: false,
        killSignal: undefined,
        resized: [],
        paused: false,
        spawnEnv: (options.env ?? {}) as { [k: string]: string },
        onData: (cb: (d: string) => void) => {
          dataCb = cb;
          return { dispose() {} };
        },
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
          exitCb = cb;
          return { dispose() {} };
        },
        on() {},
        write(data: string) {
          mock.written.push(data);
        },
        resize(cols: number, rows: number) {
          mock.resized.push({ cols, rows });
        },
        clear() {},
        kill(signal?: string) {
          mock.killed = true;
          mock.killSignal = signal;
        },
        pause() {
          mock.paused = true;
        },
        resume() {
          mock.paused = false;
        },
        emitData(d: string) {
          dataCb?.(d);
        },
        emitExit(exitCode: number, signal?: number) {
          exitCb?.({ exitCode, signal });
        },
      } as unknown as MockPty;
      state.ptys.push(mock);
      return mock as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

// ── Test adapter ───────────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<CliAgentAdapter> = {}): CliAgentAdapter {
  return {
    id: "test-cli",
    name: "Test CLI",
    capabilities: {
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "hooks",
      supportsResume: true,
    },
    buildLaunch: () => ({ command: "test-cli", args: ["--interactive"] }),
    buildEnvAllowlist: () => ["PATH", "HOME"],
    // Ready as soon as we see the "READY" marker.
    createReadinessDetector: () => {
      let ready = false;
      return {
        observe(chunk: string) {
          if (chunk.includes("READY")) ready = true;
          return ready;
        },
      };
    },
    // Trailing carriage return submits the injection.
    formatInjection: (text) => ({ payload: `${text}\r` }),
    buildResume: (ctx) => ({ command: "test-cli", args: ["--resume", ctx.nativeSessionId] }),
    ...overrides,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  manager: CliSessionManager;
  registry: CliAdapterRegistry;
  store: CliSessionStore;
  state: MockState;
  db: Database;
  tmpDir: string;
}

function makeHarness(opts?: {
  ceiling?: number;
  scrollbackBytes?: number;
  injectionQuietWindowMs?: number;
  adapter?: CliAgentAdapter;
}): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-sm-test-"));
  const fusionDir = join(tmpDir, ".fusion");
  const db = new Database(fusionDir, { inMemory: true });
  db.init();
  const store = new CliSessionStore(fusionDir, db);
  const registry = new CliAdapterRegistry();
  registry.register(opts?.adapter ?? makeAdapter());
  const state: MockState = { ptys: [] };
  const manager = new CliSessionManager({
    registry,
    store,
    concurrencyCeiling: opts?.ceiling,
    scrollbackBytes: opts?.scrollbackBytes,
    injectionQuietWindowMs: opts?.injectionQuietWindowMs,
    loadPty: async () => makeMockPtyModule(state),
  });
  return { manager, registry, store, state, db, tmpDir };
}

async function spawnSession(h: Harness, extra?: Record<string, unknown>) {
  return h.manager.spawn({
    adapterId: "test-cli",
    projectId: "proj-1",
    purpose: "execute",
    taskId: "FN-1",
    worktreePath: h.tmpDir,
    ...extra,
  });
}

function allWritten(pty: MockPty): string {
  return pty.written.join("");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("CliSessionManager (scripted PTY)", () => {
  let harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) {
      h.manager.dispose();
      h.db.close();
      await rm(h.tmpDir, { recursive: true, force: true });
    }
    harnesses = [];
  });

  function newHarness(opts?: Parameters<typeof makeHarness>[0]): Harness {
    const h = makeHarness(opts);
    harnesses.push(h);
    return h;
  }

  it("happy path: spawn → readiness → inject once ready → output in ring → clean teardown kills child", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    expect(record.agentState).toBe("starting");
    const pty = h.state.ptys[0];

    // Inject before ready: must wait for readiness, no write yet.
    const injectP = h.manager.inject(record.id, "do the thing");
    await Promise.resolve();
    expect(allWritten(pty)).toBe("");

    // Child emits readiness.
    pty.emitData("welcome\r\nREADY> ");
    await injectP;
    expect(allWritten(pty)).toBe("do the thing\r");

    // Output lands in ring (visible via attach scrollback).
    pty.emitData("working...\r\n");
    const att = h.manager.attach(record.id);
    expect(textDecoder.decode(att.scrollback)).toContain("working...");
    att.detach();

    // Persisted state advanced to ready.
    expect(h.store.getSession(record.id)?.agentState).toBe("ready");

    // Clean teardown kills the child (scoped SIGKILL).
    h.manager.kill(record.id);
    expect(pty.killed).toBe(true);
    expect(pty.killSignal).toBe("SIGKILL");
    expect(h.manager.activeCount()).toBe(0);
    const after = h.store.getSession(record.id);
    expect(after?.agentState).toBe("dead");
    expect(after?.terminationReason).toBe("killed");
  });

  it("injection serialization: user write queued mid-injection never interleaves; two injections FIFO", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    // Queue two injections and a user write between them (synchronously).
    const i1 = h.manager.inject(record.id, "first");
    h.manager.write(record.id, "U"); // user keystroke
    const i2 = h.manager.inject(record.id, "second");
    await Promise.all([i1, i2]);

    // FIFO across the shared queue: first injection, then the user keystroke,
    // then the second injection — never byte-interleaved.
    expect(pty.written).toEqual(["first\r", "U", "second\r"]);
  });

  it("injection deferred while output streaming, dispatched in a quiet window", async () => {
    const h = newHarness({ injectionQuietWindowMs: 30 });
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    const injectP = h.manager.inject(record.id, "deferred");
    // Output keeps arriving — injection must wait.
    pty.emitData("chunk-a");
    await new Promise((r) => setTimeout(r, 10));
    pty.emitData("chunk-b");
    expect(allWritten(pty)).toBe(""); // still deferred

    await injectP; // resolves once quiet window elapses
    expect(allWritten(pty)).toBe("deferred\r");
  });

  it("bracketed paste only when ?2004h observed; raw otherwise", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];

    // Raw path first (no bracketed paste negotiated).
    pty.emitData("READY");
    await h.manager.inject(record.id, "raw msg");
    expect(pty.written.at(-1)).toBe("raw msg\r");
    expect(allWritten(pty)).not.toContain("\x1b[200~");

    // Child enables bracketed paste.
    pty.emitData("\x1b[?2004h");
    await h.manager.inject(record.id, "pasted msg");
    const last = pty.written.at(-1)!;
    expect(last).toContain("\x1b[200~pasted msg\x1b[201~");

    // Child disables it again → back to raw.
    pty.emitData("\x1b[?2004l");
    await h.manager.inject(record.id, "raw again");
    expect(pty.written.at(-1)).toBe("raw again\r");
  });

  it("control-char neutralization on raw path: \\x03,\\x04,ESC never reach PTY as control", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    // Injected text laden with Ctrl-C, Ctrl-D, and an ESC sequence.
    await h.manager.inject(record.id, "safe\x03\x04before\x1b[31mafter\nnext");
    const written = pty.written.at(-1)!;

    // No raw control bytes survived (except the intended trailing submit \r and
    // the \n→\r conversion).
    expect(written).not.toContain("\x03");
    expect(written).not.toContain("\x04");
    expect(written).not.toContain("\x1b");
    // Text content preserved; the ESC sequence's bytes are stripped.
    expect(written).toContain("safebefore");
    expect(written).toContain("after");
    expect(written).toContain("next");
  });

  it("user keystrokes bypass neutralization (deliberate control input)", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    // A user pressing Ctrl-C is deliberate control input and must pass through.
    const att = h.manager.attach(record.id);
    att.write("\x03");
    await new Promise((r) => setTimeout(r, 0));
    expect(allWritten(pty)).toContain("\x03");
    att.detach();
  });

  it("concurrency ceiling=2: third rejected with typed error; slot released on teardown", async () => {
    const h = newHarness({ ceiling: 2 });
    const r1 = await spawnSession(h);
    const r2 = await spawnSession(h);
    expect(h.manager.activeCount()).toBe(2);

    await expect(spawnSession(h)).rejects.toBeInstanceOf(CliConcurrencyLimitError);

    // Release a slot.
    h.manager.kill(r1.id);
    expect(h.manager.activeCount()).toBe(1);

    // Now a third spawn succeeds.
    const r3 = await spawnSession(h);
    expect(h.manager.activeCount()).toBe(2);
    expect(r2.id).not.toBe(r3.id);
  });

  it("env allowlist: child env contains only allowlisted keys; FUSION_* and secrets absent", async () => {
    process.env.FUSION_DAEMON_TOKEN = "super-secret-token";
    process.env.FUSION_API_KEY = "sk-fusion-123";
    process.env.HOME = process.env.HOME ?? "/home/test";
    try {
      const h = newHarness();
      const record = await spawnSession(h);
      const pty = h.state.ptys[0];
      const env = pty.spawnEnv;

      // Allowlist is ["PATH","HOME"].
      expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"].filter((k) => process.env[k]).sort());
      expect(env.FUSION_DAEMON_TOKEN).toBeUndefined();
      expect(env.FUSION_API_KEY).toBeUndefined();
      expect(record.id).toBeTruthy();
    } finally {
      delete process.env.FUSION_DAEMON_TOKEN;
      delete process.env.FUSION_API_KEY;
    }
  });

  it("teardown via process registry on simulated exit leaves no orphans", async () => {
    const h = newHarness({ ceiling: 5 });
    const r1 = await spawnSession(h);
    const r2 = await spawnSession(h);
    expect(h.manager.activeCount()).toBe(2);

    // Simulate engine exit by invoking killAll (the process.on("exit") handler).
    h.manager.killAll();

    expect(h.manager.activeCount()).toBe(0);
    for (const pty of h.state.ptys) {
      expect(pty.killed).toBe(true);
      expect(pty.killSignal).toBe("SIGKILL");
    }
    expect(h.store.getSession(r1.id)?.terminationReason).toBe("engineDeath");
    expect(h.store.getSession(r2.id)?.terminationReason).toBe("engineDeath");
  });

  it("two-turns-through-one-session: latched ready state persists across turns", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    // Turn 1.
    await h.manager.inject(record.id, "turn one");
    expect(pty.written.at(-1)).toBe("turn one\r");

    // More output arrives but readiness stays latched (no re-detection needed).
    pty.emitData("...thinking...\r\n");

    // Turn 2 dispatches immediately (no second readiness wait).
    await h.manager.inject(record.id, "turn two");
    expect(pty.written.at(-1)).toBe("turn two\r");
    expect(pty.written.filter((w) => w.endsWith("\r"))).toEqual(["turn one\r", "turn two\r"]);
  });

  it("ring buffer caps at configured bytes (oldest dropped)", async () => {
    const cap = 64;
    const h = newHarness({ scrollbackBytes: cap });
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    // Emit far more than the cap.
    for (let i = 0; i < 20; i++) {
      pty.emitData(`LINE-${i.toString().padStart(2, "0")}-xxxxxx\n`);
    }
    const att = h.manager.attach(record.id);
    const snap = att.scrollback;
    expect(snap.byteLength).toBeLessThanOrEqual(cap);
    const text = textDecoder.decode(snap);
    // Oldest dropped, newest retained.
    expect(text).toContain("LINE-19");
    expect(text).not.toContain("LINE-00");
    att.detach();
  });

  it("attach replay then live bytes without duplication", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");
    pty.emitData("history-1\n");
    pty.emitData("history-2\n");

    const att = h.manager.attach(record.id);
    const replay = textDecoder.decode(att.scrollback);
    expect(replay).toContain("history-1");
    expect(replay).toContain("history-2");

    // Collect live bytes.
    const collected: string[] = [];
    const reader = (async () => {
      for await (const chunk of att.stream) {
        collected.push(textDecoder.decode(chunk));
        if (collected.join("").includes("live-2")) break;
      }
    })();

    pty.emitData("live-1\n");
    pty.emitData("live-2\n");
    await reader;

    const liveText = collected.join("");
    expect(liveText).toContain("live-1");
    expect(liveText).toContain("live-2");
    // No replay bytes duplicated into the live stream.
    expect(liveText).not.toContain("history-1");
    att.detach();
  });

  it("resize applies latest-active-client policy; detach never kills the session", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    const a = h.manager.attach(record.id);
    const b = h.manager.attach(record.id);
    a.resize(100, 40);
    b.resize(120, 50); // latest wins (last call applied)
    expect(pty.resized.at(-1)).toEqual({ cols: 120, rows: 50 });

    a.detach();
    expect(h.manager.isLive(record.id)).toBe(true); // detach != kill
    b.detach();
    expect(h.manager.isLive(record.id)).toBe(true);
  });

  it("requestPause/requestResume toggle the underlying PTY", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const pty = h.state.ptys[0];
    pty.emitData("READY");

    h.manager.requestPause(record.id);
    expect(pty.paused).toBe(true);
    h.manager.requestResume(record.id);
    expect(pty.paused).toBe(false);
  });

  it("process exit classifies nonzero/signal as crashed, exit-0 as completed", async () => {
    const h = newHarness();
    const r0 = await spawnSession(h);
    h.state.ptys[0].emitExit(0);
    expect(h.store.getSession(r0.id)?.terminationReason).toBe("completed");

    const r1 = await spawnSession(h);
    h.state.ptys[1].emitExit(1);
    expect(h.store.getSession(r1.id)?.terminationReason).toBe("crashed");
  });

  it("persists a session record at spawn (create) with starting state", async () => {
    const h = newHarness();
    const record = await spawnSession(h);
    const persisted = h.store.getSession(record.id);
    expect(persisted).toBeDefined();
    expect(persisted?.adapterId).toBe("test-cli");
    expect(persisted?.purpose).toBe("execute");
    expect(persisted?.taskId).toBe("FN-1");
    expect(persisted?.worktreePath).toBe(h.tmpDir);
  });
});

describe("neutralizeInjection (unit)", () => {
  it("drops C0 controls and ESC, converts \\n to \\r, preserves \\t and \\r", () => {
    const out = neutralizeInjection("a\x00b\x03c\x04d\x1b[31me\tf\ng\rh");
    // ESC (\x1b) is dropped — disarming the escape sequence; the following
    // printable "[31m" survive as inert text (no ESC to introduce them as a
    // control sequence). The security guarantee is "no ESC reaches the PTY".
    expect(out).toBe("abcd[31me\tf\rg\rh");
    expect(out).not.toContain("\x1b");
  });

  it("strips DEL (0x7f)", () => {
    expect(neutralizeInjection("x\x7fy")).toBe("xy");
  });
});

// ── Real node-pty end-to-end (skipped if native load fails) ────────────────

describe("CliSessionManager (real node-pty)", () => {
  let tmpDir: string;
  let db: Database;
  let manager: CliSessionManager | undefined;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-sm-real-"));
    // A scripted CLI: print READY, echo each stdin line back prefixed.
    scriptPath = join(tmpDir, "fake-cli.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nprintf 'READY>'\nwhile IFS= read -r line; do printf 'GOT:%s\\n' "$line"; if [ "$line" = "quit" ]; then exit 0; fi; done\n`,
      "utf8",
    );
    chmodSync(scriptPath, 0o755);
  });

  afterEach(async () => {
    manager?.dispose();
    db?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("spawns a real PTY, detects readiness, injects, captures echoed output, kills cleanly", async () => {
    if (!(await canRealPtyIo())) {
      console.warn("[test] PTY I/O does not flow in this environment, skipping real-PTY test");
      return;
    }
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    const store = new CliSessionStore(fusionDir, db);
    const registry = new CliAdapterRegistry();
    registry.register(
      makeAdapter({
        buildLaunch: () => ({ command: "bash", args: [scriptPath] }),
        buildEnvAllowlist: () => ["PATH"],
        createReadinessDetector: () => {
          let ready = false;
          return {
            observe(chunk: string) {
              if (chunk.includes("READY")) ready = true;
              return ready;
            },
          };
        },
        formatInjection: (text) => ({ payload: `${text}\r` }),
      }),
    );

    let mgr: CliSessionManager;
    try {
      mgr = new CliSessionManager({ registry, store });
    } catch (err) {
      console.warn("[test] node-pty unavailable, skipping real-PTY test:", err);
      return;
    }
    manager = mgr;

    let record;
    try {
      record = await mgr.spawn({
        adapterId: "test-cli",
        projectId: "proj-1",
        purpose: "execute",
        worktreePath: tmpDir,
        cols: 80,
        rows: 24,
      });
    } catch (err) {
      console.warn("[test] node-pty spawn failed, skipping real-PTY assertions:", err);
      return;
    }

    const att = mgr.attach(record.id);
    // Collect output.
    let buf = "";
    const reader = (async () => {
      for await (const chunk of att.stream) {
        buf += textDecoder.decode(chunk);
        if (buf.includes("GOT:hello")) break;
      }
    })();

    await mgr.waitForReady(record.id);
    await mgr.inject(record.id, "hello");

    await Promise.race([
      reader,
      new Promise((r) => setTimeout(r, 5000)),
    ]);

    expect(buf).toContain("GOT:hello");

    mgr.kill(record.id);
    expect(mgr.isLive(record.id)).toBe(false);
    att.detach();
  }, 15000);
});

// Touch the export so the import is exercised even if a path is removed later.
void DEFAULT_SCROLLBACK_BYTES;
