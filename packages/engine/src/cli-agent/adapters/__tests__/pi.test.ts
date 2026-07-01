import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import { TelemetryHub } from "../../telemetry-hub.js";
import {
  piAdapter,
  PI_CAPABILITIES,
  mapSessionLine,
  toTelemetryEvent,
  PiSessionTailer,
  PiReadinessDetector,
  findSessionFile,
  type DirentLike,
} from "../pi.js";

function dir(name: string): DirentLike {
  return { name, isDirectory: () => true };
}
function file(name: string): DirentLike {
  return { name, isDirectory: () => false };
}

describe("piAdapter — capabilities + identity", () => {
  it("declares the native tier capability flags (session-jsonl)", () => {
    expect(piAdapter.id).toBe("pi");
    expect(piAdapter.capabilities).toEqual({
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "session-jsonl",
      supportsResume: true,
    });
    expect(PI_CAPABILITIES).toEqual(piAdapter.capabilities);
  });
});

describe("piAdapter — buildLaunch", () => {
  it("launches bare `pi` with no settings", () => {
    const spec = piAdapter.buildLaunch({ settings: {}, posture: null });
    expect(spec.command).toBe("pi");
    expect(spec.args).toEqual([]);
  });

  it("passes --provider, --model, and a session-scoped --session-dir", () => {
    const spec = piAdapter.buildLaunch({
      settings: { provider: "anthropic", model: "*sonnet*", sessionDir: "/tmp/sess/pi" },
      posture: null,
    });
    expect(spec.args).toEqual([
      "--provider",
      "anthropic",
      "--model",
      "*sonnet*",
      "--session-dir",
      "/tmp/sess/pi",
    ]);
  });

  it("forwards arbitrary direct Anthropic user-entered model ids without Claude CLI routing", () => {
    const spec = piAdapter.buildLaunch({
      settings: { provider: "anthropic", model: "custom-anthropic-model", sessionDir: "/tmp/sess/pi" },
      posture: null,
    });
    expect(spec.command).toBe("pi");
    expect(spec.args).toEqual([
      "--provider",
      "anthropic",
      "--model",
      "custom-anthropic-model",
      "--session-dir",
      "/tmp/sess/pi",
    ]);
  });

  it("widens tool access ONLY when posture.autoApprove is true", () => {
    const off = piAdapter.buildLaunch({ settings: {}, posture: { autoApprove: false } });
    expect(off.args).not.toContain("--tools");
    const on = piAdapter.buildLaunch({ settings: {}, posture: { autoApprove: true } });
    expect(on.args).toEqual(expect.arrayContaining(["--tools", "read,bash,edit,write"]));
  });

  it("env allowlist excludes FUSION_* / service credentials", () => {
    const allow = piAdapter.buildEnvAllowlist({ settings: {}, posture: null });
    expect(allow).toContain("PATH");
    expect(allow).toContain("PI_CODING_AGENT_SESSION_DIR");
    expect(allow.some((k) => k.startsWith("FUSION_"))).toBe(false);
  });
});

describe("piAdapter — buildResume", () => {
  it("produces `pi --session <id>` (partial-uuid or path)", () => {
    const spec = piAdapter.buildResume!({
      settings: { sessionDir: "/tmp/sess/pi" },
      posture: null,
      nativeSessionId: "0e64b2d0",
    });
    expect(spec.command).toBe("pi");
    expect(spec.args).toEqual(expect.arrayContaining(["--session", "0e64b2d0"]));
    // session-dir re-applied for lookup.
    expect(spec.args).toEqual(expect.arrayContaining(["--session-dir", "/tmp/sess/pi"]));
  });
});

describe("piAdapter — formatInjection", () => {
  it("appends a trailing \\r submit, no doubling", () => {
    expect(piAdapter.formatInjection("hello", { bracketedPasteActive: false })).toEqual({
      payload: "hello\r",
    });
    expect(piAdapter.formatInjection("hi\r", { bracketedPasteActive: true })).toEqual({
      payload: "hi\r",
    });
  });
});

describe("mapSessionLine — session JSONL event mapping", () => {
  it("session header → sessionStart capturing the uuid as nativeSessionId", () => {
    const ev = mapSessionLine({ type: "session", version: 3, id: "uuid-1", cwd: "/r" });
    expect(ev).toEqual({ kind: "sessionStart", nativeSessionId: "uuid-1" });
  });

  it("turn_start/agent_start → busy; turn_end/agent_end → done", () => {
    expect(mapSessionLine({ type: "turn_start" })).toEqual({ kind: "busy" });
    expect(mapSessionLine({ type: "agent_start" })).toEqual({ kind: "busy" });
    expect(mapSessionLine({ type: "turn_end" })).toEqual({ kind: "done" });
    expect(mapSessionLine({ type: "agent_end" })).toEqual({ kind: "done" });
  });

  it("input-request events → waitingOnInput", () => {
    const ev = mapSessionLine({ type: "input_request" });
    expect(ev?.kind).toBe("waitingOnInput");
    const ev2 = mapSessionLine({ type: "ask_user" });
    expect(ev2?.kind).toBe("waitingOnInput");
  });

  it("message rows → transcript (flattening text + thinking blocks)", () => {
    const ev = mapSessionLine({
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }] },
    });
    expect(ev).toEqual({ kind: "transcript", role: "assistant", text: "hmmanswer" });
  });

  it("normalizes the toolResult role to tool", () => {
    const ev = mapSessionLine({
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "out" }] },
    });
    expect(ev).toEqual({ kind: "transcript", role: "tool", text: "out" });
  });

  it("returns null for noise rows (model_change, thinking_level_change, empty)", () => {
    expect(mapSessionLine({ type: "model_change", provider: "x" })).toBeNull();
    expect(mapSessionLine({ type: "thinking_level_change" })).toBeNull();
    expect(mapSessionLine({ type: "message", message: { role: "user", content: [] } })).toBeNull();
  });
});

describe("toTelemetryEvent — PiSessionEvent → hub TelemetryEvent", () => {
  it("maps lifecycle + transcript onto the hub contract", () => {
    expect(toTelemetryEvent({ kind: "sessionStart", nativeSessionId: "u" })).toEqual({
      kind: "sessionStart",
      payload: { nativeSessionId: "u" },
    });
    expect(toTelemetryEvent({ kind: "busy" })).toEqual({ kind: "busy", payload: {} });
    expect(toTelemetryEvent({ kind: "done" })).toEqual({ kind: "done", payload: {} });
    expect(toTelemetryEvent({ kind: "waitingOnInput", notification: { kind: "input_request" } })).toEqual({
      kind: "waitingOnInput",
      payload: { notification: { kind: "input_request" } },
    });
    expect(toTelemetryEvent({ kind: "transcript", role: "user", text: "hi" })).toEqual({
      kind: "transcript",
      payload: { text: "hi", role: "user" },
    });
  });
});

describe("PiSessionTailer — incremental session JSONL tail", () => {
  it("yields events incrementally with offset; skips noise", () => {
    const tailer = new PiSessionTailer();
    const header = JSON.stringify({ type: "session", id: "u1", cwd: "/r" }) + "\n";
    const noise = JSON.stringify({ type: "model_change", provider: "x" }) + "\n";
    const msg =
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n";

    expect(tailer.push(header + noise)).toEqual([{ kind: "sessionStart", nativeSessionId: "u1" }]);
    expect(tailer.push(msg)).toEqual([{ kind: "transcript", role: "user", text: "hi" }]);
    expect(tailer.bytesRead).toBe(Buffer.byteLength(header + noise + msg, "utf8"));
  });

  it("holds a partial line until its newline arrives", () => {
    const tailer = new PiSessionTailer();
    const line = JSON.stringify({ type: "session", id: "u2" });
    expect(tailer.push(line.slice(0, 10))).toEqual([]);
    expect(tailer.push(line.slice(10) + "\n")).toEqual([{ kind: "sessionStart", nativeSessionId: "u2" }]);
  });

  it("skips unparseable lines without throwing", () => {
    const tailer = new PiSessionTailer();
    expect(tailer.push("{bad}\n\n")).toEqual([]);
  });
});

describe("findSessionFile — newest *.jsonl, one level of cwd-nesting", () => {
  it("finds the lexically-greatest session file across nested dirs", () => {
    const fs = {
      readdirSync(p: string): DirentLike[] {
        if (p === "/sess") return [dir("--Users-x--"), file("2026-04-09T10_uuidA.jsonl")];
        if (p === "/sess/--Users-x--")
          return [file("2026-04-09T21_uuidB.jsonl"), file("2026-04-09T08_uuidC.jsonl")];
        return [];
      },
    };
    expect(findSessionFile("/sess", fs)).toBe("/sess/--Users-x--/2026-04-09T21_uuidB.jsonl");
  });

  it("returns null when the dir is missing / empty (tolerant)", () => {
    const fs = {
      readdirSync(): DirentLike[] {
        throw new Error("ENOENT");
      },
    };
    expect(findSessionFile("/missing", fs)).toBeNull();
  });
});

describe("PiReadinessDetector", () => {
  it("ready on bracketed-paste enable or prompt glyph", () => {
    const a = new PiReadinessDetector();
    expect(a.observe("starting\n")).toBe(false);
    expect(a.observe("\x1b[?2004h")).toBe(true);
    const b = new PiReadinessDetector();
    expect(b.observe("hi\n")).toBe(false);
    expect(b.observe("\n❯")).toBe(true);
  });
});

describe("end-to-end via TelemetryHub: session header → busy → input-request → done", () => {
  let tmpDir: string;
  let db: Database;
  let store: CliSessionStore;
  let hub: TelemetryHub;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-pi-e2e-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    const rec = store.createSession({
      purpose: "execute",
      projectId: "p1",
      adapterId: "pi",
      agentState: "starting",
    });
    sessionId = rec.id;
    hub = new TelemetryHub({ store });
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function feed(obj: Record<string, unknown>) {
    const ev = mapSessionLine(obj);
    if (ev) hub.ingest(sessionId, toTelemetryEvent(ev));
  }

  it("drives ready → busy → waitingOnInput → busy → done and captures session uuid", () => {
    feed({ type: "session", id: "pi-uuid" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("ready");
    expect(store.getSession(sessionId)?.nativeSessionId).toBe("pi-uuid");

    feed({ type: "turn_start" }); // ready → busy via the busy route... but markReady leaves us at ready
    // markReady put us at ready; a busy event from ready is invalid, so the hub
    // swallows it. Drive the injection transition explicitly (the session manager
    // does this when it injects the prompt), then continue.
    if (hub.getStateMachine(sessionId)?.getState() === "ready") {
      hub.getStateMachine(sessionId)!.injectPrompt();
    }
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy");

    feed({ type: "input_request" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("waitingOnInput");

    feed({ type: "turn_start" }); // user answered → busy
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy");

    feed({ type: "turn_end" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("done");
  });
});
