/**
 * Cursor CLI discovery → model-picker mapping, behind a short-TTL,
 * single-flight cache so `/api/models` never spawns the `cursor-agent` CLI
 * per request.
 *
 * FNXC:ModelCatalog 2026-07-08-00:00:
 * FN-7696: With the Cursor Runtime plugin installed and the "Cursor — via
 * Cursor CLI" provider toggle enabled (`useCursorCli === true`), Cursor
 * models never appeared in Fusion's model picker. `discoverCursorProviderModels`
 * (the plugin's `cliProviders[].discoverModels` contribution, which spawns
 * `cursor-agent models --json` with text/`model list` fallbacks) was never
 * called by the dashboard. This module owns two contracts, mirroring the
 * landed Hermes pattern (FN-7636, see hermes-model-cache.ts):
 *   1. A deterministic discovery→model-id mapping (id = discovered id; name
 *      = label ?? id) so picker selections remain stable across requests.
 *   2. A per-binaryPath TTL cache (default 60s) with single-flight
 *      de-duplication of concurrent in-flight fetches, so parallel
 *      `/api/models` requests spawn `cursor-agent` at most once per TTL
 *      window.
 * A missing/failed/unavailable `cursor-agent` binary (ENOENT, non-zero exit,
 * timeout, keychain locked, no Cursor IDE) must degrade to an empty model
 * list — never throw — so `/api/models` always returns HTTP 200 with
 * existing rows intact. The empty result is cached briefly too, so a
 * persistently-unavailable binary does not turn into a spawn-per-request
 * storm. Unlike Hermes (whose profile presence IS the enable signal), Cursor
 * has its own settings toggle (`useCursorCli`); the toggle gate lives in the
 * `/api/models` merge site (register-model-routes.ts), not in this module.
 *
 * FN-7700: `reasoning`/`contextWindow` are now source-driven, not hardcoded.
 * `cursorDiscoveryToModels` reads `entry.reasoning`/`entry.contextWindow`
 * when the discovery pipeline reports them (structured JSON `cursor-agent`
 * output only — the real, plain-text CLI never reports them today), and
 * falls back to `false`/`0` otherwise. This mirrors the still-deferred
 * Hermes enrichment gap noted below; do not change Hermes behavior here.
 */

import { discoverCursorCliModels } from "./runtime-provider-probes.js";
import { registerBoundedWindowMap } from "./lib/retention/bounded-window-map.js";

/** Stable model-picker row shape emitted for a Cursor-discovered model. */
export interface CursorPickerModel {
  provider: "cursor-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** The picker provider id used for all Cursor-derived model rows. */
export const CURSOR_PICKER_PROVIDER_ID = "cursor-cli" as const;

/** Default cache TTL for Cursor model discovery, in milliseconds. */
const DEFAULT_TTL_MS = 60_000;

/**
 * FNXC:ModelCatalog 2026-07-08-00:00:
 * FN-7710: A transient cold-start empty/unavailable discovery result (e.g. the
 * `cursor-agent` binary racing keychain/IDE warm-up right after the provider is toggled on)
 * was previously cached for the full `DEFAULT_TTL_MS` (60s), same as a real successful
 * result — so a first-load empty could persist for a minute even after the CLI became
 * available. Empty/unavailable results now use this much shorter negative TTL so a
 * transient cold-start empty self-heals quickly, while a non-empty successful discovery
 * keeps using the normal 60s TTL. Single-flight and never-throw/never-spawn-per-request
 * guarantees are unchanged — only how long an empty result is trusted.
 */
const EMPTY_RESULT_TTL_MS = 5_000;

/**
 * Map Cursor CLI discovery output into the stable `/api/models` row shape.
 *
 * The discovered `id` is used as the stable model id (it is the CLI's own
 * unique identifier, e.g. `"cursor/gpt-5"`). `name` falls back to `id` when
 * no `label` is provided.
 *
 * FN-7700: `reasoning`/`contextWindow` are source-driven — when the discovery
 * entry reports them (structured JSON `cursor-agent` output only), they are
 * carried through verbatim; otherwise they default to `false`/`0`, exactly
 * as before. This is pass-through only: never fabricated, never parsed from
 * free-text labels.
 *
 * Discovered entries that map to the same id are de-duplicated, keeping the
 * first occurrence.
 */
export function cursorDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string; reasoning?: boolean; contextWindow?: number }>,
): CursorPickerModel[] {
  const seen = new Set<string>();
  const result: CursorPickerModel[] = [];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    result.push({
      provider: CURSOR_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow ?? 0,
    });
  }

  return result;
}

interface CacheEntry {
  /** Timestamp (ms) at which this entry was populated. */
  fetchedAt: number;
  /** The resolved (possibly empty, on failure/unavailability) model list. */
  models: CursorPickerModel[];
  /** The TTL that applies to this specific entry (short for empty results; see FN-7710). */
  ttlMs: number;
}

/** Per-binaryPath cache of the most recently resolved Cursor picker models. */
const cache = new Map<string, CacheEntry>();

/** Per-binaryPath in-flight fetch promise, for single-flight de-duplication. */
/*
FNXC:RetentionCensus 2026-09-23-09:25 (RUFU-257):
`inFlight` is a single-flight lease, not a cache: every `set` is matched by a `delete` in the fetch's
`finally` block, so its cardinality is concurrent `/api/models` fetches for the cursor CLI (at
most one per binary path), never cumulative traffic. The retention ratchet classifies it as
owner-deleted.
*/
// retention-owner-deleted: single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.
const inFlight = new Map<string, Promise<CursorPickerModel[]>>();

/*
FNXC:RetentionCensus 2026-09-23-09:25 (RUFU-257):
This picker cache expires per entry but carried no count ceiling and no byte attribution, so its
footprint was invisible on `/metrics` — one of the seven OOM crashes had no attribution to read.
Registering it supplies a reclamation owner for entries the read path ALREADY treats as stale
(`now - fetchedAt >= ttlMs`, including the short negative TTL for empty results) while
`evictLiveEntries: false` guarantees no hit a `/api/models` caller would still be served is dropped.
The ceiling names the key space: one entry per resolved CLI binary path, which grows when an operator
configures more binaries or credential instances, not with request traffic.
*/
const MAX_CACHED_PICKER_BINARIES = 32;

/** Approximate bytes of one picker row (`provider`/`id`/`name` plus two numerics). */
const PICKER_MODEL_APPROX_BYTES = 200;

registerBoundedWindowMap<string, CacheEntry>({
  id: "cursor_picker_models",
  map: cache,
  ceiling: MAX_CACHED_PICKER_BINARIES,
  ceilingConstant: "MAX_CACHED_PICKER_BINARIES",
  expiryOf: (entry) => entry.fetchedAt + entry.ttlMs,
  valueBytes: (entry) => entry.models.length * PICKER_MODEL_APPROX_BYTES,
  evictLiveEntries: false,
});


/**
 * Reset all cached/in-flight state. Test-only escape hatch — production code
 * should never need this since entries expire naturally via TTL.
 */
export function __resetCursorPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetCursorPickerModelsOptions {
  /** Override the Cursor CLI binary path. Defaults to `"cursor-agent"`. */
  binaryPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the Cursor CLI binary path: explicit override, then the bare
 * `"cursor-agent"` command (resolved via PATH by the CLI spawn layer). The
 * Cursor plugin's own probe layer has no dedicated binary-path env var
 * convention (unlike Hermes's `HERMES_BIN`), so none is consulted here.
 */
function resolveBinaryPath(explicit?: string): string {
  return explicit ?? "cursor-agent";
}

/**
 * Fetch Cursor CLI-discovered models for the model picker, behind a
 * short-TTL, single-flight cache keyed by binary path.
 *
 * Never throws: a `discoverCursorCliModels` failure or an unavailable-binary
 * result (empty models + `fallbackUsed: true`) resolves to `[]`, which is
 * itself cached briefly (same TTL) so a persistently-unavailable binary does
 * not spawn the CLI on every call.
 */
export async function getCursorPickerModels(
  opts?: GetCursorPickerModelsOptions,
): Promise<CursorPickerModel[]> {
  const binaryPath = resolveBinaryPath(opts?.binaryPath);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < cached.ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<CursorPickerModel[]> => {
    try {
      const result = await discoverCursorCliModels({ binaryPath });
      if (!result || result.models.length === 0) {
        return [];
      }
      return cursorDiscoveryToModels(result.models);
    } catch {
      // Degrade to zero Cursor rows on any spawn/parse failure (ENOENT,
      // non-zero exit, timeout, keychain locked) — never let a Cursor error
      // propagate into /api/models. See FNXC:ModelCatalog comment above.
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);

  try {
    const models = await fetchPromise;
    // FN-7710: empty/unavailable results use a short negative TTL so a
    // transient cold-start empty self-heals quickly instead of persisting
    // for the full 60s TTL (see FNXC:ModelCatalog comment above).
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
