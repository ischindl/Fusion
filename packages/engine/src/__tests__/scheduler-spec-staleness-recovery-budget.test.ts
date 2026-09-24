/**
 * FNXC:PlanReplanSessionBudget 2026-09-21-10:45 (RUFU-251):
 * The scheduler's spec-staleness rebound used to be a bare `needs-replan` write with no counter.
 * Staleness is measured by PROMPT.md's mtime, so a planner session that hands the specification back
 * unchanged — the exact shape of a failed Plan Review `REVISE` turn — left the card stale forever and
 * the scheduler rebounded it on every pass. These cases pin the bound: backoff while the shared
 * planning recovery budget has turns left, then a greppable failure park, and the control proves the
 * gate is not simply refusing every dispatch.
 */
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";

const WF = "custom:staleness-bound";
const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-STALE",
    title: "card with a stale specification",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const IR = {
  version: "v2",
  id: WF,
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", label: "Review", traits: [{ trait: "humanReview" }, { trait: "mergeBlocker" }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function createStore(task: Task, settings: Partial<Settings> = {}) {
  const resolved = {
    maxConcurrent: 10,
    maxWorktrees: 10,
    groupOverlappingFiles: false,
    specStalenessEnabled: true,
    ...settings,
  };
  const selection = { workflowId: WF, stepIds: [] };
  const tasksDir = mkdtempSync(join(tmpdir(), "fusion-spec-staleness-bound-"));
  seedPlannedSpec({ getTasksDir: () => tasksDir }, task.id, { title: task.title });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch));
  const moveTask = vi.fn(async (_id: string, column: Task["column"]) => {
    task.column = column;
    return task;
  });
  const logEntry = vi.fn(async (..._args: unknown[]) => undefined);
  const store = {
    listTasks: vi.fn(async () => [task]),
    getSettings: vi.fn(async () => resolved),
    updateSettings: vi.fn(async () => resolved),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    updateTask,
    updateTaskUnlocked: updateTask,
    moveTask,
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
      if (!(await predicate(task)) || task.column === column) return { task, moved: false };
      return { task: await moveTask(id, column), moved: true };
    }),
    getTask: vi.fn(async () => task),
    logEntry,
    getRootDir: vi.fn(() => tasksDir),
    getTasksDir: vi.fn(() => tasksDir),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: IR })),
  } as unknown as TaskStore & { updateTask: ReturnType<typeof vi.fn>; logEntry: ReturnType<typeof vi.fn>; moveTask: ReturnType<typeof vi.fn> };
  return { store, task, promptPath: getPromptPath(tasksDir, task.id) };
}

async function runPass(store: TaskStore): Promise<void> {
  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();
}

function ageTheSpec(promptPath: string): void {
  const stale = (Date.now() - STALE_AGE_MS) / 1000;
  utimesSync(promptPath, stale, stale);
}

describe("bounded scheduler spec-staleness rebound (RUFU-251)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(
      Scheduler.prototype as never as { validateTaskFilesystem: () => unknown },
      "validateTaskFilesystem",
    ).mockResolvedValue({ valid: true } as never);
  });

  it("dispatches a card whose specification is fresh (control)", async () => {
    const { store, task } = createStore(makeTask());

    await runPass(store);

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some((call: unknown[]) => call[1] === "in-progress")).toBe(true);
    expect((store.updateTask as ReturnType<typeof vi.fn>).mock.calls.flat().some((arg: unknown) => (arg as Partial<Task>)?.status === "needs-replan")).toBe(false);
    expect(task.column).toBe("in-progress");
  });

  it("spends a counted recovery turn with backoff instead of an unbounded needs-replan write", async () => {
    const { store, task, promptPath } = createStore(makeTask());
    ageTheSpec(promptPath);

    await runPass(store);

    expect(task.status).toBe("needs-replan");
    expect(task.recoveryRetryCount).toBe(1);
    expect(new Date(String(task.nextRecoveryAt)).getTime()).toBeGreaterThan(Date.now());
    const logged = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[1]).join("\n");
    expect(logged).toContain(`attempt 1/${MAX_RECOVERY_RETRIES}`);
    expect(task.column).toBe("todo");
  });

  it("parks the card failed once the automatic replans are spent, instead of rebounding forever", async () => {
    const { store, task, promptPath } = createStore(makeTask({
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
      nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    ageTheSpec(promptPath);

    await runPass(store);

    expect(task.status).toBe("failed");
    expect(task.error).toContain("SPEC_STALENESS_RECOVERY_EXHAUSTED");
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
  });
});
