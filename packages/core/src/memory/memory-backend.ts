/**
 * Pluggable Memory Backend System
 *
 * This module provides a pluggable architecture for project memory storage.
 * Different backends can be plugged in based on project settings, with
 * each backend declaring its capabilities (readable, writable, etc.).
 *
 * The default backend is qmd-backed search over layered memory files, with
 * local file search as a fallback when qmd is not installed.
 */

import { readFile, writeFile, mkdir, access, constants, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
// FNXC:MemoryBackend 2026-08-13-16:35:
// MemoryBackendError lives in its dependency-free module so per-backend
// implementations (e.g. memory-backend-stash.ts) can import it as a runtime
// value without an ESM circular-init break against memory-backend.ts. We import
// it here (local binding for this module's own throws) and re-export so the
// public surface is unchanged.
import { MemoryBackendError } from "./memory-backend-error.js";
// FNXC:StashBackend 2026-08-13-16:35:
// Import the Stash backend as a runtime value (registration + per-project URL/key
// materialization in resolveMemoryBackend). memory-backend-stash.ts imports ONLY
// types from this module (erased at build), so there is no ESM circular-init.
import { StashMemoryBackend, DEFAULT_STASH_URL } from "./memory-backend-stash.js";
import { resolveStashMemorySettings, type StashSecretsReader } from "./stash-settings.js";
/*
FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012): one tokenizer, one matcher, one window
geometry for every deterministic memory lane. Static relative import (no dynamic import) so the
module graph stays analyzable; memory-query-terms.ts itself imports nothing, so this cannot cycle.
*/
import {
  MEMORY_SNIPPET_STRIDE_LINES,
  MEMORY_SNIPPET_WINDOW_LINES,
  countMemoryTermMatches,
  deriveMemoryQueryTerms,
  dropLineOverlappingMemoryHits,
} from "./memory-query-terms.js";
/*
FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665):
The cold-tier filename shape is imported, never re-declared. Budget maintenance WRITES these files from
the engine, and this module decides whether a reader can reach them; a second copy of the shape here is
how a retired note ends up searchable in one lane and refused in another.
*/
import { isArchiveMemoryFileName } from "./memory-archive-filename.js";

export const MEMORY_WORKSPACE_PATH = ".fusion/memory";
export const MEMORY_LONG_TERM_FILENAME = "MEMORY.md";
export const MEMORY_DREAMS_FILENAME = "DREAMS.md";
export const QMD_INSTALL_COMMAND = "bun install -g @tobilu/qmd";
export const QMD_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const DAILY_MEMORY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const AGENT_MEMORY_WORKSPACE_PATH = ".fusion/agent-memory";
const MAX_MEMORY_SNIPPET_CHARS = 700;
const DEFAULT_MEMORY_GET_LINES = 120;
const MAX_MEMORY_GET_LINES = 400;
const QMD_COLLECTION_PREFIX = "fusion-memory";

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number; keepAlive?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const qmdRefreshState = new Map<string, { lastStartedAt: number; inFlight?: Promise<void> }>();
const qmdAgentRefreshState = new Map<string, { lastStartedAt: number; inFlight?: Promise<void> }>();
let qmdInstallPromise: Promise<boolean> | null = null;

export function shouldSkipBackgroundQmdRefresh(): boolean {
  return (process.env.VITEST === "true" || process.env.NODE_ENV === "test")
    && process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS !== "1";
}

// ── Type Definitions ────────────────────────────────────────────────

/**
 * Capabilities that a memory backend may support.
 * Used by the engine and dashboard to determine what operations are available.
 */
export interface MemoryBackendCapabilities {
  /** Backend can read memory content */
  readable: boolean;
  /** Backend can write/update memory content */
  writable: boolean;
  /** Backend supports atomic writes (vs append-only or merge-based) */
  supportsAtomicWrite: boolean;
  /** Backend has built-in conflict resolution for concurrent access */
  hasConflictResolution: boolean;
  /** Backend persists data across sessions */
  persistent: boolean;
}

/**
 * Result of a memory read operation.
 */
export interface MemoryReadResult {
  /** The memory content, or empty string if not found */
  content: string;
  /** Whether the memory file existed */
  exists: boolean;
  /** Backend identifier that served this read */
  backend: string;
}

/**
 * Result of a memory write operation.
 */
export interface MemoryWriteResult {
  /** Whether the write succeeded */
  success: boolean;
  /** The backend that processed this write */
  backend: string;
}

export interface MemoryGetOptions {
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface MemoryGetResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  backend: string;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  /**
   * FNXC:MemoryFocus 2026-08-08-00:00:
   * (RUFU-035/RUFU-068) optional read-time focus/topic. Backends that support
   * topic scoping push `options.topic` down to their search transport;
   * topic-agnostic backends ignore it. Focus is strictly a WITHIN-project read
   * hint — it never widens cross-project isolation. That sentence needed its
   * mechanism named (RUFU-1008): a Stash read is scoped by OWNER, so one operator's
   * Fusion projects are ONE readable domain and isolation is verified client-side
   * against the asking project's identity in `StashMemoryBackend.scopeItemsToProject`.
   * No topic value can widen that check.
   *
   * FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
   * RUFU-121: the Stash backend no longer pushes `topic` down to its search
   * URL — the param was inert (Stash `search_events` accepts only q+limit and
   * the route has no topic filter; verified 2026-08-18 against
   * /home/schindler/git/stash). The option stays for the qmd/file/readonly
   * backends and read-side gating; Stash topic-like recall scoping uses the
   * structured `queryStashEvents()` filters.
   */
  topic?: string;
}

export interface MemorySearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
  /**
   * FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
   * Set ONLY when a page's `score` values are not a relevance claim. Measured on the deployed Stash
   * image: one query returned 10 rows whose score was `0.18558138608932495` identical to the last
   * digit — a constant the server sends, which tier 1 of the scoring passed through as if it ranked.
   * `positional` means the page's order is the server's response order; `server-rank-fallback` means
   * it was recomputed from the `rank` values the server did send. Absent = the score is the lane's
   * normal relevance number, so every existing consumer sees byte-identical objects on a normal page
   * and non-Stash backends never see this field at all.
   *
   * A renderer that shows the number (the proactive cue, `fn_memory_search`) must suppress it and say
   * where the order came from instead, when this is present.
   */
  rankingSource?: MemoryRankingSource;
}

/**
 * FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088): only the values this card actually writes.
 * A third value (`"relevance"`) was rejected: an absent field already says that, and a label that can
 * be set on every row would let a producer claim relevance instead of earning it from a real signal.
 */
export type MemoryRankingSource = "positional" | "server-rank-fallback";

export interface MemoryFileInfo {
  path: string;
  label: string;
  layer: "long-term" | "daily" | "dreams";
  size: number;
  updatedAt: string;
}

export {
  MemoryBackendError,
  type MemoryBackendErrorCode,
} from "./memory-backend-error.js";

/**
 * Capture event kind. Exported as the contract union that capture-capable
 * backends accept; the interface field is left permissive (`string`) so
 * backend-specific kinds (e.g. "user_message"/"assistant_message" for chat
 * capture) can flow through without a strict-union break.
 */
export type MemoryCaptureEventType = "message" | "tool_use" | "note";

/**
 * A single capture event payload sent to a capture-capable backend.
 */
export interface MemoryCaptureEvent {
  /** Machine-readable event kind (e.g. "message", "tool_use", "note"). */
  event_type: string;
  /** Event payload/text. */
  content: string;
  /** Optional producing agent name. */
  agent_name?: string;
  /** Optional tool name when the event is a tool use. */
  tool_name?: string;
  /** Optional structured metadata (never secrets). */
  metadata?: Record<string, unknown>;
  /** Optional RFC3339 timestamp; defaults to server receive time. */
  created_at?: string;
}

/**
 * Result of a best-effort capture. Always resolves — capture must NEVER throw
 * or block a run (fail-closed); callers gate on `ok` + counts.
 */
export interface MemoryCaptureResult {
  /** True if the backend accepted the capture. */
  ok: boolean;
  /** Events inserted by the backend. */
  inserted: number;
  /** Events deduplicated by the backend (idempotent tuple upsert). */
  deduped: number;
}

/**
 * FNXC:RUFU121WriteIdentity 2026-08-18-19:53:
 * RUFU-121: optional project identity for a memory write. Lets project-scoping
 * backends (Stash) resolve the per-project session folder and enrich event
 * metadata. Absent/undefined means "no identity available" — the backend
 * degrades to the pre-RUFU-121 behavior.
 */
export interface MemoryWriteIdentity {
  projectId?: string | null;
  projectName?: string | null;
}

/**
 * Interface for memory backends.
 * Implement this interface to create a new memory backend.
 */
export interface MemoryBackend {
  /** Unique identifier for this backend type */
  readonly type: string;
  /** Human-readable name for this backend */
  readonly name: string;
  /** Capabilities supported by this backend */
  readonly capabilities: MemoryBackendCapabilities;
  /**
   * Read memory content.
   * @param rootDir - The project root directory
   * @returns Promise resolving to the memory content and metadata
   * @throws MemoryBackendError if reading fails
   */
  read(rootDir: string): Promise<MemoryReadResult>;
  /**
   * Write memory content.
   * @param rootDir - The project root directory
   * @param content - The content to write
   * @param meta - FNXC:RUFU121WriteIdentity 2026-08-18-19:53: RUFU-121 optional
   *   project identity (session-folder classification + metadata enrichment for
   *   project-scoping backends such as Stash). Existing 2-arg callers are
   *   unchanged (meta is optional).
   * @returns Promise resolving to the write result
   * @throws MemoryBackendError if writing fails or backend is read-only
   */
  write(rootDir: string, content: string, meta?: MemoryWriteIdentity): Promise<MemoryWriteResult>;
  /**
   * Read a specific memory file or line window. Implementations must reject
   * paths outside the memory workspace.
   */
  get?(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult>;
  /**
   * Search memory files. Backends may use keyword search, vector search, or
   * external sidecars, but should return bounded snippets rather than full files.
   */
  search?(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]>;
  /**
   * Check if memory exists for a project.
   * @param rootDir - The project root directory
   * @returns Promise resolving to true if memory exists
   */
  exists?(rootDir: string): Promise<boolean>;
  /**
   * Best-effort capture of session events into the backend. Optional seam for
   * capture-capable backends (e.g. Stash). Called at session end by the engine.
   * MUST NOT throw or block a run — implementations resolve a MemoryCaptureResult
   * with `ok:false` on any failure. Content goes to the backend only, never to
   * the run-audit.
   */
  capture?(
    sessionId: string,
    events: MemoryCaptureEvent[],
    metadata?: {
      taskId?: string;
      projectRoot?: string;
      topic?: string;
      /**
       * FNXC:RUFU121CaptureIdentity 2026-08-18-19:53:
       * RUFU-121: optional project/chat identity. `projectId` drives
       * per-project session-folder classification; `projectName`/`chatTitle`
       * enrich event metadata (`project_name`/`chat_title`).
       */
      projectId?: string;
      projectName?: string;
      chatTitle?: string;
    },
  ): Promise<MemoryCaptureResult>;
  /**
   * Optional session-end flush/hook. Best-effort, never throws.
   */
  endSession?(sessionId: string): Promise<void>;
}

/**
 * Configuration for a memory backend.
 * Used to select and configure which backend to use.
 */
export interface MemoryBackendConfig {
  /** The type of backend to use */
  type: string;
  /** Backend-specific configuration options */
  options?: Record<string, unknown>;
}

// ── Backend Registry ────────────────────────────────────────────────

/** Registry of registered memory backends */
const backendRegistry = new Map<string, MemoryBackend>();

/**
 * File-based memory backend.
 *
 * Stores project memory in `.fusion/memory/MEMORY.md` at the project root.
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly type = "file";
  readonly name = "File (.fusion/memory/MEMORY.md)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: true,
    hasConflictResolution: false,
    persistent: true,
  };

  private getLongTermPath(rootDir: string): string {
    return join(rootDir, MEMORY_WORKSPACE_PATH, MEMORY_LONG_TERM_FILENAME);
  }

  async read(rootDir: string): Promise<MemoryReadResult> {
    const filePath = this.getLongTermPath(rootDir);
    try {
      const content = await readFile(filePath, "utf-8");
      return {
        content,
        exists: true,
        backend: this.type,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: "",
          exists: false,
          backend: this.type,
        };
      }
      throw new MemoryBackendError(
        "READ_FAILED",
        `Failed to read memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    const filePath = this.getLongTermPath(rootDir);
    const dir = join(rootDir, MEMORY_WORKSPACE_PATH);

    try {
      // Ensure directory exists
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write atomically using temp file
      const tmpPath = filePath + ".tmp";
      await writeFile(tmpPath, content, "utf-8");

      // Import rename for atomic swap
      const { rename } = await import("node:fs/promises");
      await rename(tmpPath, filePath);

      return {
        success: true,
        backend: this.type,
      };
    } catch (err) {
      throw new MemoryBackendError(
        "WRITE_FAILED",
        `Failed to write memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async exists(rootDir: string): Promise<boolean> {
    try {
      await access(this.getLongTermPath(rootDir), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async get(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return getMemoryFile(rootDir, options, this.type);
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return searchMemoryFiles(rootDir, options, this.type);
  }
}

/**
 * Read-only memory backend.
 *
 * Returns empty content on read and throws on write.
 * Useful when memory is managed externally or read-only access is required.
 */
export class ReadOnlyMemoryBackend implements MemoryBackend {
  readonly type = "readonly";
  readonly name = "Read-Only";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };

  async read(_rootDir: string): Promise<MemoryReadResult> {
    return {
      content: "",
      exists: false,
      backend: this.type,
    };
  }

  async write(_rootDir: string, _content: string): Promise<MemoryWriteResult> {
    throw new MemoryBackendError(
      "READ_ONLY",
      "This backend is read-only and cannot write memory",
      this.type,
    );
  }

  async get(_rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    throw new MemoryBackendError(
      "NOT_FOUND",
      `Memory path '${options.path}' not found`,
      this.type,
    );
  }

  async search(_rootDir: string, _options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return [];
  }
}

/**
 * QMD (qmd index/query integration) memory backend.
 *
 * Stores project memory in `.fusion/memory/MEMORY.md` so it can be indexed and queried
 * by the external `qmd` tool. Read/write operations use direct filesystem access
 * for reliability. The `qmd` tool can be configured separately to watch and index
 * layered memory files for advanced querying capabilities.
 *
 * **Capabilities:**
 * - readable: true
 * - writable: true
 * - supportsAtomicWrite: false (QMD indexing is async/external)
 * - hasConflictResolution: false
 * - persistent: true (memory files persist in `.fusion/memory/`)
 *
 * @example
 * ```typescript
 * // Configure in settings to enable qmd integration
 * const settings = { memoryBackendType: 'qmd' };
 * const backend = resolveMemoryBackend(settings);
 * ```
 */
export class QmdMemoryBackend implements MemoryBackend {
  readonly type = "qmd";
  readonly name = "QMD (qmd index/query integration)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: true,
  };

  /** Delegate file backend for actual I/O operations */
  private readonly fileBackend = new FileMemoryBackend();

  /**
   * Read memory content from the filesystem.
   *
   * @param rootDir - The project root directory
   * @returns Promise resolving to memory read result
   */
  async read(rootDir: string): Promise<MemoryReadResult> {
    // Delegate to file backend, but return "qmd" as the backend identifier
    const result = await this.fileBackend.read(rootDir);
    return {
      ...result,
      backend: this.type,
    };
  }

  /**
   * Write memory content to the filesystem.
   *
   * @param rootDir - The project root directory
   * @param content - The content to write
   * @returns Promise resolving to write result
   */
  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    // Delegate to file backend, but return "qmd" as the backend identifier
    const result = await this.fileBackend.write(rootDir, content);
    scheduleQmdProjectMemoryRefresh(rootDir);
    return {
      ...result,
      backend: this.type,
    };
  }

  /**
   * Check if memory file exists.
   *
   * @param rootDir - The project root directory
   * @returns Promise resolving to true if memory exists
   */
  async exists(rootDir: string): Promise<boolean> {
    return this.fileBackend.exists(rootDir);
  }

  async get(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return getMemoryFile(rootDir, options, this.type);
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const qmdResults = await searchWithQmd(rootDir, options);
    if (qmdResults.length > 0) {
      // FNXC:MemoryWindowGeometry 2026-11-19-04:35 (RUFU-1012): the external `qmd` index authors
      // these windows, so this lane drops line-overlapping ones rather than choosing a stride.
      return dropLineOverlappingMemoryHits(qmdResults).map((result) => ({ ...result, backend: this.type }));
    }
    return searchMemoryFiles(rootDir, options, this.type);
  }
}

export function memoryWorkspacePath(rootDir: string): string {
  return join(rootDir, MEMORY_WORKSPACE_PATH);
}

export function memoryLongTermPath(rootDir: string): string {
  return join(memoryWorkspacePath(rootDir), MEMORY_LONG_TERM_FILENAME);
}

export function memoryDreamsPath(rootDir: string): string {
  return join(memoryWorkspacePath(rootDir), MEMORY_DREAMS_FILENAME);
}

export function qmdMemoryCollectionName(rootDir: string): string {
  const absoluteRoot = resolve(rootDir);
  const slug = basename(absoluteRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
  const hash = createHash("sha1").update(absoluteRoot).digest("hex").slice(0, 12);
  return `${QMD_COLLECTION_PREFIX}-${slug}-${hash}`;
}

export function buildQmdSearchArgs(rootDir: string, options: MemorySearchOptions): string[] {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  return [
    "search",
    options.query,
    "--json",
    "--collection",
    qmdMemoryCollectionName(rootDir),
    "-n",
    String(limit),
  ];
}

export function buildQmdCollectionAddArgs(rootDir: string): string[] {
  return [
    "collection",
    "add",
    memoryWorkspacePath(rootDir),
    "--name",
    qmdMemoryCollectionName(rootDir),
    "--mask",
    "**/*.md",
  ];
}

export function buildQmdRefreshCommands(rootDir: string): string[][] {
  return [
    buildQmdCollectionAddArgs(rootDir),
    ["update"],
    ["embed"],
  ];
}

export function qmdAgentMemoryCollectionName(rootDir: string, agentId: string): string {
  const absoluteRoot = resolve(rootDir);
  const safeAgentId = agentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const hash = createHash("sha1").update(`${absoluteRoot}:${agentId}`).digest("hex").slice(0, 12);
  return `fusion-agent-memory-${safeAgentId.toLowerCase()}-${hash}`;
}

export function dailyMemoryPath(rootDir: string, date = new Date()): string {
  return join(memoryWorkspacePath(rootDir), `${date.toISOString().slice(0, 10)}.md`);
}

export function getDefaultLongTermMemoryScaffold(): string {
  return `# Project Memory

<!-- Curated long-term memory. Store durable decisions, conventions, preferences, and pitfalls. -->

## Decisions

## Conventions

## Pitfalls

## Context
`;
}

export function getDefaultDailyMemoryScaffold(date = new Date()): string {
  return `# Daily Memory ${date.toISOString().slice(0, 10)}

<!-- Append running observations, open loops, and day-to-day notes here. Promote evergreen facts to MEMORY.md. -->
`;
}

export function getDefaultDreamsScaffold(): string {
  return `# Memory Dreams

<!-- Periodic synthesized patterns from daily notes. Promote durable lessons to MEMORY.md. -->
`;
}

export async function ensureOpenClawMemoryFiles(rootDir: string, date = new Date()): Promise<{ longTermCreated: boolean; dailyCreated: boolean }> {
  const workspacePath = memoryWorkspacePath(rootDir);
  await mkdir(workspacePath, { recursive: true });

  const longTermPath = memoryLongTermPath(rootDir);
  let longTermCreated = false;
  if (!existsSync(longTermPath)) {
    await writeFile(longTermPath, getDefaultLongTermMemoryScaffold(), "utf-8");
    longTermCreated = true;
  }

  const todayPath = dailyMemoryPath(rootDir, date);
  let dailyCreated = false;
  if (!existsSync(todayPath)) {
    await writeFile(todayPath, getDefaultDailyMemoryScaffold(date), "utf-8");
    dailyCreated = true;
  }

  const dreamsPath = memoryDreamsPath(rootDir);
  if (!existsSync(dreamsPath)) {
    await writeFile(dreamsPath, getDefaultDreamsScaffold(), "utf-8");
  }

  return { longTermCreated, dailyCreated };
}

function getMemoryFileLayer(displayPath: string): MemoryFileInfo["layer"] {
  if (displayPath === `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`) return "long-term";
  if (displayPath === `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}`) return "dreams";
  /*
   * FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665):
   * A cold-tier file IS retired long-term content, so it reports the `long-term` layer rather than
   * pretending to be a daily note. The layer union is deliberately NOT widened to `"archive"`: it is a
   * published field that the dashboard re-declares in `app/api/system/memory.ts` and sorts by in two
   * places, and a new value there buys no honesty this label already carries. The LABEL is where the
   * distinction belongs, and it says what the file is.
   */
  if (isArchiveMemoryFileName(basename(displayPath))) return "long-term";
  return "daily";
}

function getMemoryFileLabel(displayPath: string): string {
  if (isArchiveMemoryFileName(basename(displayPath))) return "Archived long-term memory";
  const layer = getMemoryFileLayer(displayPath);
  if (layer === "long-term") return "Long-term memory";
  if (layer === "dreams") return "Dreams";
  return `Daily notes ${basename(displayPath, ".md")}`;
}

function getAgentMemoryFileLayer(fileName: string): MemoryFileInfo["layer"] {
  if (fileName === MEMORY_LONG_TERM_FILENAME) return "long-term";
  if (fileName === MEMORY_DREAMS_FILENAME) return "dreams";
  if (isArchiveMemoryFileName(fileName)) return "long-term";
  return "daily";
}

function getAgentMemoryFileLabel(fileName: string): string {
  if (isArchiveMemoryFileName(fileName)) return "Archived long-term memory";
  const layer = getAgentMemoryFileLayer(fileName);
  if (layer === "long-term") return "Long-term memory";
  if (layer === "dreams") return "Dreams";
  return `Daily notes ${basename(fileName, ".md")}`;
}

export async function listProjectMemoryFiles(rootDir: string, date = new Date()): Promise<MemoryFileInfo[]> {
  await ensureOpenClawMemoryFiles(rootDir, date);
  const files = await listMemoryFiles(rootDir);
  const uniqueFiles = Array.from(new Map(files.map((file) => [file.displayPath, file])).values());
  const infos = await Promise.all(uniqueFiles.map(async (file) => {
    const fileStat = await stat(file.absPath);
    return {
      path: file.displayPath,
      label: getMemoryFileLabel(file.displayPath),
      layer: getMemoryFileLayer(file.displayPath),
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    } satisfies MemoryFileInfo;
  }));

  const order: Record<MemoryFileInfo["layer"], number> = {
    "long-term": 0,
    daily: 1,
    dreams: 2,
  };
  return infos.sort((a, b) => order[a.layer] - order[b.layer] || b.path.localeCompare(a.path));
}

export async function readProjectMemoryFile(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
  return getMemoryFile(rootDir, options, "file");
}

export async function readProjectMemoryFileContent(rootDir: string, path: string): Promise<{ path: string; content: string }> {
  const { absPath, displayPath } = resolveMemoryFilePath(rootDir, path, { allowArchive: true });
  try {
    const content = await readFile(absPath, "utf-8");
    return { path: displayPath, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBackendError("NOT_FOUND", `Memory path '${path}' not found`, "file");
    }
    throw new MemoryBackendError("READ_FAILED", `Failed to read memory path '${path}': ${(err as Error).message}`, "file");
  }
}

export async function writeProjectMemoryFile(rootDir: string, path: string, content: string): Promise<MemoryWriteResult> {
  const { absPath } = resolveMemoryFilePath(rootDir, path);
  await mkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, absPath);

  return { success: true, backend: "file" };
}

export async function listAgentMemoryFiles(rootDir: string, agentId: string, date = new Date()): Promise<MemoryFileInfo[]> {
  const { agentMemoryWorkspacePath, ensureAgentMemoryFiles } = await import("./memory-dreams.js");

  await ensureAgentMemoryFiles(rootDir, { id: agentId, name: "", memory: "" }, date);

  const workspacePath = agentMemoryWorkspacePath(rootDir, agentId);
  const workspaceDisplayPath = relative(rootDir, workspacePath).replace(/\\/g, "/");
  const files: Array<{ absPath: string; displayPath: string; fileName: string }> = [];

  const longTermPath = join(workspacePath, MEMORY_LONG_TERM_FILENAME);
  if (existsSync(longTermPath)) {
    files.push({
      absPath: longTermPath,
      displayPath: `${workspaceDisplayPath}/${MEMORY_LONG_TERM_FILENAME}`,
      fileName: MEMORY_LONG_TERM_FILENAME,
    });
  }

  const dreamsPath = join(workspacePath, MEMORY_DREAMS_FILENAME);
  if (existsSync(dreamsPath)) {
    files.push({
      absPath: dreamsPath,
      displayPath: `${workspaceDisplayPath}/${MEMORY_DREAMS_FILENAME}`,
      fileName: MEMORY_DREAMS_FILENAME,
    });
  }

  if (existsSync(workspacePath)) {
    for (const entry of await readdir(workspacePath)) {
      // FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665): cold-tier archives are listed beside dailies, so
      // a retired agent note stays reachable in the same surface that listed it while it was hot.
      if (!DAILY_MEMORY_RE.test(entry) && !isArchiveMemoryFileName(entry)) continue;
      const absPath = join(workspacePath, entry);
      const fileStat = await stat(absPath);
      if (fileStat.isFile()) {
        files.push({
          absPath,
          displayPath: `${workspaceDisplayPath}/${entry}`,
          fileName: entry,
        });
      }
    }
  }

  const uniqueFiles = Array.from(new Map(files.map((file) => [file.displayPath, file])).values());
  const infos = await Promise.all(uniqueFiles.map(async (file) => {
    const fileStat = await stat(file.absPath);
    return {
      path: file.displayPath,
      label: getAgentMemoryFileLabel(file.fileName),
      layer: getAgentMemoryFileLayer(file.fileName),
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    } satisfies MemoryFileInfo;
  }));

  const order: Record<MemoryFileInfo["layer"], number> = {
    "long-term": 0,
    daily: 1,
    dreams: 2,
  };

  return infos.sort((a, b) => order[a.layer] - order[b.layer] || b.path.localeCompare(a.path));
}

async function resolveAgentMemoryFilePath(
  rootDir: string,
  agentId: string,
  requestedPath: string,
  options: { allowArchive?: boolean } = {},
): Promise<{ absPath: string; displayPath: string }> {
  /*
   * FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665):
   * Same read/write asymmetry as the project lane: `readAgentMemoryFile` passes `allowArchive`, the
   * write lane does not, so the cold tier stays the append-only record it claims to be while remaining
   * fully readable. Below this point every existing guard is untouched — traversal, absolute path, the
   * workspace-prefix containment, and the no-subdirectories rule all still apply, which is why the cold
   * tier is a flat sibling file and not `archive/…`: a subdirectory here would be refused by the rule on
   * line ~871 and a retired note would be unreachable for the agent that wrote it.
   */
  const allowArchive = options.allowArchive === true;
  const { agentMemoryWorkspacePath } = await import("./memory-dreams.js");
  const workspacePath = agentMemoryWorkspacePath(rootDir, agentId);
  const workspaceDisplayPath = relative(rootDir, workspacePath).replace(/\\/g, "/");
  const workspacePrefix = `${workspaceDisplayPath}/`;

  const trimmed = requestedPath.trim();
  if (!trimmed) {
    throw new MemoryBackendError("NOT_FOUND", "Memory path is required", "file");
  }
  if (isAbsolute(trimmed) || isPathTraversal(trimmed)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory paths must be workspace-relative", "file");
  }

  const normalized = normalize(trimmed).replace(/\\/g, "/");
  const fileName = basename(normalized);
  if (
    fileName !== MEMORY_LONG_TERM_FILENAME
    && fileName !== MEMORY_DREAMS_FILENAME
    && !DAILY_MEMORY_RE.test(fileName)
    && !(allowArchive && isArchiveMemoryFileName(fileName))
  ) {
    throw new MemoryBackendError(
      "UNSUPPORTED",
      `Memory path '${requestedPath}' is outside allowed files: ${AGENT_MEMORY_WORKSPACE_PATH}/{agentId}/MEMORY.md, ${AGENT_MEMORY_WORKSPACE_PATH}/{agentId}/DREAMS.md, ${AGENT_MEMORY_WORKSPACE_PATH}/{agentId}/YYYY-MM-DD.md`
      // Same write-lane-only hint as the project scope: name the cold tier to the caller who reached for
      // it, not to a reader whose path was already accepted.
      + (allowArchive ? "" : `; ${AGENT_MEMORY_WORKSPACE_PATH}/{agentId}/ARCHIVE-YYYY-MM-DD.md is the read-only cold tier — retired entries are read with fn_memory_get, never written`),
      "file",
    );
  }

  const displayPath = normalized === fileName
    ? `${workspaceDisplayPath}/${fileName}`
    : normalized;

  if (!displayPath.startsWith(workspacePrefix)) {
    throw new MemoryBackendError(
      "UNSUPPORTED",
      `Memory path '${requestedPath}' must be within ${workspaceDisplayPath}/`,
      "file",
    );
  }

  const absPath = resolve(rootDir, displayPath);
  const rel = relative(rootDir, absPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory path escapes project root", "file");
  }

  const relToWorkspace = relative(workspacePath, absPath);
  if (!relToWorkspace || relToWorkspace.startsWith(`..${sep}`) || relToWorkspace === ".." || isAbsolute(relToWorkspace)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory path escapes agent memory workspace", "file");
  }
  const relToWorkspaceNormalized = relToWorkspace.replace(/\\/g, "/");
  if (relToWorkspaceNormalized.includes("/")) {
    throw new MemoryBackendError("UNSUPPORTED", "Agent memory paths must not include subdirectories", "file");
  }

  return { absPath, displayPath };
}

export async function readAgentMemoryFile(rootDir: string, agentId: string, path: string): Promise<{ path: string; content: string }> {
  const { absPath, displayPath } = await resolveAgentMemoryFilePath(rootDir, agentId, path, { allowArchive: true });

  try {
    const content = await readFile(absPath, "utf-8");
    return { path: displayPath, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBackendError("NOT_FOUND", `Memory path '${path}' not found`, "file");
    }
    throw new MemoryBackendError("READ_FAILED", `Failed to read memory path '${path}': ${(err as Error).message}`, "file");
  }
}

export async function writeAgentMemoryFile(rootDir: string, agentId: string, path: string, content: string): Promise<{ success: boolean }> {
  const { absPath } = await resolveAgentMemoryFilePath(rootDir, agentId, path);
  await mkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, absPath);

  return { success: true };
}

function isPathTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

/**
 * FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665):
 * The cold tier is READABLE through this allowance and NOT WRITABLE through it. Retirement is
 * maintenance's own append-only move; a memory-file API that could overwrite `ARCHIVE-*.md` would let
 * any caller rewrite the verbatim record the whole loss-free contract depends on, while the only lane
 * that genuinely needs the file is the read path — `fn_memory_get` and the follow-up on a search hit are
 * what a retired note must stay reachable through. The accepted shape stays exactly as strict as the
 * writer's, so nothing `archiveMemoryFileName()` could not have produced is let in here.
 */
function normalizeMemoryRequestPath(rawPath: string, options: { allowArchive?: boolean } = {}): string {
  const allowArchive = options.allowArchive === true;
  const isAllowedLeaf = (leaf: string): boolean =>
    leaf === MEMORY_LONG_TERM_FILENAME
    || leaf === MEMORY_DREAMS_FILENAME
    || DAILY_MEMORY_RE.test(leaf)
    || (allowArchive && isArchiveMemoryFileName(leaf));

  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new MemoryBackendError("NOT_FOUND", "Memory path is required", "memory");
  }
  if (isAbsolute(trimmed) || isPathTraversal(trimmed)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory paths must be workspace-relative", "memory");
  }
  const normalized = normalize(trimmed).replace(/\\/g, "/");
  if (
    normalized === MEMORY_LONG_TERM_FILENAME
    || normalized === MEMORY_DREAMS_FILENAME
    || normalized === `memory/${MEMORY_LONG_TERM_FILENAME}`
    || normalized === `memory/${MEMORY_DREAMS_FILENAME}`
  ) {
    return `${MEMORY_WORKSPACE_PATH}/${basename(normalized)}`;
  }
  if (DAILY_MEMORY_RE.test(basename(normalized)) && (normalized === basename(normalized) || normalized.startsWith("memory/"))) {
    return `${MEMORY_WORKSPACE_PATH}/${basename(normalized)}`;
  }
  if (normalized.startsWith(`${MEMORY_WORKSPACE_PATH}/`)) {
    const file = basename(normalized);
    if (isAllowedLeaf(file)) {
      return `${MEMORY_WORKSPACE_PATH}/${file}`;
    }
  }
  throw new MemoryBackendError(
    "UNSUPPORTED",
    `Memory path '${rawPath}' is outside allowed files: .fusion/memory/MEMORY.md, .fusion/memory/DREAMS.md, .fusion/memory/YYYY-MM-DD.md`
    // The cold tier is named ONLY on the write lane, where the caller just tried to write it: there the
    // useful sentence is "that file exists and is read-only", and a caller on the read lane never needs
    // to be told about a path that was just accepted.
    + (allowArchive ? "" : "; .fusion/memory/ARCHIVE-YYYY-MM-DD.md is the read-only cold tier — retired entries are read with fn_memory_get, never written"),
    "memory",
  );
}

function resolveMemoryFilePath(
  rootDir: string,
  requestedPath: string,
  options: { allowArchive?: boolean } = {},
): { absPath: string; displayPath: string } {
  const displayPath = normalizeMemoryRequestPath(requestedPath, options);
  const absPath = resolve(rootDir, displayPath);
  const rel = relative(rootDir, absPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new MemoryBackendError("UNSUPPORTED", "Memory path escapes project root", "memory");
  }
  return { absPath, displayPath };
}

async function getMemoryFile(rootDir: string, options: MemoryGetOptions, backend: string): Promise<MemoryGetResult> {
  // Reads reach the cold tier; the write lane never passes this option (see `normalizeMemoryRequestPath`).
  const { absPath, displayPath } = resolveMemoryFilePath(rootDir, options.path, { allowArchive: true });
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBackendError("NOT_FOUND", `Memory path '${options.path}' not found`, backend);
    }
    throw new MemoryBackendError("READ_FAILED", `Failed to read memory path '${options.path}': ${(err as Error).message}`, backend);
  }

  const lines = content.split("\n");
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const requestedCount = Math.max(1, Math.floor(options.lineCount ?? DEFAULT_MEMORY_GET_LINES));
  const lineCount = Math.min(requestedCount, MAX_MEMORY_GET_LINES);
  const startIndex = Math.min(startLine - 1, lines.length);
  const endIndex = Math.min(startIndex + lineCount, lines.length);

  return {
    path: displayPath,
    content: lines.slice(startIndex, endIndex).join("\n"),
    startLine,
    endLine: endIndex,
    totalLines: lines.length,
    backend,
  };
}

async function listMemoryFiles(rootDir: string): Promise<Array<{ absPath: string; displayPath: string }>> {
  const files: Array<{ absPath: string; displayPath: string }> = [];
  const workspacePath = memoryWorkspacePath(rootDir);
  const longTerm = memoryLongTermPath(rootDir);
  if (existsSync(longTerm)) {
    files.push({ absPath: longTerm, displayPath: `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}` });
  }
  const dreams = memoryDreamsPath(rootDir);
  if (existsSync(dreams)) {
    files.push({ absPath: dreams, displayPath: `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}` });
  }

  if (existsSync(workspacePath)) {
    for (const entry of await readdir(workspacePath)) {
      // Daily notes and cold-tier archives only. The archive branch is what keeps a retired note in the
      // listing, the file-lane search, and the dashboard after budget maintenance moves it out of
      // MEMORY.md; anything else in this directory stays unlisted.
      if (!DAILY_MEMORY_RE.test(entry) && !isArchiveMemoryFileName(entry)) continue;
      const absPath = join(workspacePath, entry);
      const fileStat = await stat(absPath);
      if (fileStat.isFile()) {
        files.push({ absPath, displayPath: `${MEMORY_WORKSPACE_PATH}/${entry}` });
      }
    }
  }

  return files;
}

/*
FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012):
Word-level scoring through the shared matcher. This lane had the identical defect the agent lane
was reported for: its query was split on the ASCII class `/[^a-z0-9_-]+/i`, so a Slovak query lost
or shredded every accented word, and `normalized.includes(term)` then let a 2-character fragment
(`te`, `syst`) score against unrelated English prose. Terms and candidate text are now tokenized
by the SAME core boundary, so a word means the same thing on both sides in any language the
operator writes.
*/
function scoreSnippet(snippet: string, queryTerms: readonly string[]): number {
  return countMemoryTermMatches(snippet, queryTerms);
}

/**
 * Does this project have any readable layered memory content at all?
 *
 * FNXC:MemoryEmptyReason 2026-11-19-04:35 (RUFU-1012):
 * `fn_memory_search` reported a bare "NONE" for three different states — no memory written, a query
 * with no usable words, and a query whose words matched nothing — so an agent could not tell an
 * empty store from a bad query and the operator could not tell either. This is the honest
 * discriminator for the project lane: it reports whether there is content to score, never whether
 * anything matched. Read-only (it uses the same file inventory the scorer walks), non-throwing, and
 * whitespace-only files do not count as content.
 */
export async function hasProjectMemoryContent(rootDir: string): Promise<boolean> {
  try {
    for (const file of await listMemoryFiles(rootDir)) {
      const content = await readFile(file.absPath, "utf-8");
      if (content.trim().length > 0) return true;
    }
    return false;
  } catch {
    // Fail closed to "content may exist": claiming an empty store the reader could not read
    // would be a false statement, so the caller keeps the neutral `no-token-match` reason.
    return true;
  }
}

/*
FNXC:MemoryFileLayerSearch 2026-11-18-17:25 (RUFU-1010):
Exported as a shared seam. The deterministic file scorer was module-private because only the
file/qmd backends called it; RUFU-1010 measured that the Stash index never received the durable
layered memory corpus (write paths refresh only qmd), so the core read seams
(searchProjectMemory, buildProactiveMemoryCueBlock, buildPerTurnMemoryRecallCue) run THIS scorer
as a second lane when the resolved backend is `stash`. Behavior unchanged; only visibility widened.
*/
export async function searchMemoryFiles(rootDir: string, options: MemorySearchOptions, backend: string): Promise<MemorySearchResult[]> {
  const queryTerms = deriveMemoryQueryTerms(options.query);
  if (queryTerms.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const results: MemorySearchResult[] = [];

  for (const file of await listMemoryFiles(rootDir)) {
    const lines = (await readFile(file.absPath, "utf-8")).split("\n");
    /*
    FNXC:MemoryWindowGeometry 2026-11-19-04:35 (RUFU-1012):
    Stride == window (both from the shared constant) instead of 8-over-12: the old geometry made
    adjacent windows share four lines, so one result set carried e.g. `97-108` beside `105-116`.
    The score sort, the limit clamp and MAX_MEMORY_SNIPPET_CHARS below are untouched.
    */
    for (let index = 0; index < lines.length; index += MEMORY_SNIPPET_STRIDE_LINES) {
      const chunkLines = lines.slice(index, index + MEMORY_SNIPPET_WINDOW_LINES);
      const snippet = chunkLines.join("\n").trim();
      if (!snippet) continue;
      const score = scoreSnippet(snippet, queryTerms);
      if (score === 0) continue;
      results.push({
        path: file.displayPath,
        lineStart: index + 1,
        lineEnd: Math.min(index + chunkLines.length, lines.length),
        snippet: snippet.slice(0, MAX_MEMORY_SNIPPET_CHARS),
        score,
        backend,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function normalizeQmdSearchResultPath(rootDir: string, rawPath: unknown): string {
  const original = String(rawPath ?? "").trim();
  if (!original) {
    return "";
  }

  let candidate = original.replace(/\\/g, "/");
  const uriMatch = candidate.match(/^qmd:\/\/[^/]+\/(.+)$/i);
  if (uriMatch?.[1]) {
    candidate = uriMatch[1];
  }

  candidate = candidate.split("?")[0]?.split("#")[0] ?? "";
  candidate = candidate.replace(/^\.\/+/, "");

  if (isAbsolute(candidate)) {
    const rel = relative(resolve(rootDir), resolve(candidate)).replace(/\\/g, "/");
    if (rel && rel !== "." && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
      candidate = rel;
    }
  }

  const lowerCandidate = candidate.toLowerCase();
  const normalizedBaseName = basename(candidate).toLowerCase();
  const normalizedDirName = dirname(lowerCandidate).replace(/\\/g, "/");

  // Map stale indexed top-level memory paths to the canonical layered path so
  // qmd search results stay readable. This does not re-enable legacy read/write
  // requests in runtime APIs.
  if (normalizedBaseName === "memory.md" && (normalizedDirName === ".fusion" || normalizedDirName.endsWith("/.fusion"))) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`;
  }
  if (normalizedBaseName === MEMORY_LONG_TERM_FILENAME.toLowerCase()) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_LONG_TERM_FILENAME}`;
  }
  if (normalizedBaseName === MEMORY_DREAMS_FILENAME.toLowerCase()) {
    return `${MEMORY_WORKSPACE_PATH}/${MEMORY_DREAMS_FILENAME}`;
  }
  if (DAILY_MEMORY_RE.test(normalizedBaseName)) {
    return `${MEMORY_WORKSPACE_PATH}/${normalizedBaseName}`;
  }
  // FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665): an indexed cold-tier hit must resolve to the same
  // canonical path the listing publishes, or a retired note is findable by search and unreadable by get.
  if (isArchiveMemoryFileName(normalizedBaseName)) {
    return `${MEMORY_WORKSPACE_PATH}/${normalizedBaseName}`;
  }

  try {
    return normalizeMemoryRequestPath(candidate, { allowArchive: true });
  } catch {
    return original;
  }
}

async function searchWithQmd(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
  if (shouldSkipBackgroundQmdRefresh()) {
    return [];
  }
  const command = "qmd";
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  try {
    // FNXC:ProjectMemory 2026-07-08-00:00:
    // searchWithQmd used to carry its own inline `promisify(execFile)` copy — a
    // second, un-unref'd executor separate from the hardened default below — to
    // spawn `qmd collection add` and `qmd search`. Even though the search is
    // awaited (unlike the fire-and-forget background refresh fixed by FN-7706), a
    // short-lived caller (e.g. a one-shot CLI memory search) could be held open
    // for up to the 4s awaited timeout: per the documented nextTick re-ref pitfall
    // (see getDefaultExecFileAsync's doc comment / .fusion/memory/MEMORY.md),
    // `promisify(execFile)`'s internal stdout/stderr buffering re-refs the pipe
    // handles on a later tick, so even a manual `.unref()` wouldn't have stuck.
    // Reuse the same hardened, spawn-based, synchronously-unref'd executor FN-7706
    // established for the refresh path instead of carrying a second leaky copy.
    const execFileAsync = await getDefaultExecFileAsync();
    await ensureQmdProjectMemoryCollection(rootDir, execFileAsync);
    scheduleQmdProjectMemoryRefresh(rootDir);
    const args = buildQmdSearchArgs(rootDir, options);
    const { stdout } = await execFileAsync(command, args, {
      cwd: rootDir,
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const rawResults = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    return rawResults
      .slice(0, limit)
      .map((result: Record<string, unknown>, index: number) => {
        const rawPath = result.path ?? result.file ?? `qmd/result-${index + 1}`;
        return {
          path: normalizeQmdSearchResultPath(rootDir, rawPath) || String(rawPath),
          lineStart: Number(result.lineStart ?? result.startLine ?? 1),
          lineEnd: Number(result.lineEnd ?? result.endLine ?? result.startLine ?? 1),
          snippet: String(result.snippet ?? result.text ?? result.content ?? "").slice(
            0,
            MAX_MEMORY_SNIPPET_CHARS,
          ),
          score: Number(result.score ?? 1),
          backend: "qmd",
        };
      })
      .filter((result: MemorySearchResult) => result.snippet.trim().length > 0);
  } catch {
    return [];
  }
}

async function ensureQmdProjectMemoryCollection(
  rootDir: string,
  execFileAsync: ExecFileAsync,
): Promise<string> {
  const collectionName = qmdMemoryCollectionName(rootDir);
  const memoryDir = memoryWorkspacePath(rootDir);
  await mkdir(memoryDir, { recursive: true });

  try {
    await execFileAsync("qmd", buildQmdCollectionAddArgs(rootDir), {
      cwd: rootDir,
      timeout: 4000,
      maxBuffer: 512 * 1024,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = typeof err === "object" && err && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
    if (!/already exists|exists/i.test(`${message}\n${stderr}`)) {
      throw err;
    }
  }

  return collectionName;
}

/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Fire-and-forget background qmd refresh (scheduleQmdProjectMemoryRefresh /
 * scheduleQmdAgentMemoryRefresh / scheduleQmdInstallAndRefresh) must never hold a
 * short-lived caller's event loop open. A repro showed 5 Socket + 1 ChildProcess
 * (`spawnfile: qmd`) handles persisting for the child's full 15-30s runtime, keeping
 * a short-lived Node process (e.g. `fn agent stop <id>`) alive well after its own
 * work finished.
 *
 * `promisify(execFile)` looks like the obvious fix (its returned promise exposes a
 * `.child` ChildProcess we can `.unref()`), but it does NOT stick: execFile's
 * internal stdout/stderr accumulation calls `stream.resume()`, which defers the
 * actual `readStart()` (and an internal re-ref of the pipe handle) to a later
 * `process.nextTick` tick — AFTER our synchronous `unref()` call runs — so the
 * handle silently becomes ref'd again and the process hangs for the child's full
 * runtime regardless of calling `.unref()`. Verified via `process._getActiveHandles()`
 * repro: unref immediately after spawn briefly shows zero active handles, yet the
 * process still doesn't exit until the child does.
 *
 * The reliable fix is to bypass `execFile`'s internal buffering entirely and drive a
 * plain `spawn()` child ourselves: unref the child + its stdio synchronously right
 * after spawn (nothing internal to execFile re-refs them later), and accumulate
 * stdout/stderr via our own `data` listeners. This preserves the `{stdout, stderr}`
 * resolve shape and reject-on-nonzero-exit / reject-on-spawn-error behavior that
 * callers (e.g. `ensureQmdProjectMemoryCollection`'s "already exists" stderr check)
 * depend on, so a long-lived caller that stays alive anyway still sees the refresh
 * resolve/reject normally and complete. This lives only in the DEFAULT real executor;
 * injected mock `execFileAsync` implementations (used by tests) are untouched.
 */
export function unrefQmdChildProcess(childProcessLike: unknown): void {
  if (!childProcessLike || typeof childProcessLike !== "object") {
    return;
  }
  const child = childProcessLike as {
    unref?: () => void;
    stdout?: { unref?: () => void } | null;
    stderr?: { unref?: () => void } | null;
    stdin?: { unref?: () => void } | null;
  };
  child.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.stdin?.unref?.();
}

interface QmdExecError extends Error {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

async function getDefaultExecFileAsync(): Promise<ExecFileAsync> {
  const { spawn } = await import("node:child_process");

  return (file, args, options) =>
    new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(file, args as string[], {
        cwd: options?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      /*
       * FNXC:CliAwaitLiveness 2026-08-11-09:17:
       * Background QMD refreshes must unref their child, but an awaited availability
       * probe must retain its child and stdio until close/error settles. Otherwise a
       * missing `qmd` leaves `fn init`'s top-level await pending with an empty loop,
       * so Node exits 13 before durable project registration.
       */
      if (!options?.keepAlive) {
        unrefQmdChildProcess(child);
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let killedForMaxBuffer = false;
      const maxBuffer = options?.maxBuffer;

      const timeoutHandle = options?.timeout
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, options.timeout)
        : undefined;
      timeoutHandle?.unref?.();

      const checkMaxBuffer = () => {
        if (maxBuffer && !killedForMaxBuffer && (stdout.length > maxBuffer || stderr.length > maxBuffer)) {
          killedForMaxBuffer = true;
          child.kill();
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        checkMaxBuffer();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        checkMaxBuffer();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (code === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }
        const error: QmdExecError = new Error(
          `Command failed: ${file} ${args.join(" ")}\n${stderr || stdout}`,
        );
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      });
    });
}

export async function refreshQmdProjectMemoryIndex(
  rootDir: string,
  options?: { force?: boolean; execFileAsync?: ExecFileAsync },
): Promise<void> {
  const key = resolve(rootDir);
  const now = Date.now();
  const current = qmdRefreshState.get(key);

  if (!options?.force) {
    if (current?.inFlight) {
      return current.inFlight;
    }
    if (current && now - current.lastStartedAt < QMD_REFRESH_INTERVAL_MS) {
      return;
    }
  }

  const promise = (async () => {
    const execFileAsync = options?.execFileAsync ?? await getDefaultExecFileAsync();
    await ensureQmdProjectMemoryCollection(rootDir, execFileAsync);
    await execFileAsync("qmd", ["update"], {
      cwd: rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("qmd", ["embed"], {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  })();

  qmdRefreshState.set(key, { lastStartedAt: now, inFlight: promise });

  try {
    await promise;
  } finally {
    const latest = qmdRefreshState.get(key);
    if (latest?.inFlight === promise) {
      qmdRefreshState.set(key, { lastStartedAt: latest.lastStartedAt });
    }
  }
}

export function scheduleQmdProjectMemoryRefresh(rootDir: string): void {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }

  void refreshQmdProjectMemoryIndex(rootDir).catch(() => {
    // qmd is optional. Search falls back to local file scanning when refresh fails.
  });
}

export async function refreshQmdAgentMemoryIndex(
  rootDir: string,
  agentId: string,
  options?: { force?: boolean; execFileAsync?: ExecFileAsync },
): Promise<void> {
  const key = `${resolve(rootDir)}:${agentId}`;
  const now = Date.now();
  const current = qmdAgentRefreshState.get(key);

  if (!options?.force) {
    if (current?.inFlight) {
      return current.inFlight;
    }
    if (current && now - current.lastStartedAt < QMD_REFRESH_INTERVAL_MS) {
      return;
    }
  }

  const promise = (async () => {
    const execFileAsync = options?.execFileAsync ?? await getDefaultExecFileAsync();
    const { agentMemoryWorkspacePath } = await import("./memory-dreams.js");
    const workspacePath = agentMemoryWorkspacePath(rootDir, agentId);
    await mkdir(workspacePath, { recursive: true });

    try {
      await execFileAsync("qmd", ["collection", "add", workspacePath, "--name", qmdAgentMemoryCollectionName(rootDir, agentId), "--mask", "**/*.md"], {
        cwd: rootDir,
        timeout: 4000,
        maxBuffer: 512 * 1024,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = typeof err === "object" && err && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
      if (!/already exists|exists/i.test(`${message}\n${stderr}`)) {
        throw err;
      }
    }

    await execFileAsync("qmd", ["update"], { cwd: rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("qmd", ["embed"], { cwd: rootDir, timeout: 120_000, maxBuffer: 1024 * 1024 });
  })();

  qmdAgentRefreshState.set(key, { lastStartedAt: now, inFlight: promise });

  try {
    await promise;
  } finally {
    const latest = qmdAgentRefreshState.get(key);
    if (latest?.inFlight === promise) {
      qmdAgentRefreshState.set(key, { lastStartedAt: latest.lastStartedAt });
    }
  }
}

export function scheduleQmdAgentMemoryRefresh(rootDir: string, agentId: string): void {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }

  void refreshQmdAgentMemoryIndex(rootDir, agentId).catch(() => {
    // qmd is optional. Search falls back to local file scanning when refresh fails.
  });
}

export async function isQmdAvailable(): Promise<boolean> {
  try {
    const execFileAsync = await getDefaultExecFileAsync();
    await execFileAsync("qmd", ["--help"], {
      timeout: 3000,
      maxBuffer: 128 * 1024,
      keepAlive: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function installQmd(
  options?: { execFileAsync?: ExecFileAsync },
): Promise<boolean> {
  const execFileAsync = options?.execFileAsync ?? await getDefaultExecFileAsync();
  const [command, ...args] = QMD_INSTALL_COMMAND.split(" ");
  if (!command || args.length === 0) {
    throw new MemoryBackendError("BACKEND_UNAVAILABLE", "qmd install command is not configured", "qmd");
  }
  await execFileAsync(command, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return true;
}

export async function ensureQmdInstalled(
  options?: {
    execFileAsync?: ExecFileAsync;
    isAvailable?: () => Promise<boolean>;
  },
): Promise<boolean> {
  const checkAvailable = options?.isAvailable ?? isQmdAvailable;
  if (await checkAvailable()) {
    return true;
  }

  if (!qmdInstallPromise) {
    qmdInstallPromise = installQmd({ execFileAsync: options?.execFileAsync })
      .then(async () => checkAvailable())
      .finally(() => {
        qmdInstallPromise = null;
      });
  }

  return qmdInstallPromise;
}

export async function ensureQmdInstalledAndRefresh(rootDir: string): Promise<void> {
  const available = await ensureQmdInstalled();
  if (available) {
    await refreshQmdProjectMemoryIndex(rootDir, { force: true });
  }
}

export function scheduleQmdInstallAndRefresh(rootDir: string): void {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }

  void ensureQmdInstalledAndRefresh(rootDir).catch(() => {
    // qmd remains optional at runtime. Search falls back to local file scanning.
  });
}

// ── Backend Registration ─────────────────────────────────────────────

/**
 * File-based backend instance (shared across registry operations).
 */
const fileBackendInstance = new FileMemoryBackend();

// Register built-in backends
backendRegistry.set("file", fileBackendInstance);
backendRegistry.set("readonly", new ReadOnlyMemoryBackend());
backendRegistry.set("qmd", new QmdMemoryBackend());
// FNXC:StashBackend 2026-08-05-16:06: (RUFU-068) register the Stash backend so
// resolving with memoryBackendType="stash" returns it and it appears in
// listMemoryBackendTypes(). The shared default instance picks up per-project
// stashUrl/stashApiKey via resolveMemoryBackend's materialization branch below.
backendRegistry.set("stash", new StashMemoryBackend());

/**
 * Register a new memory backend.
 * @param backend - The backend to register
 */
export function registerMemoryBackend(backend: MemoryBackend): void {
  backendRegistry.set(backend.type, backend);
}

/**
 * Get a registered memory backend by type.
 * @param type - The backend type
 * @returns The backend instance, or undefined if not found
 */
export function getMemoryBackend(type: string): MemoryBackend | undefined {
  return backendRegistry.get(type);
}

/**
 * List all registered backend types.
 * @returns Array of backend type identifiers
 */
export function listMemoryBackendTypes(): string[] {
  return Array.from(backendRegistry.keys());
}

// ── Settings Keys ────────────────────────────────────────────────────

/**
 * Settings keys related to memory backend selection.
 */
export const MEMORY_BACKEND_SETTINGS_KEYS = {
  /** Backend type to use (default: "file") */
  MEMORY_BACKEND_TYPE: "memoryBackendType",
} as const;

/**
 * Default memory backend type.
 */
export const DEFAULT_MEMORY_BACKEND = "qmd";

// ── Type for Settings ───────────────────────────────────────────────

/**
 * Type for settings that can be used with memory backend resolution.
 * Uses a generic constraint to accept any object with string indexing.
 */
type MemorySettings = {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
};

// ── Resolution Functions ─────────────────────────────────────────────

/**
 * Resolve the appropriate memory backend based on settings.
 *
 * @param settings - Project settings object
 * @returns The memory backend to use, defaulting to DEFAULT_MEMORY_BACKEND (qmd)
 */
export function resolveMemoryBackend(settings?: MemorySettings): MemoryBackend {
  const backendType = (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) || DEFAULT_MEMORY_BACKEND;
  const backend = backendRegistry.get(backendType);
  if (backend) {
    // FNXC:StashConfig 2026-08-05-16:06: (RUFU-068) Stash's server URL and
    // optional per-project API key are per-project operational settings, not
    // baked-in constants. When stashUrl/stashApiKey are set, materialize a
    // fresh StashMemoryBackend bound to them so search/write/capture/health
    // target the configured instance; otherwise fall through to the shared
    // default instance. The API key never sits in settings as plaintext after
    // write — callers thread the resolved key through at construction time;
    // here we carry whatever value is present on the settings object.
    if (backend instanceof StashMemoryBackend) {
      const url = settings?.["stashUrl"];
      const key = settings?.["stashApiKey"];
      const baseUrl = typeof url === "string" && url.trim().length > 0 ? url.trim() : DEFAULT_STASH_URL;
      const apiKey = typeof key === "string" ? key : "";
      // FNXC:Rufu126VectorSearch 2026-08-19-10:50:
      // RUFU-126 (D3): thread the opt-in vector (semantic) search flag from
      // project settings into the materialized backend. Strict `=== true` —
      // undefined/false/any other value keeps the keyword-only baseline.
      // The shared registry default instance (above) stays vector-disabled.
      const vectorSearch = settings?.["stashVectorSearch"] === true;
      return new StashMemoryBackend({ baseUrl, apiKey, vectorSearch });
    }
    return backend;
  }
  // Fall back to the default (qmd) backend if the configured type is unknown
  return backendRegistry.get(DEFAULT_MEMORY_BACKEND)!;
}

/**
 * Get memory backend capabilities based on settings.
 *
 * @param settings - Project settings object
 * @returns The capabilities of the resolved backend
 */
export function getMemoryBackendCapabilities(settings?: MemorySettings): MemoryBackendCapabilities {
  return resolveMemoryBackend(settings).capabilities;
}

// ── Convenience Functions ────────────────────────────────────────────

/**
 * Read memory using the configured backend.
 * Returns empty content if backend is not readable or file doesn't exist.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to memory content
 */
export async function readMemory(
  rootDir: string,
  settings?: MemorySettings,
  /**
   * RUFU-994: the store behind the ONE Stash key resolver (`resolveStashMemorySettings`).
   * `GET /api/memory` went through here with raw settings, so a Stash-backed project reported
   * empty memory content on the operator's own memory screen while capture kept succeeding.
   */
  secretsReader?: StashSecretsReader,
): Promise<MemoryReadResult> {
  const backend = resolveMemoryBackend(
    secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings,
  );
  try {
    return await backend.read(rootDir);
  } catch (err) {
    if (err instanceof MemoryBackendError) {
      // For readable backends that fail, return empty content
      if (err.code === "READ_FAILED" || err.code === "BACKEND_UNAVAILABLE") {
        return {
          content: "",
          exists: false,
          backend: backend.type,
        };
      }
    }
    throw err;
  }
}

/**
 * Write memory using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param content - Content to write
 * @param settings - Project settings
 * @returns Promise resolving to write result
 * @throws MemoryBackendError if backend is not writable
 */
export async function writeMemory(
  rootDir: string,
  content: string,
  settings?: MemorySettings,
  /** RUFU-994: same reader, so the memory screen's save path authenticates like its read path. */
  secretsReader?: StashSecretsReader,
): Promise<MemoryWriteResult> {
  const backend = resolveMemoryBackend(
    secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings,
  );

  if (!backend.capabilities.writable) {
    throw new MemoryBackendError(
      "READ_ONLY",
      `Backend '${backend.type}' does not support writing`,
      backend.type,
    );
  }

  return backend.write(rootDir, content);
}

/**
 * Check if memory exists using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to true if memory exists
 */
export async function memoryExists(
  rootDir: string,
  settings?: MemorySettings,
  /** RUFU-994: `exists()` is a Stash read (the empty-query search probe) and needs the credential. */
  secretsReader?: StashSecretsReader,
): Promise<boolean> {
  const backend = resolveMemoryBackend(
    secretsReader ? await resolveStashMemorySettings(secretsReader, settings) : settings,
  );

  if (backend.exists) {
    return backend.exists(rootDir);
  }

  // Fall back to read operation
  try {
    const result = await backend.read(rootDir);
    return result.exists;
  } catch {
    return false;
  }
}

/**
 * Best-effort capture of session events into the configured memory backend.
 *
 * FNXC:StashCaptureSeam 2026-08-05-16:06:
 * Deterministic, non-LLM, never blocks (modeled on
 * AgentReflectionService.captureTaskPerformance, FN-7528). This is the engine's
 * harness-agnostic session-capture seam: it no-ops unless memory is enabled AND
 * the resolved backend implements the optional `capture` seam. It NEVER throws
 * and NEVER persists capture content to the run-audit (FN-7158 rule: content
 * goes to the backend only; only ids/counts might be surfaced by the caller).
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @param sessionId - Capturing engine session id (e.g. `fusion-<taskId>-<hash>`)
 * @param events - Capture events to write
 * @param meta - Optional task/project context tagged on the events
 */
export async function captureMemory(
  rootDir: string,
  settings: MemorySettings | undefined,
  sessionId: string,
  events: MemoryCaptureEvent[],
  meta?: {
    taskId?: string;
    projectRoot?: string;
    /**
     * FNXC:RUFU121CaptureIdentity 2026-08-18-19:53:
     * RUFU-121: project/chat identity forwarded to backend.capture for
     * session-folder classification and metadata enrichment.
     */
    projectId?: string;
    projectName?: string;
    chatTitle?: string;
  },
): Promise<MemoryCaptureResult> {
  if (settings?.memoryEnabled === false) {
    return { ok: false, inserted: 0, deduped: 0 };
  }
  /*
  FNXC:StashCaptureFacadeOrder 2026-08-21-13:35:
  RUFU-146 review (PRRT_kwDOSA-8Y86a7RZi): an enabled capture with an EMPTY
  event list is a successful no-op, not a failure — return ok:true BEFORE
  backend resolution so no transport/secret resolution runs at all. The
  backend gate is `!backend.capture` only: endSession is an OPTIONAL seam
  (MemoryBackend.endSession is optional; stateless backends like stash
  implement it as a no-op but its absence must not block capture), and
  treating its absence as a failure previously dropped every capture on
  backends without an explicit endSession.
  */
  if (!events || events.length === 0) {
    return { ok: true, inserted: 0, deduped: 0 };
  }
  const backend = resolveMemoryBackend(settings);
  if (!backend.capture) {
    // Backend doesn't implement the capture seam -> no-op.
    return { ok: false, inserted: 0, deduped: 0 };
  }
  try {
    return await backend.capture(sessionId, events, {
      taskId: meta?.taskId,
      projectRoot: meta?.projectRoot ?? rootDir,
      // FNXC:RUFU121CaptureIdentity 2026-08-18-19:53: forward identity only when present.
      ...(meta?.projectId ? { projectId: meta.projectId } : {}),
      ...(meta?.projectName ? { projectName: meta.projectName } : {}),
      ...(meta?.chatTitle ? { chatTitle: meta.chatTitle } : {}),
    });
  } catch {
    // Capture must never block or fail a run.
    return { ok: false, inserted: 0, deduped: 0 };
  }
}
