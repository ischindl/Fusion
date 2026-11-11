/**
 * Machine-local stat sidecar for the knowledge-graph build (RUFU-500).
 *
 * FNXC:KnowledgeGraph 2026-11-11-18:53:
 * An incremental pass used to `readFile` + SHA-256 **every discovered file** even when nothing had changed,
 * because the only reuse signal was the manifest hash, and checking a hash requires the bytes. Measured on a
 * 430-file fixture: a no-op pass that parsed 0 files still read 430 (RUFU-500 Step 1). This sidecar records
 * `size`/`mtimeMs` per path so an unchanged file is decided by one `stat` instead of a read plus a hash,
 * which is what turns "re-walk and re-hash the whole tree" into work proportional to what changed.
 *
 * THE ACCEPTED TRADEOFF, stated once, in the open:
 * - The cache may only ever **skip work**; it can never change graph bytes. Reuse additionally requires that
 *   the committable manifest still carries that exact path with the exact hash the sidecar recorded, so the
 *   sidecar is never the source of truth for content identity -- the manifest is, and it is content-derived.
 * - What it CAN miss: an edit that keeps the byte size identical AND lands inside the filesystem's mtime
 *   resolution (same-second writes on a coarse filesystem, or a tool that restores mtime). That edit is
 *   invisible to `stat`, so the pass reports the file as unchanged. It is a stale-graph risk, not a corrupt-
 *   graph risk, and the bytes stay self-consistent.
 * - Operator escape hatch: `fn knowledge-graph build --force` bypasses the sidecar entirely and re-reads and
 *   re-hashes every discovered file. Any doubt about a graph's freshness is answered by that flag, and any
 *   artifact-load recovery (`missing-artifact` / `invalid-artifact` / `inconsistent-artifact` /
 *   `version-mismatch`) bypasses it implicitly, because reuse requires a manifest entry and recovery drops
 *   the manifest.
 *
 * It is deliberately NOT part of the committable artifact triple: `nodes.json`, `edges.json` and
 * `manifest.json` stay content-derived with no host metadata (see `docs/knowledge-graph.md`), so this file
 * lives beside them, is never read by `loadArtifacts` or `consistent`, and a machine that loses it merely
 * pays for one full pass. Changing `KNOWLEDGE_GRAPH_STAT_CACHE_VERSION` invalidates every existing cache
 * rather than mis-trusting it.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Bumping this makes every on-disk sidecar from an older build read as absent, never as a hit. */
export const KNOWLEDGE_GRAPH_STAT_CACHE_VERSION = 1;

/** Filename of the machine-local sidecar, written directly inside the graph directory. */
export const KNOWLEDGE_GRAPH_STAT_CACHE_FILENAME = "stat-cache.json";

/** One per-file stat record: what a `stat` can answer plus the hash that `stat` is standing in for. */
export type KnowledgeGraphStatEntry = { size: number; mtimeMs: number; hash: string };

export type KnowledgeGraphStatCache = Record<string, KnowledgeGraphStatEntry>;

/** Sidecar path for a graph directory. Kept beside -- never inside -- the committable triple. */
export function statCachePath(graphDir: string): string {
  return resolve(graphDir, KNOWLEDGE_GRAPH_STAT_CACHE_FILENAME);
}

/**
 * Load the sidecar tolerantly: absent, unreadable, unparseable, wrong-typed, or written by another schema
 * version all read as an empty cache. A missing cache costs one full pass; it can never cost correctness, so
 * there is nothing to report and nothing to fail.
 */
export async function loadStatCache(graphDir: string): Promise<KnowledgeGraphStatCache> {
  let text: string;
  try {
    text = await readFile(statCachePath(graphDir), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as { version?: unknown; entries?: unknown };
  if (record.version !== KNOWLEDGE_GRAPH_STAT_CACHE_VERSION) return {};
  if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) return {};
  const cache: KnowledgeGraphStatCache = {};
  for (const [path, raw] of Object.entries(record.entries as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as { size?: unknown; mtimeMs?: unknown; hash?: unknown };
    // A partially corrupt entry degrades to "no entry for this path", which is the read path, not a hit.
    if (typeof entry.size !== "number" || !Number.isFinite(entry.size)) continue;
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) continue;
    if (typeof entry.hash !== "string" || entry.hash.length === 0) continue;
    cache[path] = { size: entry.size, mtimeMs: entry.mtimeMs, hash: entry.hash };
  }
  return cache;
}

/** Deterministic serialization so an idempotent rewrite writes byte-identical bytes and skips the write. */
export function serializeStatCache(entries: KnowledgeGraphStatCache): string {
  const sorted: Record<string, KnowledgeGraphStatEntry> = {};
  for (const path of Object.keys(entries).sort()) sorted[path] = entries[path]!;
  return `${JSON.stringify({ version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION, entries: sorted }, null, 2)}\n`;
}

/**
 * Atomic write (temp + rename), skipping identical bytes. A torn sidecar is impossible by construction, and
 * a lost sidecar is harmless, so every IO error is swallowed: telemetry-free, failure-free, never a build
 * failure. The build already produced its artifacts by the time this runs.
 */
export async function writeStatCache(graphDir: string, entries: KnowledgeGraphStatCache): Promise<boolean> {
  const path = statCachePath(graphDir);
  const content = serializeStatCache(entries);
  try {
    const existing = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === content) return false;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, "utf8");
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether one file may skip its body read. All four conditions must hold, and the manifest is the
 * content authority: a sidecar hit whose manifest hash disagrees is a MISS and the file IS re-read.
 */
export function statCacheMayReuse(
  entry: KnowledgeGraphStatEntry | undefined,
  live: { size: number; mtimeMs: number },
  manifestHash: string | undefined,
): boolean {
  if (!entry || !manifestHash) return false;
  if (entry.size !== live.size) return false;
  if (entry.mtimeMs !== live.mtimeMs) return false;
  return entry.hash === manifestHash;
}
