/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: additive types for the real (non-no-op) `GrokRuntimeAdapter`
streaming implementation. `GrokNdjsonEvent` mirrors the VERIFIED
`HeadlessJsonEvent` union from upstream grok-cli's `src/headless/output.ts`
(captured in docs/grok-cli-contract.md) — there is deliberately no
thinking/reasoning event type here because upstream's JSONL emitter never
surfaces one (confirmed absence, not an omission). `GrokSession` /
`GrokCallbacks` / `AgentRuntime*` mirror the Droid plugin's `types.ts` shape
so this adapter satisfies the same plugin runtime contract
(`packages/engine/src/runtime-resolution.ts`'s `resolveRuntime`). Additive
only — does not collide with FN-7716's `GrokBinaryStatus` fields below.
*/

export interface GrokToolCallLike {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

export interface GrokToolResultLike {
  success?: boolean;
  output?: string;
  [key: string]: unknown;
}

export interface GrokStepStartEvent {
  type: "step_start";
  sessionID?: string;
  stepNumber: number;
  timestamp: number;
}

export interface GrokTextEvent {
  type: "text";
  sessionID?: string;
  stepNumber: number;
  text: string;
  timestamp: number;
}

export interface GrokToolUseEvent {
  type: "tool_use";
  sessionID?: string;
  stepNumber: number;
  timestamp: number;
  toolCall: GrokToolCallLike;
  toolResult: GrokToolResultLike;
  timing?: { startedAt?: number; finishedAt?: number; durationMs?: number };
}

export interface GrokStepFinishEvent {
  type: "step_finish";
  sessionID?: string;
  stepNumber: number;
  timestamp: number;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsdTicks?: number };
}

export interface GrokErrorEvent {
  type: "error";
  sessionID?: string;
  message: string;
  timestamp: number;
}

export type GrokNdjsonEvent =
  | GrokStepStartEvent
  | GrokTextEvent
  | GrokToolUseEvent
  | GrokStepFinishEvent
  | GrokErrorEvent;

export interface GrokCallbacks {
  onText?: (text: string) => void;
  /**
   * FNXC:GrokCli 2026-07-09-00:00: kept for AgentRuntime interface parity
   * with the Droid/Cursor plugins, but never invoked by this adapter —
   * upstream grok-cli's `--format json` stream has no thinking/reasoning
   * event to bridge (see docs/grok-cli-contract.md).
   */
  onThinking?: (text: string) => void;
  /**
   * FNXC:GrokCli 2026-07-09-00:10:
   * FN-7724: bridged from the verified `tool_use` NDJSON event's
   * `toolCall.function.name` / parsed `toolCall.function.arguments`.
   * Mirrors the Droid plugin's `DroidCallbacks.onToolStart` signature. No
   * Grok→pi tool-name mapping is applied — the verified contract
   * (docs/grok-cli-contract.md) does not pin grok-cli's specific tool-name
   * vocabulary, so names/args pass through unchanged (see FN-7724 research
   * task document for the decision).
   */
  onToolStart?: (toolName: string, args?: unknown) => void;
  /**
   * FNXC:GrokCli 2026-07-09-00:10:
   * FN-7724: bridged from the same `tool_use` event's `toolResult` field —
   * `isError` derives from the verified `toolResult.success === false`,
   * `result` is the full `toolResult` object (includes `output` plus any
   * other verified/unverified passthrough fields).
   */
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface GrokSession {
  model: string;
  systemPrompt?: string;
  messages: unknown[];
  sessionId?: string;
  lastModelDescription: string;
  callbacks: GrokCallbacks;
}

export type AgentSession = GrokSession;

export interface AgentRuntimeOptions {
  cwd?: string;
  systemPrompt?: string;
  defaultModelId?: string;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  /** FNXC:GrokCli 2026-07-09-00:10: FN-7724 — additive, mirrors GrokCallbacks.onToolStart. */
  onToolStart?: (toolName: string, args?: unknown) => void;
  /** FNXC:GrokCli 2026-07-09-00:10: FN-7724 — additive, mirrors GrokCallbacks.onToolEnd. */
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  signal?: AbortSignal;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}

export interface GrokBinaryStatus {
  available: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: means "Grok CLI runtime ready" (the `grok` binary is available
   * on PATH or at a configured path) — NOT "a Fusion-visible API key was
   * found". The `grok` CLI owns its own authentication (env var, project
   * `.env`, `grok -k`, etc.); Fusion no longer requires visibility into a
   * key to treat the provider as authenticated. See `apiKeyDetected` for the
   * non-blocking informational key-presence signal.
   */
  authenticated?: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: non-blocking informational hint only — true when Fusion itself
   * detected a Grok API key (GROK_API_KEY env var or
   * ~/.grok/user-settings.json `apiKey`). Never gates `authenticated` or
   * enable/disable; the direct xAI OpenAI-compatible streaming path
   * (FN-7711/FN-7714) uses $GROK_API_KEY when present regardless of this CLI
   * probe.
   */
  apiKeyDetected?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}
