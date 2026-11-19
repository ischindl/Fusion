/**
 * Project Memory Bootstrap
 *
 * Provides the canonical path and default scaffold for `.fusion/memory/MEMORY.md`,
 * plus idempotent `ensure` functions that create memory only when missing.
 *
 * This module supports both file-based (direct filesystem) and backend-aware
 * memory operations. Backend-aware operations use the configured memory backend
 * for storage, enabling pluggable backends like QMD.
 *
 * Key behaviors:
 * - Bootstrap is idempotent: existing memory is NEVER overwritten
 * - Non-writable backends do not throw during bootstrap (non-fatal)
 * - Backend selection is based on project settings
 *
 * This module is the single source of truth for:
 * - The memory file path relative to project root
 * - The default scaffold content for a new memory file
 * - The memory instruction templates used by triage and executor prompts
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ensureOpenClawMemoryFiles,
  memoryLongTermPath,
  readProjectMemoryFile,
  resolveMemoryBackend,
  searchMemoryFiles,
  MEMORY_BACKEND_SETTINGS_KEYS,
  MEMORY_DREAMS_FILENAME,
  MEMORY_LONG_TERM_FILENAME,
  MEMORY_WORKSPACE_PATH,
  DEFAULT_MEMORY_BACKEND,
  scheduleQmdInstallAndRefresh,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryGetOptions,
  type MemoryGetResult,
} from "./memory-backend.js";
import { resolveStashMemorySettings } from "./stash-settings.js";
import {
  reportStashReadOutcome,
  reportStashReadScopeForRoot,
  stashBaseUrlFromSettings,
  type StashReadStoreHost,
} from "./memory-backend-stash.js";
import { appendRecallInstructionSection } from "./recall/recall-instructions.js";
import type { RecallSearchHit } from "./recall/recall-types.js";
import { buildMemoryPreSteeringNudge } from "./memory-pre-steering.js";
import type { AgentMemoryInclusionMode } from "../types/settings/settings-scope.js";

// ── Default Scaffold ─────────────────────────────────────────────────

/**
 * Get the default scaffold content for a new memory file.
 *
 * The scaffold provides section headings that agents are expected to fill
 * with durable project learnings over time.
 *
 * @returns The default markdown scaffold string.
 */
export function getDefaultMemoryScaffold(): string {
  return `# Project Memory

<!-- This file stores durable project learnings. Agents consult and update it during triage and execution. -->

## Architecture

<!-- Key architectural patterns, module boundaries, and design decisions -->

## Conventions

<!-- Project-specific coding standards, naming patterns, file organization -->

## Pitfalls

<!-- Known issues, common mistakes, and things to avoid -->

## Context

<!-- Important background information, dependency constraints, deployment notes -->
`;
}

// ── Bootstrap ────────────────────────────────────────────────────────

/**
 * Ensure the project memory file exists using direct filesystem access.
 * Creates it with the default scaffold only when the file is missing.
 * Never overwrites user-edited content.
 *
 * Also ensures the `.fusion` directory exists.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns `true` if the file was created, `false` if it already existed.
 */
export async function ensureMemoryFile(rootDir: string): Promise<boolean> {
  const longTermPath = memoryLongTermPath(rootDir);
  if (existsSync(longTermPath)) {
    return false;
  }
  const { longTermCreated } = await ensureOpenClawMemoryFiles(rootDir);
  return longTermCreated;
}

/**
 * Settings type for memory backend resolution.
 */
type MemorySettings = {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
};


// ── Memory Instruction Context ─────────────────────────────────────────

/**
 * Context for memory instruction generation.
 * Provides the engine with enough information to generate appropriate
 * prompt instructions for different memory backends.
 */
export interface MemoryInstructionContext {
  /** The backend type (e.g., "file", "readonly", "qmd") */
  backendType: string;
  /** Human-readable backend name */
  backendName: string;
  /** Backend capabilities */
  capabilities: import("./memory-backend.js").MemoryBackendCapabilities;
  /**
   * Path hint for memory instructions.
   * - For "file" backend: ".fusion/memory/MEMORY.md"
   * - For "readonly" backend: null (no write path)
   * - For "qmd"/non-file backends: null (path is backend-specific)
   */
  instructionPathHint: string | null;
}

/**
 * Resolve the memory instruction context based on project settings.
 *
 * This function determines what memory instructions should be injected
 * based on the configured backend type:
 * - "file" backend: full read/write instructions with `.fusion/memory/MEMORY.md` path
 * - "readonly" backend: read-only instructions, no write/update directives
 * - "qmd"/non-file backends: instructions without unconditional `.fusion/memory/MEMORY.md` path
 *   (unless `instructionPathHint` is explicitly non-null)
 *
 * @param settings - Optional project settings containing memoryEnabled and memoryBackendType
 * @returns The resolved instruction context
 */
export function resolveMemoryInstructionContext(
  settings?: MemorySettings,
): MemoryInstructionContext {
  if (settings?.memoryEnabled === false) {
    return {
      backendType: "disabled",
      backendName: "Disabled",
      capabilities: {
        readable: false,
        writable: false,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: false,
      },
      instructionPathHint: null,
    };
  }

  // Synchronous resolution using getMemoryBackendCapabilities
  // This avoids the async import but requires synchronous access to capabilities
  // For file backend (default), we can inline the capabilities
  const backendType = settings?.memoryBackendType || "qmd";

  switch (backendType) {
    case "readonly":
      return {
        backendType: "readonly",
        backendName: "Read-Only",
        capabilities: {
          readable: true,
          writable: false,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: false,
        },
        instructionPathHint: null,
      };
    case "qmd":
      return {
        backendType: "qmd",
        backendName: "QMD (Quantized Memory Distillation)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: null,
      };
    case "file":
      return {
        backendType: "file",
        backendName: "File (.fusion/memory/MEMORY.md)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: true,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: ".fusion/memory/MEMORY.md",
      };
    default:
      return {
        backendType: "qmd",
        backendName: "QMD (Quantized Memory Distillation)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: null,
      };
  }
}

/**
 * Ensure project memory exists using the configured backend.
 *
 * This function provides backend-aware memory bootstrap that:
 * - Creates memory with default scaffold when missing (idempotent)
 * - Never overwrites existing memory content
 * - Does not throw for non-writable backends (non-fatal)
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Project settings including memoryBackendType.
 * @returns `true` if memory was created/initialized, `false` if it already existed.
 */
/*
FNXC:StashReadAuth 2026-11-12-19:21 (RUFU-994):
Operator decision 2026-11-12: Stash becomes the source of truth for project memory, so READS must
work — not only the capture writes that already did (measured on production: 8320 x 201 on
POST /events/batch against 2334 x 401 on GET /events/semantic-search and 176 x 401 on the keyword
route in 24 h). The asymmetry was never the transport — `stashHttpJsonRequest` sends
`Authorization: Bearer <apiKey>` identically in both directions and omits the header entirely when
`apiKey` is "". It was the ARGUMENT: every write caller runs `resolveStashMemorySettings(store,
settings)` first (which reads the global `stash-api-key` secret), while every read path handed RAW
settings to the synchronous `resolveMemoryBackend`, whose materialization branch reads
`settings.stashApiKey` — the schema default empty string, a key no UI field ever writes. So the read
backend was built with `apiKey: ""` and left the credential off the wire, where Stash's own
`get_current_user` answers 401 "Missing Authorization header". That 401 was then swallowed into
"no memories exist", so the defect was undetectable from any Fusion surface.

Contract every read entry below now holds:
- the ONE resolver is `resolveStashMemorySettings`; a read entry with no reader degrades to raw
  settings exactly as before (never a second key-reading path, never a throw);
- resolution happens ONCE per invocation, before the first network call, so multi-lane recall and
  the vector fallback share one enriched settings object and at most one reveal;
- `resolveMemoryBackend` stays synchronous — the settings are enriched before it is called;
- fail-closed is unchanged: a refused read still answers `[]` / `""` / `false`. What is ADDED is the
  outcome code from `reportStashReadOutcome`, which is how "we were not allowed to look" stopped
  being indistinguishable from "nothing was stored".
*/
export async function ensureMemoryFileWithBackend(
  rootDir: string,
  settings?: MemorySettings,
  /** RUFU-994: `TaskStore`-shaped reader; absent → raw settings (today's degradation). */
  secretsReader?: StashReadStoreHost,
): Promise<boolean> {
  const backendType =
    (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) ||
    DEFAULT_MEMORY_BACKEND;
  const resolvedSettings = secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings;
  const backend = resolveMemoryBackend(resolvedSettings);
  const refreshQmdIfNeeded = () => {
    if (backend.type === "qmd" || backendType === "qmd") {
      scheduleQmdInstallAndRefresh(rootDir);
    }
  };

  if (backend.exists) {
    const exists = await backend.exists(rootDir);
    if (exists) {
      if (backend.capabilities.writable) {
        await ensureOpenClawMemoryFiles(rootDir);
      }
      refreshQmdIfNeeded();
      return false;
    }
  }

  if (backend.capabilities.writable) {
    await ensureOpenClawMemoryFiles(rootDir);
  }

  // Try to write using the backend
  try {
    const result = await backend.write(rootDir, getDefaultMemoryScaffold());
    refreshQmdIfNeeded();
    return result.success;
  } catch {
    // Non-writable backends (readonly) don't throw during bootstrap
    // This is intentional - bootstrap should not fail for non-writable backends
    // The error is caught and we return false to indicate no action was taken
    return false;
  }
}

/**
 * Read project memory using the configured backend.
 *
 * This function provides backend-aware memory read that:
 * - Returns empty string if memory doesn't exist
 * - Gracefully handles read failures by returning empty string
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Project settings including memoryBackendType.
 * @returns The memory content, or empty string if not found.
 */
export async function readProjectMemoryWithBackend(
  rootDir: string,
  settings?: MemorySettings,
  /** RUFU-994: resolves the Stash key once, before the broad empty-query recall. */
  secretsReader?: StashReadStoreHost,
): Promise<string> {
  const resolvedSettings = secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings;
  const backend = resolveMemoryBackend(resolvedSettings);

  try {
    const result = await backend.read(rootDir);
    return result.content;
  } catch {
    // Read failures return empty string (graceful degradation)
    return "";
  } finally {
    // RUFU-994: this entry holds the store, so it is where the refusal becomes a counted
    // row + one warn line. Fire-and-forget; the returned content is already decided.
    reportStashReadOutcome(secretsReader, stashBaseUrlFromSettings(resolvedSettings));
    // RUFU-1008: the same argument covers the other empty-causing class — rows that arrived and
    // belonged to another project. `read()` goes through `search()`, so the scope record exists.
    reportStashReadScopeForRoot(secretsReader, stashBaseUrlFromSettings(resolvedSettings), rootDir);
  }
}

/*
FNXC:RUFU172FocusResolver 2026-08-31-19:41:
RUFU-172 moved the canonical focus/topic collapse from packages/engine/src/agent-tools.ts
down into core so the recall core (`buildPerTurnMemoryRecallCue`) and the engine memory tool
share ONE definition of "no focus". It lives here because `@fusion/core` cannot import
`@fusion/engine` (AGENTS.md → "Importing across `@fusion/*` packages"; core uses DI precisely
to avoid that cycle), and engine→core is already the direction of every other agent-tools
import. `agent-tools.ts` re-exports this function so its existing import site
(`packages/engine/src/__tests__/memory-focus-recalling.test.ts`) keeps resolving.

Semantics are unchanged from RUFU-068: trim; empty / "all" / "*" (an operator's way of
clearing the focus) collapse to `undefined` so callers keep whole-project scope; any other
trimmed string is the active focus. An active focus is a RANKING input, never a filter — the
resolved value is used as a query-side bias (RUFU-172 two-lane recall), never a corpus partition.
*/

/**
 * Resolve an active memory-search topic/focus to its effective value, or `undefined`
 * when the value means "no focus" (whole-project scope):
 *   - undefined / null → undefined
 *   - empty or whitespace-only string → undefined
 *   - "all" or "*" → undefined
 * Otherwise the trimmed string.
 */
export function resolveMemorySearchTopic(focus: string | null | undefined): string | undefined {
  if (focus == null) return undefined;
  const trimmed = focus.trim();
  if (trimmed === "" || trimmed === "all" || trimmed === "*") return undefined;
  return trimmed;
}

// ── Durable File-Layer Search Lane (RUFU-1010) ─────────────────────────

/*
FNXC:MemoryFileLayerSearch 2026-11-18-17:25 (RUFU-1010):
Single named site deciding WHICH resolved backend needs the durable layered memory files served
as a search lane. Measured, not inferred: the Stash index has NEVER contained them — every writer
of `.fusion/memory/**` refreshes only the qmd index (`scheduleQmdProjectMemoryRefresh` and the
agent-memory equivalent are the only index refreshes), while Stash is POSTed session transcripts,
the bootstrap scaffold, and dashboard saves truncated to 4000 chars. The four built-ins:
- "file" and "qmd": answer for the corpus themselves (file search / qmd index with file fallback)
  → no lane, and a lane would double every row;
- "readonly": excluded BY DESIGN — it has no search surface and its `get` is a NOT_FOUND throw
  by contract, so it must never start serving disk content;
- "stash": the violation this card closes — remote transcript rows only, no file corpus.
The gate keys on the EXACT built-in type string, deliberately NOT "not file and not qmd": the
registered test backends (`stash-topic`, `stash-boom`, `stash-no-get`, `perturn-fake`, ...) must
keep today's byte-identical behavior, which is what keeps the existing suite free of fixture churn.
RESIDUAL RISK (accepted, and the reason this is one named site): a future backend that also lacks
the corpus inherits the gap until it is added here — adding a type to this list is a deliberate,
reviewable act, never an accident of a broadened negation.
*/
export function searchesDurableMemoryFileLayer(backendType: string): boolean {
  return backendType === "stash";
}

/**
 * Code-owned guarantee behind AC1: when the file lane produced hits but the merged page kept
 * none, ONE slot is reserved for the top file hit. Load-bearing, not cosmetic: the file lane
 * scores a raw matched-term count (one term → 1) while the Stash keyword lane's tier-3 first
 * hit scores 2.0, so a plain merge reproduces the measured outcome of 20 slots and none of them
 * the file. At `limit` 1 nothing is reserved — the caller keeps its backend slot.
 */
export const MEMORY_FILE_LAYER_RESERVED_SLOTS = 1;

/**
 * Deterministic two-lane merge for memory search: cap each lane at `limit`, sort by score
 * descending with a stable path-then-lineStart tie-break, slice to `limit`, then apply the
 * one-slot file-layer reservation. Two calls with the same inputs return the same ordering.
 * Cross-scope ranking (the `+ 1000` agent-memory offset in the engine tool) is RUFU-665's
 * subject, not this merge's; this helper only merges the remote and file lanes of ONE scope.
 */
export function mergeMemoryFileLayerHits(
  remoteHits: MemorySearchResult[],
  fileHits: MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || 5, 20));
  const remote = remoteHits.slice(0, boundedLimit);
  if (fileHits.length === 0) {
    // No file content to reserve for → the page is exactly today's remote-only result.
    return remote;
  }
  const file = fileHits.slice(0, boundedLimit);
  const merged = [...remote, ...file].sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      a.path.localeCompare(b.path) ||
      (a.lineStart ?? 0) - (b.lineStart ?? 0),
  );
  const page = merged.slice(0, boundedLimit);
  const fileKeys = new Set(file.map((h) => `${h.path}\u0000${h.lineStart}`));
  const fileSurvived = page.some((h) => fileKeys.has(`${h.path}\u0000${h.lineStart}`));
  if (
    !fileSurvived &&
    boundedLimit >= 1 + MEMORY_FILE_LAYER_RESERVED_SLOTS &&
    page.length === boundedLimit
  ) {
    page[page.length - 1] = file[0];
  }
  return page;
}

/** Effective search-page size shared by the two-lane callers (matches the file scorer's clamp). */
function memorySearchLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 5, 20));
}

/** Daily-layer filename shape, mirroring the file scorer's private DAILY_MEMORY_RE. */
const CANONICAL_DAILY_MEMORY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Is `rawPath` one of the canonical layered memory paths (long-term MEMORY.md, DREAMS.md, or a
 * daily YYYY-MM-DD.md under .fusion/memory/)? Used to bound the disk fallback in
 * `getProjectMemory`: ONLY these paths may be served from disk when the resolved backend stubs
 * the window - any other request (a bare `.env`, an arbitrary project file) keeps the backend's
 * own honest answer, so the fallback can never widen `fn_memory_get` into a general file reader.
 */
export function isCanonicalLayeredMemoryPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized.startsWith(`${MEMORY_WORKSPACE_PATH}/`)) return false;
  const leaf = normalized.slice(MEMORY_WORKSPACE_PATH.length + 1);
  if (leaf.includes("/")) return false;
  return (
    leaf === MEMORY_LONG_TERM_FILENAME ||
    leaf === MEMORY_DREAMS_FILENAME ||
    CANONICAL_DAILY_MEMORY_RE.test(leaf)
  );
}

/**
 * The file lane: the deterministic layered-file scorer, run for backends whose own index does
 * not carry the corpus. Fail-closed to [] like every other memory read path; a lane, never a
 * failure fallback - it runs whether the remote lane answered or refused.
 */
export async function searchDurableMemoryFileLayer(
  rootDir: string,
  options: MemorySearchOptions,
  backendType: string,
): Promise<MemorySearchResult[]> {
  try {
    return (await searchMemoryFiles(rootDir, options, backendType)) ?? [];
  } catch {
    return [];
  }
}

// FNXC:MemorySearchTopic 2026-08-13-16:35: (RUFU-035/RUFU-068) search can be
// scoped to an optional read-time focus/topic. Corrected by RUFU-172: the topic is
// honored only by topic-aware backends and is INERT for Stash — RUFU-121 removed the
// `&topic=` push-down because the Stash search route accepts `q`+`limit` only, so no
// SQL-side filtering ever happened. Topic-agnostic backends (file/qmd/readonly) ignore
// it too. Proactive per-turn recall uses the focus as a ranking bias, not a filter
// (RUFU-172). Searching never throws: an availability/auth/parse failure on a remote
// backend (e.g. Stash down) degrades to an empty result set so fn_memory_search and
// proactive recall never block an agent task.
export async function searchProjectMemory(
  rootDir: string,
  options: MemorySearchOptions,
  settings?: MemorySettings,
  topic?: string,
  /** RUFU-994: resolves the Stash key once for keyword + semantic + fallback in one call. */
  secretsReader?: StashReadStoreHost,
): Promise<MemorySearchResult[]> {
  const resolvedSettings = secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings;
  const backend = resolveMemoryBackend(resolvedSettings);
  if (!backend.search) {
    return [];
  }
  // RUFU-035: fold the optional focus into the search options so a topic-aware
  // backend can honor it. For Stash this is inert (RUFU-121: the search route
  // accepts q+limit only) — it is carried for the other backends and for
  // read-side gating, never as a SQL filter.
  const searchOptions =
    topic && topic.trim().length > 0 && topic !== "all" && topic !== "*"
      ? { ...options, topic: topic.trim() }
      : options;
  try {
    /*
    FNXC:MemoryFileLayerSearch 2026-11-18-17:35 (RUFU-1010):
    Second lane for backends that never received the durable layered memory corpus (gate: one
    named predicate; today that is `stash` only). The remote lane failing (refusal already answers
    [], a transport throw is caught here) contributes an empty list to its own lane; it does NOT
    gate the file lane, which runs whether the remote answered or refused. The RUFU-994 refusal
    reporting in the finally is byte-identical - this lane changes which rows come back, never
    what the outcome code records. Non-lane backends keep the exact pre-existing single-call path.
    */
    if (searchesDurableMemoryFileLayer(backend.type)) {
      const [remote, fileHits] = await Promise.all([
        backend.search(rootDir, searchOptions).then((r) => r ?? []).catch(() => []),
        searchDurableMemoryFileLayer(rootDir, searchOptions, backend.type),
      ]);
      return mergeMemoryFileLayerHits(remote, fileHits, memorySearchLimit(options.limit));
    }
    return await backend.search(rootDir, searchOptions);
  } catch {
    // FNXC:MemoryResilience 2026-08-13-16:35: (RUFU-068) fail closed to empty —
    // never let a Stash/gateway search failure block a task, chat, or test.
    return [];
  } finally {
    // RUFU-994: fn_memory_search, POST /api/memory/test and the proactive cue all land here, so
    // this is the seam that turns a swallowed 401 into a counted row. The returned array is
    // already decided — reporting cannot change it.
    reportStashReadOutcome(secretsReader, stashBaseUrlFromSettings(resolvedSettings));
    // RUFU-1008: and the seam that counts rows dropped for belonging to another project, without
    // which a recall emptied by the scope filter is indistinguishable from a project with nothing.
    reportStashReadScopeForRoot(secretsReader, stashBaseUrlFromSettings(resolvedSettings), rootDir);
  }
}

export async function getProjectMemory(
  rootDir: string,
  options: MemoryGetOptions,
  settings?: MemorySettings,
  /**
   * RUFU-994: threaded for seam symmetry with the search/read entries. Stash's `get()` is a
   * pure empty-window stub that performs no HTTP call, so this path cannot refuse on auth
   * today; the reader is accepted so a future windowed read inherits the credential instead
   * of rediscovering the defect.
   */
  secretsReader?: StashReadStoreHost,
): Promise<MemoryGetResult> {
  const resolvedSettings = secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings;
  const backend = resolveMemoryBackend(resolvedSettings);
  if (!backend.get) {
    throw new Error(`Memory backend '${backend.type}' does not support memory_get`);
  }
  try {
    const result = await backend.get(rootDir, options);
    /*
    FNXC:MemoryFileLayerSearch 2026-11-18-17:50 (RUFU-1010):
    The `fn_memory_get` description promises a search hit can be read back; under `stash` that
    was false twice over - search never produced file rows (fixed by the search lane) AND the
    windowed read was a pure empty-window stub, so the operator's proposed fallback ("read the
    index with fn_memory_get") was itself broken. When the backend's own window holds no content
    and the backend is one that does not serve the layered files (the same one named predicate;
    `readonly` throws NOT_FOUND before reaching here, so its catch-and-empty contract stays
    closed), serve the requested window of a CANONICAL layered memory path from disk and report
    the backend that actually answered ("file"). A path with no disk content falls through to the
    backend's empty window; a non-canonical path never takes this branch at all.
    */
    if (
      (!result || result.content === "") &&
      searchesDurableMemoryFileLayer(backend.type) &&
      isCanonicalLayeredMemoryPath(options.path)
    ) {
      try {
        return await readProjectMemoryFile(rootDir, options);
      } catch {
        return result;
      }
    }
    return result;
  } catch {
    // FNXC:MemoryResilience 2026-08-13-16:35: (RUFU-068) degrade a remote
    // backend read/parse failure (e.g. Stash down) to an empty window so
    // fn_memory_get never blocks the caller. The unsupported-backend throw
    // above (no `get`) is preserved so agents get a clear message.
    return {
      path: options.path,
      content: "",
      startLine: 1,
      endLine: 1,
      totalLines: 0,
      backend: backend.type,
    };
  }
}

/**
 * Proactive pre-response memory cue (LCM / Volt-style ghost cue).
 *
 * At the start of a task execution the executor recalls relevant prior context from
 * the memory backend using the task description as the query, then injects the top
 * matches directly into the system prompt. The agent does NOT have to remember to
 * call fn_memory_search — relevant memory arrives proactively.
 *
 * Only search-capable backends can be proactively recalled. Fails closed: any recall
 * error or empty result returns "" so a memory hiccup can never block or bloat a run.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param query   - The natural-language query (typically the task description).
 * @param settings - Project settings including memoryBackendType.
 * @param opts    - Optional limit on the number of recalled cues, and a topic
 *                  (RUFU-035) naming the working topic. Honored only by
 *                  topic-aware backends; inert for Stash (RUFU-121), so it biases
 *                  nothing there — it never filters. undefined/'all'/empty topic →
 *                  whole-project scope. Proactive per-turn recall handles an active
 *                  focus as a two-lane ranking bias instead (RUFU-172).
 * @returns A formatted "## Relevant Prior Context" block, or "" when disabled,
 *          not search-capable, failed, or with nothing to inject.
 */
export async function buildProactiveMemoryCueBlock(
  rootDir: string,
  query: string,
  settings?: MemorySettings,
  opts?: { limit?: number; topic?: string; secretsReader?: StashReadStoreHost },
): Promise<string> {
  if (!rootDir || !query) return "";
  // FNXC:MemoryResilience 2026-08-13-16:35: (RUFU-068) respect the memory
  // off-switch so proactive recall never activates when memory is disabled.
  if (settings?.memoryEnabled === false) return "";
  // RUFU-994: resolve before the backend exists — see the StashReadAuth block on
  // `ensureMemoryFileWithBackend` for why a read that skips this reads as "empty".
  const resolvedSettings = opts?.secretsReader
    ? await resolveStashMemorySettings(opts.secretsReader, settings)
    : settings;
  const backend = resolveMemoryBackend(resolvedSettings);
  // Only search-capable backends can be proactively recalled; the file/readonly
  // backends have no recall primitive.
  if (!backend.search) return "";
  try {
    const limit = opts?.limit ?? 5;
    // RUFU-035 Step 3: when the enclosing conversation/task carries an active
    // topic, carry it into the search options. RUFU-172 correction: this is NOT a
    // within-project read filter - Stash never received it (RUFU-121 removed the
    // &topic= push-down; the route accepts q+limit only) and no backend performs
    // SQL-side topic filtering. Topic-aware backends may use it as a hint;
    // undefined/'all'/empty -> whole-project scope.
    const topic = opts?.topic?.trim();
    const searchOptions = {
      query,
      limit,
      ...(topic && topic !== "all" && topic !== "*" ? { topic } : {}),
    };
    /*
    FNXC:MemoryFileLayerSearch 2026-11-18-17:35 (RUFU-1010):
    The executor's session-start cue is the third direct backend.search caller; fixing only
    searchProjectMemory would leave this surface reporting the same empty project memory it
    reports today. Same lane and same merge policy as `searchProjectMemory`; the formatter below
    is untouched, so a lane row renders as `- .fusion/memory/MEMORY.md (score N): snippet`.
    */
    let results: MemorySearchResult[];
    if (searchesDurableMemoryFileLayer(backend.type)) {
      const [remote, fileHits] = await Promise.all([
        backend.search(rootDir, searchOptions).then((r) => r ?? []).catch(() => []),
        searchDurableMemoryFileLayer(rootDir, searchOptions, backend.type),
      ]);
      results = mergeMemoryFileLayerHits(remote, fileHits, memorySearchLimit(limit));
    } else {
      results = await backend.search(rootDir, searchOptions);
    }
    if (!results || results.length === 0) return "";
    const items = results
      .slice(0, limit)
      .map((r) => {
        const src = r.path && r.path !== ".memory/recall/" ? r.path : r.backend;
        const score =
          typeof r.score === "number" && Number.isFinite(r.score) ? ` (score ${r.score.toFixed(2)})` : "";
        const snippet = (r.snippet ?? r.path ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        return `- ${src}${score}: ${snippet || "(no excerpt)"}`;
      })
      .join("\n");
    return (
      `\n## Relevant Prior Context (auto-recalled)\n\n` +
      `The following memories were recalled for this task before execution. ` +
      `They may contain relevant decisions, constraints, or patterns you should honor. ` +
      `You may use them without calling fn_memory_search.\n${items}\n`
    );
  } catch {
    // Graceful degradation: never let a recall failure block execution.
    return "";
  } finally {
    // RUFU-994: same reason as `searchProjectMemory` — the cue builder is the executor's
    // proactive read seam and holds the store host.
    reportStashReadOutcome(opts?.secretsReader, stashBaseUrlFromSettings(resolvedSettings));
    // RUFU-1008: ditto for dropped-by-scope rows; an empty cue must not hide a foreign-project hit.
    reportStashReadScopeForRoot(opts?.secretsReader, stashBaseUrlFromSettings(resolvedSettings), rootDir);
  }
}

// ── Memory Instructions for Prompts ──────────────────────────────────

/**
 * Build the memory instruction section for the triage/specification prompt.
 *
 * Tells the spec agent to consult the project memory file for context and
 * to include relevant memory insights in the task specification.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Optional project settings for backend-aware instruction generation.
 *                 When provided, the function branches based on memoryBackendType:
 *                 - "file": includes `.fusion/memory/MEMORY.md` read guidance
 *                 - "readonly": read-only instructions, no write directives
 *                 - "qmd"/non-file: instructions without unconditional `.fusion/memory/MEMORY.md` path
 * @returns The memory instruction section string, or empty string if the
 *          memory file does not exist yet.
 */
export function buildTriageMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
  recallHits?: readonly RecallSearchHit[],
  inclusionMode: AgentMemoryInclusionMode = "full",
): string {
  void rootDir; // Parameter kept for future use (e.g., checking file existence)
  const ctx = resolveMemoryInstructionContext(settings);

  // Read-only backend: provide read guidance without file path reference
  if (!ctx.capabilities.readable) {
    return ""; // No memory available
  }

  if (!ctx.capabilities.writable) {
    // Read-only backend: consult memory for context but don't mention file path
    return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has a memory system that stores durable project learnings.

**Before writing the specification:**
1. Consult the project memory for relevant context
2. Incorporate any useful learnings into your specification
`, recallHits);
  }

  // Writable backend (file or qmd)
  if (ctx.instructionPathHint) {
    // File backend: mention the explicit path
    return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has OpenClaw-style memory files:
- \`.fusion/memory/MEMORY.md\` — curated long-term memory for durable decisions, conventions, and pitfalls
- \`.fusion/memory/YYYY-MM-DD.md\` — append-only daily notes for running context

**Before writing the specification:**
1. Use \`fn_memory_search\` first for task-relevant context
2. Use \`fn_memory_get\` only for specific memory files/line ranges returned by search
3. Incorporate relevant learnings into your specification — reference actual patterns, constraints, and conventions documented there

**Memory write contract for planning agents:**
- If you need to save durable planning context, use \`fn_memory_append\` (choose scope/layer intentionally)
- Do **not** write \`.fusion/memory/MEMORY.md\`, \`.fusion/memory/YYYY-MM-DD.md\`, or any other memory files directly when \`fn_memory_append\` is available

Do not read all memory directly by default. If memory is irrelevant, skip it.
`, recallHits);
  }

  // QMD/non-file writable backend: generic instructions without specific path
  return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has a memory system that stores durable project learnings.

**Before writing the specification:**
1. Use \`fn_memory_search\` first for task-relevant context
2. Use \`fn_memory_get\` only for specific memory files/line ranges returned by search
3. Incorporate useful learnings into your specification

**Memory write contract for planning agents:**
- If you need to save durable planning context, use \`fn_memory_append\` (choose scope/layer intentionally)
- Do **not** write memory files directly when \`fn_memory_append\` is available

**If the memory contains useful context for this task, reference it in the specification.**
`, recallHits);
}

/**
 * Build the memory instruction section for the execution prompt.
 *
 * Tells the executor agent to read the memory file at the start of execution
 * and selectively update it with durable learnings at the end.
 *
 * Key behavioral changes from legacy append-only pattern:
 * - Agents SHOULD skip memory updates when nothing durable was learned
 * - Agents CAN edit/consolidate existing entries (not just append)
 * - Only genuinely reusable insights qualify — not task-specific trivia
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Optional project settings for backend-aware instruction generation.
 *                  When provided, the function branches based on memoryBackendType:
 *                  - "file": includes `.fusion/memory/MEMORY.md` read/write guidance
 *                  - "readonly": read-only instructions, no write/update directives
 *                  - "qmd"/non-file: instructions without unconditional `.fusion/memory/MEMORY.md` path
 * @returns The memory instruction section string.
 */
export function buildExecutionMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
  recallHits?: readonly RecallSearchHit[],
  inclusionMode: AgentMemoryInclusionMode = "full",
): string {
  void rootDir; // Parameter kept for future use (e.g., checking file existence)
  const ctx = resolveMemoryInstructionContext(settings);

  // Read-only backend: provide read guidance without file path reference
  if (!ctx.capabilities.readable) {
    return ""; // No memory available
  }

  if (!ctx.capabilities.writable) {
    // Read-only backend: consult memory for context but no update instructions
    return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has a memory system that stores durable project learnings.

**At the start of execution:**
1. Consult the project memory for relevant context
2. Apply any useful learnings to your implementation
`, recallHits);
  }

  // Writable backend (file or qmd)
  if (ctx.instructionPathHint) {
    // File backend: mention the explicit path with full read/write instructions
    return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has OpenClaw-style memory files:
- \`.fusion/memory/MEMORY.md\` — curated long-term memory for durable decisions, conventions, and pitfalls
- \`.fusion/memory/YYYY-MM-DD.md\` — append-only daily notes for running observations and open loops

**At the start of execution:**
1. Use \`fn_memory_search\` first for task-relevant context
2. Use \`fn_memory_get\` only for specific memory files/line ranges returned by search
3. Apply relevant learnings to your implementation — follow documented patterns and avoid known pitfalls
4. Do not load all memory directly by default. Skip memory reads when memory is irrelevant or context is tight.

**At the end of execution (before calling \`fn_task_done()\`):**
1. Review what you learned during this task that would genuinely benefit future runs
2. Choose scope intentionally:
   - Use \`fn_memory_append(scope="agent")\` for your private operating context (personal checklists, delegation habits, temporary playbooks, self-improvement notes)
   - Use \`fn_memory_append(scope="project")\` for repository-wide durable knowledge any future agent should know
3. Choose layer intentionally:
   - \`layer="long-term"\` for durable conventions/decisions/pitfalls
   - \`layer="daily"\` for running observations, unresolved context, and open loops
4. If using project scope with file backend, write long-term memory to \`.fusion/memory/MEMORY.md\` and daily notes to today's \`.fusion/memory/YYYY-MM-DD.md\`
5. **If nothing durable was learned, skip the memory update entirely** — do not append trivial or task-specific notes
6. Only write to **project** memory when the insight is genuinely reusable across the workspace (architecture patterns, shared conventions, durable pitfalls, cross-task constraints)
7. **Do not** write private/ephemeral items to project memory, such as personal TODOs, one-off scratch notes, or preferences that only help you as an individual agent
8. **Consolidate when possible**: If an existing entry already covers a concept, update or refine it rather than adding a duplicate. Delete entries that are no longer accurate.

**Format for additions:** Add bullet points under the relevant section heading:
- Use \`- \` prefix for list items
- Keep entries concise and actionable
- Example: \`- The API layer uses Zod schemas for all request validation\`
`, recallHits);
  }

  // QMD/non-file writable backend: generic instructions without specific path
  return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has a memory system that stores durable project learnings accumulated from past task runs.

**At the start of execution:**
1. Use \`fn_memory_search\` first for task-relevant context
2. Use \`fn_memory_get\` only for specific memory files/line ranges returned by search
3. Apply useful learnings to your implementation

**At the end of execution (before calling \`fn_task_done()\`):**
1. Review what you learned during this task that would genuinely benefit future runs
2. Choose scope intentionally:
   - Use \`fn_memory_append(scope="agent")\` for your private operating context
   - Use \`fn_memory_append(scope="project")\` only for repo-wide durable knowledge
3. Choose layer intentionally:
   - \`layer="long-term"\` for durable conventions/decisions/pitfalls
   - \`layer="daily"\` for running observations and open loops
4. **If nothing durable was learned, skip the memory update entirely** — do not append trivial or task-specific notes
5. **Avoid task-specific trivia** in project scope (for example: personal reminders, one-off scratch thoughts, individual communication preferences)
6. Consolidate when possible: refine an existing memory entry instead of adding duplicates.
`, recallHits);
}

export function buildReviewerMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
  recallHits?: readonly RecallSearchHit[],
  inclusionMode: AgentMemoryInclusionMode = "full",
): string {
  void rootDir;
  const ctx = resolveMemoryInstructionContext(settings);
  if (!ctx.capabilities.readable) {
    return "";
  }

  return appendRecallInstructionSection(`
## Project Memory

${buildMemoryPreSteeringNudge(inclusionMode)}

This project has a memory system that stores durable project learnings.

**During review:**
1. Use \`fn_memory_search\` for task-relevant project conventions, pitfalls, and prior decisions when they could affect your verdict
2. Use \`fn_memory_get\` only for specific memory files/line ranges returned by search
3. Treat documented durable conventions and pitfalls as review evidence when deciding APPROVE, REVISE, or RETHINK
4. Do not update memory during review; reviewer memory access is read-only
5. Skip memory reads when they are not relevant to the reviewed plan or code
`, recallHits);
}

/**
 * Read the project memory file content.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The memory file content, or empty string if not found.
 */
export async function readProjectMemory(rootDir: string): Promise<string> {
  const longTermPath = memoryLongTermPath(rootDir);
  if (!existsSync(longTermPath)) {
    return "";
  }
  return readFile(longTermPath, "utf-8");
}
