import { EventEmitter } from "node:events";
import type { NodeConfig, Task, TaskStore } from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type {
  ProjectRuntime,
  ProjectRuntimeEvents,
  RuntimeMetrics,
  InFlightObservation,
  RuntimeStatus,
} from "../project/project-runtime.js";
import { INFLIGHT_PROBE_TIMEOUT_MS } from "../project/project-runtime.js";
import { withBoundedRead } from "../project/isolation-transition-blockers.js";
import { remoteNodeLog } from "../logger.js";
import {
  RemoteNodeClient,
  type RemoteNodeEvent,
  type RemoteNodeTaskAssignedPayload,
} from "./remote-node-client.js";

export interface RemoteNodeRuntimeConfig {
  nodeConfig: NodeConfig;
  projectId: string;
  projectName: string;
}

export class RemoteNodeRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private client: RemoteNodeClient;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private streamLoopAbortController: AbortController | null = null;
  private streamLoopPromise: Promise<void> | null = null;
  private lastSuccessfulMetricsAt: string;
  private cachedMetrics: RuntimeMetrics;

  // Kept as mutable fields for testability.
  private reconnectBaseDelayMs = 5_000;
  private maxReconnectDelayMs = 60_000;
  private maxReconnectAttempts = 10;
  private lastAssignmentCursor: string | null = null;
  private readonly seenAssignmentKeys = new Set<string>();

  constructor(private config: RemoteNodeRuntimeConfig) {
    super();
    this.setMaxListeners(100);

    this.cachedMetrics = {
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    };
    this.lastSuccessfulMetricsAt = this.cachedMetrics.lastActivityAt;

    this.client = new RemoteNodeClient({
      baseUrl: config.nodeConfig.url ?? "",
      apiKey: config.nodeConfig.apiKey ?? "",
    });

    remoteNodeLog.log(
      `Created RemoteNodeRuntime for project ${config.projectId} on node ${config.nodeConfig.name}`
    );
  }

  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.validateRemoteNodeConfig();

    this.setStatus("starting");
    try {
      await this.client.health();
      await this.refreshMetrics();

      this.setStatus("active");
      this.startHealthChecks();
      this.startEventStreamLoop();

      remoteNodeLog.log(
        `RemoteNodeRuntime started for ${this.config.projectId} (${this.config.projectName})`
      );
    } catch (error) {
      const err = this.toError(error);
      this.setStatus("errored");
      this.emitRuntimeError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.streamLoopAbortController) {
      this.streamLoopAbortController.abort();
    }

    if (this.streamLoopPromise) {
      try {
        await this.streamLoopPromise;
      } catch {
        // Best-effort shutdown. Errors are already emitted via runtime events.
      }
    }

    this.streamLoopAbortController = null;
    this.streamLoopPromise = null;

    this.setStatus("stopped");
    remoteNodeLog.log(`RemoteNodeRuntime stopped for ${this.config.projectId}`);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  getTaskStore(): TaskStore {
    throw new Error(
      "TaskStore not accessible for remote node runtime. Use the remote Fusion API directly."
    );
  }

  getScheduler(): Scheduler {
    throw new Error("Scheduler not accessible for remote node runtime.");
  }

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-04:54 (RUFU-328):
  This transport deliberately does NOT implement the optional `ProjectRuntime.getInFlightBlockers?()`
  capability that InProcessRuntime and ChildProcessRuntime gained. The durable-status veto that capability
  performs needs a local `TaskStore` to read each holder's board row, and this runtime has none by design
  (`getTaskStore()` above throws). Leaving the member absent is the safe branch, not an unfinished one:
  a transition this transport cannot cross-check stays a conservative refusal, never a false all-clear.
  Adding a remote read would mean inventing a cross-node status protocol for a settings-change guard.

  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  The consequence of that absence is stronger now, which is why it must not be read as an oversight. The
  guard no longer decides on `getMetrics().inFlightTasks` but on `observeInFlight()`, and where the other
  two transports an unproven answer gets released by a durable all-clear, this one has nothing to release
  it: an unreachable node reports `proven: false` and the transition is refused. That is the intended
  asymmetry — a remote project can be transitioned only when its node is actually reachable and says it is
  idle — and it replaces the previous failure mode, where an unreachable node fail-opened to a zero count
  and the transition was permitted on an answer this transport could not possibly prove.
  */
  getMetrics(): RuntimeMetrics {
    void this.refreshMetrics();
    return { ...this.cachedMetrics };
  }

  private validateRemoteNodeConfig(): void {
    if (this.config.nodeConfig.type !== "remote") {
      throw new Error(
        `RemoteNodeRuntime requires a remote node configuration (received: ${this.config.nodeConfig.type})`
      );
    }

    if (!this.config.nodeConfig.url) {
      throw new Error("Remote node runtime requires nodeConfig.url for remote nodes.");
    }

    if (!this.config.nodeConfig.apiKey) {
      throw new Error("Remote node runtime requires nodeConfig.apiKey for authentication.");
    }
  }

  private startHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }

    this.healthInterval = setInterval(() => {
      void this.client.health().catch((error) => {
        this.emitRuntimeError(this.toError(error));
      });
    }, 30_000);
  }

  private startEventStreamLoop(): void {
    if (this.streamLoopPromise) {
      return;
    }

    this.streamLoopAbortController = new AbortController();
    this.streamLoopPromise = this.runEventStreamLoop(this.streamLoopAbortController.signal)
      .catch((error) => {
        this.emitRuntimeError(this.toError(error));
      })
      .finally(() => {
        this.streamLoopPromise = null;
      });
  }

  private async runEventStreamLoop(signal: AbortSignal): Promise<void> {
    let reconnectAttempts = 0;

    while (!signal.aborted && !this.isShuttingDown()) {
      let sawAnyEvent = false;

      try {
        for await (const event of this.client.streamEvents({ signal })) {
          if (signal.aborted || this.isShuttingDown()) {
            return;
          }

          sawAnyEvent = true;
          this.forwardRemoteEvent(event);
        }

        if (signal.aborted || this.isShuttingDown()) {
          return;
        }

        if (sawAnyEvent) {
          reconnectAttempts = 0;
        }

        throw new Error("Remote event stream ended unexpectedly");
      } catch (error) {
        if (signal.aborted || this.isShuttingDown()) {
          return;
        }

        reconnectAttempts += 1;
        this.emitRuntimeError(this.toError(error));

        if (reconnectAttempts >= this.maxReconnectAttempts) {
          this.setStatus("errored");
          return;
        }

        const delayMs = Math.min(
          this.reconnectBaseDelayMs * 2 ** (reconnectAttempts - 1),
          this.maxReconnectDelayMs
        );

        remoteNodeLog.warn(
          `Remote event stream disconnected for ${this.config.projectId}; reconnecting in ${delayMs}ms ` +
            `(attempt ${reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        await this.pollPendingAssignments("cross-node-poll");

        await this.sleep(delayMs, signal);
        if (signal.aborted) {
          return;
        }

        try {
          await this.client.health();
        } catch (healthError) {
          this.emitRuntimeError(this.toError(healthError));
        }
      }
    }
  }

  private forwardRemoteEvent(event: RemoteNodeEvent): void {
    switch (event.type) {
      case "task:created":
        this.emit("task:created", event.payload as Task);
        break;
      case "task:moved": {
        const payload = event.payload as { task: Task; from: string; to: string };
        this.emit("task:moved", {
          task: payload.task,
          from: payload.from,
          to: payload.to,
        });
        break;
      }
      case "task:updated":
        this.emit("task:updated", event.payload as Task);
        break;
      case "task:assigned":
        this.emitAssignmentWake(event.payload as RemoteNodeTaskAssignedPayload, "cross-node-push");
        break;
      case "error": {
        const payload = event.payload;
        if (payload instanceof Error) {
          this.emitRuntimeError(payload);
        } else if (typeof payload === "object" && payload && "message" in payload) {
          const message = String((payload as { message: unknown }).message);
          this.emitRuntimeError(new Error(message));
        } else {
          this.emitRuntimeError(new Error(String(payload)));
        }
        break;
      }
      default:
        remoteNodeLog.warn(
          `Ignoring unsupported remote event type "${event.type}" for ${this.config.projectId}`
        );
    }
  }

  async reconcileAssignments(assignments: RemoteNodeTaskAssignedPayload[]): Promise<void> {
    for (const assignment of assignments) {
      this.emitAssignmentWake(assignment, "cross-node-reconcile");
    }
  }

  private async pollPendingAssignments(source: "cross-node-poll" | "cross-node-reconcile"): Promise<void> {
    try {
      const assignments = await this.client.pollPendingAssignments({
        since: this.lastAssignmentCursor ?? undefined,
      });
      for (const assignment of assignments) {
        this.emitAssignmentWake(assignment, source);
      }
    } catch (error) {
      this.emitRuntimeError(this.toError(error));
    }
  }

  private emitAssignmentWake(
    assignment: RemoteNodeTaskAssignedPayload,
    source: "cross-node-push" | "cross-node-poll" | "cross-node-reconcile"
  ): void {
    const key = `${assignment.taskId}:${assignment.agentId}:${assignment.assignedAt}`;
    if (this.seenAssignmentKeys.has(key)) {
      return;
    }
    this.seenAssignmentKeys.add(key);
    this.lastAssignmentCursor = assignment.assignedAt;
    remoteNodeLog.log(
      `[wake-trigger-diagnostics] source=${source} taskId=${assignment.taskId} agentId=${assignment.agentId}`
    );
    this.emit("task:assigned", {
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      assignedAt: assignment.assignedAt,
      source,
    });
  }

  /*
  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  The error branch of this method used to overwrite the cache with `inFlightTasks: 0, activeAgents: 0`,
  which made an unreachable node read exactly like an idle one. `ProjectManager`'s isolation-transition
  guard consumed that cache, so the failure direction was a transition ALLOWED over work that may have
  been executing — the dangerous side of the bug. A failed fetch now leaves the last real observation in
  place: it can be stale, and the display path may keep showing it, but staleness is decided by
  {@link observeInFlight}, which is the only form that reports whether it reached the node.
  */
  private async refreshMetrics(): Promise<RuntimeMetrics> {
    try {
      return this.applyMetricsObservation(await this.client.getMetrics()) ?? this.cachedMetrics;
    } catch {
      // Keep the last real observation rather than inventing an idle one.
      return this.cachedMetrics;
    }
  }

  /*
  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  The decision-grade form of the metrics question for a remote node: await the HTTP read under
  `INFLIGHT_PROBE_TIMEOUT_MS` instead of returning a cache, and report the transport. A node that cannot be
  reached, answers late, answers with an unusable frame, or rejects is `proven: false` over the LAST REAL
  observation — never a zero, because this transport's zero previously cost nothing to claim.

  Provenance is also the only honest answer available here: `RemoteNodeRuntime` deliberately owns no local
  `TaskStore` (see `getTaskStore()`), so it cannot cross-check a busy answer against durable board state
  the way the in-process and child transports do through `getInFlightBlockers()`. Refusing is therefore
  the only correct action for an unproven answer on this transport; a cross-node status protocol is a
  larger design change than this bug fix.
  */
  async observeInFlight(): Promise<InFlightObservation> {
    const answer = await withBoundedRead(() => this.client.getMetrics(), INFLIGHT_PROBE_TIMEOUT_MS);
    const observed = this.applyMetricsObservation(answer);

    if (!observed) {
      remoteNodeLog.warn(
        `In-flight probe for project ${this.config.projectId} on node ${this.config.nodeConfig.name} did not answer within ${INFLIGHT_PROBE_TIMEOUT_MS}ms; treating as unproven (last successful metrics observation: ${this.lastSuccessfulMetricsAt})`,
      );
      return { inFlightTasks: this.cachedMetrics.inFlightTasks, proven: false, source: "remote-node" };
    }

    return { inFlightTasks: observed.inFlightTasks, proven: true, source: "remote-node" };
  }

  /**
   * Record one metrics answer into the cache the display/health path reads.
   *
   * FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
   * A frame without a usable count is not an answer and is refused (`null`), because accepting one would
   * reintroduce the invented zero this change removed by other means.
   */
  private applyMetricsObservation(answer: unknown): RuntimeMetrics | null {
    if (!answer || typeof answer !== "object") return null;

    const candidate = answer as Partial<RuntimeMetrics>;
    if (typeof candidate.inFlightTasks !== "number" || !Number.isFinite(candidate.inFlightTasks) || candidate.inFlightTasks < 0) {
      return null;
    }

    const observed: RuntimeMetrics = {
      inFlightTasks: candidate.inFlightTasks,
      activeAgents:
        typeof candidate.activeAgents === "number" ? candidate.activeAgents : this.cachedMetrics.activeAgents,
      lastActivityAt:
        typeof candidate.lastActivityAt === "string" ? candidate.lastActivityAt : this.cachedMetrics.lastActivityAt,
      ...(typeof candidate.memoryBytes === "number" ? { memoryBytes: candidate.memoryBytes } : {}),
    };

    this.cachedMetrics = observed;
    this.lastSuccessfulMetricsAt = observed.lastActivityAt;
    return observed;
  }

  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", {
        status: newStatus,
        previous,
      });
    }
  }

  private emitRuntimeError(error: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }

    remoteNodeLog.error(
      `Unhandled remote runtime error for ${this.config.projectId}: ${error.message}`
    );
  }

  private isShuttingDown(): boolean {
    return this.status === "stopping" || this.status === "stopped";
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
