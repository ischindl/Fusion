/**
 * RUFU-911: the `/metrics` domain fan-out's view of EVERY project the dashboard already serves.
 *
 * The domain sampler used to enumerate `listRegisteredProjectStores()` alone. That cache is the
 * dashboard's SECONDARY project-store cache — it holds only projects some project-scoped route
 * happened to open — so the sampler silently covered a strict subset of the fleet. Measured live on
 * a board with 25 visible projects, `fusion_domain_projects_total` reported 1 and exactly one
 * `fusion_domain_project_running_agents` series existed: an operator reading that panel was told the
 * fleet was idle, which is a worse failure than a missing tile.
 *
 * This module is the fix at the narrowest seam: it assembles the union of the three store sources the
 * server already holds, with the SAME precedence the per-project live-count reader uses
 * (`resolveRunningAgentCountFromOpenStores` in `server.ts`) so the metrics fan-out and the footer /
 * Command-Center count can never disagree about which store answers for a project:
 *
 *   1. an engine-manager-owned engine store (the runtime-facing store),
 *   2. a secondary registered project store,
 *   3. the default in-process store, addressed by the central default project id.
 *
 * Read-only by contract. Like the sampler it feeds, this never opens a store, never starts a watcher,
 * and never starts an engine to answer a scrape: a project with no already-open store contributes
 * nothing. That absence is the honest shape — the sampler must not invent a zero for a project it
 * cannot observe, because "not measured" and "measured idle" are different claims to an operator.
 */

/** The store handle the fan-out reads. Structural, so no `@fusion/*` type cycle is introduced. */
export type ServedStoreHandle = object;

/** The engine-manager slice the registry needs: a synchronous (projectId -> engine) inventory. */
export interface ServedProjectEngineManager {
  getAllEngines?: () => ReadonlyMap<string, { getTaskStore?: () => ServedStoreHandle | undefined }>;
}

/** The default-store address resolver. Async because the central registry owns the default id. */
export type DefaultProjectIdResolver = () => Promise<string | null | undefined>;

export interface ServedProjectStoreRegistryInit {
  /** Engine-manager handle, or `null`/`undefined` for a headless boot with no engines. */
  engineManager?: ServedProjectEngineManager | null;
  /** Secondary registered stores — injected so the caller owns the module dependency. */
  listRegisteredStores?: () => Array<{ projectId: string; store: ServedStoreHandle }>;
  /** The default in-process store, already open at boot and intentionally absent from the cache. */
  defaultStore?: ServedStoreHandle | null;
  /** Resolves the central default project id that addresses `defaultStore`. */
  resolveDefaultProjectId?: DefaultProjectIdResolver;
}

/** One entry of the fan-out: the project id plus the store that answers for it. */
export interface ServedProjectStore {
  projectId: string;
  store: ServedStoreHandle;
}

/**
 * Build the synchronous registry the domain sampler (and its PG-rate probe) reads.
 *
 * The registry contract is synchronous because the sampler's tick must not await on a project
 * lookup, so the central default project id — the one async fact in the union — is cached on first
 * sight and refreshed on a bounded, self-guarded background re-resolve. A resolver that throws,
 * hangs, or never answers degrades to "no default entry" and can never break a scrape.
 */
export function createServedProjectStoreRegistry(
  init: ServedProjectStoreRegistryInit = {},
): () => ServedProjectStore[] {
  const { engineManager, listRegisteredStores, defaultStore, resolveDefaultProjectId } = init;
  let cachedDefaultProjectId: string | null = null;
  let defaultIdRequested = false;

  function kickDefaultIdResolve(): void {
    if (defaultIdRequested || !resolveDefaultProjectId || !defaultStore) return;
    defaultIdRequested = true;
    // Best-effort and detached: a slow or failing central read only delays the default entry
    // appearing, it never propagates into the tick or the render path.
    void (async () => {
      try {
        const resolved = await resolveDefaultProjectId();
        cachedDefaultProjectId = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
      } catch {
        cachedDefaultProjectId = null;
      } finally {
        // Allow a later tick to retry a resolver that failed or has no answer yet, so a boot whose
        // central registry was not ready still reaches the full fleet.
        defaultIdRequested = false;
      }
    })();
  }

  return (): ServedProjectStore[] => {
    const out: ServedProjectStore[] = [];
    const claimed = new Set<string>();

    // 1. Engine-manager stores win, matching the FN-7205 precedence in the live-count reader.
    const engines = engineManager?.getAllEngines?.();
    if (engines) {
      for (const [projectId, engine] of engines) {
        if (typeof projectId !== "string" || projectId.length === 0 || claimed.has(projectId)) continue;
        const store = engine?.getTaskStore?.();
        if (!store) continue;
        claimed.add(projectId);
        out.push({ projectId, store });
      }
    }

    // 2. Secondary registered stores fill the projects no engine currently owns.
    for (const entry of listRegisteredStores?.() ?? []) {
      const projectId = entry?.projectId;
      if (typeof projectId !== "string" || projectId.length === 0 || claimed.has(projectId)) continue;
      if (!entry.store) continue;
      claimed.add(projectId);
      out.push({ projectId, store: entry.store });
    }

    // 3. The default in-process store, addressed by the central default project id.
    if (!cachedDefaultProjectId) kickDefaultIdResolve();
    if (defaultStore && cachedDefaultProjectId && !claimed.has(cachedDefaultProjectId)) {
      claimed.add(cachedDefaultProjectId);
      out.push({ projectId: cachedDefaultProjectId, store: defaultStore });
    }

    return out;
  };
}
