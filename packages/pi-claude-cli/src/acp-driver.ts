/**
 * ACP transport for the pi-claude-cli provider (U11 — Route A).
 *
 * `streamViaAcp` is the drop-in alternative to `streamViaCli` that drives Claude
 * through the `claude-code-cli-acp` bridge over the Agent Client Protocol instead
 * of `claude -p`. It returns the SAME `AssistantMessageEventStream` shape, so the
 * provider's `streamSimple` can dispatch to either transport behind a kill-switch.
 *
 * Design (see plan U11):
 * - Full-history prompt EVERY turn (`buildPrompt`) — the ACP path has no Claude
 *   `--resume`, so we never send the latest-turn-only `buildResumePrompt` (R13).
 * - MCP tool SCHEMAS are forwarded on `session/new` so Claude knows the Fusion
 *   tools and emits correct `tool_use` calls; we DO NOT let the bridge execute
 *   them. We break early ONLY on a pi-known tool (mirroring the `-p` guard) — and
 *   surface it to pi, which runs the tool itself. Claude's INTERNAL tools
 *   (`ToolSearch`/`Task`/…) are NOT pi-known: we must NOT break on them, or we'd
 *   abort the turn before the real `fn_*` call (Claude uses `ToolSearch` to load
 *   deferred MCP tools first). See review P0 (correctness).
 * - Translation reuses the tested `createEventBridge` by synthesizing Claude
 *   stream events from ACP `session/update`s, so pi event sequencing, tool-name
 *   mapping and arg translation are shared with the `-p` path.
 * - Untrusted-output floor: agent text/thinking is control-char-stripped and
 *   byte-capped; identifiers are bounded (review P1, security).
 *
 * Auth: the bridge spawns the real `claude`, which authenticates from the host
 * login/keychain session (R17). The bridge binary path is injected by the caller
 * (engine seam, KTD10) — this module never reaches into the ACP plugin.
 *
 * NOT-YET-VERIFIED (kill-switch stays OFF until then): the bridge's tool-execution
 * ordering (`session/request_permission` vs `tool_call` update) and native-tool
 * (Read/Write/Bash) execution-prevention need a live behavioral test against the
 * real bridge before any lane enables this path. `requestPermission` denies by
 * default and we break early, but the TOCTOU window is unproven (review P2).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildPrompt, buildSystemPrompt, type PiContext } from "./prompt-builder.js";
import { createEventBridge } from "./event-bridge.js";
import { registerProcess, captureStderr } from "./process-manager.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import type { ClaudeApiEvent } from "./types.js";

/** A stdio MCP server forwarded on `session/new` (schema-only — never executed here). */
export interface AcpMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** Options for the ACP transport: pi's stream options plus ACP wiring. */
export type StreamViaAcpOptions = SimpleStreamOptions & {
  cwd?: string;
  /** Absolute path to the `claude-code-cli-acp` bridge binary (injected by the engine seam). */
  bridgePath: string;
  /** MCP servers (tool schemas) forwarded so Claude emits correct tool calls. */
  mcpServers?: AcpMcpServerSpec[];
  /** Env keys to forward to the bridge — filtered to the allow-list below regardless. */
  bridgeEnv?: NodeJS.ProcessEnv;
};

const INITIALIZE_TIMEOUT_MS = 30_000;
/** Last-resort guard: kill a silent bridge. Mirrors streamViaCli (30 min). */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;
/** Untrusted-output bounds (review P1, security). */
const MAX_CHUNK_CHARS = 64 * 1024;
const MAX_TURN_CHARS = 5_000_000;
const MAX_ID_CHARS = 256;

/**
 * Bridge subprocess env allow-list. The bridged `claude` needs HOME (for
 * `~/.claude` auth/keychain, R17) and PATH; terminal vars improve rendering.
 * Inherited `process.env` and any secret-bearing keys are NEVER forwarded — the
 * filter is enforced HERE, not trusted from the caller (review P2, security).
 */
const BRIDGE_ENV_ALLOWLIST = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERMINFO", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COLORTERM",
];

function buildBridgeEnv(supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = supplied ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of BRIDGE_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  return env;
}

/** Strip ANSI escape sequences and C0/C1 control chars (keep \n \r \t), then cap length. */
function sanitizeText(text: string, cap = MAX_CHUNK_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return stripped.length > cap ? stripped.slice(0, cap) : stripped;
}

/** Bound an untrusted identifier (tool id / name) before it becomes a content-block key. */
function boundId(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f/\\]/g, "").slice(0, MAX_ID_CHARS);
}

/**
 * Convert buildPrompt's output into ACP prompt content blocks, PRESERVING image
 * blocks (review P1, correctness — flatten-to-text dropped vision input).
 */
function toAcpPromptBlocks(
  prompt: string | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  const out: Array<Record<string, unknown>> = [];
  for (const b of prompt) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image" && b.source && typeof b.source === "object") {
      const src = b.source as { media_type?: string; data?: string };
      if (src.data) out.push({ type: "image", mimeType: src.media_type ?? "image/png", data: src.data });
    }
  }
  return out;
}

/**
 * Stream a Claude response via the ACP bridge as an `AssistantMessageEventStream`.
 * Mirrors `streamViaCli`'s contract (start → deltas → done; break-early on tools).
 */
export function streamViaAcp(
  model: Model<Api>,
  context: PiContext,
  options: StreamViaAcpOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — pi-ai exports AssistantMessageEventStream as a type; the
  // constructor exists at runtime (same workaround as streamViaCli).
  const stream = new AssistantMessageEventStream();
  const bridge = createEventBridge(stream, model);

  (async () => {
    let child: ChildProcess | undefined;
    let getStderr: (() => string) | undefined;
    let ended = false;
    let turnChars = 0;
    let blockIndex = -1;
    let openKind: "text" | "thinking" | null = null;
    let sawToolCall = false;
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (inactivity) { clearTimeout(inactivity); inactivity = undefined; }
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
      try { child?.kill("SIGKILL"); } catch { /* registry SIGKILL is authoritative */ }
    };
    const armInactivity = () => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => failWith(`ACP bridge inactivity timeout after ${INACTIVITY_TIMEOUT_MS / 1000}s`), INACTIVITY_TIMEOUT_MS);
    };

    const finish = (reason: "stop" | "tool_use") => {
      if (ended) return;
      ended = true;
      if (openKind !== null) bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      // Downgrade a tool_use turn that surfaced zero pi tool calls → stop, so pi
      // doesn't try to dispatch non-existent tools (mirrors provider.ts:366-375).
      const toolCount = (bridge.getOutput().content ?? []).filter((c) => (c as { type?: string }).type === "toolCall").length;
      const effective: "stop" | "tool_use" = reason === "tool_use" && toolCount > 0 ? "tool_use" : "stop";
      bridge.handleEvent({ type: "message_delta", delta: { stop_reason: effective === "tool_use" ? "tool_use" : "end_turn" } } as ClaudeApiEvent);
      stream.push({ type: "done", reason: effective === "tool_use" ? "toolUse" : "stop", message: bridge.getOutput() });
      stream.end();
      cleanup();
    };

    const failWith = (msg: string) => {
      if (ended) return;
      ended = true;
      const output = bridge.getOutput();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          ...output,
          content: output.content?.length ? output.content : [{ type: "text" as const, text: `Error: ${msg}` }],
          stopReason: "stop" as const,
        },
      });
      stream.end();
      cleanup();
    };

    const openBlock = (kind: "text" | "thinking") => {
      if (openKind === kind) return;
      if (openKind !== null) bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      blockIndex += 1;
      openKind = kind;
      bridge.handleEvent({ type: "content_block_start", index: blockIndex, content_block: { type: kind } } as ClaudeApiEvent);
    };

    // Surface a pi-known tool call to pi and break early (pi executes it, not the bridge).
    const surfaceToolAndBreak = (claudeName: string, rawId: string, rawInput: unknown) => {
      const id = boundId(rawId);
      if (openKind !== null) { bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent); openKind = null; }
      blockIndex += 1;
      bridge.handleEvent({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", name: boundId(claudeName), id } } as ClaudeApiEvent);
      bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: sanitizeText(JSON.stringify(rawInput ?? {})) } } as ClaudeApiEvent);
      bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      sawToolCall = true;
      finish("tool_use");
    };

    const clientHandler = {
      async sessionUpdate(params: { update?: Record<string, unknown> } & Record<string, unknown>) {
        if (ended) return;
        armInactivity();
        const u = (params.update ?? params) as Record<string, unknown>;
        const kind = u.sessionUpdate as string;
        const content = u.content as { type?: string; text?: string } | undefined;

        if (kind === "agent_message_chunk" && content?.type === "text" && content.text) {
          if (turnChars >= MAX_TURN_CHARS) return;
          openBlock("text");
          const text = sanitizeText(content.text);
          turnChars += text.length;
          bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } } as ClaudeApiEvent);
        } else if (kind === "agent_thought_chunk" && content?.text) {
          if (turnChars >= MAX_TURN_CHARS) return;
          openBlock("thinking");
          const text = sanitizeText(content.text);
          turnChars += text.length;
          bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: text } } as ClaudeApiEvent);
        } else if (kind === "tool_call") {
          // Break early ONLY on a pi-known tool. Claude's internal tools
          // (ToolSearch/Task/…) are not pi-known — let the bridge run them so
          // Claude can load deferred MCP schemas and emit the real fn_* call.
          const claudeName = ((u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName) ?? (u.title as string) ?? "";
          if (isPiKnownClaudeTool(claudeName)) {
            surfaceToolAndBreak(claudeName, (u.toolCallId as string) ?? `acp_${blockIndex + 1}`, u.rawInput ?? u.input);
          }
        }
      },
      async requestPermission(params: Record<string, unknown>) {
        // A permission request means the bridge is about to EXECUTE a tool. For a
        // pi-known tool, surface it to pi and break early (pi executes it); deny
        // by default otherwise. We always return cancelled so the bridge never
        // executes Fusion's tools itself.
        if (!ended) {
          const tc = (params.toolCall ?? {}) as Record<string, unknown>;
          const claudeName = ((tc._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName) ?? (tc.title as string) ?? "";
          if (isPiKnownClaudeTool(claudeName)) {
            surfaceToolAndBreak(claudeName, (tc.toolCallId as string) ?? `acp_${blockIndex + 1}`, tc.rawInput ?? tc.input);
          }
        }
        return { outcome: { outcome: "cancelled" as const } };
      },
    };

    try {
      if (!isAbsolute(options.bridgePath) || !existsSync(options.bridgePath)) {
        failWith(`ACP bridge path invalid (must be an absolute, existing binary): ${options.bridgePath}`);
        return;
      }
      child = spawn(options.bridgePath, [], { stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd ?? process.cwd(), env: buildBridgeEnv(options.bridgeEnv) });
      registerProcess(child);
      getStderr = captureStderr(child);
      child.on("error", (e) => failWith(`ACP bridge spawn failed: ${e.message}`));
      child.on("close", (code) => { if (!ended) failWith(`ACP bridge exited (code ${code ?? "?"})${getStderr ? `: ${getStderr().slice(-500)}` : ""}`); });
      onAbort = () => failWith("aborted");
      if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      armInactivity();

      const acpStream = ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => clientHandler, acpStream);

      const withTimeout = <T>(p: Promise<T>, label: string) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ACP ${label} timeout`)), INITIALIZE_TIMEOUT_MS))]);

      const init = await withTimeout(
        conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
        "initialize",
      );
      if (ended) return;
      if (init.protocolVersion !== PROTOCOL_VERSION) { failWith(`incompatible ACP protocol ${init.protocolVersion}`); return; }

      const opened = await withTimeout(conn.newSession({ cwd: options.cwd ?? process.cwd(), mcpServers: options.mcpServers ?? [] }), "newSession");
      if (ended) return;

      const cwd = options.cwd ?? process.cwd();
      const systemPrompt = buildSystemPrompt(context, cwd);
      const blocks = [
        ...(systemPrompt ? [{ type: "text" as const, text: `${systemPrompt}\n\n` }] : []),
        ...toAcpPromptBlocks(buildPrompt(context) as string | Array<Record<string, unknown>>),
      ];

      // ACP ContentBlock[] — text/image shapes match; cast through unknown.
      await conn.prompt({ sessionId: opened.sessionId, prompt: blocks as unknown as Parameters<typeof conn.prompt>[0]["prompt"] });
      if (!sawToolCall) finish("stop");
    } catch (err) {
      failWith(err instanceof Error ? err.message : String(err));
    }
  })();

  return stream;
}
