/**
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Memory client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export function fetchMemory(projectId?: string): Promise<{ content: string }> {
  return api<{ content: string }>(withProjectId("/memory", projectId));
}

export function saveMemory(content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/memory", projectId), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export interface MemoryFileInfo {
  path: string;
  label: string;
  layer: "long-term" | "daily" | "dreams";
  size: number;
  updatedAt: string;
}

export function fetchMemoryFiles(projectId?: string): Promise<{ files: MemoryFileInfo[] }> {
  return api<{ files: MemoryFileInfo[] }>(withProjectId("/memory/files", projectId));
}

export function fetchMemoryFile(path: string, projectId?: string): Promise<{ path: string; content: string }> {
  const query = `path=${encodeURIComponent(path)}`;
  return api<{ path: string; content: string }>(withProjectId(`/memory/file?${query}`, projectId));
}

/*
FNXC:MemorySurfaceTruth 2026-11-18-02:05:
Mirrors the `describeMemoryFileWrite` fields the file-save route now returns. The Memory screen's
Save button posts to `/memory/file` with a path, and that path-scoped write stays in the local
workspace even when the screen reads Stash — so the response has to carry where the bytes landed or
the edit silently disappears on the next load.
*/
export interface MemoryFileWriteTruth {
  /** Always `file`: the per-file editor writes the local memory workspace. */
  storedIn: "file";
  /** Backend the memory screen reads from. */
  configuredBackend: string;
  /** True when the save did not reach the backend the screen reads. */
  diverges: boolean;
  notice: string | null;
}

export function saveMemoryFile(
  path: string,
  content: string,
  projectId?: string,
): Promise<{ success: boolean } & MemoryFileWriteTruth> {
  return api<{ success: boolean } & MemoryFileWriteTruth>(withProjectId("/memory/file", projectId), {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

/**
 * Compact memory content using AI to distill it down to the most important insights.
 * Reads one memory file, compacts it via AI, and writes the result back.
 *
 * FNXC:CodeOrganization 2026-07-17-00:00:
 * Call contract is explicit: first arg is always an optional memory path, second is
 * optional projectId. Do not overload a single string as path-or-projectId — that
 * dropped project scoping for values that did not look like paths (e.g. bare project ids).
 *
 * @param path - Optional memory file path to compact (omit to compact default)
 * @param projectId - Optional project ID for multi-project support
 * @returns Promise resolving to the compacted memory content
 */
export function compactMemory(
  path?: string,
  projectId?: string,
): Promise<{ path?: string; content: string } & Partial<MemoryFileWriteTruth>> {
  return api<{ path?: string; content: string } & Partial<MemoryFileWriteTruth>>(withProjectId("/memory/compact", projectId), {
    method: "POST",
    body: JSON.stringify(path ? { path } : {}),
  });
}

/**
 * Trigger manual memory dream processing.
 * Synthesizes daily notes into dreams and promotes durable lessons to long-term memory.
 *
 * @param projectId - Optional project ID for multi-project support
 * @returns Promise resolving to dream processing result
 */
export function triggerMemoryDreams(projectId?: string): Promise<{
  success: boolean;
  summary?: string;
  dreamsWritten?: boolean;
  longTermUpdatesWritten?: boolean;
  error?: string;
}> {
  return api(withProjectId("/memory/dream", projectId), {
    method: "POST",
  });
}

/** Memory audit report type (mirrors @fusion/core MemoryAuditReport) */
export interface MemoryAuditReport {
  generatedAt: string;
  workingMemory: {
    exists: boolean;
    size: number;
    sectionCount: number;
    lastModified?: string;
  };
  insightsMemory: {
    exists: boolean;
    size: number;
    insightCount: number;
    categories: Record<string, number>;
    lastUpdated?: string;
  };
  extraction: {
    runAt: string;
    success: boolean;
    insightCount: number;
    duplicateCount: number;
    skippedCount: number;
    summary: string;
    error?: string;
  };
  pruning: {
    applied: boolean;
    reason: string;
    sizeDelta: number;
    originalSize: number;
    newSize: number;
  };
  checks: Array<{
    id: string;
    name: string;
    passed: boolean;
    details: string;
  }>;
  health: "healthy" | "warning" | "issues";
}

/**
 * Fetch memory insights content.
 * Returns { content: string | null, exists: boolean }.
 * content is null when no insights file exists yet.
 */
export function fetchMemoryInsights(projectId?: string): Promise<{ content: string | null; exists: boolean }> {
  return api<{ content: string | null; exists: boolean }>(withProjectId("/memory/insights", projectId));
}

/**
 * Save memory insights content.
 * The insights file stores parsed long-term memory grouped by category.
 */
export function saveMemoryInsights(content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/memory/insights", projectId), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

/**
 * Trigger AI-powered insight extraction from working memory.
 * Reads working memory, generates insights via AI, merges/prunes existing insights,
 * and generates an audit report.
 *
 * Returns: { success: boolean, summary: string, insightCount: number, pruned: boolean }
 */
export function triggerInsightExtraction(projectId?: string): Promise<{ success: boolean; summary: string; insightCount: number; pruned: boolean }> {
  return api<{ success: boolean; summary: string; insightCount: number; pruned: boolean }>(withProjectId("/memory/extract", projectId), {
    method: "POST",
  });
}

/**
 * Fetch memory audit report.
 * The audit checks working memory and insights memory state, extraction history,
 * and generates health recommendations.
 */
export function fetchMemoryAudit(projectId?: string): Promise<MemoryAuditReport> {
  return api<MemoryAuditReport>(withProjectId("/memory/audit", projectId));
}

/**
 * Fetch quick memory stats (lightweight, no AI).
 * Useful for dashboard displays showing memory size and insight counts.
 *
 * Returns: { workingMemorySize: number, insightsSize: number, insightsExists: boolean }
 */
export function fetchMemoryStats(projectId?: string): Promise<{ workingMemorySize: number; insightsSize: number; insightsExists: boolean }> {
  return api<{ workingMemorySize: number; insightsSize: number; insightsExists: boolean }>(withProjectId("/memory/stats", projectId));
}

/**
 * Memory backend capabilities returned by the backend status API.
 */
export interface MemoryBackendCapabilities {
  readable: boolean;
  writable: boolean;
  supportsAtomicWrite: boolean;
  hasConflictResolution: boolean;
  persistent: boolean;
}

/**
 * Memory backend status response from GET /api/memory/backend
 */
export interface MemoryBackendStatus {
  /** The effective backend type after runtime resolution */
  currentBackend: string;
  /** Capabilities of the effective backend */
  capabilities: MemoryBackendCapabilities;
  /** List of registered backend types available */
  availableBackends: string[];
  /** Whether the qmd CLI is available on PATH */
  qmdAvailable?: boolean;
  /** Suggested install command when qmd is unavailable */
  qmdInstallCommand?: string;
  /**
   * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
   * What the last Stash read for THIS project cost in dropped rows, or null when this process has
   * read nothing for it. `outcome: "dropped-foreign"` is the operator-relevant class: the server
   * answered, and the answer belonged to another Fusion project on the same Stash account. Counts
   * and one fixed class only - never a URL, a row identifier, or any recalled text. Mirrors
   * `StashReadScope` in `@fusion/core` (the browser bundle keeps its own structural copy, the way
   * `MemorySearchResult` does here).
   */
  stashReadScope?: StashReadScope | null;
}

export interface MemorySearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
}

/**
 * How many rows a Stash read dropped for this project (`0` when there is nothing to report).
 *
 * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008): one predicate shared by both memory surfaces so
 * the Settings section and the Memory view cannot disagree about when the sentence appears; the
 * wording itself is shared by the `memory.stashScopeDropped` key they both call.
 */
export function stashScopeDroppedCount(scope?: StashReadScope | null): number {
  if (!scope) return 0;
  return scope.droppedForeignCount + scope.droppedUnidentifiedCount;
}

/**
 * One Stash read's project-scope accounting (mirrors `StashReadScope` in `@fusion/core`).
 *
 * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008): the closed three-value class plus counts. A
 * Stash read is scoped by OWNER on the server, so per-project isolation is verified client-side and
 * counted here; `matchedCount` is `ownCount` plus both drop counts.
 */
export interface StashReadScope {
  outcome: "all-own" | "dropped-foreign" | "dropped-unidentified";
  matchedCount: number;
  ownCount: number;
  droppedForeignCount: number;
  droppedUnidentifiedCount: number;
  limit: number;
  at: number;
}

export interface MemoryRetrievalTestResult {
  query: string;
  /** Which backend this probe actually asked — the configured one, not always qmd. */
  testedBackend: string;
  qmdAvailable: boolean;
  /** True only when qmd is configured but not installed, so files were read instead. */
  usedFallback: boolean;
  /** Set when the probe could not test what is configured. */
  notice?: string | null;
  /** Last Stash read outcome recorded by real recall paths. */
  stashReadOutcome?: string | null;
  /** Last scoped-read drop counts for this project (see `MemoryBackendStatus.stashReadScope`). */
  stashReadScope?: StashReadScope | null;
  qmdInstallCommand: string;
  results: MemorySearchResult[];
}

export interface QmdInstallResult {
  success: boolean;
  qmdAvailable: boolean;
  qmdInstallCommand: string;
}

/**
 * Fetch the current memory backend status and capabilities.
 * Use this to determine which backend is active and what operations it supports.
 */
export function fetchMemoryBackendStatus(projectId?: string): Promise<MemoryBackendStatus> {
  return api<MemoryBackendStatus>(withProjectId("/memory/backend", projectId));
}

export function installQmd(projectId?: string): Promise<QmdInstallResult> {
  return api<QmdInstallResult>(withProjectId("/memory/install-qmd", projectId), {
    method: "POST",
  });
}

export function testMemoryRetrieval(query: string, projectId?: string): Promise<MemoryRetrievalTestResult> {
  return api<MemoryRetrievalTestResult>(withProjectId("/memory/test", projectId), {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

/** Fetch global (user-level) settings from ~/.fusion/settings.json */
