import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-context");
import { Router, type Request } from "express";
import { resolve, sep } from "node:path";
import {
  createProjectScopedPluginMcpProvider,
  PluginLoader,
  type PluginStore,
  type PluginLoaderOptions,
  type TaskStore,
} from "@fusion/core";
import type { ServerOptions } from "../server.js";
import { ApiError, internalError } from "../api-error.js";
import { getOrCreateProjectStore } from "../project-store-resolver.js";
import { createRuntimeLogger } from "../runtime-logger.js";
import type { RuntimeLogger } from "../runtime-logger.js";
import type {
  ApiRoutesContext,
  AuthSyncAuditLogInput,
  ProjectContext,
  RemoteRouteDiagnosticInput,
  RemoteRouteErrorClassification,
  ScopeValue,
} from "./types.js";

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error) {
    throw internalError(error.message || fallbackMessage);
  }

  throw internalError(fallbackMessage);
}

/**
 * FNXC:PluginMcpServers 2026-07-23-12:00:
 * FN-8596 requires dashboard cross-root MCP inspection to use a private,
 * non-persisting loader so ordinary requests cannot unload an engine runtime.
 */
export function createDiscoveryPluginLoaderOptions(
  otherStore: Pick<TaskStore, "getPluginStore">,
): PluginLoaderOptions {
  return {
    pluginStore: otherStore.getPluginStore() as PluginStore,
    taskStore: otherStore as TaskStore,
    lifecycleScope: "isolated",
    persistRuntimeState: false,
  };
}

/**
 * FNXC:PluginMcpServers 2026-07-23-12:00:
 * FN-8596 keeps this narrow dashboard binding seam testable: every cross-root
 * request must construct only an isolated, non-persisting discovery loader.
 */
export function createDashboardProjectScopedPluginMcpProvider(input: {
  hostRootDir: string;
  hostLoader: PluginLoader;
}): ReturnType<typeof createProjectScopedPluginMcpProvider> {
  return createProjectScopedPluginMcpProvider({
    hostRootDir: input.hostRootDir,
    hostLoader: input.hostLoader,
    createScopedLoader: (otherStore) => new PluginLoader(createDiscoveryPluginLoaderOptions(otherStore as TaskStore)),
  });
}

export function classifyRemoteRouteError(error: unknown): RemoteRouteErrorClassification {
  const fallbackMessage = String(error);

  if (error instanceof Error) {
    const errorClass = error.constructor?.name || error.name || "Error";
    const errorMessage = error.message || fallbackMessage;

    if (error.name === "AbortError") {
      return { classification: "timeout", errorClass, errorMessage };
    }

    if (error instanceof TypeError) {
      return { classification: "transport", errorClass, errorMessage };
    }

    return { classification: "unexpected", errorClass, errorMessage };
  }

  if ((error as { name?: unknown } | null)?.name === "AbortError") {
    return { classification: "timeout", errorClass: "AbortError", errorMessage: fallbackMessage };
  }

  return {
    classification: "unexpected",
    errorClass: typeof error,
    errorMessage: fallbackMessage,
  };
}

// FNXC:CentralProjectIdentity 2026-07-14-00:15: normalize with .trim() and treat a
// whitespace-only projectId as absent so it falls through to the launch-id resolution
// instead of binding a bogus id (restores strictness the seam replaced).
export function getProjectIdFromRequest(req: Request): string | undefined {
  if (req.query && typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0) {
    return req.query.projectId.trim();
  }
  if (req.body && typeof req.body.projectId === "string" && req.body.projectId.trim().length > 0) {
    return req.body.projectId.trim();
  }
  return undefined;
}

/*
FNXC:CentralProjectIdentity 2026-07-13-23:50:
Directive: dashboard API requests operate on an EXPLICIT central-registry project id, never a silent bind to the raw launch-directory TaskStore.
Resolution order for a request's project identity:
  1. request `projectId` (query/body),
  2. else the daemon's registered launch project id (`options.engine.getProjectId()`),
  3. else undefined — the caller is an unregistered/legacy launch directory and the raw injected store is a last resort (see warnLaunchDirFallbackOnce).
Once an id resolves it ALWAYS flows through the same bound-store path used for explicit ids (engine store when a live engine exists, else getOrCreateProjectStore), so store identity always comes from the central registry — with one dedup: the launch project reuses the injected registry-bound store instead of booting a second connection pool for the same id.
*/
export function resolveRequestProjectId(req: Request, options?: ServerOptions): string | undefined {
  return getProjectIdFromRequest(req) ?? options?.engine?.getProjectId?.() ?? undefined;
}

/*
FNXC:CentralProjectIdentity 2026-07-13-23:51:
The launch-dir raw-store fallback is legacy behavior preserved ONLY for unregistered directories (no request id AND no registered launch engine). Warn once per process (not per request) so the signal is visible without flooding logs; a single flag is shared with server.ts's resolveScopedStore via this exported helper.
*/
let warnedLaunchDirFallback = false;
export function warnLaunchDirFallbackOnce(options?: ServerOptions): void {
  if (warnedLaunchDirFallback) return;
  warnedLaunchDirFallback = true;
  const message =
    "project-scope fallback: request without projectId on an unregistered launch directory — using launch-dir store";
  const logger = options?.runtimeLogger;
  if (logger?.warn) {
    logger.warn(message);
  } else {
    severityAuditLog.warn(message);
  }
}

/*
FNXC:CentralProjectIdentity 2026-07-14-00:15:
Single id-based store-resolution core shared by both routes/context.ts getScopedStore
and server.ts resolveScopedStore (the realtime path). Deduplicates the previously
mirrored resolution so identity semantics can never drift between the two entry points.
Given an ALREADY-resolved id (request id → launch id folded in by the caller):
  1. no id → one-time launch-dir fallback warn + return the raw injected store,
  2. live engineManager engine for the id → its TaskStore,
  3. id === launch project id → reuse the injected registry-bound store (no duplicate pool),
  4. else → getOrCreateProjectStore(id).

FNXC:CentralProjectIdentity 2026-07-14-00:15 (F6 caveat):
Launch-store reuse (step 3) assumes the injected store belongs to a live launch engine.
When an engineManager is present but getEngine(launchId) is undefined, this cannot
distinguish a launch engine that was never started (store still valid) from one that was
explicitly stopped/paused (store may be closed). ProjectEngineManager exposes no synchronous
engine-liveness/paused introspection (getEngine returns undefined for a stopped engine since
it is deleted from the engines map, and paused status lives async in CentralCore), so no
correct fall-through to getOrCreateProjectStore(launchId) is implementable here without
inventing an API. Behavior is preserved; a live engine store (step 2) always wins first.
*/
export async function resolveStoreForProjectId(
  resolvedId: string | undefined,
  store: TaskStore,
  options?: ServerOptions,
): Promise<TaskStore> {
  if (!resolvedId) {
    warnLaunchDirFallbackOnce(options);
    return store;
  }

  const engineManager = options?.engineManager;
  if (engineManager) {
    const engine = engineManager.getEngine(resolvedId);
    if (engine) {
      return engine.getTaskStore();
    }
  }

  // Launch project: the injected store is already registry-bound to this id, so
  // reuse it instead of booting a duplicate connection pool via
  // getOrCreateProjectStore. See the F6 caveat above.
  if (options?.engine?.getProjectId?.() === resolvedId) {
    return store;
  }

  return getOrCreateProjectStore(resolvedId);
}

export async function getScopedStore(
  req: Request,
  store: TaskStore,
  options?: ServerOptions,
): Promise<TaskStore> {
  const projectId = resolveRequestProjectId(req, options);
  return resolveStoreForProjectId(projectId, store, options);
}

/*
FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
ONE answer to "this request named a project that neither a warm engine serves nor is the launch
project", shared by `getProjectContext` (which publishes it as `ProjectContext.launchScoped`), the
`POST /tasks/:id/merge` refusal, and the automation/routine resolvers. Two definitions of "foreign
and cold" would let the merge route and the Automations page disagree about the same request.

The measured defect this closes: `getProjectContext` returns `engine: undefined` for a cold project on
purpose (it only kicks `engineManager.onProjectAccessed` fire-and-forget so a read is not blocked), so
`engine: undefined` meant TWO different things — "unscoped request" and "foreign project still
starting". `POST /tasks/:id/merge` papered over the ambiguity with `options?.onMerge`, a callback
permanently bound to the launch engine's own TaskStore, so a real card in project B was looked up in
the launch project and answered `500 Task <id> not found` in ~0.05 s while scoped GETs on the same
card returned 200. Measured in production at a restart window: a warm-up GET does NOT wire the target
engine into the route context, so the first engine-backed mutation after a new listener is the one that
misroutes, while `POST /retry` — which mutates through the correctly-scoped store and only
optional-chains the engine — kept returning 200 on the same cold project.

Falsy arms, each a distinct reason the launch-tenancy objects are the CORRECT ones to use:
1. no `projectId` — unscoped/legacy single-project request, nothing was named;
2. no `engineManager` — the `--no-engine` UI-only host passes none deliberately (see
   `FNXC:EngineAvailability` in `packages/cli/src/commands/dashboard.ts`), and its `uiOnlyOnMerge` is
   the only merge path it owns. Do NOT "close" this arm: it is the contract, not a hole;
3. `engineManager.getEngine(projectId)` resolves — a warm engine serves the request itself;
4. the id IS the launch project's own id. Decisive: `options.onMerge`, `automationStore`,
   `routineStore` and `routineRunner` are themselves LAUNCH-tenancy, derived from the launch engine at
   `packages/dashboard/src/server.ts:1326-1395`, so a request naming the launch id already has the right
   tenancy and must not gain a new 503. A predicate keyed only on "id present + engine cold" would
   regress the launch project's own Automations and Routines.

The launch id resolves as `options?.engine?.getProjectId?.() ?? store.getProjectId?.()`, mirroring
`getProjectContext`'s own launch branch, because a mock or partially-built engine may not answer
`getProjectId`. `store` is the INJECTED (launch) store, never the request-scoped one.
*/
export function namesForeignColdProject(
  projectId: string | undefined,
  options: ServerOptions | undefined,
  store: TaskStore,
): boolean {
  if (!projectId) return false;

  const engineManager = options?.engineManager;
  if (!engineManager) return false;
  if (engineManager.getEngine(projectId)) return false;

  const launchProjectId = options?.engine?.getProjectId?.() ?? store.getProjectId?.() ?? null;
  return launchProjectId !== projectId;
}

/** The refusal shared by every route that would otherwise mutate through a launch-tenancy callback. */
export function engineStartingError(projectId: string): ApiError {
  /*
  FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
  The sentence must never contain "not found" phrasing: a sub-second `Task <id> not found` on a card
  that a scoped GET resolves is what tempts an operator, or a scripted drain, into destructive cleanup
  against a project that was merely still starting. `retryable: true` plus `Retry-After` (set by the
  route) is the machine-checkable "wait a few seconds" signal, and no `messageKey` is added on purpose —
  that would require a `Column.tsx` case plus 7-locale parity for a merge-button toast.
  */
  return new ApiError(503, "The project's engine is not running yet. Retry in a few seconds.", {
    code: "engine-starting",
    retryable: true,
    projectId,
  });
}

export async function getProjectContext(
  req: Request,
  store: TaskStore,
  options?: ServerOptions,
): Promise<ProjectContext> {
  const projectId = resolveRequestProjectId(req, options);
  const engineManager = options?.engineManager;
  /*
  FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
  Computed ONCE here from the shared predicate and carried to every return site below, so no route can
  receive a context that disagrees with `namesForeignColdProject`. Each of the five sites is a different
  tenancy situation, which is exactly why a per-site ad-hoc expression is forbidden.
  */
  const launchScoped = !namesForeignColdProject(projectId, options, store);

  if (!projectId) {
    /*
    FNXC:DashboardApi 2026-07-14-22:05:
    Single-project / unregistered launch still has a live options.engine (the daemon's launch ProjectEngine). Prefer that for remote tunnel and self-healing so lifecycle routes are not silently engine-less when no project id is on the request; only fall back to raw store when no engine was injected.
    */
    if (options?.engine) {
      try {
        return { store: options.engine.getTaskStore?.() ?? store, engine: options.engine, projectId: undefined, launchScoped };
      } catch {
        // Fall through to raw-store last resort.
      }
    }
    // No request id and no registered launch engine: unregistered/legacy launch
    // directory. Preserve the raw-store last resort with a one-time warn.
    warnLaunchDirFallbackOnce(options);
    return { store, engine: undefined, projectId: undefined, launchScoped };
  }

  if (engineManager) {
    const engine = engineManager.getEngine(projectId);
    if (!engine) {
      // Trigger lazy engine start as fire-and-forget so this request is not
      // blocked while the engine initialises (engine.start() may take several
      // seconds for a newly-registered project).
      // The engine will be available for subsequent requests once it starts.
      engineManager.onProjectAccessed(projectId);
    }
    if (engine) {
      return { store: engine.getTaskStore(), engine, projectId, launchScoped };
    }
  }

  // Launch project: reuse the live launch engine + its registry-bound store
  // rather than a duplicate boot. The resolved projectId is returned explicitly
  // (never undefined) so downstream context is always attributable to a
  // central-registry id.
  if (options?.engine && options.engine.getProjectId?.() === projectId) {
    try {
      return { store: options.engine.getTaskStore(), engine: options.engine, projectId, launchScoped };
    } catch {
      // Fall back to scoped store resolution.
    }
  }

  const scopedStore = await getScopedStore(req, store, options);
  /*
  FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
  The one ambiguous site: reached both by an unscoped request and by a FOREIGN project whose engine is
  cold. Its STORE is correct either way (getScopedStore resolved it), so reads stay non-blocking and
  unchanged; only `launchScoped` distinguishes the two, and it is what stops an engine-backed MUTATION
  from falling through to the launch project's `options.on*` callback.
  */
  return { store: scopedStore, engine: undefined, projectId, launchScoped };
}

export function emitRemoteRouteDiagnostic(
  runtimeLogger: RuntimeLogger,
  input: RemoteRouteDiagnosticInput,
): void {
  const logger = runtimeLogger.child("remote-route").child(input.route);
  const level = input.level ?? "error";

  const context: Record<string, unknown> = {
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.upstreamPath !== undefined ? { upstreamPath: input.upstreamPath } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.operationStage !== undefined ? { operationStage: input.operationStage } : {}),
    ...(input.context ?? {}),
  };

  if (input.error !== undefined) {
    const classified = classifyRemoteRouteError(input.error);
    context.transportClassification = classified.classification;
    context.errorClass = classified.errorClass;
    context.errorMessage = classified.errorMessage;
  }

  if (level === "info") {
    logger.info(input.message, context);
    return;
  }

  if (level === "warn") {
    logger.warn(input.message, context);
    return;
  }

  logger.error(input.message, context);
}

export function createApiRoutesContext(store: TaskStore, options?: ServerOptions): ApiRoutesContext {
  const router = Router();
  const runtimeLogger = options?.runtimeLogger?.child("routes") ?? createRuntimeLogger("routes");
  const planningLogger = runtimeLogger.child("planning");
  const chatLogger = runtimeLogger.child("chat");

  function prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[] {
    const cwd = resolve(process.cwd());

    const rankProject = (projectPath: string): number => {
      const normalizedProjectPath = resolve(projectPath);
      if (normalizedProjectPath === cwd) {
        return Number.MAX_SAFE_INTEGER;
      }

      const prefix = normalizedProjectPath.endsWith(sep)
        ? normalizedProjectPath
        : `${normalizedProjectPath}${sep}`;

      if (!cwd.startsWith(prefix)) {
        return -1;
      }

      return normalizedProjectPath.length;
    };

    return [...projects].sort((a, b) => rankProject(b.path) - rankProject(a.path));
  }

  const resolveScopedStore = (req: Request): Promise<TaskStore> => getScopedStore(req, store, options);

  /*
  FNXC:PluginEnablementScope 2026-07-21-12:00:
  Plugin installation metadata is global, but every enabled/state decision belongs to the
  TaskStore selected for the request's project. A dashboard launched from project A must not
  use A's host loader after mutating project B: that loader reads A's project_plugin_states row
  and can immediately report B's newly enabled plugin as disabled. Prefer B's running engine
  loader; only reuse the host loader when it owns the same PluginStore, otherwise bind a loader
  directly to B's TaskStore.

  FNXC:PluginEnablementScope 2026-07-21-15:30:
  A project without a live engine still needs one loader for its dashboard lifetime.
  Creating one per request starts a plugin in enable(), then loses that instance before
  disable(), UI-slot, contribution, and runtime reads. Cache by the resolved TaskStore so
  all fallback readers share the same project_plugin_states key and loaded plugin instance.

  FNXC:PluginEnablementScope 2026-07-22-20:30:
  Moved here from register-plugins-automation.ts so plugin-defined HTTP route dispatch
  (plugin-routes.ts) resolves through the SAME loader cache as dashboard-views/ui-slots/
  enable/disable. When these used separate loader instances, a plugin enabled after boot or
  enabled only in a non-launch project rendered its dashboard view while every one of its
  API routes 404'd (Compound Engineering "Failed to load sessions: Not found").
  */
  const fallbackProjectLoaders = new WeakMap<TaskStore, {
    loader: PluginLoader;
    initialized: Promise<void>;
  }>();

  const getProjectPluginLoader = async (
    scopedStore: TaskStore,
    engine?: { getPluginRunner?: () => { getLoader?: () => PluginLoader } | undefined },
  ): Promise<PluginLoader | undefined> => {
    const engineLoader = engine?.getPluginRunner?.()?.getLoader?.();
    if (engineLoader) return engineLoader;

    const scopedPluginStore = scopedStore.getPluginStore();
    if (scopedPluginStore === options?.pluginStore) return options?.pluginLoader;

    let fallback = fallbackProjectLoaders.get(scopedStore);
    if (!fallback) {
      const loader = new PluginLoader({ pluginStore: scopedPluginStore as PluginStore, taskStore: scopedStore });
      /*
      FNXC:PluginEnablementScope 2026-07-21-20:15:
      Dashboard-only projects lack an engine startup pass, so initialize their persistent scoped
      loader once before introspection. Reusing this promise prevents ui-slots, contributions,
      runtimes, and views from observing an empty loader after a dashboard restart.
      */
      fallback = {
        loader,
        initialized: loader.loadAllPlugins().then(() => undefined),
      };
      fallbackProjectLoaders.set(scopedStore, fallback);
    }
    await fallback.initialized;
    return fallback.loader;
  };

  const fallbackMcpLoaders = new WeakMap<TaskStore, { loader: PluginLoader; initialized: Promise<void> }>();
  const projectMcpProviders = new WeakMap<PluginLoader, ReturnType<typeof createProjectScopedPluginMcpProvider>>();

  const bindProjectScopedPluginMcpProvider = async (context: ProjectContext): Promise<void> => {
    const scopedStore = context.store as TaskStore & {
      getProjectScopedPluginMcpServers?: () => Promise<unknown>;
    };
    // A live runtime already owns the provider for its TaskStore. Dashboard-only
    // contexts install the same core provider below rather than falling back to
    // raw plugin enumeration.
    if (typeof scopedStore.getProjectScopedPluginMcpServers === "function") return;

    const engineLoader = (context.engine as { getPluginRunner?: () => { getLoader?: () => PluginLoader } | undefined } | undefined)
      ?.getPluginRunner?.()?.getLoader?.();
    // The host loader is valid only for the TaskStore that owns its PluginStore;
    // another root needs its own non-persisting loader before the core provider
    // filters enabled IDs.
    const hostLoader = context.store.getPluginStore() === options?.pluginStore ? options?.pluginLoader : undefined;
    let loader = engineLoader ?? hostLoader;
    if (!loader) {
      let fallback = fallbackMcpLoaders.get(context.store);
      if (!fallback) {
        const fallbackLoader = new PluginLoader({
          pluginStore: context.store.getPluginStore() as PluginStore,
          taskStore: context.store,
        });
        fallback = {
          loader: fallbackLoader,
          initialized: context.store.getPluginStore().init().then(() => fallbackLoader.loadAllPlugins()).then(() => undefined),
        };
        fallbackMcpLoaders.set(context.store, fallback);
      }
      await fallback.initialized;
      loader = fallback.loader;
    }

    let provider = projectMcpProviders.get(loader);
    if (!provider) {
      provider = createDashboardProjectScopedPluginMcpProvider({
        hostRootDir: context.store.getRootDir(),
        hostLoader: loader,
      });
      projectMcpProviders.set(loader, provider);
    }
    scopedStore.getProjectScopedPluginMcpServers = () => provider.get(context.store);
    /*
     * FNXC:PluginMcpServers 2026-07-22-15:35:
     * FN-8491 / #2401 makes API and dashboard session contexts project-aware.
     * Every non-runtime scoped store receives the same core provider so an
     * active project other than the host cannot silently resolve no plugin MCP
     * servers or inherit a different project's enabled-plugin state.
     */
  };

  const resolveProjectContext = async (req: Request): Promise<ProjectContext> => {
    const context = await getProjectContext(req, store, options);
    await bindProjectScopedPluginMcpProvider(context);
    return context;
  };
  const disposeCallbacks: Array<() => void> = [];

  function emitAuthSyncAuditLog(input: AuthSyncAuditLogInput): void {
    const logger = runtimeLogger.child("settings-sync").child("auth");
    const level = input.level ?? "info";
    const providerNames = input.providerNames.filter((provider) => typeof provider === "string");

    const context: Record<string, unknown> = {
      operation: input.operation,
      direction: input.direction,
      route: input.route,
      providerNames,
      providerCount: providerNames.length,
      ...(input.sourceNodeId !== undefined ? { sourceNodeId: input.sourceNodeId } : {}),
      ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
    };

    if (level === "warn") {
      logger.warn("Auth sync diagnostic event", context);
      return;
    }

    if (level === "error") {
      logger.error("Auth sync diagnostic event", context);
      return;
    }

    logger.info("Auth sync diagnostic event", context);
  }

  function parseScopeParam(req: Request): ScopeValue | undefined {
    const rawScope =
      (typeof req.query.scope === "string" ? req.query.scope : undefined) ??
      (req.body && typeof req.body.scope === "string" ? req.body.scope : undefined);

    if (rawScope === undefined || rawScope === "") {
      return undefined;
    }

    if (rawScope !== "global" && rawScope !== "project") {
      throw new ApiError(400, `Invalid scope value "${rawScope}". Must be "global" or "project".`);
    }

    return rawScope;
  }

  /*
  FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
  The gate every project-scoped resolver in this file passes through before it may touch a
  process-default (launch-tenancy) object. `options.automationStore`, `options.routineStore` and
  `options.routineRunner` are all derived from the LAUNCH engine at `server.ts:1326-1395`, so for a
  request naming a FOREIGN project whose engine is still starting they are the wrong project's rows
  and the wrong project's scheduler.

  This calls `namesForeignColdProject` rather than re-deriving "project id present + engine cold", for
  two reasons: the launch-id carve-out must stay identical to the merge route's (a request naming the
  LAUNCH project's own id is already correctly served by these defaults and must keep answering 200),
  and two definitions of "foreign and cold" would let the Automations page and the merge button
  disagree about the same request. The refusal sentence is the function's own pre-existing 503 copy so
  no existing assertion moves; only `details` is added, which is what a drain keys on.
  */
  function refuseForeignColdProject(projectId: string | undefined, sentence: string): never {
    throw new ApiError(503, sentence, {
      code: "engine-starting",
      retryable: true,
      projectId,
    });
  }

  function resolveAutomationStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").AutomationStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.automationStore;
      if (!defaultStore) {
        throw new ApiError(503, "Automation store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getAutomationStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }
    // Reached instead of the launch default whenever the named project is foreign and its engine is
    // cold. A warm engine that simply exposes no store keeps today's fallthrough: the predicate is
    // false there, so this cannot change what a started project sees.
    if (namesForeignColdProject(projectId, options, store)) {
      refuseForeignColdProject(projectId, "Automation store not available");
    }

    const defaultStore = options?.automationStore;
    if (!defaultStore) {
      throw new ApiError(503, "Automation store not available");
    }
    return defaultStore;
  }

  function resolveRoutineStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").RoutineStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.routineStore;
      if (!defaultStore) {
        throw new ApiError(503, "Routine store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getRoutineStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }
    // Same gate as the automation resolver: see `refuseForeignColdProject`.
    if (namesForeignColdProject(projectId, options, store)) {
      refuseForeignColdProject(projectId, "Routine store not available");
    }

    const defaultStore = options?.routineStore;
    if (!defaultStore) {
      throw new ApiError(503, "Routine store not available");
    }
    return defaultStore;
  }

  function resolveRoutineRunner(req: Request, scope: ScopeValue | undefined): NonNullable<ServerOptions["routineRunner"]> {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "project" && projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineRunner = engine.getRoutineRunner();
        if (engineRunner) {
          return {
            triggerManual: engineRunner.triggerManual.bind(engineRunner),
            triggerWebhook: engineRunner.triggerWebhook.bind(engineRunner),
          };
        }
      }
    }
    /*
    FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
    The runner leg was the worst of the three resolvers: falling through to `options.routineRunner`
    EXECUTES a routine in the launch project while the request named another one, so the card, the
    schedule and the workspace the routine acts on all belong to the wrong project. Refusing here is
    therefore not a UX nicety - executing in the wrong project is the defect.
    */
    if (scope === "project" && namesForeignColdProject(projectId, options, store)) {
      refuseForeignColdProject(projectId, "Routine execution not available");
    }

    const runner = options?.routineRunner;
    if (!runner) {
      throw new ApiError(503, "Routine execution not available");
    }
    return runner;
  }

  return {
    router,
    store,
    options,
    runtimeLogger,
    planningLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore: resolveScopedStore,
    getProjectContext: resolveProjectContext,
    getProjectPluginLoader,
    emitRemoteRouteDiagnostic: (input) => emitRemoteRouteDiagnostic(runtimeLogger, input),
    emitAuthSyncAuditLog,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    registerDispose: (callback) => {
      disposeCallbacks.push(callback);
    },
    dispose: () => {
      while (disposeCallbacks.length > 0) {
        const callback = disposeCallbacks.pop();
        if (!callback) continue;
        try {
          callback();
        } catch {
          // best-effort cleanup
        }
      }
    },
    rethrowAsApiError,
  };
}
