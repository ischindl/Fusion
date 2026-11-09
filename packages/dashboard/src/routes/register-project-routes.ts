import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  invalidateGitBinaryCache,
  isSpawnGitEnoent,
  resolveGitBinary,
  countRunningAgentTasks,
  ensureMemoryFileWithBackend,
  isValidSqliteDatabaseFile,
  ProjectIdentityConflictError,
  readProjectIdentity,
  writeProjectIdentity,
  resolveWorkflowIrForTask,
  columnsWithFlag,
  resolveTaskLifecycleColumns,
  isTerminalColumnRole,
  resolveEffectiveConcurrency,
  emitBoundedRunAudit,
} from "@fusion/core";
import type { CentralCore as CentralCoreApi, WorkflowIr } from "@fusion/core";
import {
  DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS,
  resolveHybridExecutorReadiness,
} from "@fusion/engine";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { execFileAsync } from "../exec-file.js";
import {
  acrossNodesRequestKey,
  acrossNodesTtlMs,
  createProjectListCoalescer,
} from "./project-list-coalescer.js";
import { getOrCreateProjectStore, evictProjectStore } from "../project-store-resolver.js";
import { computeCodebaseMetrics } from "../lib/codebase-metrics.js";
import type { ApiRouteRegistrar } from "./types.js";

const {
  access,
  stat,
  mkdir,
  readdir,
  rm,
} = fsPromises;

/**
 * FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871):
 * The ONE projection read for the operator's runtime unload switch.
 *
 * `GET /api/projects` answered 25 rows with no runtime field, so the project combo could not tell a
 * loaded project from an unloaded one, and a turned-off project was indistinguishable from a live one.
 * `status` was NOT reused: production `status` reads `active` (11) / `paused` (14) and names the
 * project-row lifecycle, a different axis from the runtime gate.
 *
 * Cost and correctness contract: the flag comes from the PERSISTED central settings in ONE batched
 * read per request, regardless of project count. The first version read it per project through
 * `getOrCreateProjectStore`, which (a) opened a full TaskStore per row — a side-effecting
 * `store:open` write inside a GET route — and (b) got the answer wrong, because a store that will not
 * open is not evidence about the setting: 14 of 25 projects reported `runtimeState: "unknown"`, each
 * wearing a "Runtime off" label the operator never applied, while `project.config.settings` held the
 * true value for all 25. The per-store read survives only as the fallback for a deployment whose
 * central read cannot answer at all.
 */
export type ProjectRuntimeReadState = "enabled" | "disabled" | "unknown";

/**
 * Persisted runtime flags for every project the central database has a settings row for.
 * `null` is not an empty result — it means the central read could not answer, which is the only
 * condition that permits the legacy per-project store fallback.
 */
type ProjectRuntimeFlags = Record<string, boolean> | null;

/** The store seam this route needs from a project store; narrow so a fake can satisfy it. */
type RuntimeSettingsStore = { getSettingsFast?: () => Promise<{ runtimeEnabled?: boolean }> };

/**
 * The single batched central read. Any failure shape — no seam, a throwing read, a `null` "could not
 * answer", a non-object answer — collapses to `null` so the caller takes the legacy path rather than
 * rendering every project `unknown` because one read broke.
 *
 * FNXC:ProjectRuntimeOff 2026-11-07-22:12 (RUFU-871): `null` is the ONLY shape that may reach the
 * fallback, and the central read now produces it deliberately when it cannot obtain a cross-project
 * view. A record is trusted as complete, so a record truncated to the reader's own project (the RLS
 * defect this replaces) would silently win over the fallback — the read helper verifies its own
 * privilege instead of returning a short record.
 */
async function readRuntimeFlags(
  central: { getProjectRuntimeEnabledFlags?: () => Promise<ProjectRuntimeFlags> } | null | undefined,
): Promise<ProjectRuntimeFlags> {
  if (!central || typeof central.getProjectRuntimeEnabledFlags !== "function") return null;
  try {
    const flags = await central.getProjectRuntimeEnabledFlags();
    return flags && typeof flags === "object" ? flags : null;
  } catch {
    return null;
  }
}

/**
 * Legacy per-project fallback, reached ONLY when the central read could not answer. Kept honest in the
 * same three steps the central read is: key present and false is `disabled`, a settings row without
 * the key is `enabled` (the gate's own default, `isProjectRuntimeEnabled`), and an unreadable project
 * is `unknown` — never `enabled`, because claiming a project is loaded is what made the original
 * incident unanswerable.
 */
async function resolveRuntimeStateFromStore(
  projectId: string,
  openStore: RuntimeSettingsStore | null | undefined,
): Promise<ProjectRuntimeReadState> {
  try {
    const store = openStore ?? await getOrCreateProjectStore(projectId);
    if (!store || typeof store.getSettingsFast !== "function") return "unknown";
    const settings = await store.getSettingsFast();
    if (!settings) return "unknown";
    return settings.runtimeEnabled === false ? "disabled" : "enabled";
  } catch {
    return "unknown";
  }
}

/**
 * Attach `runtimeEnabled` + `runtimeState` to every row of a project projection.
 *
 * FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871):
 * `runtimeFlags` is the ONE central read, so this performs no read of its own when it is present —
 * the cost no longer scales with the number of projects. A project id the flags do not name has no
 * persisted settings row, so it answers `unknown`; that is the absence of a read, not a failed one,
 * and it must not fall back to opening a store while the central read is healthy and authoritative.
 *
 * A REMOTE row is not read here at all: it already carries its own node's answer from that node's
 * `GET /api/projects`, and this server has no local settings row for it. Overwriting a running remote
 * project with a local `unknown` would hand the UI a "Runtime off" label for work it is not running.
 */
async function withRuntimeProjection<T extends { id: string; runtimeEnabled?: unknown }>(
  projects: T[],
  runtimeFlags: ProjectRuntimeFlags,
  openStoreFor: (projectId: string) => RuntimeSettingsStore | null | undefined,
  localProjectIds?: Set<string>,
  noteFallback?: (projectCount: number) => void,
): Promise<Array<T & { runtimeEnabled: boolean; runtimeState: ProjectRuntimeReadState }>> {
  // The store path is a logged exception, never a silent second primary: an operator reading `unknown`
  // rows must be able to find out from the log that the authoritative read was unavailable.
  if (runtimeFlags === null && projects.length > 0) noteFallback?.(projects.length);
  return Promise.all(
    projects.map(async (project) => {
      const isRemote = localProjectIds !== undefined && !localProjectIds.has(project.id);
      const runtimeState: ProjectRuntimeReadState = isRemote
        ? project.runtimeEnabled === true
          ? "enabled"
          : project.runtimeEnabled === false
            ? "disabled"
            : "unknown"
        : runtimeFlags
          ? runtimeFlags[project.id] === true
            ? "enabled"
            : runtimeFlags[project.id] === false
              ? "disabled"
              : "unknown"
          : await resolveRuntimeStateFromStore(project.id, openStoreFor(project.id));
      return {
        ...project,
        // `runtimeEnabled` keeps its boolean shape for existing clients, but it means "positively
        // known to be running": an unreadable project is false, and `runtimeState` says why.
        runtimeEnabled: runtimeState === "enabled",
        runtimeState,
      };
    }),
  );
}

export const registerProjectRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, runtimeLogger, prioritizeProjectsForCurrentDirectory, rethrowAsApiError } = ctx;

  /** The store this server already holds open for a project, if any. Never opens one. */
  const openStoreFor = (projectId: string) => options?.engineManager?.getStore(projectId) ?? null;

  /*
  FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
  One coalescer per registrar, so a second `createApiRoutes` (a test, an embedded host) can never read
  another server's project list. The TTL is read at construction from `FUSION_PROJECTS_ACROSS_NODES_TTL_MS`
  and is clamped to one client poll; `0` makes `run` a pass-through, which is the no-redeploy rollback.
  */
  const acrossNodesCoalescer = createProjectListCoalescer({ ttlMs: acrossNodesTtlMs() });

  /*
  FNXC:ProjectRuntimeOff 2026-11-07-22:12 (RUFU-871):
  The per-project store read is retained ONLY as a fallback, and it is announced. It is the path whose
  answer depends on which TaskStores this process happens to have opened — measured drifting
  `12 unknown / 11 enabled / 2 disabled` to `11 unknown / 11 enabled / 3 disabled` 45 seconds apart on
  the same database — so leaving it silent would let the warm-cache lie return unnoticed.
  */
  const noteRuntimeFallback = (scope: string) => (projectCount: number): void => {
    runtimeLogger.child(scope).warn(
      `${scope}: the batched central runtime-flag read could not answer for ${projectCount} project(s); ` +
        `falling back to per-project store reads, which report "unknown" for any project this process has not already opened.`,
    );
  };

  async function withCentralCore<T>(
    run: (central: CentralCoreApi) => Promise<T>,
    onError?: (error: unknown) => Promise<T> | T,
  ): Promise<T> {
    const sharedCentral = options?.centralCore;
    const shouldClose = !sharedCentral;
    const central = sharedCentral ?? new (await import("@fusion/core")).CentralCore();

    try {
      if (!sharedCentral || (typeof central.isInitialized === "function" && !central.isInitialized())) {
        await central.init();
      }
      return await run(central);
    } catch (error) {
      if (onError) {
        return await onError(error);
      }
      throw error;
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }
  }

  // ── Project Management Routes (Multi-Project Support) ───────────────────────
  // These routes require CentralCore for the shared project registry.

  /**
   * GET /api/projects
   * List all registered projects with their basic info.
   * Returns: ProjectInfo[]
   */
  router.get("/projects", async (_req, res) => {
    try {
      const { projects, runtimeFlags } = await withCentralCore(
        async (central) => {
          // Reconcile stale "initializing" projects before listing so the
          // dashboard never shows permanent loading spinners for legacy records.
          await central.reconcileProjectStatuses();
          /*
          FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871):
          The one batched runtime-flag read, taken on the same already-open central handle that just
          listed the projects — this request costs one extra SELECT whether there are 2 projects or 25.
          */
          const listed = prioritizeProjectsForCurrentDirectory(await central.listProjects());
          return {
            projects: listed,
            runtimeFlags: await readRuntimeFlags(central),
          };
        },
        (error) => {
          runtimeLogger.child("projects").warn(
            `Failed to list registered projects: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { projects: [], runtimeFlags: null as ProjectRuntimeFlags };
        },
      );

      // FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871): one central read, projected onto every row.
      res.json(await withRuntimeProjection(projects, runtimeFlags, openStoreFor, undefined, noteRuntimeFallback("projects")));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/across-nodes
   * List all registered projects from all nodes (local + remote).
   * Fetches projects from online remote nodes and merges with local projects.
   * Returns: Array of projects with nodeId and _sourceNodeName for remote projects.
   */
  /*
  FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
  The fan-out is hoisted out of the request handler so concurrent identical requests can share one
  computation. Measured on the operator's host 2026-11-09: EIGHT dashboard tabs open for eight projects
  against ONE dashboard process on ONE event loop (`createServer`, single pid on :4040), each tab polling
  this route every 5 s — ~1.6 full cross-project fan-outs per second on the loop that also serves the
  board, with per-project reads of 1.95, 2.43, 4.07, 9.34, 24.7, 35.6, 57.3 and 59.5 s across 25 projects
  and three more hitting a 60 s client cap. The body is unchanged below; only the `res.json(...)` sinks
  became `return`s, so the payload this function produces is byte-identical to what the handler answered.
  Error handling stays inside (normalized to `ApiError`) and is re-thrown to the caller's handler, so a
  failed computation is shared by its joiners but never cached.
  */
  async function computeAcrossNodesProjects() {
    try {
      const { localProjects, allNodes, runtimeFlags } = await withCentralCore(
        async (central) => {
          // Reconcile stale "initializing" projects before listing
          await central.reconcileProjectStatuses();

          /*
          FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871):
          The runtime-flag read joins the reads this request already performs on the shared central
          handle, so the route still costs exactly ONE central settings read for the whole board. It is
          taken here rather than per branch so the local-only short circuit and the merged remote path
          cannot diverge in cost or in truth.
          */
          const [projects, nodes, flags] = await Promise.all([
            central.listProjects(),
            central.listNodes(),
            readRuntimeFlags(central),
          ]);

          return { localProjects: projects, allNodes: nodes, runtimeFlags: flags };
        },
        (error) => {
          runtimeLogger.child("projects:across-nodes").warn(
            `Failed to load local project registry: ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            localProjects: [] as Awaited<ReturnType<CentralCoreApi["listProjects"]>>,
            allNodes: [] as Awaited<ReturnType<CentralCoreApi["listNodes"]>>,
            runtimeFlags: null as ProjectRuntimeFlags,
          };
        },
      );

      // Filter to online remote nodes with URLs
      const remoteNodes = allNodes.filter(
        (node) => node.type === "remote" && node.status === "online" && node.url,
      );

      // Short-circuit: zero remote nodes means we behave exactly like /projects.
      // Skip the Promise.allSettled machinery entirely so local-only setups pay
      // no cross-node aggregation overhead.
      if (remoteNodes.length === 0) {
        const prioritizedProjects = prioritizeProjectsForCurrentDirectory(localProjects);
        // FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871): the combo reads this route, so the
        // local-only fast path carries the runtime field exactly like GET /projects.
        // FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905): returned, not answered — the handler
        // is the only thing that writes a response, so every joined request serializes its own.
        return await withRuntimeProjection(prioritizedProjects, runtimeFlags, openStoreFor, undefined, noteRuntimeFallback("projects:across-nodes"));
      }

      // Fetch projects from all remote nodes in parallel
      const remoteProjectArrays = await Promise.allSettled(
        remoteNodes.map(async (node) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          try {
            const response = await fetch(`${node.url}/api/projects`, {
              headers: {
                Authorization: `Bearer ${node.apiKey}`,
              },
              signal: controller.signal,
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const projects = (await response.json()) as Array<{
              id: string;
              name: string;
              path: string;
              status: "active" | "paused" | "errored" | "initializing";
              isolationMode: "in-process" | "child-process";
              nodeId?: string;
              createdAt: string;
              updatedAt: string;
              lastActivityAt?: string;
              /** That node's own runtime gate; absent on a node predating RUFU-871 = enabled. */
              runtimeEnabled?: boolean;
            }>;

            // Tag each remote project with the source node info
            return projects.map((project) => ({
              ...project,
              nodeId: node.id,
              _sourceNodeName: node.name,
            }));
          } finally {
            clearTimeout(timeoutId);
          }
        }),
      );

      // Collect successful remote projects, log failures
      type RemoteProject = {
        id: string;
        name: string;
        path: string;
        status: "active" | "paused" | "errored" | "initializing";
        isolationMode: "in-process" | "child-process";
        nodeId: string;
        _sourceNodeName: string;
        createdAt: string;
        updatedAt: string;
        lastActivityAt?: string;
        /** That node's own runtime gate; absent on a node predating RUFU-871 = enabled. */
        runtimeEnabled?: boolean;
      };
      const remoteProjects = remoteProjectArrays
        .filter((result): result is PromiseFulfilledResult<RemoteProject[]> => result.status === "fulfilled")
        .flatMap((result) => result.value);

      // Log failures for any unreachable nodes
      remoteProjectArrays.forEach((result, index) => {
        if (result.status === "rejected") {
          const node = remoteNodes[index];
          runtimeLogger.child("projects:across-nodes").warn(
            `Failed to fetch projects from node ${node?.id}: ${result.reason?.message ?? result.reason}`,
          );
        }
      });

      // Merge local and remote projects
      const mergedProjects = [...localProjects, ...remoteProjects];

      /*
      FNXC:ProjectRuntimeOff 2026-11-07-20:24 (RUFU-871):
      LOCAL rows are answered from the one batched central read; a REMOTE row keeps the answer its own
      node already gave on `GET /api/projects`. This server holds no `project.config` row for another
      node's project, so reading locally would call "unknown" — and the UI renders that as "Runtime
      off — unloaded, nothing runs" — on a project that is running on its own node.
      */
      const prioritizedProjects = prioritizeProjectsForCurrentDirectory(mergedProjects);

      return await withRuntimeProjection(
        prioritizedProjects,
        runtimeFlags,
        openStoreFor,
        new Set(localProjects.map((project: { id: string }) => project.id)),
        noteRuntimeFallback("projects:across-nodes"),
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  }

  /*
  FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
  The handler now owns only the response. The cache key is (authenticated principal, scoping params),
  because project visibility is per-principal and RLS-enforced — one computed board handed to a second
  principal would leak which projects exist. The duplicated catch is deliberate: the computation
  normalizes its own failures, and this one keeps the handler's error contract for anything the
  coalescing seam itself throws.
  */
  router.get("/projects/across-nodes", async (req, res) => {
    try {
      res.json(await acrossNodesCoalescer.run(acrossNodesRequestKey(req), computeAcrossNodesProjects));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/detect-workspace
   * Probe a directory for git sub-repos (workspace mode detection).
   * Body: { path: string }
   * Returns: { repos: string[], isWorkspace: boolean }
   */
  router.post("/projects/detect-workspace", async (req, res) => {
    try {
      const { path } = req.body;
      if (!path || typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required");
      }
      const normalizedPath = path.trim();
      if (!isAbsolute(normalizedPath)) {
        throw badRequest("path must be an absolute path");
      }

      try {
        await access(normalizedPath);
      } catch {
        throw badRequest("Project path does not exist");
      }

      const { detectWorkspaceRepos } = await import("@fusion/core");
      const repos = await detectWorkspaceRepos(normalizedPath);

      res.json({ repos, isWorkspace: repos.length > 0 });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects
   * Register a new project.
   * Body: {
   *   name: string,
   *   path: string,
   *   isolationMode?: "in-process" | "child-process",
   *   nodeId?: string,
   *   gitSetupMode?: "existing" | "init" | "clone",
   *   cloneUrl?: string,
   *   workspaceMode?: boolean,
   *   taskPrefix?: string
   * }
   * Returns: RegisteredProject
   */
  router.post("/projects", async (req, res) => {
    try {
      const { name, path, isolationMode = "in-process", nodeId, cloneUrl, gitSetupMode, workspaceMode, taskPrefix } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (!path || typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required and must be a non-empty string");
      }
      if (!["in-process", "child-process"].includes(isolationMode)) {
        throw badRequest("isolationMode must be 'in-process' or 'child-process'");
      }

      const normalizedName = name.trim();
      const normalizedPath = path.trim();
      let normalizedCloneUrl: string | undefined;
      let normalizedGitSetupMode: "existing" | "init" | "clone" | undefined;

      if (gitSetupMode !== undefined) {
        if (!["existing", "init", "clone"].includes(gitSetupMode)) {
          throw badRequest("gitSetupMode must be 'existing', 'init', or 'clone'");
        }
        normalizedGitSetupMode = gitSetupMode;
      }

      if (normalizedPath.includes("\0")) {
        throw badRequest("path cannot contain null bytes");
      }
      if (!isAbsolute(normalizedPath)) {
        throw badRequest("path must be an absolute path");
      }

      if (cloneUrl !== undefined) {
        if (typeof cloneUrl !== "string") {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }

        const trimmedCloneUrl = cloneUrl.trim();
        if (trimmedCloneUrl.length === 0) {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }
        if (trimmedCloneUrl.includes("\0")) {
          throw badRequest("cloneUrl cannot contain null bytes");
        }

        normalizedCloneUrl = trimmedCloneUrl;
      }

      if (normalizedCloneUrl !== undefined && normalizedGitSetupMode !== undefined && normalizedGitSetupMode !== "clone") {
        throw badRequest("cloneUrl can only be provided when gitSetupMode is 'clone'");
      }

      if (normalizedGitSetupMode === "clone" && normalizedCloneUrl === undefined) {
        throw badRequest("cloneUrl must be a non-empty string when gitSetupMode is 'clone'");
      }

      /*
      FNXC:Onboarding 2026-07-02-14:48:
      Dashboard onboarding now sends an explicit git setup mode, but existing clients may still only send cloneUrl.
      Preserve the legacy cloneUrl trigger while treating existing/init as the CentralCore ensureProjectForPath path where non-git directories are initialized by ensureGitRepositoryForProjectPath.
      */
      const isCloneMode = normalizedGitSetupMode === "clone" || normalizedCloneUrl !== undefined;
      let destinationCreatedForClone = false;

      if (!isCloneMode) {
        // Existing-directory mode: path must already exist.
        try {
          await access(normalizedPath);
        } catch {
          throw badRequest("Project path does not exist");
        }
      } else {
        // Clone mode: parent directory must exist.
        const destinationParent = dirname(normalizedPath);
        try {
          await access(destinationParent);
        } catch {
          throw badRequest("Clone destination parent directory does not exist");
        }

        // Destination must either not exist yet, or be an empty directory.
        let destinationExists = false;
        try {
          const destinationStats = await stat(normalizedPath);
          destinationExists = true;
          if (!destinationStats.isDirectory()) {
            throw badRequest("Clone destination must be a directory path");
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
            throw err;
          }
        }

        if (destinationExists) {
          const entries = await readdir(normalizedPath);
          if (entries.length > 0) {
            throw badRequest("Clone destination must be empty");
          }
        } else {
          await mkdir(normalizedPath, { recursive: false });
          destinationCreatedForClone = true;
        }

        const cloneSource = normalizedCloneUrl;
        if (!cloneSource) {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }

        try {
          /*
          FNXC:ProjectSetup 2026-07-18-06:00:
          Review finding: match runGitCommand's ENOENT invalidate-and-retry so
          a stale cached absolute git path (moved/uninstalled mid-session)
          re-resolves once instead of failing every clone until restart.
          */
          const runClone = (binary: string) =>
            execFileAsync(binary, ["clone", cloneSource, normalizedPath], {
              timeout: 90_000,
              maxBuffer: 10 * 1024 * 1024,
              encoding: "utf-8",
            });
          const cloneGit = await resolveGitBinary();
          try {
            await runClone(cloneGit);
          } catch (firstError) {
            if (!isSpawnGitEnoent(firstError)) throw firstError;
            invalidateGitBinaryCache();
            const retryGit = await resolveGitBinary();
            if (retryGit === cloneGit) throw firstError;
            await runClone(retryGit);
          }
        } catch (cloneError) {
          if (destinationCreatedForClone) {
            try {
              await rm(normalizedPath, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup only.
            }
          }

          const cloneErrorInfo = cloneError as Error & { stderr?: string; stdout?: string };
          const details = [cloneErrorInfo.stderr, cloneErrorInfo.stdout, cloneErrorInfo.message]
            .find((value) => typeof value === "string" && value.trim().length > 0)
            ?.toString()
            .trim();
          throw badRequest(`Git clone failed${details ? `: ${details}` : ""}`);
        }
      }

      let hasFusionDir = false;
      const fusionDirPath = join(normalizedPath, ".fusion");
      try {
        await access(fusionDirPath);
        hasFusionDir = true;
      } catch {
        hasFusionDir = false;
      }

      const activeProjectWithOutcome = await withCentralCore(async (central) => {
        const identity = readProjectIdentity(fusionDirPath);
        const ensured = await central.ensureProjectForPath({
          path: normalizedPath,
          identity: identity ?? undefined,
          name: normalizedName,
          isolationMode,
          nodeId,
        });
        const project = ensured.project;

        // Activate the project (registration sets it to 'initializing')
        const activeProject = await central.updateProject(project.id, { status: "active" });
        try {
          writeProjectIdentity(fusionDirPath, {
            id: activeProject.id,
            createdAt: activeProject.createdAt,
          });
        } catch {
          // Best-effort stamp only.
        }

        return {
          activeProject,
          outcome: ensured.outcome,
          integrationBranches: ensured.integrationBranches ?? [],
        };
      });

      /*
       * FNXC:Onboarding 2026-07-03-05:40:
       * Proactively warm the new project's engine on creation. getOrCreateProjectStore fires the
       * onProjectFirstAccessed hook (engineManager.onProjectAccessed -> ensureEngine), so the
       * project's engine starts immediately instead of waiting for the first lazy store access.
       * Without this, a freshly-created project (especially the operator's FIRST project on the
       * desktop, where no other engine is running) leaves engineManager with no running engine, so
       * /api/health reports engine.available=false and the dashboard shows "AI engine is not
       * running" right after project creation. Fire-and-forget: engine startup is async and must not
       * block or fail the registration response.
       */
      void getOrCreateProjectStore(activeProjectWithOutcome.activeProject.id).catch(() => undefined);

      // Bootstrap memory files (non-blocking, non-fatal)
      ensureMemoryFileWithBackend(normalizedPath).catch(() => {
        // Memory bootstrap failure is non-fatal - project registration succeeded
      });

      /*
      FNXC:Onboarding 2026-06-24-18:00:
      For new registrations (not reattachments), configure workspace mode (if specified or
      auto-detected), set a task prefix, and default workflow via the per-project TaskStore
      config.json so the project is immediately usable without manual settings configuration.
      */
      if (activeProjectWithOutcome.outcome === "registered") {
        try {
          const { suggestTaskPrefix, detectWorkspaceRepos, saveWorkspaceConfig } = await import("@fusion/core");
          /*
          FNXC:PostgresCutover 2026-07-05-12:00:
          Use the shared backend-booted project store (getOrCreateProjectStore)
          instead of `new TaskStore(normalizedPath)`: the bare constructor
          resolves to the removed SQLite runtime and throws in backend mode,
          which silently skipped workspace-mode/task-prefix/default-workflow
          setup for every newly registered project. The shared store is cached
          for SSE/API reuse, so it must NOT be closed here.
          */
          const store = await getOrCreateProjectStore(activeProjectWithOutcome.activeProject.id);

          /*
          FNXC:Workspace 2026-06-24-19:00:
          Workspace mode: if the client explicitly requested it (workspaceMode: true from the
          wizard checkbox), detect and persist sub-repos. If the client didn't specify and
          auto-detection finds sub-repos, also apply it. This mirrors the CLI interactive flow.
          */
          if (workspaceMode === true) {
            const repos = await detectWorkspaceRepos(normalizedPath);
            if (repos.length > 0) {
              await saveWorkspaceConfig(normalizedPath, { repos });
              await store.updateSettings({ workspaceMode: true });
            }
          } else if (workspaceMode === undefined) {
            const repos = await detectWorkspaceRepos(normalizedPath);
            if (repos.length > 0) {
              await saveWorkspaceConfig(normalizedPath, { repos });
              await store.updateSettings({ workspaceMode: true });
            }
          }

          const rawPrefix = typeof taskPrefix === "string" ? taskPrefix.trim().toUpperCase() : "";
          const validPrefix = /^[A-Z]{1,5}$/.test(rawPrefix) ? rawPrefix : "";
          const prefix = validPrefix || suggestTaskPrefix(normalizedName);
          await store.updateSettings({
            taskPrefix: prefix,
            defaultWorkflowId: "builtin:coding",
          });
        } catch {
          // Non-fatal: project registration succeeded; settings can be configured later
        }
      }

      /*
      FNXC:IntegrationBranchReadiness 2026-08-24-00:53:
      FN-183 exposes the single-repository reconciliation result at every dashboard registration
      outcome, including existing and reattached projects. Persist it only into a blank project
      scope and never for active workspace mode, so an operator's explicit integrationBranch or
      legacy baseBranch remains authoritative and per-member workspace defaults do not bleed here.
      */
      const [integrationBranch] = activeProjectWithOutcome.integrationBranches;
      if (activeProjectWithOutcome.integrationBranches.length === 1 && integrationBranch?.action !== "unavailable") {
        try {
          const store = await getOrCreateProjectStore(activeProjectWithOutcome.activeProject.id);
          const scopedSettings = await store.getSettingsByScope();
          const projectSettings = scopedSettings.project as typeof scopedSettings.project & { baseBranch?: unknown };
          const integrationBranchIsBlank = typeof projectSettings.integrationBranch !== "string"
            || projectSettings.integrationBranch.trim().length === 0;
          const baseBranchIsBlank = typeof projectSettings.baseBranch !== "string"
            || projectSettings.baseBranch.trim().length === 0;
          if (projectSettings.workspaceMode !== true && integrationBranchIsBlank && baseBranchIsBlank) {
            await store.updateSettings({ integrationBranch: integrationBranch.branch });
          }
        } catch {
          // FNXC:IntegrationBranchReadiness 2026-08-24-00:53: Settings persistence is non-fatal after registration.
        }
      }

      // Notify the host (serve.ts/daemon.ts) so it can run project-setup
      // side-effects like installing the fusion Claude-skill into
      // .claude/skills/fusion when pi-claude-cli is configured. The callback
      // is responsible for catching its own errors — a failure here must not
      // fail the registration response.
      if (options?.onProjectRegistered) {
        try {
          options.onProjectRegistered({
            id: activeProjectWithOutcome.activeProject.id,
            name: activeProjectWithOutcome.activeProject.name,
            path: activeProjectWithOutcome.activeProject.path,
          });
        } catch (hookErr) {
          runtimeLogger.warn(
            `onProjectRegistered callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }
      res.status(201).json({
        ...activeProjectWithOutcome.activeProject,
        outcome: activeProjectWithOutcome.outcome,
        _meta: { hasFusionDir: hasFusionDir ? undefined : false },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof ProjectIdentityConflictError) {
        throw new ApiError(409, "orphan-identity", {
          projectId: err.projectId,
          path: err.incomingPath,
          message: err.message,
        });
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already registered")
        ? 409
        : (err instanceof Error ? err.message : String(err)).includes("Duplicate path")
          ? 409
          : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/detect
   * Auto-detect fn projects in a directory.
   * Body: { basePath?: string }
   * Returns: { projects: DetectedProject[] }
   */
  router.post("/projects/detect", async (req, res) => {
    try {
      const { basePath } = req.body;

      // Default to home directory if no basePath provided
      const searchPath = basePath || process.env.HOME || process.env.USERPROFILE || ".";

      // Check search path exists (async to avoid blocking event loop)
      try {
        await access(searchPath);
      } catch {
        throw badRequest("Base path does not exist");
      }

      // Get list of existing projects to check for duplicates
      const existingProjects = await withCentralCore(
        async (central) => await central.listProjects(),
        (error) => {
          runtimeLogger.child("projects:detect").warn(
            `Failed to load existing projects during detection: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        },
      );

      const existingPaths = new Set(existingProjects.map((p: { path: string }) => p.path));

      // Scan for PostgreSQL-era project markers or openable legacy SQLite DBs.
      const detected: Array<{ path: string; suggestedName: string; existing: boolean }> = [];

      try {
        const entries = await readdir(searchPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const dirPath = join(searchPath, entry.name);
          /*
           * FNXC:PostgresProjectDiscovery 2026-07-14-17:30:
           * Current projects advertise `.fusion/project.json`; an openable
           * `fusion.db` remains discoverable only as legacy migration input.
           */
          const fusionDir = join(dirPath, ".fusion");
          if (
            readProjectIdentity(fusionDir) !== null
            || isValidSqliteDatabaseFile(join(fusionDir, "fusion.db"))
          ) {
            detected.push({
              path: dirPath,
              suggestedName: entry.name,
              existing: existingPaths.has(dirPath),
            });
          }
        }
      } catch {
        // Ignore read errors
      }

      res.json({ projects: detected });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id
   * Get a single project by ID.
   */
  router.get("/projects/:id", async (req, res) => {
    try {
      const project = await withCentralCore(async (central) => await central.getProject(req.params.id));

      if (!project) {
        throw notFound("Project not found");
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/path-mappings
   * List all per-node path mappings for a project.
   */
  router.get("/projects/:id/path-mappings", async (req, res) => {
    try {
      const mappings = await withCentralCore(async (central) => {
        return await central.listProjectNodePathMappingsForProject(req.params.id);
      });

      res.json(mappings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Project not found")) {
        throw notFound(message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/path-mappings/:nodeId
   * Get a single project-node path mapping.
   */
  router.get("/projects/:id/path-mappings/:nodeId", async (req, res) => {
    try {
      const mapping = await withCentralCore(async (central) => {
        return await central.getProjectNodePathMapping(req.params.id, req.params.nodeId);
      });

      if (!mapping) {
        throw notFound("Project-node path mapping not found");
      }

      res.json(mapping);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/projects/:id/path-mappings/:nodeId
   * Create or update a project-node path mapping.
   */
  router.put("/projects/:id/path-mappings/:nodeId", async (req, res) => {
    try {
      const { path } = req.body as { path?: unknown };
      if (typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required and must be a non-empty string");
      }
      const normalizedPath = path.trim();
      if (normalizedPath.includes("\0")) {
        throw badRequest("path cannot contain null bytes");
      }
      if (!isAbsolute(normalizedPath)) {
        throw badRequest("path must be an absolute path");
      }

      const mapping = await withCentralCore(async (central) => {
        return await central.upsertProjectNodePathMapping({
          projectId: req.params.id,
          nodeId: req.params.nodeId,
          path: normalizedPath,
        });
      });

      res.json(mapping);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Project not found") || message.includes("Node not found")) {
        throw notFound(message);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/projects/:id/path-mappings/:nodeId
   * Remove a project-node path mapping.
   */
  router.delete("/projects/:id/path-mappings/:nodeId", async (req, res) => {
    try {
      await withCentralCore(async (central) => {
        await central.removeProjectNodePathMapping({
          projectId: req.params.id,
          nodeId: req.params.nodeId,
        });
      });

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/projects/:id
   * Update a project.
   */
  router.patch("/projects/:id", async (req, res) => {
    try {
      const { name, status, isolationMode, nodeId, force } = req.body;

      const updates: Partial<import("@fusion/core").RegisteredProject> = {};
      if (name !== undefined) updates.name = name;
      if (status !== undefined) updates.status = status as import("@fusion/core").ProjectStatus;
      if (isolationMode !== undefined) updates.isolationMode = isolationMode as "in-process" | "child-process";

      const result = await withCentralCore(async (central) => {
        const existing = await central.getProject(req.params.id);
        if (!existing) {
          throw notFound("Project not found");
        }

        const transitionDeferred = false;
        const isolationChanged =
          isolationMode !== undefined && isolationMode !== existing.isolationMode;

        if (isolationChanged) {
          if (options?.hybridExecutor) {
            /*
            FNXC:HybridExecutorBoot 2026-09-26-03:10:
            RUFU-322: a live isolation transition is the one route that needs loaded project runtimes,
            and since the boot no longer awaits `HybridExecutor.initialize()` before HTTP listen, a
            transition can now arrive while runtimes are still loading. Wait for readiness under a
            bounded, injectable window (`hybridExecutorReadyWaitMs`) and answer honestly instead of
            running the transition against a half-built executor or hanging the request: `starting` is
            retryable, `failed` is not. Both refuse the write, so the stored isolationMode stays
            consistent with the live runtime (the same guarantee as `isolation_transition_unavailable`).
            When already initialized this resolves immediately and adds no latency to the common case.
            */
            const readiness = await resolveHybridExecutorReadiness(
              options.hybridExecutor,
              options?.hybridExecutorReadyWaitMs ?? DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS,
            );
            if (readiness !== "ready") {
              const code = readiness === "failed" ? "hybrid_executor_failed" : "hybrid_executor_starting";
              throw new ApiError(503, code, {
                error: code,
                message:
                  readiness === "failed"
                    ? "Live isolation mode transition is unavailable: HybridExecutor failed to load its project runtimes. Fix the reported startup error or restart the dashboard, then retry."
                    : "Live isolation mode transition is unavailable: HybridExecutor is still loading project runtimes. Retry shortly.",
                readyWaitMs: options?.hybridExecutorReadyWaitMs ?? DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS,
              });
            }
            const transition = await options.hybridExecutor.transitionProjectIsolation(
              req.params.id,
              isolationMode as "in-process" | "child-process",
              { force: Boolean(force) },
            );
            if (!transition.ok && transition.reason === "active_tasks") {
              /*
              FNXC:IsolationTransitionBlockers 2026-10-15-06:40 (RUFU-328):
              The 409 body used to be only a count, so an operator staring at "3 active tasks" had no way
              to tell live work from a leaked in-memory binding — the reported incident sat refused for
              hours over two cards whose rows already read `failed`, and nothing on the dashboard named
              them. The ids ride through from the guard's durable read; when that read could not answer,
              the key is OMITTED rather than sent empty, because an empty list would claim the board
              proved nothing blocks while the transition was still refused. `activeTaskCount` remains in
              every shape, so any client reading only the count is unaffected.

              FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
              `inFlightUnproven` is the second thing the count could not say: the refusal came from a
              transport that cannot prove the project idle (a wedged child, an unreachable remote node),
              so `activeTaskCount` is a last-known number that may well be zero while work runs. A client
              that renders the count must branch on this flag, and a retry is only worth it once the
              transport is reachable again — not after moving cards, which was the dead end the reporter
              was left chasing. Omitted, never `false`, for a refusal that really did observe live work.
              */
              throw new ApiError(409, "active_tasks", {
                error: "active_tasks",
                activeTaskCount: transition.activeTaskCount ?? 0,
                ...(transition.blockingTaskIds?.length
                  ? { blockingTaskIds: transition.blockingTaskIds }
                  : {}),
                ...(transition.inFlightUnproven ? { inFlightUnproven: true } : {}),
              });
            }
            delete updates.isolationMode;
          } else {
            // No HybridExecutor available (local-only single-node setup).
            // The previous behavior here was to set transitionDeferred=true
            // and silently persist the new isolationMode while the live
            // ProjectEngine continued under the old isolation — confusing,
            // and the active-tasks safety check was also bypassed.
            // Surface the limitation explicitly so the UI can show a clear
            // error and the user can either restart the dashboard (which
            // picks up the new isolationMode on next ProjectEngine start)
            // or force-enable HybridExecutor via FUSION_HYBRID_EXECUTOR=1.
            throw new ApiError(503, "isolation_transition_unavailable", {
              error: "isolation_transition_unavailable",
              message:
                "Live isolation mode transition requires HybridExecutor, which is disabled on local-only single-node setups. Restart the dashboard to apply the new isolation mode for this project, or set FUSION_HYBRID_EXECUTOR=1 to enable live transitions.",
            });
          }
        }

        const project = await central.updateProject(req.params.id, updates);

        if (nodeId === undefined) {
          return { project, transitionDeferred };
        }
        if (nodeId === null) {
          return {
            project: await central.unassignProjectFromNode(req.params.id),
            transitionDeferred,
          };
        }
        if (typeof nodeId === "string" && nodeId.trim()) {
          return {
            project: await central.assignProjectToNode(req.params.id, nodeId.trim()),
            transitionDeferred,
          };
        }

        throw badRequest("nodeId must be a non-empty string or null");
      });

      res.json(result.transitionDeferred ? { ...result.project, transitionDeferred: true } : result.project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * DELETE /api/projects/:id
   * Unregister a project.
   *
   * FNXC:ProjectLifecycle 2026-06-28-12:00:
   * Unregistering a project removes ONLY the central registry row (and its
   * cascade children: project_health, central_activity_log, path mappings).
   * Task data in project.tasks is NEVER deleted — the table has no FK to
   * central.projects, so tasks survive unregister and are immediately visible
   * when the project is re-added via ensureProjectForPath with the same
   * project ID. This is intentional: operators can remove and re-add projects
   * without data loss.
   *
   * The in-memory TaskStore cache is evicted so stale connections/watchers
   * don't linger after the project is removed from the dashboard.
   */
  router.delete("/projects/:id", async (req, res) => {
    try {
      await withCentralCore(async (central) => {
        await central.unregisterProject(req.params.id);
      });

      // Evict the in-memory store (closes watchers + connection pool) so the
      // dashboard doesn't hold stale resources for an unregistered project.
      // When the project is re-added, getOrCreateProjectStore will re-create it.
      await evictProjectStore(req.params.id);

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/projects/:id/health
   * Get health metrics for a specific project.
   * Computes live task counts from the project-scoped task store to ensure
   * accurate stats for all projects, not just the default/first project.
   * Returns: ProjectHealth
   */
  router.get("/projects/:id/health", async (req, res) => {
    try {
      const health = await withCentralCore(async (central) => {
        const project = await central.getProject(req.params.id);
        if (!project) {
          throw notFound("Project not found");
        }

        // Use the project-scoped store resolver to get the correct store for
        // this project. This ensures we compute counts from the right project,
        // regardless of which project is the dashboard's default.
        const projectStore = await getOrCreateProjectStore(req.params.id);

        // Compute live task counts from the project-specific store
        const tasks = await projectStore.listTasks({ slim: true });
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-31-08:10:
        Project-health "active tasks" is the negation of each card's OWN terminal lanes.

        CENSUS-INVISIBLE: a `Set` literal is a definition, not a comparison. On a renamed board it
        matched nothing, so project health reported **0 active tasks** beside an in-flight agent
        count that was still correct — the same silent-zero shape as the analytics tallies fixed in
        #2780. A zero next to a populated neighbour reads as "this project is idle", not as "this
        number is broken".

        Note the set also listed `triage`, a column U11 deleted, so one of its four entries had been
        dead on every board since that cutover.

        Resolved per card through one shared IR cache; a card whose workflow will not resolve keeps
        the legacy answer via `isTerminalColumnRole`'s own degraded mode.
        */
        const activeIrCache = new Map<string, never>();
        const terminalByTaskId = new Map<string, boolean>();
        for (const t of tasks) {
          const lanes = await resolveTaskLifecycleColumns(projectStore, t.id, activeIrCache as never).catch(() => undefined);
          terminalByTaskId.set(
            t.id,
            lanes === undefined
              ? isTerminalColumnRole(undefined, t.column)
              : t.column === lanes.complete,
          );
        }
        const activeTaskCount = tasks.filter((t) => !terminalByTaskId.get(t.id)).length;
        /*
         * FNXC:GlobalConcurrencyControls 2026-06-26-23:46:
         * Project health In-Flight Agents is a live read-layer count, not persisted slot bookkeeping.
         * Include all shared top-level slot holders, including active in-review reviewer/merger/fix agents, so project-level health matches global concurrency without mutating stored health.
         */
        const inFlightAgentCount = countRunningAgentTasks(tasks);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-00:40 (batch-core):
        Project-health "tasks completed" — landed work, resolved from each task's own workflow. Keyed
        on the literal pair, a board that renamed its complete lane reported 0 completed forever, so
        project health read as a project that had never finished anything.

        SHARED cache across the whole board, so this is one IR resolution per distinct WORKFLOW rather
        than per task: this iterates every task in the project and a per-task resolve would make a
        health read scale with board size.

        Every Complete column counts as landed. Done remains the fallback when the IR cannot be read or resolves empty, as v1-upgraded workflows carry no traits.
        */
        const healthIrCache = new Map<string, WorkflowIr>();
        let totalTasksCompleted = 0;
        for (const t of tasks) {
          let landed: Set<string>;
          try {
            const ir = await resolveWorkflowIrForTask(projectStore, t.id, healthIrCache);
            const lanes = columnsWithFlag(ir, "complete");
            landed = new Set(lanes.length > 0 ? lanes : ["done"]);
          } catch {
            landed = new Set(["done"]);
          }
          if (landed.has(t.column)) totalTasksCompleted += 1;
        }

        // Get central health metadata (if available) to preserve non-count fields
        const centralHealth = await central.getProjectHealth(req.params.id);

        // Build response: use central health as base if available, otherwise synthesize
        const healthBase = centralHealth ?? {
          projectId: req.params.id,
          status: project.status ?? "active",
          activeTaskCount: 0,
          inFlightAgentCount: 0,
          totalTasksCompleted: 0,
          totalTasksFailed: 0,
          updatedAt: new Date().toISOString(),
        };

        return {
          ...healthBase,
          activeTaskCount,
          inFlightAgentCount,
          totalTasksCompleted,
        };
      });

      res.json(health);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/config
   * Get project-specific configuration.
   * Returns: { maxConcurrent: number, rootDir: string }
   */
  router.get("/projects/:id/config", async (req, res) => {
    try {
      const project = await withCentralCore(async (central) => await central.getProject(req.params.id));

      if (!project) {
        throw notFound("Project not found");
      }

      /*
      FNXC:CapacityModel 2026-08-21-15:25:
      FN-9185 replaces this route's historical literal `2` with the target project's
      live settings blob. Registry metadata only establishes existence and rootDir.
      */
      const settings = await (await getOrCreateProjectStore(req.params.id)).getSettingsFast();
      const capacity = resolveEffectiveConcurrency(settings);
      res.json({
        maxConcurrent: capacity.maxConcurrent,
        maxWorktrees: capacity.worktreeLimit ?? settings.maxWorktrees,
        worktreeLimitEnabled: settings.worktreeLimitEnabled !== false,
        rootDir: project.path,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/codebase-metrics
   * Compute bounded, local-only codebase context and apparent disk metrics.
   */
  router.get("/projects/:id/codebase-metrics", async (req, res) => {
    try {
      const metrics = await withCentralCore(async (central) => {
        const project = await central.getProject(req.params.id);
        if (!project) throw notFound("Project not found");
        return await computeCodebaseMetrics(project.path);
      });
      res.json(metrics);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/:id/runtime
   *
   * FNXC:ProjectRuntimeOff 2026-11-07-15:56:
   * The operator toggle for a project's RUNTIME UNLOAD switch (`settings.runtimeEnabled`), the
   * one control that actually stops the minute-long engine passes starving `/api/tasks/page`.
   * It is deliberately NOT `pause`/`resume`: those write `globalPause`/`enginePaused`, which the
   * scheduler consults only at the END of a pass, so the pass and all its DB reads keep running.
   *
   * Writing the setting is the whole contract: the persisted value is what a restart reads, and
   * `ProjectEngine`'s settings listener applies it to the live engine — disarming lanes, never
   * aborting a pass already in flight. Reads are untouched, so the board stays browsable.
   */
  router.post("/projects/:id/runtime", async (req, res) => {
    try {
      const projectId = req.params.id;
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        throw badRequest("`enabled` must be a boolean");
      }

      const engine = options?.engineManager?.getEngine(projectId);
      const store = options?.engineManager?.getStore(projectId) ?? await getOrCreateProjectStore(projectId);
      const prior = (await store.getSettings()).runtimeEnabled !== false;
      await store.updateSettings({ runtimeEnabled: enabled });
      /*
      FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
      The switch is now authored from two operator surfaces: the footer engine menu of the open
      project, and the project card of a turned-off project in the projects list. Any declared
      surface is a human clicking something; only an undeclared call is a bare API client.
      */
      // In-process immediacy: a running engine applies the switch without waiting for its own
      // settings event, and re-applying the current value changes nothing.
      if (engine) await engine.applyRuntimeGate(enabled);

      // One row per operator switch, ids and fixed values only — never prose. Best-effort through
      // the bounded core seam: telemetry cannot fail the switch it reports.
      void emitBoundedRunAudit(store, {
        agentId: "dashboard",
        runId: `project-runtime-toggle:${projectId}:${Date.now()}`,
        domain: "database",
        mutationType: "project:runtime-toggled",
        target: projectId,
        metadata: {
          projectId,
          priorRuntimeEnabled: prior,
          runtimeEnabled: enabled,
          source: req.get("x-fusion-surface") ? "operator-ui" : "operator-api",
        },
      });

      res.json({ projectId, runtimeEnabled: enabled, priorRuntimeEnabled: prior });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/:id/pause
   * Pause a project.
   */
  router.post("/projects/:id/pause", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.pauseProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        await withCentralCore(async (central) => {
          await central.updateProject(projectId, { status: "paused" });
          await central.updateProjectHealth(projectId, { status: "paused" });
        });
      }

      // Fetch and return the updated project
      const project = await withCentralCore(async (central) => await central.getProject(projectId));

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/:id/resume
   * Resume a paused project.
   */
  router.post("/projects/:id/resume", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.resumeProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        await withCentralCore(async (central) => {
          await central.updateProject(projectId, { status: "active" });
          await central.updateProjectHealth(projectId, { status: "active" });
        });
      }

      // Fetch and return the updated project
      const project = await withCentralCore(async (central) => await central.getProject(projectId));

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });
};
