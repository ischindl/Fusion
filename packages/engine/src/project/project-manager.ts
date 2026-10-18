import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createTaskStoreForBackend, resolveEffectiveConcurrency, type Task, type CentralCore, type RegisteredProject } from "@fusion/core";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { ChildProcessRuntime } from "../runtimes/child-process-runtime.js";
import { RemoteNodeRuntime } from "../runtimes/remote-node-runtime.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  GlobalMetrics,
  RuntimeStopOptions,
  InFlightObservation,
} from "./project-runtime.js";
import { INFLIGHT_OBSERVATION_READ_TIMEOUT_MS } from "./project-runtime.js";
import type { IsolationBlockerAnswer } from "./isolation-transition-blockers.js";
import { ISOLATION_BLOCKER_READ_TIMEOUT_MS } from "./isolation-transition-blockers.js";
import { projectManagerLog } from "../logger.js";

/**
 * Events emitted by ProjectManager with project attribution.
 */
export interface ProjectManagerEvents {
  /** Emitted when a task is created in any project */
  "task:created": [data: { projectId: string; projectName: string; task: Task }];
  /** Emitted when a task is deleted in any project */
  "task:deleted": [data: { projectId: string; projectName: string; task: Task; meta?: { githubIssueAction?: import("@fusion/core").GithubIssueAction; observed?: boolean; outboxEventId?: string } }];
  /** Emitted when a task is moved in any project */
  "task:moved": [
    data: {
      projectId: string;
      projectName: string;
      task: Task;
      from: string;
      to: string;
    }
  ];
  /** Emitted when a task is updated in any project */
  "task:updated": [data: { projectId: string; projectName: string; task: Task }];
  /** Emitted when an error occurs in any project */
  "error": [data: { projectId: string; projectName: string; error: Error }];
  /** Emitted when project health status changes */
  "health:changed": [
    data: {
      projectId: string;
      projectName: string;
      status: RuntimeStatus;
      previous: RuntimeStatus;
    }
  ];
  /** Emitted when a runtime is added */
  "runtime:added": [data: { projectId: string; projectName: string }];
  /** Emitted when a runtime is removed */
  "runtime:removed": [data: { projectId: string; projectName: string }];
  /** Emitted when a runtime is restarted */
  "project:runtime-restarted": [data: { projectId: string; projectName: string; isolationMode: import("@fusion/core").IsolationMode; reason?: string }];
}



export interface ProjectRuntimeRestartBlockedError {
  kind: "active_tasks";
  count: number;
  /**
   * Which cards the durable read counted as blockers, when the read was able to answer. Absent whenever
   * it could not (no store, hang, rejection, or a runtime with no durable-read path), which is also the
   * only case where `count` is a live-holder number rather than the size of a proven set.
   */
  taskIds?: string[];
  /*
  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  `unproven` distinguishes the one refusal that is NOT a positive observation of live work: the transport
  could not prove the project idle, so `count` is a last-known number that may be zero while work runs.
  Without it, "a card is executing" and "we cannot tell" reach the operator as the same sentence, which
  is how RUFU-332's remote-node report read as a phantom busy project. A proven-busy refusal omits the
  key entirely rather than writing `false` — absence already means "the count is an observation".
  */
  /**
   * True when the refusal rests on a transport that could not prove the project idle, rather than on an
   * observation of live work. Only ever present on a bare-count refusal (no `taskIds`).
   */
  unproven?: boolean;
}

export function isProjectRuntimeRestartBlockedError(error: unknown): error is ProjectRuntimeRestartBlockedError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { kind?: unknown; count?: unknown };
  return candidate.kind === "active_tasks" && typeof candidate.count === "number";
}

/*
FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
One clause naming what an observation proved, shared by the release and refusal log lines so an operator
reading the engine log can attribute a stall to a transport (`in-process`, `child-process`, `remote-node`,
or `unavailable` for a runtime that gave no answer at all) instead of guessing from a bare count.
*/
function describeInFlightObservation(observation: InFlightObservation): string {
  return observation.proven
    ? `the ${observation.source} transport reports ${observation.inFlightTasks} live card(s)`
    : `the ${observation.source} transport cannot prove idleness (last known count: ${observation.inFlightTasks})`;
}

/**
 * ProjectManager orchestrates all project runtimes and enforces global
 * concurrency limits from CentralCore.
 *
 * This is the main entry point for multi-project support in the engine.
 * It manages multiple ProjectRuntime instances (one per project) and:
 * - Creates appropriate runtime type based on isolation mode
 * - Forwards runtime events with project attribution
 * - Enforces global concurrency limits via CentralCore
 * - Updates project health in CentralCore
 * - Logs activity to CentralCore's unified feed
 *
 * **Project Registration Assumption:**
 * ProjectManager assumes projects are already registered in CentralCore.
 * Call `centralCore.registerProject()` before `addProject()`.
 *
 * @example
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * const manager = new ProjectManager(central);
 *
 * // Register project in CentralCore first
 * const project = await central.registerProject({
 *   name: "My Project",
 *   path: "/path/to/project"
 * });
 *
 * // Then add runtime
 * const runtime = await manager.addProject({
 *   projectId: project.id,
 *   workingDirectory: await central.resolveLocalProjectWorkingDirectory(project.id),
 *   isolationMode: "in-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * });
 *
 * // Listen to all project events
 * manager.on("task:created", ({ projectId, projectName, task }) => {
 *   console.log(`${projectName}: Task ${task.id} created`);
 * });
 * ```
 */
export class ProjectManager extends EventEmitter<ProjectManagerEvents> {
  private runtimes = new Map<string, ProjectRuntime>();
  private projectNames = new Map<string, string>();
  /*
  FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
  The shared cross-project semaphore, its mutable limit, the 30s reconciliation
  poll and the live `concurrency:changed` subscription are all DELETED. Capacity is
  two numbers PER PROJECT; the machine-wide cap was a third limiter kept in a
  separate authority (a central-DB singleton row) which every runtime then had to
  subscribe to and periodically re-reconcile. Removing the limiter removes the
  subscription, the poll, and the drift between them in one step.
  */

  /**
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(private centralCore: CentralCore) {
    super();
    this.setMaxListeners(100);

    projectManagerLog.log("ProjectManager initialized");
  }

  /**
   * Add a project runtime and start it.
   *
   * **Prerequisite:** Project must already be registered in CentralCore.
   *
   * @param config - Runtime configuration (must match a registered project)
   * @returns The created and started ProjectRuntime
   * @throws Error if project not found in CentralCore or runtime already exists
   */
  async addProject(config: ProjectRuntimeConfig): Promise<ProjectRuntime> {
    // Validate project exists in CentralCore
    const project = await this.centralCore.getProject(config.projectId);
    if (!project) {
      throw new Error(
        `Project ${config.projectId} not found in CentralCore. ` +
          "Register the project first with centralCore.registerProject()."
      );
    }

    // Check if runtime already exists
    if (this.runtimes.has(config.projectId)) {
      throw new Error(`Runtime already exists for project ${config.projectId}`);
    }

    projectManagerLog.log(`Adding project runtime for ${config.projectId} (${project.name})`);

    // Store project name for event attribution
    this.projectNames.set(config.projectId, project.name);

    // Create appropriate runtime based on isolation mode
    let runtime: ProjectRuntime;
    const configWithSemaphore = { ...config };

    if (config.isolationMode === "child-process") {
      runtime = new ChildProcessRuntime(configWithSemaphore, this.centralCore);
    } else {
      let assignedNode = undefined;

      if (project.nodeId) {
        assignedNode = await this.centralCore.getNode(project.nodeId);

        if (!assignedNode) {
          projectManagerLog.warn(
            `Assigned node ${project.nodeId} not found for project ${project.id}; falling back to InProcessRuntime`
          );
        }
      }

      if (assignedNode?.type === "remote") {
        runtime = new RemoteNodeRuntime({
          nodeConfig: assignedNode,
          projectId: config.projectId,
          projectName: project.name,
        });
      } else {
        // Default to local in-process runtime (includes unassigned + local-node assigned)
        runtime = new InProcessRuntime(configWithSemaphore, this.centralCore);
      }
    }

    // Set up event forwarding with project attribution
    this.setupEventForwarding(runtime, config.projectId, project.name);

    // Start the runtime
    await runtime.start();

    // Update project health to active
    await this.centralCore.updateProjectHealth(config.projectId, {
      status: "active",
      activeTaskCount: 0,
      inFlightAgentCount: 0,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
      updatedAt: new Date().toISOString(),
    });

    // Update project status from "initializing" to "active"
    await this.centralCore.updateProject(project.id, {
      status: "active",
    });

    // Store runtime
    this.runtimes.set(config.projectId, runtime);

    // Log to activity feed
    await this.centralCore.logActivity({
      type: "task:created", // Using task:created as a generic activity type
      projectId: config.projectId,
      projectName: project.name,
      timestamp: new Date().toISOString(),
      details: `Project runtime started for ${project.name}`,
    });

    this.emit("runtime:added", { projectId: config.projectId, projectName: project.name });

    projectManagerLog.log(`Project runtime added for ${config.projectId}`);
    return runtime;
  }

  /**
   * Remove a project runtime and stop it.
   *
   * @param id - Project ID to remove
   * @param stopOptions - Optional shutdown budget carried from a caller that already spent part of its
   *   own transition bound (see {@link restartProjectRuntime}); omitted means the runtime derives its own.
   * @throws Error if runtime not found
   */
  async removeProject(id: string, stopOptions?: RuntimeStopOptions): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw new Error(`Runtime not found for project ${id}`);
    }

    const projectName = this.projectNames.get(id) ?? id;
    projectManagerLog.log(`Removing project runtime for ${id}`);

    // Stop the runtime
    await runtime.stop(stopOptions);

    // Remove from maps
    this.runtimes.delete(id);
    this.projectNames.delete(id);

    // Update project health to paused
    await this.centralCore.updateProjectHealth(id, {
      status: "paused",
      activeTaskCount: 0,
      inFlightAgentCount: 0,
      updatedAt: new Date().toISOString(),
    });

    // Log to activity feed
    await this.centralCore.logActivity({
      type: "task:created",
      projectId: id,
      projectName: projectName,
      timestamp: new Date().toISOString(),
      details: `Project runtime stopped for ${projectName}`,
    });

    this.emit("runtime:removed", { projectId: id, projectName });

    projectManagerLog.log(`Project runtime removed for ${id}`);
  }

  /**
   * Get a runtime by project ID.
   */
  getRuntime(id: string): ProjectRuntime | undefined {
    return this.runtimes.get(id);
  }

  /**
   * List all managed runtimes.
   */
  listRuntimes(): ProjectRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /**
   * Get all project IDs.
   */
  getProjectIds(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * Get global metrics aggregated across all runtimes.
   *
   * FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
   * This is the DISPLAY / HEALTH consumer of `getMetrics()` — dashboard polling and health reporting — and
   * stays on the cached estimate deliberately: aggregating an awaited probe per runtime would make a
   * dashboard poll depend on every transport's reachability. Lifecycle decisions never read here; see
   * `restartProjectRuntime`, which decides from `observeInFlight()`.
   */
  async getGlobalMetrics(): Promise<GlobalMetrics> {
    const statusCounts: Record<RuntimeStatus, number> = {
      active: 0,
      paused: 0,
      errored: 0,
      stopped: 0,
      starting: 0,
      stopping: 0,
    };

    let totalInFlight = 0;
    let totalActiveAgents = 0;

    for (const [id, runtime] of this.runtimes) {
      const status = runtime.getStatus();
      statusCounts[status]++;

      try {
        const metrics = runtime.getMetrics();
        totalInFlight += metrics.inFlightTasks;
        totalActiveAgents += metrics.activeAgents;

        // Update health in CentralCore
        const project = await this.centralCore.getProject(id);
        if (project) {
          await this.centralCore.updateProjectHealth(id, {
            status: status as "active" | "paused" | "errored" | "initializing",
            activeTaskCount: metrics.inFlightTasks,
            inFlightAgentCount: metrics.activeAgents,
            lastActivityAt: metrics.lastActivityAt,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        projectManagerLog.warn(`Failed to get metrics for ${id}:`, error);
      }
    }

    return {
      totalInFlightTasks: totalInFlight,
      totalActiveAgents: totalActiveAgents,
      runtimeCountByStatus: statusCounts,
      totalRuntimes: this.runtimes.size,
    };
  }

  /**
   * Set up event forwarding from runtime to ProjectManager listeners.
   */
  private setupEventForwarding(
    runtime: ProjectRuntime,
    projectId: string,
    projectName: string
  ): void {
    // Forward task:created
    runtime.on("task:created", (task: Task) => {
      this.emit("task:created", { projectId, projectName, task });
      this.logActivity("task:created", projectId, projectName, `Task ${task.id} created`, task.id, task.title).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:created activity for ${projectId}:`, err);
      });
    });

    // Forward task:moved
    runtime.on("task:moved", (data: { task: Task; from: string; to: string }) => {
      this.emit("task:moved", { projectId, projectName, task: data.task, from: data.from, to: data.to });
      this.logActivity(
        "task:moved",
        projectId,
        projectName,
        `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
        data.task.id,
        data.task.title,
        { from: data.from, to: data.to }
      ).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:moved activity for ${projectId}:`, err);
      });
    });

    // Forward task:updated
    runtime.on("task:updated", (task: Task) => {
      this.emit("task:updated", { projectId, projectName, task });
    });

    // Forward task:deleted
    runtime.on("task:deleted", (task: Task, meta?: { githubIssueAction?: import("@fusion/core").GithubIssueAction; observed?: boolean; outboxEventId?: string }) => {
      this.emit("task:deleted", { projectId, projectName, task, meta });
    });

    // Forward errors
    runtime.on("error", (error: Error) => {
      this.emit("error", { projectId, projectName, error });
      this.logActivity(
        "task:failed",
        projectId,
        projectName,
        `Error in ${projectName}: ${error.message}`
      ).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:failed activity for ${projectId}:`, err);
      });
    });

    // Forward health changes
    runtime.on("health-changed", (data: { status: RuntimeStatus; previous: RuntimeStatus }) => {
      this.emit("health:changed", { projectId, projectName, status: data.status, previous: data.previous });

      // Update health in CentralCore
      this.centralCore.updateProjectHealth(projectId, {
        status: data.status as "active" | "paused" | "errored" | "initializing",
        updatedAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to update health for ${projectId}:`, err);
      });
    });
  }

  /**
   * Log activity to CentralCore's unified feed.
   */
  private async logActivity(
    type: "task:created" | "task:moved" | "task:failed",
    projectId: string,
    projectName: string,
    details: string,
    taskId?: string,
    taskTitle?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.centralCore.logActivity({
        type,
        projectId,
        projectName,
        timestamp: new Date().toISOString(),
        details,
        taskId,
        taskTitle,
        metadata,
      });
    } catch (error) {
      // Best-effort logging
      projectManagerLog.warn("Failed to log activity:", error);
    }
  }

  /*
  FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
  `acquireGlobalSlot` / `releaseGlobalSlot` are DELETED. Measured: they had NO
  production callers — only tests — so the central-DB `currentlyActive` counter
  they maintained was never incremented by real work. The cross-project cap had two
  mechanisms, an in-memory semaphore (live) and this durable slot counter (dead);
  both are gone with the limiter itself.
  */


  /**
   * Ask a runtime which of its in-flight cards a transition would actually destroy, degrading every
   * hostile outcome — a runtime with no such path, a throw, or a hang — into a bare `null`.
   *
   * The `null` is load-bearing: the caller reads it as "cannot answer" and refuses exactly as it did
   * before this capability existed. It must never collapse into `[]`, which means "proven settled" and
   * releases the transition. The runtime already bounds its own read; this bound is the transport's, so
   * a runtime whose method never returns cannot hold the transition open indefinitely either.
   */
  private async readIsolationTransitionBlockers(
    runtime: ProjectRuntime,
    budgetMs = ISOLATION_BLOCKER_READ_TIMEOUT_MS,
  ): Promise<IsolationBlockerAnswer | null> {
    if (!runtime.getInFlightBlockers) return null;
    try {
      const answer = await Promise.race<IsolationBlockerAnswer | null>([
        runtime.getInFlightBlockers({ budgetMs }),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), budgetMs);
          timer.unref?.();
        }),
      ]);
      return answer && typeof answer === "object" && (answer.taskIds === null || Array.isArray(answer.taskIds))
        ? answer
        : null;
    } catch (error) {
      projectManagerLog.warn(
        `Durable blocker read failed for one runtime (${error instanceof Error ? error.message : String(error)}); falling back to the in-flight metric`,
      );
      return null;
    }
  }

  /*
  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  The observation the guard decides from, with every hostile outcome degraded to `proven: false` over the
  last known number rather than to a throw. A runtime that declares no `observeInFlight` keeps its
  historical treatment — its synchronous `getMetrics()` is authoritative by construction, which is the
  contract the in-process transport and the doubles in this file's tests present — so absent means proven,
  NOT unproven; reading absence as unproven would refuse every transition the moment a transport declines
  to implement the seam, which is the false-409 direction this guard already fights.

  The bound is `INFLIGHT_OBSERVATION_READ_TIMEOUT_MS`, deliberately above the transport's own probe budget
  so the transport wins the race and its `proven: false` is what gets reported; this bound only stops a
  method that never returns from holding a transition open. `getMetrics()` is never consulted on the
  `force` path — it is not a cheap call on an isolated transport — so a runtime whose metric throws cannot
  break a forced restart.
  */
  private async readInFlightObservation(runtime: ProjectRuntime): Promise<InFlightObservation> {
    const lastKnownCount = (): number => {
      try {
        return runtime.getMetrics().inFlightTasks;
      } catch {
        // A runtime that cannot even answer the display question certainly cannot prove idleness; the
        // count it would have carried is moot, because `proven: false` refuses either way.
        return 0;
      }
    };

    if (!runtime.observeInFlight) {
      return { inFlightTasks: lastKnownCount(), proven: true, source: "unavailable" };
    }

    try {
      const answer = await Promise.race<InFlightObservation | null>([
        runtime.observeInFlight(),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), INFLIGHT_OBSERVATION_READ_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (
        answer &&
        typeof answer === "object" &&
        typeof answer.inFlightTasks === "number" &&
        Number.isFinite(answer.inFlightTasks) &&
        typeof answer.proven === "boolean"
      ) {
        return answer;
      }
      projectManagerLog.warn(
        "In-flight observation came back unusable; treating the runtime as unable to prove idleness",
      );
      return { inFlightTasks: lastKnownCount(), proven: false, source: "unavailable" };
    } catch (error) {
      projectManagerLog.warn(
        `In-flight observation failed (${error instanceof Error ? error.message : String(error)}); treating the runtime as unable to prove idleness`,
      );
      return { inFlightTasks: lastKnownCount(), proven: false, source: "unavailable" };
    }
  }

  async restartProjectRuntime(projectId: string, options?: { reason?: string; force?: boolean }): Promise<void> {
    // One timestamp for the whole attempt, so the guard's decision and the shutdown that follows it
    // divide a single bound instead of each being handed a fresh one.
    const runtime = this.runtimes.get(projectId);
    if (!runtime) {
      throw new Error(`Runtime not found for project ${projectId}`);
    }

    // Set only on the proven-clear path: the drain budget the runtime handed back, and the moment it
    // handed it back, so the shutdown can be charged for everything that happened since.
    let carriedDrainMs: number | undefined;
    let answeredAtMs: number | undefined;
    /*
    FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
    The decision input is an OBSERVATION, not a metric. `getMetrics()` is a display/health estimate whose
    per-transport contract differs — cached fire-and-forget over IPC, cached-and-refreshed-unawaited over
    HTTP — and the guard previously read whichever number the last round trip happened to leave behind.
    That produced both directions of the reported bug: a child cache stuck high refused a transition for
    work that had already ended, and a remote node whose fetch failed reported zero, which permitted a
    transition over possibly-live work. `observeInFlight()` answers now and says whether it got there.
    */
    const observation = options?.force ? undefined : await this.readInFlightObservation(runtime);
    /*
    FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
    The in-flight answer used to come from process memory alone, so a card whose durable row was a
    terminal park — `failed` in the in-progress lane, nothing running behind it — refused isolation
    transitions forever, and the operator's only route to the setting was deleting or moving cards from
    an unrelated screen. Durable state is what releases that class, and RUFU-332 left the rule standing:
    - a proven-empty blocker set proceeds even though the transport says busy or cannot prove idleness;
    - a non-empty set refuses and names the cards, so the refusal can be read without guessing;
    - a cannot-answer (no durable read, a hang, a rejection, or a runtime with no such path) refuses and
      carries no ids, because "the store would not answer" is not evidence of an idle runtime.
    `force: true` never reaches either read at all: same behaviour, same instant return, as before.
    */
    if (observation && (observation.inFlightTasks > 0 || !observation.proven)) {
      const answer = await this.readIsolationTransitionBlockers(runtime);

      if (answer && Array.isArray(answer.taskIds)) {
        if (answer.taskIds.length > 0) {
          throw {
            kind: "active_tasks",
            count: observation.inFlightTasks,
            taskIds: answer.taskIds,
          } satisfies ProjectRuntimeRestartBlockedError;
        }
        projectManagerLog.log(
          `Project ${projectId}: ${describeInFlightObservation(observation)}, durable state proves no blocker — proceeding with the transition`,
        );
        carriedDrainMs = typeof answer.drainMs === "number" ? answer.drainMs : undefined;
        answeredAtMs = Date.now();
      } else {
        projectManagerLog.warn(
          `Project ${projectId}: refusing the transition — ${describeInFlightObservation(observation)} and the durable read could not answer`,
        );
        throw {
          kind: "active_tasks",
          count: observation.inFlightTasks,
          ...(observation.proven ? {} : { unproven: true }),
        } satisfies ProjectRuntimeRestartBlockedError;
      }
    }

    const project = await this.centralCore.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const workingDirectory = await this.centralCore.resolveLocalProjectWorkingDirectory(projectId);
    /*
    FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
    Only the proven-clear path carries a drain budget. The runtime already charged its own decision time
    to it; the project lookups above spent more of the same attempt, so they are charged here too. A
    refusal never reaches this line and `force` never consulted durable state, so both keep the
    historical full drain a runtime derives for itself.
    */
    const stopOptions: RuntimeStopOptions | undefined =
      answeredAtMs === undefined
        ? undefined
        : {
            drainMs: Math.max(
              0,
              (carriedDrainMs ?? 0) - (Date.now() - answeredAtMs),
            ),
          };
    await this.removeProject(projectId, stopOptions);

    const capacity = await this.resolveStartupConcurrency(project, workingDirectory);
    await this.addProject({
      projectId,
      workingDirectory,
      isolationMode: project.isolationMode,
      maxConcurrent: capacity.maxConcurrent,
      maxWorktrees: capacity.worktreeLimit ?? capacity.maxConcurrent,
      settings: project.settings,
    });

    this.emit("project:runtime-restarted", {
      projectId,
      projectName: project.name,
      isolationMode: project.isolationMode,
      reason: options?.reason,
    });
  }

  /*
  FNXC:CapacityModel 2026-08-21-15:45:
  Runtime restarts must preserve FN-9185's live-settings precedence instead of restoring a stale registry snapshot.
  */
  private async resolveStartupConcurrency(project: RegisteredProject, workingDirectory: string) {
    if (!existsSync(workingDirectory)) return resolveEffectiveConcurrency(project.settings);
    try {
      const boot = await createTaskStoreForBackend({ rootDir: workingDirectory, projectId: project.id });
      try {
        return resolveEffectiveConcurrency(await boot.taskStore.getSettingsFast());
      } finally {
        await boot.shutdown();
      }
    } catch {
      return resolveEffectiveConcurrency(project.settings);
    }
  }

  /**
   * Stop all runtimes and clean up.
   */
  async stopAll(): Promise<void> {
    projectManagerLog.log("Stopping all project runtimes...");

    const stopPromises = Array.from(this.runtimes.keys()).map((id) =>
      this.removeProject(id).catch((error) => {
        projectManagerLog.error(`Failed to stop runtime ${id}:`, error);
      })
    );

    await Promise.all(stopPromises);

    projectManagerLog.log("All project runtimes stopped");
    this.removeAllListeners();
  }
}
