import type { Request } from "express";
import {
  columnsWithFlag,
  createLogger,
  findVitestProcessInventory,
  getAvailableMemoryBytes,
  readProcessCwds,
  resolveWorktreesDirCandidates,
  resolveWorkflowIrForTask,
  type VitestProcessInventory,
} from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { ApiError, notFound, rethrowAsApiError } from "../api-error.js";
import { resolveHeapCeiling } from "../lib/heap-ceiling.js";
import { fetchFromRemoteNode } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";
import os from "node:os";
import { resolve as resolvePath } from "node:path";
import v8 from "node:v8";

const vitestScopeLog = createLogger("dashboard-system-maintenance");

/**
 * FNXC:RouteModularity 2026-07-19-18:00:
 * System maintenance routes moved with their process-local CPU sampling helpers so
 * stats remain accurate while the registrar stays before model/auth routes.
 */
export const registerSystemMaintenanceRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext } = ctx;
let lastCpuUsageSample: NodeJS.CpuUsage | null = null;
let lastCpuSampleAt: number | null = null;

const getAppCpuPercent = (): number | null => {
  const currentCpuUsage = process.cpuUsage();
  const currentSampleAt = Date.now();

  if (lastCpuUsageSample === null || lastCpuSampleAt === null) {
    lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
    lastCpuSampleAt = currentSampleAt;
    return null;
  }

  const elapsedMs = currentSampleAt - lastCpuSampleAt;
  const cpuUsageDelta = process.cpuUsage(lastCpuUsageSample);

  lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
  lastCpuSampleAt = currentSampleAt;

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }

  const elapsedMicros = elapsedMs * 1_000;
  const usedMicros = cpuUsageDelta.user + cpuUsageDelta.system;
  if (!Number.isFinite(usedMicros) || usedMicros < 0) {
    return null;
  }

  return Math.max(0, Number(((usedMicros / elapsedMicros) * 100).toFixed(1)));
};

/*
FNXC:VitestKillScope 2026-11-21-01:37 (RUFU-760):
The directories whose ownership makes a process killable for THIS project: its own checkout plus every
managed task-worktree root. `worktreesDir` is read from the request's own project store, because a
configured root is exclusive — resolving it from the launch project instead would put another
project's workers out of scope and this project's own workers would be missed.

An unresolvable project resolves to NO roots, which the probe reads as "run unscoped", i.e. exactly
the pre-attribution behavior. A failed lookup must never make a destructive action stricter, and it
must never answer an operator's kill with a silent no-op.
*/
const resolveVitestScopeRoots = async (req: Request): Promise<string[]> => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();
    const settings = await scopedStore.getSettingsFast();
    const candidates = [
      rootDir,
      ...resolveWorktreesDirCandidates(rootDir, { worktreesDir: settings.worktreesDir }),
    ];
    const roots = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
      roots.add(resolvePath(candidate));
    }
    return [...roots];
  } catch {
    return [];
  }
};

/*
FNXC:VitestKillScope 2026-11-21-01:37 (RUFU-760):
ONE resolution for both surfaces. `GET /api/system-stats` reports `vitestProcessCount` and
`POST /api/kill-vitest` signals the set; when they resolved scope independently, the number the
operator read and the pids the button signalled could be two different sets — the count showing one
project while the kill reached another. No `procRoot` is ever passed from here: `resolveProcRoot()`
remains the single decider of where the process table is read, in production and in tests alike.
*/
const getVitestProcessInventory = async (req: Request): Promise<VitestProcessInventory> => {
  // Async pgrep/ps via the core probe so the dashboard's event loop stays responsive while the
  // process table is walked. The probe first filters matches to actual node processes — a bare
  // `pgrep -f vitest` also matches wrapper shells, monitors, and editors whose command line merely
  // mentions vitest, and SIGKILLing those took out unrelated process trees (2026-06-03 incident) —
  // and then drops only candidates whose cwd provably belongs to another checkout (RUFU-760).
  const scopeRoots = await resolveVitestScopeRoots(req);
  return scopeRoots.length > 0
    ? findVitestProcessInventory({ scopeRoots })
    : findVitestProcessInventory();
};

const collectSystemStatsResponse = async (req: Request) => {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const load = os.loadavg();
  const vitestInventory = await getVitestProcessInventory(req);
  const cpuPercent = getAppCpuPercent();

  let totalTasks = 0;
  let activeTasks = 0;
  const byColumn: Record<string, number> = {
    triage: 0,
    todo: 0,
    "in-progress": 0,
    "in-review": 0,
    done: 0,
  };
  const agentCounts = { idle: 0, active: 0, running: 0, error: 0 };
  let vitestLastAutoKillAt: string | null = null;

  try {
    const { store: scopedStore } = await getProjectContext(req);

    const globalSettingsStore = scopedStore.getGlobalSettingsStore?.();
    if (globalSettingsStore?.getSettings) {
      const globalSettings = await globalSettingsStore.getSettings();
      const candidate = (globalSettings as Record<string, unknown>).vitestLastAutoKillAt;
      if (typeof candidate === "string" && candidate.length > 0) {
        vitestLastAutoKillAt = candidate;
      }
    }

    const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
    totalTasks = tasks.length;

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-00:35 (batch-core):
    "Is this card ACTIVE?" for the maintenance health count — WIP or review, resolved from each task's
    own workflow. Keyed on the literal pair, a board that renamed either lane reported ZERO active
    tasks, and the health panel showed an idle system while work was running.

    Resolved through a SHARED cache across the loop, so this costs one IR resolution per distinct
    WORKFLOW rather than one per task. That matters here specifically because this iterates the whole
    board; a per-task resolve would turn a cheap count into an N-round-trip scan.

    Membership over both roles, with the legacy pair as the fallback when the IR cannot be read or
    resolves empty (a v1-upgraded workflow carries `traits: []` on every synthesized column, so empty
    means UNEXPRESSED, not absent).
    */
    const irCache = new Map<string, WorkflowIr>();
    const activeColumnsCache = new Map<string, Set<string>>();
    for (const task of tasks) {
      byColumn[task.column] = (byColumn[task.column] ?? 0) + 1;
      let active = activeColumnsCache.get(task.id);
      if (!active) {
        try {
          const ir = await resolveWorkflowIrForTask(scopedStore, task.id, irCache);
          const lanes = [
            ...columnsWithFlag(ir, "countsTowardWip"),
            ...columnsWithFlag(ir, "mergeOrchestration"),
            ...columnsWithFlag(ir, "mergeBlocker"),
            ...columnsWithFlag(ir, "humanReview"),
          ];
          active = new Set(lanes.length > 0 ? lanes : ["in-progress", "in-review"]);
        } catch {
          active = new Set(["in-progress", "in-review"]);
        }
        activeColumnsCache.set(task.id, active);
      }
      if (active.has(task.column)) {
        activeTasks += 1;
      }
    }

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
    await agentStore.init();
    const agents = await agentStore.listAgents();
    for (const agent of agents) {
      const state = agent.state as keyof typeof agentCounts;
      if (state in agentCounts) {
        agentCounts[state] += 1;
      }
    }
  } catch {
    // System stats should still be available even when project resolution/scoped store fails.
  }

  /*
  FNXC:HeapCeilingObservability 2026-10-01-11:02 (RUFU-462):
  `heapLimit` already published the ceiling, but with no provenance — the panel could show "16 GiB" while the
  process actually ran on the ~4 GiB V8 default under a different label, which is precisely the ambiguity that
  hid the 28-restart OOM. The source is classified FROM THE SAME `heapStats` sample on the same line, so the
  reported number and its provenance cannot drift apart (a live re-read against a boot-time memo would).
  Observation only: this never changes the ceiling.
  */
  const heapCeiling = resolveHeapCeiling({ heapSizeLimitBytes: heapStats.heap_size_limit });

  return {
    systemStats: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: heapStats.heap_size_limit,
      heapLimitSource: heapCeiling.source,
      heapLimitIsV8Default: heapCeiling.isV8Default,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      cpuPercent,
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: os.cpus().length,
      systemTotalMem: os.totalmem(),
      /*
      FNXC:CommandCenter 2026-06-21-13:01:
      The public `systemFreeMem` field carries OS-available memory so SystemStatsArea derives Memory Used from reclaimable-aware bytes and matches Activity Monitor on macOS.
      */
      systemFreeMem: getAvailableMemoryBytes(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    taskStats: {
      total: totalTasks,
      byColumn,
      active: activeTasks,
      agents: agentCounts,
    },
    vitestProcessCount: vitestInventory.pids.length,
    vitestLastAutoKillAt,
  };
};

/**
 * GET /api/system-stats
 * Returns process/system metrics plus task and agent aggregates.
 */
router.get("/system-stats", async (req, res) => {
  try {
    res.json(await collectSystemStatsResponse(req));
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/*
FNXC:CommandCenter 2026-07-19-18:00:
The Command Center System area views per-node stats by defaulting to this local process and proxying remote selections to the node's authenticated /api/system-stats endpoint. The shared CPU/vitest helpers now live in this early registrar so the historical route precedence is retained without keeping the route inline in routes.ts.
*/
router.get("/nodes/:id/system-stats", async (req, res) => {
  try {
    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore();
    let node: Awaited<ReturnType<typeof central.getNode>>;
    await central.init();
    try {
      node = await central.getNode(req.params.id);
    } finally {
      await central.close();
    }

    if (!node) {
      throw notFound("Node not found");
    }

    if (node.type === "local") {
      res.json(await collectSystemStatsResponse(req));
      return;
    }

    res.json(await fetchFromRemoteNode(node, "/api/system-stats"));
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * POST /api/kill-vitest
 * Kill the running vitest processes of the request's project (excluding this process).
 *
 * FNXC:VitestKillScope 2026-11-21-01:37 (RUFU-760):
 * The handler used to take `_req` and signal every node process on the host whose command line
 * mentioned vitest, so the project the client sent decided nothing and a second checkout's test run
 * died when an operator killed vitest for the project they were looking at. The request's project now
 * decides the set, which is the same set the count above reports. A spared foreign pid is logged
 * with its resolved cwd, so a kill that did fewer things than expected stays explainable afterwards;
 * the log names pids and paths and carries nothing from those processes themselves.
 */
router.post("/kill-vitest", async (req, res) => {
  try {
    const vitestInventory = await getVitestProcessInventory(req);

    if (vitestInventory.foreignPids.length > 0) {
      const foreignCwds = readProcessCwds(vitestInventory.foreignPids);
      const detail = vitestInventory.foreignPids
        .map((pid) => `${pid}=${foreignCwds.cwds.get(pid) ?? "unknown"}`)
        .join(" ");
      vitestScopeLog.warn(
        `Spared ${vitestInventory.foreignPids.length} vitest process(es) whose cwd is outside this project's checkout and managed worktrees: ${detail}`,
      );
    }

    const killedPids: number[] = [];

    for (const pid of vitestInventory.pids) {
      try {
        process.kill(pid, "SIGKILL");
        killedPids.push(pid);
      } catch {
        // Process may have exited before kill.
      }
    }

    res.json({
      killed: killedPids.length,
      pids: killedPids,
    });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to kill vitest processes");
  }
});

// ── Maintenance Routes ─────────────────────────────────────────────

/**
 * GET /api/maintenance/legacy-automerge-stamps
 * Dry-run the legacy auto-merge stamp cleanup and list candidates.
 */
router.get("/maintenance/legacy-automerge-stamps", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const candidates = await scopedStore.reconcileLegacyAutoMergeStamps();
    res.json({ candidates, count: candidates.length });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to list legacy auto-merge stamps");
  }
});

/**
 * POST /api/maintenance/legacy-automerge-stamps/apply
 * Apply the legacy auto-merge stamp cleanup via the store-owned reconcile API.
 */
router.post("/maintenance/legacy-automerge-stamps/apply", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const cleared = await scopedStore.reconcileLegacyAutoMergeStamps({ apply: true });
    res.json({ cleared, count: cleared.length });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to apply legacy auto-merge stamp cleanup");
  }
});

// ── Backup Routes ─────────────────────────────────────────────────

/**
 * GET /api/backups
 * List all database backups with metadata.
 */
router.get("/backups", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const {
      BACKUP_SCHEDULE_NAME,
      GlobalRoutineStore,
      buildBackupScheduleStatus,
      createBackupManager,
      resolveGlobalBackupRoot,
    } = await import("@fusion/core");
    const settings = await scopedStore.getSettings();
    const asyncLayer = scopedStore.getAsyncLayer?.();
    const routine = asyncLayer
      ? await new GlobalRoutineStore(asyncLayer).getByName(BACKUP_SCHEDULE_NAME)
      : undefined;
    const schedule = buildBackupScheduleStatus(settings, routine);

    /*
    FNXC:SettingsBackups 2026-08-13-23:51:
    Backup inventory failures must not hide schedule evidence. Operators need to
    distinguish an unavailable listing backend from an unregistered routine.
    */
    try {
      const manager = createBackupManager(resolveGlobalBackupRoot(scopedStore), settings);
      const backups = (await manager.listBackups()).sort((left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
      const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
      res.json({ backups, count: backups.length, totalSize, schedule });
    } catch (err: unknown) {
      res.json({
        backups: [],
        count: 0,
        totalSize: 0,
        schedule,
        listError: err instanceof Error ? err.message : "Unable to list backups",
      });
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to load backup schedule");
  }
});

/**
 * POST /api/backups
 * Create a new database backup immediately.
 */
router.post("/backups", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const { runBackupCommand, resolveGlobalBackupRoot } = await import("@fusion/core");
    const settings = await scopedStore.getSettings();
    const result = await runBackupCommand(resolveGlobalBackupRoot(scopedStore), settings);

    if (result.success) {
      res.json({
        success: true,
        backupPath: result.backupPath,
        output: result.output,
        deletedCount: result.deletedCount,
      });
    } else {
      throw new ApiError(500, result.output);
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to create backup");
  }
});

};
