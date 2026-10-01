/**
 * OMP CLI discovery → model-picker mapping, behind a short-TTL single-flight cache.
 *
 * FNXC:OmpAcp 2026-07-13-22:50:
 * Mirrors grok-model-cache / cursor-model-cache. When useOmpCli is true, surface
 * models from `omp models` under provider id `omp-cli`. Never throws; empty on failure.
 */

import { discoverOmpCliModels } from "./runtime-provider-probes.js";
import { registerBoundedWindowMap } from "./lib/retention/bounded-window-map.js";

export interface OmpPickerModel {
  provider: "omp-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

export const OMP_PICKER_PROVIDER_ID = "omp-cli" as const;

const DEFAULT_TTL_MS = 60_000;
const EMPTY_RESULT_TTL_MS = 5_000;

export function ompDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string }>,
): OmpPickerModel[] {
  const seen = new Set<string>();
  const result: OmpPickerModel[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      provider: OMP_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: false,
      contextWindow: 0,
    });
  }
  return result;
}

interface CacheEntry {
  fetchedAt: number;
  models: OmpPickerModel[];
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
/*
FNXC:RetentionCensus 2026-09-23-09:25 (RUFU-257):
`inFlight` is a single-flight lease, not a cache: every `set` is matched by a `delete` in the fetch's
`finally` block, so its cardinality is concurrent `/api/models` fetches for the omp CLI (at
most one per binary path), never cumulative traffic. The retention ratchet classifies it as
owner-deleted.
*/
// retention-owner-deleted: single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.
const inFlight = new Map<string, Promise<OmpPickerModel[]>>();

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
  id: "omp_picker_models",
  map: cache,
  ceiling: MAX_CACHED_PICKER_BINARIES,
  ceilingConstant: "MAX_CACHED_PICKER_BINARIES",
  expiryOf: (entry) => entry.fetchedAt + entry.ttlMs,
  valueBytes: (entry) => entry.models.length * PICKER_MODEL_APPROX_BYTES,
  evictLiveEntries: false,
});


export function __resetOmpPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetOmpPickerModelsOptions {
  binaryPath?: string;
  ttlMs?: number;
  now?: () => number;
}

export async function getOmpPickerModels(
  opts?: GetOmpPickerModelsOptions,
): Promise<OmpPickerModel[]> {
  const binaryPath = opts?.binaryPath ?? "omp";
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < cached.ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) return existingInFlight;

  const fetchPromise = (async (): Promise<OmpPickerModel[]> => {
    try {
      const result = await discoverOmpCliModels({ binaryPath });
      if (!result || result.models.length === 0) return [];
      return ompDiscoveryToModels(result.models);
    } catch {
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);
  try {
    const models = await fetchPromise;
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
