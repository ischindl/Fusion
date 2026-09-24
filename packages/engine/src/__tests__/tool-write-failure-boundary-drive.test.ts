/*
STAS-258: the behavioural half of the write-failure boundary guard.

`tool-write-failure-boundary.test.ts` scans the registration sources for the shape of a failure return. A scan can
only describe shape, so this file drives the *registered handlers themselves*: every tool factory the engine and
executor lanes export is constructed over a fake store whose write verbs refuse with a unique sentinel, and each
handler is called with parameters synthesised from its own parameter schema. The assertion is not about wording —
it is about the handler that *awaited a write the store refused* and then answered the agent anyway: such a result
must be flagged, must carry the shared store-failure code, and must reach the log as a `tool_error` row.

Enumeration comes from the modules, never from a list this file keeps: a tool added to `agent-tools.ts` or to an
executor factory is driven the moment it is exported. The pinned numbers below are the drive's *reach*, not its
scope — they fail loudly when a fixture stops reaching a store write, so coverage cannot quietly rot to zero.

The `fn_task_logs_read`-visible consequence is asserted through the real `AgentLogger.onToolEnd` seam: a flagged
result appends `tool_error`, an unflagged one appends `tool_result`. That is why `isError` exists.

Lanes this drive cannot execute — the fn CLI extension (its tool bodies need the whole extension runtime) and the
dashboard chat planner — are covered by the committed source scan in `tool-write-failure-boundary.test.ts`, with
their per-site behaviour pinned in `packages/cli/src/__tests__/` and `packages/dashboard/src/__tests__/`.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import * as agentTools from "../agent-tools.js";
import * as agentTaskUpdate from "../executor/create-task-update-tool.js";
import * as spawnToolModule from "../executor/create-spawn-agent-tool.js";
import * as taskDoneToolModule from "../executor/create-task-done-tool.js";
import * as reviewDisputeModule from "../executor/create-review-dispute-tool.js";
import * as taskAddDepModule from "../executor/task-add-dep-tool.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { STORE_RETRY_GUIDANCE, storeErrorResult } from "../tool-store-errors.js";

const SENTINEL = "STAS-258 drive sentinel: store refused the write";
const TASK_ID = "STAS-258";

/** The shape a store failure must arrive in, read from the composer at run time so this file copies no literal. */
const SHARED_SHAPE = storeErrorResult("probe", new Error("probe"));
const SHARED_CODE = SHARED_SHAPE.details.code;

/**
 * Store methods that observe rather than mutate. The agent log and usage events are fail-soft by design (STAS-249)
 * and the seam test below needs them to succeed, so they answer instead of refusing.
 */
const OBSERVER_METHODS = new Set(["appendAgentLog", "appendAgentLogBatch", "emitUsageEvent"]);

/** A method whose name says "read" belongs to the read half of the invariant (STAS-256/STAS-259), so it answers. */
const READ_VERB =
  /^(get|list|resolve|peek|read|is|has|count|find|search|load|fetch|preview|validate|check|assert|describe|enumerate|watch|inspect|explain|lookup|estimate|summarize|browse|diff|show|view|parse|evaluate|wait|subscribe)/i;

/** Accessors that hand back a sub-store synchronously (`store.getMissionStore().addFeature(...)`), not a promise. */
const SUB_STORE_ACCESSOR = /(Store|Provider|Api|Client|Adapter|Runner|Factory|Registry)$/;

/**
 * Method names that mutate board state. Only these refuse, so "the handler met a store refusal" means "the handler
 * asked the store to write" and never counts a `String.prototype` call on a proxied row as a write attempt.
 */
const WRITE_VERB =
  /^(create|update|upsert|insert|patch|put|save|persist|store|record|write|append|add|link|unlink|assign|attach|detach|delete|destroy|remove|drop|set|clear|reset|mark|move|rename|duplicate|merge|reconcile|repair|register|publish|apply|commit|sync|mirror|bump|increment|decrement|archive|restore|revert|promote|demote|dispatch|deliver|send|post|reply|notify|queue|enqueue|spawn|start|stop|pause|resume|finalize|cancel|retry|refine|advance|complete|fulfil|dispute|vote|approve|reject|flag|mute|hide|wipe|truncate|migrate|seed|hydrate|invalidate|expire|flush|close|reopen|activate|select)(?=[A-Z]|$)/;

/**
 * Deps-bag setters that mutate an in-process counter rather than the board (`deps-bags.ts:365` assigns
 * `host.totalSpawnedCount`), so refusing them would report a board write that does not exist.
 */
const IN_PROCESS_SETTERS = new Set(["setTotalSpawnedCount"]);

/**
 * Handlers the drive must not execute: they act on the machine or the network rather than the board, so their
 * first argument is not a store and running them would spawn a command or a request. Their failure path is a
 * throw, which is loud by protocol, and the scan guard pins their source.
 */
const NOT_A_BOARD_WRITE = new Set(["fn_web_fetch", "fn_run_verification", "fn_install_worktree_dependencies", "fn_memory_append"]);

/** Registration surfaces: the modules that hand tools to a session, enumerated, not transcribed. */
const REGISTRATION_MODULES: Array<Record<string, unknown>> = [
  agentTools,
  agentTaskUpdate,
  spawnToolModule,
  taskDoneToolModule,
  reviewDisputeModule,
  taskAddDepModule,
];

type Tool = { name?: string; parameters?: unknown; execute?: (...args: unknown[]) => Promise<unknown> };
type Refusal = { method: string; wasRead: boolean };
type Driven = {
  tool: string;
  reachedRefusedWrite: boolean;
  unawaitedWrites: string[];
  isError?: boolean;
  code?: unknown;
  text: string;
  threw?: string;
};

describe("every registered handler that reports a store write failure answers in the shared shape (STAS-258)", () => {
  it("drives the whole registered tool set and finds no silent store failure", async () => {
    const driven = await driveRegisteredHandlers();

    const silent = driven
      .filter((entry) => entry.reachedRefusedWrite && entry.isError !== true)
      .map((entry) => `${entry.tool}: ${entry.text.slice(0, 160)}`);
    expect(silent, "a handler that awaited a refused write must flag its result").toEqual([]);

    /*
    FNXC:WriteFailureSurfacing 2026-09-24:
    The handlers whose refused write arrives as an agent-actionable store failure: flagged, carrying the composer's
    code, and carrying the retry guidance. This is the reach pin for the composed lane — a converted site that
    regresses to hand-composed text drops out of this list and fails here, which is the behavioural counterpart of
    the source scan. The mission, feature, slice and ideation lanes answer loudly but outside this list on purpose:
    their catch wraps the whole handler (`agent-tools.ts:4915`), so labelling every throw a store outage would
    mislabel a parameter error; see the write-surface-map task document.
    */
    expect(sharedShapeTools(driven)).toEqual([
      "fn_artifact_list", "fn_post_room_message", "fn_send_message", "fn_spawn_agent", "fn_task_add_dep",
      "fn_task_assign", "fn_task_delete", "fn_task_document_write", "fn_task_duplicate", "fn_task_file_scope_add",
      "fn_task_logs_read", "fn_task_merge", "fn_task_pause", "fn_task_prompt_write", "fn_task_retry",
      "fn_task_unpause", "fn_task_update", "fn_workflow_create", "fn_workflow_delete", "fn_workflow_select",
      "fn_workflow_update",
    ]);

    /*
    FNXC:WriteFailureSurfacing 2026-09-24:
    Reach, not scope: how many distinct registered tools the drive caught a refused store write with, and how many
    it exercised at all. Both stay exact so a fixture that stops reaching the store — or a registration surface that
    stops enumerating — fails loudly instead of leaving this file asserting nothing.
    */
    expect(reachedTools(driven).length).toBe(27);
    expect(exercisedTools(driven).length).toBe(88);

    /*
    FNXC:WriteFailureSurfacing 2026-09-24:
    A write the handler never awaits is the STAS-251 defect class — the store refuses and nobody looks. Zero is the
    invariant, not a measurement: a new fire-and-forget write lands here and has to be named deliberately.
    */
    expect(unawaitedWriteSites(driven)).toEqual([]);
  }, 300_000);

  it("records a refused store write as a tool_error row and a guard refusal as a tool_result row", async () => {
    const driven = await driveRegisteredHandlers();
    const failures = driven.filter((entry) => entry.reachedRefusedWrite && entry.isError === true);
    const refusals = driven.filter((entry) => !entry.reachedRefusedWrite && entry.text.length > 0 && entry.isError !== true);
    expect(failures.length).toBeGreaterThan(0);
    expect(refusals.length).toBeGreaterThan(0);

    const logged = await rowTypesFor(failures);
    const refused = await rowTypesFor(refusals);
    expect(logged).toEqual(failures.map(() => "tool_error"));
    expect(refused).toEqual(refusals.map(() => "tool_result"));
  }, 300_000);
});

/** Feeds tool results through the real `onToolEnd` seam and returns the agent-log row types it appended. */
async function rowTypesFor(entries: Driven[]): Promise<string[]> {
  const store = { appendAgentLog: vi.fn().mockResolvedValue(undefined) } as unknown as TaskStore;
  const logger = new AgentLogger({ store, taskId: TASK_ID, flushSizeBytes: 1 });
  for (const entry of entries) logger.onToolEnd(entry.tool, entry.isError === true, entry.text);
  await logger.flush();
  return (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
}

function sharedShapeTools(driven: Driven[]): string[] {
  const composed = driven.filter((entry) => entry.code === SHARED_CODE && entry.text.includes(STORE_RETRY_GUIDANCE));
  return [...new Set(composed.map((entry) => entry.tool))].sort();
}

function reachedTools(driven: Driven[]): string[] {
  return [...new Set(driven.filter((entry) => entry.reachedRefusedWrite).map((entry) => entry.tool))].sort();
}

function exercisedTools(driven: Driven[]): string[] {
  return [...new Set(driven.map((entry) => entry.tool))].sort();
}

function unawaitedWriteSites(driven: Driven[]): string[] {
  return [...new Set(driven.flatMap((entry) => entry.unawaitedWrites))].sort();
}

/*
Each tool is constructed twice, once per read stance: a store that answers "no such row" (the handler should stop
at its guard) and one that answers with a plausible board row (the handler should reach its write and meet the
refusal). The stance that reaches the write is the one that proves the failure path.
*/
async function driveRegisteredHandlers(): Promise<Driven[]> {
  const driven: Driven[] = [];
  for (const surface of REGISTRATION_MODULES) {
    for (const [exportName, exported] of Object.entries(surface)) {
      if (!/^create[A-Za-z]*Tools?$/.test(exportName) || typeof exported !== "function") continue;
      for (const readAnswersWithRow of [false, true]) {
        const refusals: Refusal[] = [];
        const driveStore = endpoint(readAnswersWithRow, refusals);
        for (const tool of await construct(exported as (...args: unknown[]) => unknown, driveStore)) {
          if (!tool?.name?.startsWith("fn_")) continue;
          driven.push({ tool: tool.name, ...(await callHandler(tool, paramsFor(tool.parameters, tool.name), refusals)) });
        }
      }
    }
  }
  return driven;
}

async function construct(factory: (...args: unknown[]) => unknown, driveStore: unknown): Promise<Tool[]> {
  try {
    const built = await Promise.resolve(factory(driveStore, TASK_ID, driveStore, driveStore, driveStore));
    return Array.isArray(built) ? (built as Tool[]) : [built as Tool];
  } catch {
    // A factory whose first argument is a path or an options bag, not a store, cannot be driven here.
    return [];
  }
}

async function callHandler(tool: Tool, params: Record<string, unknown>, refusals: Refusal[]): Promise<Omit<Driven, "tool">> {
  const skipped = { reachedRefusedWrite: false, unawaitedWrites: [], text: "" };
  if (NOT_A_BOARD_WRITE.has(tool.name ?? "") || typeof tool.execute !== "function") return skipped;

  refusals.length = 0;
  const settled = await Promise.race([
    tool.execute("drive-call", params).then((result) => ({ kind: "result" as const, result })).catch((error) => ({ kind: "throw" as const, error })),
    new Promise<{ kind: "hang" }>((resolve) => setTimeout(() => resolve({ kind: "hang" }), 5_000)),
  ]);
  const unawaitedWrites = refusals.filter((refusal) => !refusal.wasRead).map((refusal) => refusal.method);
  if (settled.kind === "hang") return { ...skipped, unawaitedWrites };
  if (settled.kind === "throw") return { ...skipped, unawaitedWrites, threw: messageOf(settled.error) };
  return {
    reachedRefusedWrite: refusals.some((refusal) => refusal.wasRead),
    unawaitedWrites,
    isError: (settled.result as { isError?: boolean })?.isError,
    code: (settled.result as { details?: { code?: unknown } })?.details?.code,
    text: textOf(settled.result),
  };
}

/**
 * One proxy answers every store, sub-store and dependency path: a read verb answers with a row (or nothing), any
 * other call hands back a refusal that only exists once the handler asks for it. An unread refusal therefore leaves
 * no stray unhandled rejection behind, and stays visible to the drive as `unawaitedWrites`.
 */
function endpoint(readAnswersWithRow: boolean, refusals: Refusal[], method = ""): unknown {
  const callable = (...args: unknown[]) => {
    if (SUB_STORE_ACCESSOR.test(method)) return endpoint(readAnswersWithRow, refusals, method);
    if (method === "isBackendMode") return Promise.resolve(false);
    if (WRITE_VERB.test(method) && !OBSERVER_METHODS.has(method) && !IN_PROCESS_SETTERS.has(method)) return refusedWrite(method, refusals);
    if (READ_VERB.test(method)) return Promise.resolve(readAnswer(readAnswersWithRow, refusals, method, args));
    return Promise.resolve(TASK_ID);
  };
  return new Proxy(callable, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "then" || property === "catch" || property === "finally") return undefined;
      if (property === "toString" || property === "valueOf") return () => TASK_ID;
      if (property === "length") return 0;
      return endpoint(readAnswersWithRow, refusals, property);
    },
  });
}

/**
 * What a read answers with: nothing in the "no such row" stance; in the permissive one, a board row (or a one-row
 * collection) that echoes the id the handler asked for, so an id lookup resolves instead of stopping at
 * "not found" and the handler is pushed on to the write the guard cannot pre-empt.
 */
function readAnswer(readAnswersWithRow: boolean, refusals: Refusal[], method: string, args: unknown[]): unknown {
  if (!readAnswersWithRow) return null;
  const row = boardRow(readAnswersWithRow, refusals, typeof args[0] === "string" ? args[0] : TASK_ID);
  if (/^(list|search|browse|enumerate|read|peek)/i.test(method)) return [row];
  if (/^(has|is)/i.test(method)) return true;
  if (/^(count|total)/i.test(method)) return 1;
  return row;
}

function refusedWrite(method: string, refusals: Refusal[]): PromiseLike<never> {
  const refusal: Refusal = { method, wasRead: false };
  refusals.push(refusal);
  return {
    then(onFulfilled, onRejected) {
      refusal.wasRead = true;
      const rejected = Promise.reject(new Error(`${SENTINEL} (${method})`));
      return rejected.then(onFulfilled, onRejected) as PromiseLike<never>;
    },
  } as PromiseLike<never>;
}

/** A row broad enough to satisfy a tool's pre-write lookups without pinning this file to one domain object. */
function boardRow(readAnswersWithRow: boolean, refusals: Refusal[], requestedId: string): Record<string, unknown> {
  // A row is a value, never a promise: `then` must stay undefined or awaiting a row adopts a store refusal.
  const row: Record<string, unknown> = {
    id: requestedId,
    taskId: requestedId,
    title: "Drive the write boundary",
    name: "drive",
    key: "drive",
    slug: "drive",
    description: "row",
    content: "row",
    column: "in-progress",
    status: "in-progress",
    steps: [{ name: "Preflight", status: "done" }],
    log: [],
    dependencies: [],
    customFields: {},
    settings: {},
    nodes: [],
    edges: [],
    columns: [],
    features: [],
    slices: [],
    milestones: [],
    artifacts: [],
    documents: [],
    messages: [],
    agents: [],
    goals: [],
    missions: [],
    results: [],
    items: [],
    entries: [],
    total: 1,
    count: 1,
    revision: 1,
    outcome: "ok",
  };
  return new Proxy(row, {
    get(existing, property) {
      if (property in existing) return existing[property];
      if (property === Symbol.iterator) return () => [][Symbol.iterator]();
      if (typeof property === "symbol") return undefined;
      if (property === "then" || property === "catch" || property === "finally") return undefined;
      return endpoint(readAnswersWithRow, refusals, property);
    },
  });
}

/** Payload sources a tool offers as alternatives; filling them all trips the "give exactly one" guard. */
const MUTUALLY_EXCLUSIVE_PAYLOADS = new Set(["uri", "dataBase64", "instructionsPath", "ratingFilter"]);

/** A parameter value for each declared property, so every handler is handed a well-formed request. */
function paramsFor(parameters: unknown, toolName: string): Record<string, unknown> {
  const schema = parameters as { properties?: Record<string, { type?: string; enum?: unknown[] }> };
  const params: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (MUTUALLY_EXCLUSIVE_PAYLOADS.has(name)) continue;
    if (Array.isArray(prop.enum)) params[name] = prop.enum[0];
    else if (prop.type === "string") params[name] = stringParam(name, toolName);
    else if (prop.type === "number" || prop.type === "integer") params[name] = 0;
    else if (prop.type === "boolean") params[name] = false;
    else if (prop.type === "array") params[name] = [];
    else if (prop.type === "object") params[name] = {};
    else params[name] = stringParam(name, toolName);
  }
  return params;
}

function stringParam(name: string, toolName: string): string {
  if (name === "command") return "true";
  if (name === "url") return "http://127.0.0.1:1/nothing";
  if (name === "path") return ".engine/drive-probe.txt";
  if (name === "key") return "drive";
  if (name === "title" || name === "name") return `drive ${toolName}`;
  if (name.endsWith("Id") || name === "id" || name.endsWith("_id")) return TASK_ID;
  return "drive";
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
