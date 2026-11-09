import { createHash } from "node:crypto";
import type { TaskStore, AgentLogEntry, AgentRole } from "@fusion/core";
import { categorizeToolName, redactSecrets } from "@fusion/core";
import { createLogger } from "../logger.js";

/**
 * Session-context fields that let the logger emit normalized `usage_events`
 * telemetry (KTD3/U1) alongside its agent-log writes. Populated by the
 * executor/session layer where `model`/`provider`/`nodeId` are resolved; when
 * absent, no usage events are emitted (the agent-log behavior is unchanged).
 */
export interface AgentLoggerUsageContext {
  /** Resolved model id for the running session, when known. */
  model?: string | null;
  /** Resolved provider for the running session, when known. */
  provider?: string | null;
  /** Workflow/session node the session is routed to, when known. */
  nodeId?: string | null;
  /** The agent id producing the activity, when known. */
  agentId?: string | null;
}

/** Default byte threshold before an automatic flush. */
const FLUSH_SIZE_BYTES = 1024;
/** Default timer interval (ms) for periodic flush of small writes. */
const FLUSH_INTERVAL_MS = 500;
const ENTRY_BATCH_SIZE = 50;
/*
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * This constant used to be `TOOL_RESULT_DETAIL_LIMIT = 4_096` — the ENGINE's own inline cap, applied to
 * `detail` before `writeEntry` was ever called. Because it ran upstream of the storage layer it destroyed the
 * payload for every copy at once: no store row, no spill, no run log could recover what had been sliced away
 * here, and `summarizeToolResultValue` re-cut every string in a structured result against a budget seeded at
 * the same number — the mechanism that left section 4 of a six-section report with ~40 characters and a prose
 * notice (the measured saneca SANE-435 loss this card removes).
 *
 * What has to survive is the memory guard from `FNXC:AgentLogging 2026-06-23-09:26` — building a bounded
 * preview before JSON serialization so logging cannot materialize a multi-megabyte tool result — NOT the
 * inline bound. So this is now explicitly a MEMORY CEILING, declared larger than the inline bound
 * (`AGENT_LOG_TOOL_DETAIL_LIMIT`, 4 096) so ordinary overflow reaches the spill seam whole instead of being
 * cut here. Bytes past the ceiling are a real producer-side loss, so exceeding it is counted and warned about
 * (see `agentLogMemoryCeilingExceedances`); it never writes prose into `detail`. The value is 256 KiB of code units.
 */
const TOOL_RESULT_MEMORY_CEILING = 262_144;
const TOOL_RESULT_MAX_ARRAY_ITEMS = 25;
const TOOL_RESULT_MAX_OBJECT_KEYS = 50;

/**
 * Counted observability for payload the producer itself had to give up on.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * The operator's third requested bullet was "make truncation observable: a counter or warning row, not silent
 * prose". Inline-bound overflow needs no counter — it spills, and the row's pointer already names the exact
 * chars and bytes — but ceiling overflow is genuine loss and must be countable without reading row text.
 * The counter is process-monotonic and exported so a diagnostic surface or test can read it; every increment
 * is paired with a warning line, and nothing about it is written into `detail`.
 */
let memoryCeilingExceedances = 0;
const ceilingLogger = createLogger("agent-logger");

/** How many tool results this process has bounded at the memory ceiling (never reset by production code). */
export function agentLogMemoryCeilingExceedances(): number {
  return memoryCeilingExceedances;
}

/** Test-only reset so a suite can assert a delta rather than a process-wide total. */
export function resetAgentLogMemoryCeilingExceedances(): void {
  memoryCeilingExceedances = 0;
}

/**
 * Fold one ceiling breach into the counter and the warning stream.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * One call site, so every loss path is counted identically and none of them can reach a persisted row.
 */
function noteMemoryCeilingExceeded(context: string, droppedChars: number): void {
  memoryCeilingExceedances += 1;
  ceilingLogger.warn(
    `Tool result exceeded the agent-log memory ceiling (${TOOL_RESULT_MEMORY_CEILING} code units); persisted detail for ${context} is missing about ${droppedChars} code units. This is producer-side loss, not a display clamp.`,
  );
}

/**
 * Build a memory-bounded preview of a structured tool result.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Only the byte budget changed here. The item and key caps stay, and their count-bearing placeholders
 * (`[N more items truncated]`, `__truncatedKeys`) stay with them: those describe the STRUCTURAL caps this
 * preview has always had, not a size cut, and removing them would hide content that a reader cannot otherwise
 * see is absent. What is gone is every sentence the byte budget used to paste — the notice constant and the
 * bare `[truncated]` placeholder — because those were persisted inside `detail` and read as evidence.
 * A byte-budget exhaustion now yields a structural `null` plus the counted warning above.
 */
interface PreviewBudget {
  remainingChars: number;
  seen: WeakSet<object>;
  droppedChars: number;
}

/** One budget breach per preview, folded into the counted warning after the summary is built. */
function summarizeToolResultValue(value: unknown, state: PreviewBudget): unknown {
  if (state.remainingChars <= 0) {
    state.droppedChars += 1;
    return null;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > state.remainingChars) {
      state.droppedChars += value.length - state.remainingChars;
    }
    const clipped = value.length > state.remainingChars ? value.slice(0, state.remainingChars) : value;
    state.remainingChars -= Math.min(value.length, state.remainingChars);
    return clipped;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeToolResultValue(value.message, state),
      ...(value.stack ? { stack: summarizeToolResultValue(value.stack, state) } : {}),
    };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `<Buffer ${value.byteLength} bytes>`;
  }
  if (ArrayBuffer.isView(value)) {
    return `<${value.constructor.name} ${value.byteLength} bytes>`;
  }
  if (value instanceof ArrayBuffer) {
    return `<ArrayBuffer ${value.byteLength} bytes>`;
  }
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);
  if (Array.isArray(value)) {
    const summarized = value
      .slice(0, TOOL_RESULT_MAX_ARRAY_ITEMS)
      .map((item) => summarizeToolResultValue(item, state));
    if (value.length > TOOL_RESULT_MAX_ARRAY_ITEMS) summarized.push(`[${value.length - TOOL_RESULT_MAX_ARRAY_ITEMS} more items truncated]`);
    return summarized;
  }
  const summarized: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (count >= TOOL_RESULT_MAX_OBJECT_KEYS) {
      summarized.__truncatedKeys = true;
      break;
    }
    summarized[key] = summarizeToolResultValue((value as Record<string, unknown>)[key], state);
    count += 1;
    if (state.remainingChars <= 0) {
      summarized.__truncated = true;
      break;
    }
  }
  return summarized;
}

/**
 * Serialize a tool result for `detail`, bounded only by the memory ceiling.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * A plain string result passes through UNTOUCHED — nothing here cuts it any more, so a large string result
 * reaches the storage seam intact and spills. Structured results keep the pre-serialization preview, because
 * that preview is what stops a 40 MB object from being materialized twice; the ceiling is what the preview is
 * now sized against, and a preview that reached it is counted rather than annotated.
 */
function summarizeToolResultDetail(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  /*
   * FNXC:AgentLogging 2026-06-23-09:26:
   * Execution memory can spike when tools return large structured payloads. Build a bounded preview before
   * JSON serialization so logging cannot materialize multi-megabyte tool results. RUFU-340 retargets that
   * bound from the inline row cap to the memory ceiling, because the row cap no longer decides what is
   * persisted — the spill seam does.
   */
  try {
    const state: PreviewBudget = {
      remainingChars: TOOL_RESULT_MEMORY_CEILING,
      seen: new WeakSet<object>(),
      droppedChars: 0,
    };
    const preview = summarizeToolResultValue(result, state);
    const serialized = JSON.stringify(preview);
    if (state.droppedChars > 0) noteMemoryCeilingExceeded("structured tool result", state.droppedChars);
    return serialized;
  } catch {
    const fallback = String(result);
    if (fallback.length > TOOL_RESULT_MEMORY_CEILING) {
      noteMemoryCeilingExceeded("unserializable tool result", fallback.length - TOOL_RESULT_MEMORY_CEILING);
      return fallback.slice(0, TOOL_RESULT_MEMORY_CEILING);
    }
    return fallback;
  }
}

/** Maximum visible characters for the primary argument in a multi-argument tool call. */
const TOOL_ARG_PRIMARY_VALUE_MAX = 1_000;
/** Maximum visible characters for each secondary argument in a multi-argument tool call. */
const TOOL_ARG_SECONDARY_VALUE_MAX = 200;
/** Maximum visible characters for a rendered multi-argument tool-call summary. */
const TOOL_ARG_SUMMARY_MAX = 1_200;
/** Hex prefix of sha256 of the full argument JSON when the log summary is truncated. */
const STRUCTURED_ARG_HASH_HEX_LEN = 12;

function compactToolArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // Tool schemas normally yield JSON values; preserve an inspectable fallback for unusual input.
  }
  return JSON.stringify(String(value));
}

function clipToolArgValue(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

function resolvePrimaryToolArgKey(name: string, args: Record<string, unknown>, keys: string[]): string {
  const lowerName = name.toLowerCase();
  const preferredKey = lowerName === "bash"
    ? "command"
    : lowerName === "read" || lowerName === "edit" || lowerName === "write"
      ? "path"
      : undefined;
  if (preferredKey && keys.includes(preferredKey)) return preferredKey;
  return keys.find((key) => typeof args[key] === "string") ?? keys[0]!;
}

/**
 * Produce a human-readable summary from tool arguments.
 * A sole string argument remains byte-identical for common command/path calls.
 * Returns `undefined` when no args or only empty objects.
 *
 * FNXC:AgentLogging 2026-08-29-04:21:
 * FN-253 requires task logs to preserve complete tool-call arguments rather than only one primary value.
 * Keep the primary argument first so the most useful command or path survives bounded previews and the
 * shared stuck-detector fingerprint always matches the persisted row.
 *
 * FNXC:StuckDetector 2026-07-22-20:25:
 * When truncating long argument summaries, append a short hash of the FULL payload so differences past
 * the visible prefix remain distinct for stuck-loop fingerprints.
 */
export function summarizeToolArgs(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;

  const onlyKey = keys[0]!;
  if (keys.length === 1 && typeof args[onlyKey] === "string") {
    return args[onlyKey] as string;
  }

  let fullArgsJson: string;
  try {
    fullArgsJson = JSON.stringify(args) ?? "{}";
  } catch {
    return undefined;
  }

  const primaryKey = resolvePrimaryToolArgKey(name, args, keys);
  const orderedKeys = [primaryKey, ...keys.filter((key) => key !== primaryKey)];
  const rendered = orderedKeys.map((key) => {
    const maximum = key === primaryKey ? TOOL_ARG_PRIMARY_VALUE_MAX : TOOL_ARG_SECONDARY_VALUE_MAX;
    return `${key}=${clipToolArgValue(compactToolArgValue(args[key]), maximum)}`;
  }).join(", ");

  if (rendered.length <= TOOL_ARG_SUMMARY_MAX) return rendered;
  const hash = createHash("sha256").update(fullArgsJson).digest("hex").slice(0, STRUCTURED_ARG_HASH_HEX_LEN);
  // Reserve room for "…#" + hash so the suffix always survives.
  const suffix = `…#${hash}`;
  const keep = Math.max(0, TOOL_ARG_SUMMARY_MAX - suffix.length);
  return `${rendered.slice(0, keep)}${suffix}`;
}

/**
 * Options for creating an {@link AgentLogger}.
 *
 * Two sink modes are supported:
 * 1. **Task-store mode** (original): provide `store` + `taskId`. Writes go to
 *    `store.appendAgentLog(taskId, ...)`.
 * 2. **Callback mode**: provide `appendLog`. Writes go to the callback instead.
 *    When both are provided, both sinks receive every entry.
 */
export interface AgentLoggerOptions {
  /** When true, persist `detail` payloads for `tool` and successful `tool_result` entries; failed `tool_error` details always persist. */
  persistAgentToolOutput?: boolean;
  /** When true, persist `thinking` rows. Default: false (skip thinking persistence). */
  persistAgentThinkingLog?: boolean;
  /** The task store used to persist agent log entries (task-store mode). */
  store?: TaskStore;
  /** The task ID this logger is associated with (task-store mode). */
  taskId?: string;
  /**
   * Optional alternative sink callback. When provided, every flushed entry is
   * forwarded here in addition to (or instead of) `store.appendAgentLog`.
   * Use this for run-scoped logging where there is no task.
   */
  appendLog?: (entry: AgentLogEntry) => Promise<void>;
  /** Which agent role is producing log entries (persisted on every entry). */
  agent?: AgentRole;
  /** Optional callback invoked alongside text logging (e.g. for SSE streaming). */
  onAgentText?: (taskId: string, delta: string) => void;
  /**
   * Optional callback invoked alongside tool logging (e.g. for SSE streaming / stuck detection).
   * `detail` is the complete bounded, secret-redacted argument summary from {@link summarizeToolArgs}.
   */
  onAgentTool?: (taskId: string, toolName: string, detail?: string) => void;
  /*
  FNXC:PlannerOversight 2026-07-13-23:00:
  Session-advisor seam: after durable entries flush, notify the overseer
  advisor runtime with the batch. Must be fail-soft (never throw into flush).
  */
  onEntriesFlushed?: (taskId: string, entries: AgentLogEntry[]) => void | Promise<void>;
  /** Byte threshold for automatic flush. Defaults to 1024. */
  flushSizeBytes?: number;
  /** Timer interval (ms) for periodic flush. Defaults to 500. */
  flushIntervalMs?: number;
  /**
   * When provided (with `store` + `taskId`), tool start/end callbacks also emit
   * normalized `usage_events` telemetry carrying the session's model/provider/
   * node context. Omit to leave agent-log behavior unchanged.
   */
  usageContext?: AgentLoggerUsageContext;
  /** Store used solely for usage telemetry; supports sessions without a task log. */
  usageStore?: TaskStore;
}

/**
 * Buffers agent text output and flushes it to the task store periodically
 * or when a size threshold is reached. Also handles tool-start logging with
 * detailed argument summaries via {@link summarizeToolArgs}.
 *
 * Produces `onText` and `onToolStart` callbacks compatible with
 * `createFnAgent`'s `AgentOptions` interface.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ store, taskId, onAgentText, onAgentTool });
 * const { session } = await createFnAgent({
 *   cwd: worktreePath,
 *   onText: logger.onText,
 *   onToolStart: logger.onToolStart,
 *   // ...
 * });
 * try {
 *   await session.prompt(prompt);
 * } finally {
 *   await logger.flush();
 *   session.dispose();
 * }
 * ```
 */
export class AgentLogger {
  private textBuffer = "";
  private thinkingBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private entryFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntries: AgentLogEntry[] = [];
  private readonly flushSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly store?: TaskStore;
  private readonly taskId: string;
  private readonly appendLogCb?: (entry: AgentLogEntry) => Promise<void>;
  private readonly agent?: AgentRole;
  private readonly externalTextCb?: (taskId: string, delta: string) => void;
  private readonly externalToolCb?: (taskId: string, toolName: string, detail?: string) => void;
  private readonly onEntriesFlushedCb?: (taskId: string, entries: AgentLogEntry[]) => void | Promise<void>;
  private readonly log = createLogger("agent-logger");
  private readonly persistAgentToolOutput: boolean;
  private readonly persistAgentThinkingLog: boolean;
  private usageContext?: AgentLoggerUsageContext;
  /*
   * FNXC:CommandCenterActivity 2026-08-09-10:29:
   * Durable no-task heartbeat runs must publish usage telemetry, so emission cannot
   * require a task id. Several lanes resolve model/provider after construction,
   * therefore telemetry storage and identity are attachable after construction.
   */
  private usageStore?: TaskStore;
  /*
   * FNXC:AgentLogging 2026-07-04-09:40:
   * Task logs must expose Time To First Token once per logger/request on the first persisted visible model output. Capture the arrival time at onText/onThinking instead of flush time so buffered writes do not inflate TTFT.
   */
  private readonly requestStartedAtMs = Date.now();
  private firstVisibleOutputRecorded = false;
  private textTimeToFirstTokenMs: number | undefined;
  private thinkingTimeToFirstTokenMs: number | undefined;
  /*
   * FNXC:AgentLogging 2026-07-04-09:41:
   * Tool completion rows need non-sensitive processing duration for Bash and every other tool. Store only start timestamps in FIFO order per tool name so overlapping same-name calls do not leak arguments/results or collapse into one duration.
   */
  private readonly toolStartedAt = new Map<string, number[]>();

  constructor(options: AgentLoggerOptions) {
    this.store = options.store;
    this.taskId = options.taskId ?? "";
    this.appendLogCb = options.appendLog;
    this.agent = options.agent;
    this.externalTextCb = options.onAgentText;
    this.externalToolCb = options.onAgentTool;
    this.onEntriesFlushedCb = options.onEntriesFlushed;
    this.flushSizeBytes = options.flushSizeBytes ?? FLUSH_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    /*
    FNXC:AgentLogging 2026-08-29-05:25:
    Bare logger construction remains conservative when no setting is supplied. Production construction
    sites pass resolved settings, whose FN-253 global default persists tool arguments and successful
    results; failed tool_error detail remains bounded diagnostic signal regardless of an explicit false.
    */
    this.persistAgentToolOutput = options.persistAgentToolOutput === true;
    this.persistAgentThinkingLog = options.persistAgentThinkingLog === true;
    this.usageContext = options.usageContext;
    this.usageStore = options.usageStore;

    // Bind callbacks so they can be passed directly as function references
    this.onText = this.onText.bind(this);
    this.onToolStart = this.onToolStart.bind(this);
    this.onThinking = this.onThinking.bind(this);
    this.onToolEnd = this.onToolEnd.bind(this);
  }

  /**
   * Set (or update) the session context used to emit `usage_events` telemetry.
   * The executor resolves `model`/`provider`/`nodeId` after the logger is
   * constructed, so it calls this once those are known.
   */
  setUsageContext(context: AgentLoggerUsageContext | undefined): void {
    this.setUsageTelemetry({ usageContext: context });
  }

  /** Attach or refresh telemetry independently from task-log persistence. */
  setUsageTelemetry(options: { store?: TaskStore; usageContext?: AgentLoggerUsageContext }): void {
    if (options.store !== undefined) this.usageStore = options.store;
    /* FNXC:CommandCenterActivity 2026-08-09-16:05: Preserve setUsageContext(undefined)'s historical clearing behavior while allowing callers to refresh only the store. */
    if ("usageContext" in options) this.usageContext = options.usageContext;
  }

  /**
   * Emit a normalized tool `usage_events` row through the task store, if a store,
   * taskId, and usage context are all available.
   *
   * FNXC:Telemetry 2026-06-16-05:47:
   * Usage-event emission is fail-soft: telemetry is a side effect of tool logging and must never break it.
   * `store.emitUsageEvent` is wrapped in try/catch so a throwing (or rejecting) store leaves
   * `onToolStart`/`onToolEnd` non-throwing and lets agent-log writes proceed. Failures are warned, not propagated.
   */
  private emitToolUsageEvent(
    kind: "tool_call" | "tool_result" | "tool_error",
    toolName: string,
    meta?: Record<string, unknown>,
  ): void {
    const ctx = this.usageContext;
    const store = this.usageStore ?? this.store;
    if (!ctx || !store) return;
    try {
      const maybePromise = store.emitUsageEvent({
        kind,
        taskId: this.taskId || null,
        agentId: ctx.agentId ?? null,
        nodeId: ctx.nodeId ?? null,
        model: ctx.model ?? null,
        provider: ctx.provider ?? null,
        toolName,
        category: categorizeToolName(toolName),
        ...(meta !== undefined && { meta }),
      });
      // Swallow async rejections too so a Promise-returning store stays fail-soft.
      void Promise.resolve(maybePromise).catch((err) => {
        this.log.warn(`Failed to emit usage event (${kind}) for "${toolName}" on ${this.taskId || "<no task>"}: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      this.log.warn(`Failed to emit usage event (${kind}) for "${toolName}" on ${this.taskId || "<no task>"}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Callback for agent text deltas. Buffers text and flushes on size
   * threshold or after a timer interval. Compatible with `AgentOptions.onText`.
   */
  onText(delta: string): void {
    this.externalTextCb?.(this.taskId, delta);
    if (delta.length > 0 && !this.firstVisibleOutputRecorded) {
      this.textTimeToFirstTokenMs = this.markFirstVisibleOutput();
    }
    this.textBuffer += delta;
    if (this.textBuffer.length >= this.flushSizeBytes) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flushTextBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Callback for thinking block deltas. Buffers and flushes thinking text
   * as `type: "thinking"` entries, using the same size/timer pattern as `onText`.
   */
  onThinking(delta: string): void {
    if (!this.persistAgentThinkingLog) {
      return;
    }
    if (delta.length > 0 && !this.firstVisibleOutputRecorded) {
      this.thinkingTimeToFirstTokenMs = this.markFirstVisibleOutput();
    }
    this.thinkingBuffer += delta;
    if (this.thinkingBuffer.length >= this.flushSizeBytes) {
      if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
      this.flushThinkingBuffer();
    } else {
      this.scheduleThinkingFlush();
    }
  }

  /**
   * Callback for tool invocation starts. Flushes pending text, then logs the
   * tool name with a detail summary. Compatible with `AgentOptions.onToolStart`.
   */
  onToolStart(name: string, args?: Record<string, unknown>): void {
    // Flush any pending text/thinking before recording the tool entry
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushTextBuffer();
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    this.flushThinkingBuffer();
    const detail = summarizeToolArgs(name, args);
    /*
    FNXC:AgentLogging 2026-08-29-05:45:
    FN-253 makes complete tool arguments visible by default. Redact before forwarding to onAgentTool
    because its stuck-detector and telemetry subscribers are external sinks too; writeEntry remains the
    canonical durable-sink redaction boundary and independently protects every persisted entry.

    FNXC:StuckDetector 2026-07-22-18:05:
    Pass the complete bounded argument detail so StuckTaskDetector can fingerprint tool novelty for loop classification.
    Call after summarizeToolArgs so the detector input matches the agent-log row.
    */
    const redactedDetail = detail === undefined ? undefined : redactSecrets(detail);
    this.externalToolCb?.(this.taskId, name, redactedDetail);
    this.writeEntry(name, "tool", redactedDetail, `Failed to log tool start "${name}" for ${this.taskId}`);
    // agent-log type "tool" maps to usage_events kind "tool_call". meta carries
    // only non-sensitive descriptors (category) — never the tool arguments.
    const starts = this.toolStartedAt.get(name) ?? [];
    starts.push(Date.now());
    this.toolStartedAt.set(name, starts);
    this.emitToolUsageEvent("tool_call", name);
  }

  /**
   * Callback for tool execution completion. Logs as `type: "tool_result"` on success
   * or `type: "tool_error"` on failure.
   *
   * @param name - The tool name
   * @param isError - Whether the tool execution resulted in an error
   * @param result - Optional result value. Downstream storage may clip very
   * large tool payloads to keep dashboard log views responsive.
   */
  onToolEnd(name: string, isError: boolean, result?: unknown): void {
    const type = isError ? "tool_error" : "tool_result";
    const detail = summarizeToolResultDetail(result);
    const startedAt = this.shiftToolStart(name);
    const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
    this.writeEntry(name, type, detail, `Failed to log tool end "${name}" (${type}) for ${this.taskId}`, false, durationMs !== undefined ? { durationMs } : undefined);
    // Record completion as tool_result/tool_error with a duration descriptor.
    // meta NEVER includes the tool result payload — only non-sensitive metrics.
    const meta: Record<string, unknown> = {};
    if (durationMs !== undefined) meta.durationMs = durationMs;
    if (isError) meta.isError = true;
    this.emitToolUsageEvent(
      isError ? "tool_error" : "tool_result",
      name,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
  }

  /**
   * Flush any remaining buffered text/thinking and clear timers.
   * Call this in a `finally` block before disposing the agent session.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    if (this.entryFlushTimer) { clearTimeout(this.entryFlushTimer); this.entryFlushTimer = null; }
    await this.flushTextBuffer();
    await this.flushThinkingBuffer();
    await this.flushPendingEntries();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  /**
   * Write a single structured entry through whichever sink(s) are configured.
   * When both `store`+`taskId` and `appendLogCb` are set, both receive the entry.
   * When only `appendLogCb` is set (no store/taskId), only the callback is used.
   * @param storeWarnMsg - Warning message prefix used when the task-store write fails.
   */
  private markFirstVisibleOutput(): number {
    this.firstVisibleOutputRecorded = true;
    return Math.max(0, Date.now() - this.requestStartedAtMs);
  }

  private shiftToolStart(name: string): number | undefined {
    const starts = this.toolStartedAt.get(name);
    if (!starts || starts.length === 0) return undefined;
    const startedAt = starts.shift();
    if (starts.length === 0) {
      this.toolStartedAt.delete(name);
    }
    return startedAt;
  }

  private writeEntry(
    text: string,
    type: AgentLogEntry["type"],
    detail: string | undefined,
    _storeWarnMsg: string,
    immediate = false,
    timing?: Pick<AgentLogEntry, "durationMs" | "timeToFirstTokenMs">,
  ): void {
    const isToolEntry = type === "tool" || type === "tool_result" || type === "tool_error";
    // FNXC:AgentLogging 2026-07-15-16:00: Failed tool detail is diagnostic signal, unlike verbose arguments/success output, and must survive default-off tool-output persistence for FN-7995 Activity diagnosis.
    const includeDetail = !isToolEntry || type === "tool_error" || this.persistAgentToolOutput;
    /*
    FNXC:AgentLogDiagnostics 2026-08-01-17:51:
    FN-8697 requires useful failed-tool detail to cross the established secret-redaction boundary
    before an AgentLogger batch reaches JSONL, the API, or the Activity disclosure. Redact at this
    common entry point so store and callback sinks cannot persist or display credentials.
    */
    const persistedDetail = detail !== undefined && includeDetail ? redactSecrets(detail) : undefined;
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      text,
      type,
      ...(persistedDetail !== undefined && { detail: persistedDetail }),
      ...(this.agent !== undefined && { agent: this.agent }),
      ...(timing?.durationMs !== undefined && { durationMs: timing.durationMs }),
      ...(timing?.timeToFirstTokenMs !== undefined && { timeToFirstTokenMs: timing.timeToFirstTokenMs }),
    };

    this.pendingEntries.push(entry);
    if (immediate || (type !== "text" && type !== "thinking")) {
      if (this.entryFlushTimer) {
        clearTimeout(this.entryFlushTimer);
        this.entryFlushTimer = null;
      }
      void this.flushPendingEntries();
      return;
    }

    if (this.pendingEntries.length >= ENTRY_BATCH_SIZE) {
      if (this.entryFlushTimer) {
        clearTimeout(this.entryFlushTimer);
        this.entryFlushTimer = null;
      }
      void this.flushPendingEntries();
      return;
    }

    this.scheduleEntryFlush();
  }

  private flushTextBuffer(): Promise<void> {
    if (this.textBuffer.length === 0) return Promise.resolve();
    const chunk = this.textBuffer;
    this.textBuffer = "";
    const timeToFirstTokenMs = this.textTimeToFirstTokenMs;
    this.textTimeToFirstTokenMs = undefined;
    this.writeEntry(
      chunk,
      "text",
      undefined,
      `Failed to flush text buffer for ${this.taskId}`,
      true,
      timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : undefined,
    );
    return this.flushPendingEntries();
  }

  private flushThinkingBuffer(): Promise<void> {
    if (this.thinkingBuffer.length === 0) return Promise.resolve();
    const chunk = this.thinkingBuffer;
    this.thinkingBuffer = "";
    if (!this.persistAgentThinkingLog) {
      return Promise.resolve();
    }
    const timeToFirstTokenMs = this.thinkingTimeToFirstTokenMs;
    this.thinkingTimeToFirstTokenMs = undefined;
    this.writeEntry(
      chunk,
      "thinking",
      undefined,
      `Failed to flush thinking buffer for ${this.taskId}`,
      true,
      timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : undefined,
    );
    return this.flushPendingEntries();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTextBuffer();
    }, this.flushIntervalMs);
  }

  private scheduleThinkingFlush(): void {
    if (this.thinkingFlushTimer) return;
    this.thinkingFlushTimer = setTimeout(() => {
      this.thinkingFlushTimer = null;
      this.flushThinkingBuffer();
    }, this.flushIntervalMs);
  }

  private scheduleEntryFlush(): void {
    if (this.entryFlushTimer) return;
    this.entryFlushTimer = setTimeout(() => {
      this.entryFlushTimer = null;
      void this.flushPendingEntries();
    }, this.flushIntervalMs);
  }

  private async flushPendingEntries(): Promise<void> {
    if (this.pendingEntries.length === 0) {
      return;
    }

    const entries = this.pendingEntries;
    this.pendingEntries = [];

    if (this.store && this.taskId) {
      if (typeof (this.store as TaskStore & { appendAgentLogBatch?: unknown }).appendAgentLogBatch === "function") {
        await this.store
          .appendAgentLogBatch(
            /*
            FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
            This hand-written 7-field literal builds NEW objects, which is exactly why the caller's entry object
            survives intact for the run-log fan-out below (`appendLogCb` receives the ORIGINAL object). It must
            therefore list the pointer explicitly, or the task-log row loses it while the run-log row keeps one
            from a different producer directory.
            */
            entries.map((entry) => ({
              taskId: entry.taskId,
              text: entry.text,
              type: entry.type,
              detail: entry.detail,
              ...(entry.detailSpill !== undefined && { detailSpill: entry.detailSpill }),
              agent: entry.agent,
              ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
              ...(entry.timeToFirstTokenMs !== undefined && { timeToFirstTokenMs: entry.timeToFirstTokenMs }),
            })),
          )
          .catch((err) => {
            this.log.warn(`Failed to flush agent log batch for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
          });
      } else {
        /*
        FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
        The positional fallback `appendAgentLog(taskId, text, type, detail, agent, timing)` has no pointer
        slot, so this path cannot carry one — and does not need to: the pointer comes from the SINK's own seam
        run inside `appendAgentLogImpl`, which redacts, spills, buffers, and emits the same pair. Passing an
        already-resolved prefix here and a pointer there is precisely why the seam is per-sink.
        */
        await Promise.all(
          entries.map((entry) => {
            const timing = entry.durationMs !== undefined || entry.timeToFirstTokenMs !== undefined
              ? { durationMs: entry.durationMs, timeToFirstTokenMs: entry.timeToFirstTokenMs }
              : undefined;
            const write = timing === undefined
              ? this.store!.appendAgentLog(entry.taskId, entry.text, entry.type, entry.detail, entry.agent)
              : this.store!.appendAgentLog(entry.taskId, entry.text, entry.type, entry.detail, entry.agent, timing);
            return write.catch((err) => {
              this.log.warn(`Failed to flush agent log entry for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }),
        );
      }
    }

    if (this.appendLogCb) {
      await Promise.all(
        entries.map((entry) =>
          this.appendLogCb!(entry).catch((err) => {
            this.log.warn(`appendLog callback failed for entry (${entry.type}): ${err instanceof Error ? err.message : String(err)}`);
          }),
        ),
      );
    }

    // FNXC:PlannerOversight 2026-07-13-23:00: best-effort session-advisor notify after durable flush.
    if (this.onEntriesFlushedCb && this.taskId && entries.length > 0) {
      try {
        await Promise.resolve(this.onEntriesFlushedCb(this.taskId, entries)).catch((err) => {
          this.log.warn(
            `onEntriesFlushed callback failed for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } catch (err) {
        this.log.warn(
          `onEntriesFlushed callback threw for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
