import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: unknown) => ({ type: "string", ...((opts as object) ?? {}) }),
    Number: (opts?: unknown) => ({ type: "number", ...((opts as object) ?? {}) }),
    // FNXC:EngineTests 2026-07-23-21:20: f21d3ce13 (#2375) added Type.Integer to agent-tools document CAS schemas (expected_revision); partial Type mocks must cover it or these files fail at collect time.
    Integer: (opts?: unknown) => ({ type: "integer", ...((opts as object) ?? {}) }),
    Boolean: (opts?: unknown) => ({ type: "boolean", ...((opts as object) ?? {}) }),
    Optional: (schema: unknown) => schema,
    Array: (schema: unknown, opts?: unknown) => ({ type: "array", items: schema, ...((opts as object) ?? {}) }),
    Union: (schemas: unknown[], opts?: unknown) => ({ anyOf: schemas, ...((opts as object) ?? {}) }),
    Literal: (value: unknown) => ({ const: value }),
    Unknown: (opts?: unknown) => ({ ...((opts as object) ?? {}) }),
    Record: (_key: unknown, value: unknown, opts?: unknown) => ({
      type: "object",
      additionalProperties: value,
      ...((opts as object) ?? {}),
    }),
  },
}));

import { EventEmitter } from "node:events";
import type { Task, TaskStore, CentralCore } from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project/project-runtime.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { ChildProcessRuntime } from "../runtimes/child-process-runtime.js";
import { TaskExecutor } from "../executor.js";
import { addActiveWorktree } from "../executor/active-worktrees.js";

/**
 * Mock implementation of ProjectRuntime for interface compliance testing.
 * This verifies the interface contract without relying on the full implementation.
 */
class MockProjectRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private _status: RuntimeStatus = "stopped";
  private _metrics: RuntimeMetrics = {
    inFlightTasks: 0,
    activeAgents: 0,
    lastActivityAt: new Date().toISOString(),
  };

  constructor(private config: ProjectRuntimeConfig) {
    super();
    this.setMaxListeners(100);
  }

  async start(): Promise<void> {
    this._status = "starting";
    this.emit("health-changed", { status: "starting", previous: "stopped" });
    this._status = "active";
    this.emit("health-changed", { status: "active", previous: "starting" });
  }

  async stop(): Promise<void> {
    this._status = "stopping";
    this.emit("health-changed", { status: "stopping", previous: "active" });
    this._status = "stopped";
    this.emit("health-changed", { status: "stopped", previous: "stopping" });
  }

  getStatus(): RuntimeStatus {
    return this._status;
  }

  getTaskStore(): TaskStore {
    throw new Error("Mock: getTaskStore not implemented");
  }

  getScheduler(): Scheduler {
    throw new Error("Mock: getScheduler not implemented");
  }

  getMetrics(): RuntimeMetrics {
    return { ...this._metrics };
  }

  simulateTaskCreated(task: Task): void {
    this.emit("task:created", task);
  }

  simulateTaskMoved(
    task: Task,
    from: string,
    to: string
  ): void {
    this.emit("task:moved", { task, from, to });
  }

  simulateTaskUpdated(task: Task): void {
    this.emit("task:updated", task);
  }

  simulateError(error: Error): void {
    this.emit("error", error);
  }
}

describe("ProjectRuntime Interface", () => {
  const testConfig: ProjectRuntimeConfig = {
    projectId: "proj_test123",
    workingDirectory: "/tmp/test-project",
    isolationMode: "in-process",
    maxConcurrent: 2,
    maxWorktrees: 4,
  };

  describe("interface contract", () => {
    let runtime: MockProjectRuntime;

    beforeEach(() => {
      runtime = new MockProjectRuntime(testConfig);
    });

    afterEach(async () => {
      try {
        await runtime.stop();
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should extend EventEmitter", () => {
      expect(runtime).toBeInstanceOf(EventEmitter);
    });

    it("should have required methods", () => {
      expect(typeof runtime.start).toBe("function");
      expect(typeof runtime.stop).toBe("function");
      expect(typeof runtime.getStatus).toBe("function");
      expect(typeof runtime.getTaskStore).toBe("function");
      expect(typeof runtime.getScheduler).toBe("function");
      expect(typeof runtime.getMetrics).toBe("function");
    });

    it("should return RuntimeStatus from getStatus()", () => {
      const status = runtime.getStatus();
      expect(["active", "paused", "errored", "stopped", "starting", "stopping"]).toContain(status);
    });

    it("should return RuntimeMetrics from getMetrics()", () => {
      const metrics = runtime.getMetrics();
      expect(metrics).toHaveProperty("inFlightTasks");
      expect(metrics).toHaveProperty("activeAgents");
      expect(metrics).toHaveProperty("lastActivityAt");
      expect(typeof metrics.inFlightTasks).toBe("number");
      expect(typeof metrics.activeAgents).toBe("number");
      expect(typeof metrics.lastActivityAt).toBe("string");
    });
  });

  describe("status lifecycle", () => {
    let runtime: MockProjectRuntime;

    beforeEach(() => {
      runtime = new MockProjectRuntime(testConfig);
    });

    afterEach(async () => {
      try {
        await runtime.stop();
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should start with status 'stopped'", () => {
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("should transition through starting to active", async () => {
      const transitions: Array<{ status: RuntimeStatus; previous: RuntimeStatus }> = [];
      runtime.on("health-changed", (data) => {
        transitions.push(data);
      });

      await runtime.start();

      expect(runtime.getStatus()).toBe("active");
      expect(transitions).toContainEqual({ status: "starting", previous: "stopped" });
      expect(transitions).toContainEqual({ status: "active", previous: "starting" });
    });

    it("should transition through stopping to stopped", async () => {
      await runtime.start();

      const transitions: Array<{ status: RuntimeStatus; previous: RuntimeStatus }> = [];
      runtime.on("health-changed", (data) => {
        transitions.push(data);
      });

      await runtime.stop();

      expect(runtime.getStatus()).toBe("stopped");
      expect(transitions).toContainEqual({ status: "stopping", previous: "active" });
      expect(transitions).toContainEqual({ status: "stopped", previous: "stopping" });
    });
  });

  describe("event emission", () => {
    let runtime: MockProjectRuntime;

    beforeEach(() => {
      runtime = new MockProjectRuntime(testConfig);
    });

    it("should emit task:created events", () => {
      const handler = vi.fn();
      runtime.on("task:created", handler);

      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      runtime.simulateTaskCreated(mockTask);

      expect(handler).toHaveBeenCalledWith(mockTask);
    });

    it("should emit task:moved events", () => {
      const handler = vi.fn();
      runtime.on("task:moved", handler);

      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      runtime.simulateTaskMoved(mockTask, "todo", "in-progress");

      expect(handler).toHaveBeenCalledWith({
        task: mockTask,
        from: "todo",
        to: "in-progress",
      });
    });

    it("should emit task:updated events", () => {
      const handler = vi.fn();
      runtime.on("task:updated", handler);

      const mockTask = { id: "KB-001", title: "Updated Task" } as Task;
      runtime.simulateTaskUpdated(mockTask);

      expect(handler).toHaveBeenCalledWith(mockTask);
    });

    it("should emit error events", () => {
      const handler = vi.fn();
      runtime.on("error", handler);

      const error = new Error("Test error");
      runtime.simulateError(error);

      expect(handler).toHaveBeenCalledWith(error);
    });

    it("should support removing event listeners with off()", () => {
      const handler = vi.fn();
      runtime.on("task:created", handler);
      runtime.off("task:created", handler);

      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      runtime.simulateTaskCreated(mockTask);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("real implementations", () => {
    let mockCentralCore: CentralCore;

    beforeEach(() => {
      mockCentralCore = {
        getGlobalConcurrencyState: vi.fn().mockResolvedValue({
          globalMaxConcurrent: 4,
          currentlyActive: 0,
          queuedCount: 0,
          projectsActive: {},
        }),
        recordTaskCompletion: vi.fn().mockResolvedValue(undefined),
      } as unknown as CentralCore;
    });

    describe("InProcessRuntime", () => {
      let runtime: InProcessRuntime;

      beforeEach(() => {
        runtime = new InProcessRuntime(testConfig, mockCentralCore);
      });

      afterEach(async () => {
        try {
          await runtime.stop();
        } catch {
          // Ignore cleanup errors
        }
      });

      it("should implement ProjectRuntime interface", () => {
        expect(typeof runtime.start).toBe("function");
        expect(typeof runtime.stop).toBe("function");
        expect(typeof runtime.getStatus).toBe("function");
        expect(typeof runtime.getTaskStore).toBe("function");
        expect(typeof runtime.getScheduler).toBe("function");
        expect(typeof runtime.getMetrics).toBe("function");
      });

      it("should be an EventEmitter", () => {
        expect(runtime).toBeInstanceOf(EventEmitter);
      });
    });

    describe("ChildProcessRuntime", () => {
      let runtime: ChildProcessRuntime;

      beforeEach(() => {
        runtime = new ChildProcessRuntime(testConfig, mockCentralCore);
      });

      afterEach(async () => {
        try {
          await runtime.stop();
        } catch {
          // Ignore cleanup errors
        }
      });

      it("should implement ProjectRuntime interface", () => {
        expect(typeof runtime.start).toBe("function");
        expect(typeof runtime.stop).toBe("function");
        expect(typeof runtime.getStatus).toBe("function");
        expect(typeof runtime.getTaskStore).toBe("function");
        expect(typeof runtime.getScheduler).toBe("function");
        expect(typeof runtime.getMetrics).toBe("function");
      });

      it("should be an EventEmitter", () => {
        expect(runtime).toBeInstanceOf(EventEmitter);
      });

      it("should throw for getTaskStore() (not accessible in child mode)", () => {
        expect(() => runtime.getTaskStore()).toThrow("not accessible in ChildProcessRuntime");
      });

      it("should throw for getScheduler() (not accessible in child mode)", () => {
        expect(() => runtime.getScheduler()).toThrow("not accessible in ChildProcessRuntime");
      });
    });
  });

  describe("type guards", () => {
    it("should validate RuntimeStatus values", () => {
      const validStatuses: RuntimeStatus[] = [
        "active",
        "paused",
        "errored",
        "stopped",
        "starting",
        "stopping",
      ];

      for (const status of validStatuses) {
        expect(status).toBeDefined();
      }
    });

    it("should validate RuntimeMetrics structure", () => {
      const metrics: RuntimeMetrics = {
        inFlightTasks: 0,
        activeAgents: 0,
        lastActivityAt: new Date().toISOString(),
        memoryBytes: 1024 * 1024,
      };

      expect(metrics.inFlightTasks).toBe(0);
      expect(metrics.activeAgents).toBe(0);
      expect(typeof metrics.lastActivityAt).toBe("string");
      expect(typeof metrics.memoryBytes).toBe("number");
    });
  });
});

/*
FNXC:WorktreeLiveness 2026-10-08-04:04 (RUFU-323):
`RuntimeMetrics.inFlightTasks` is the number an operator's isolation transition is judged by:
`ProjectManager.restartProjectRuntime()` throws `{ kind: "active_tasks", count }` whenever it is
non-zero. Deriving it from the raw size of the executor's worktree-OWNERSHIP map made a card whose run
had already ended report as running work forever, so a project holding only terminal `failed` cards
could never transition without `force`. These cases pin the liveness-derived derivation and, just as
importantly, the two ways it must never break: it must still count genuinely live work, and it must
never throw for an executor object that cannot answer the liveness question — `stop()`'s post-abort
drain reads the same metric and re-throws anything raised inside `stop()`.
*/
describe("InProcessRuntime in-flight metric derivation", () => {
  const metricsConfig = {
    projectId: "proj_inflight",
    workingDirectory: "worktree-relative",
    isolationMode: "in-process",
  } as const;

  function makeRuntime(): any {
    return new InProcessRuntime(metricsConfig as any, {} as any);
  }

  /**
   * A real TaskExecutor carrying only the liveness surfaces `isTaskLiveForOverseerRetry` consults
   * (the same shape `leaked-slot-reaper-planner-liveness.test.ts` builds), so the assertion exercises
   * the production facade instead of a hand-counted fake.
   */
  function makeExecutorHolding(taskId: string, worktreePath: string): any {
    const executor = Object.create(TaskExecutor.prototype) as any;
    executor.activeSessions = new Map();
    executor.activeStepExecutors = new Map();
    executor.activeWorkflowStepSessions = new Map();
    executor.activePlanningWorkflowSessions = new Map();
    executor.activeCliTaskSessions = new Map();
    executor.activeWorktrees = new Map([[taskId, new Set([worktreePath])]]);
    executor.executing = new Set();
    executor.recoveringCompleted = new Set();
    executor.resumingUnpaused = new Set();
    executor.approvalSuspended = new Set();
    executor.approvalResumeAfterUnwind = new Set();
    executor.effectiveColumnAgentByTask = new Map();
    return executor;
  }

  it("counts a card that owns a checkout but runs nowhere as zero in-flight work", () => {
    const runtime = makeRuntime();
    runtime.executor = makeExecutorHolding("SANE-435", "worktree/sane-435");

    const metrics = runtime.getMetrics();

    expect(metrics.inFlightTasks).toBe(0);
    expect(metrics.activeAgents).toBe(0);
  });

  it("still counts a card that is live on an execution surface", () => {
    const runtime = makeRuntime();
    const executor = makeExecutorHolding("SANE-435", "worktree/sane-435");
    executor.executing.add("SANE-435");
    runtime.executor = executor;

    expect(runtime.getMetrics().inFlightTasks).toBe(1);
  });

  it("counts each workspace card once whatever number of sub-repo checkouts it holds", () => {
    const runtime = makeRuntime();
    const executor = makeExecutorHolding("SANE-500", "worktree/apps-api");
    addActiveWorktree(executor.activeWorktrees, "SANE-500", "worktree/apps-web");
    executor.executing.add("SANE-500");
    runtime.executor = executor;

    expect(runtime.getMetrics().inFlightTasks).toBe(1);
  });

  it("falls back to the ownership-map size for an executor that cannot prove liveness, without throwing", () => {
    const runtime = makeRuntime();
    // The `engine-stop-aborts-execution.test.ts` double shape: a map, placeholder values, no facade.
    runtime.executor = { activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]) };

    expect(() => runtime.getMetrics()).not.toThrow();
    expect(runtime.getMetrics().inFlightTasks).toBe(1);
  });

  it("reports zero in-flight work when no executor exists yet", () => {
    const runtime = makeRuntime();

    expect(runtime.getMetrics().inFlightTasks).toBe(0);
    expect(runtime.getMetrics().activeAgents).toBe(0);
  });

  it("keeps the stop() drain loop resolvable for an executor double without the facade", async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      runtime.status = "active";
      runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 10 }) };
      runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
      runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
      runtime.executor = {
        activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]),
        abortAllSessionBash: vi.fn(),
        abortAllInFlight: vi.fn().mockResolvedValue(undefined),
        disposeStoreLifecycleDisposers: vi.fn(),
        disposeEphemeralTimers: vi.fn(),
      };

      const stopPromise = runtime.stop();
      await vi.advanceTimersByTimeAsync(50);

      await expect(stopPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
