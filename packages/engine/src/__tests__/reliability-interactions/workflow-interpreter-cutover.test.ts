import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_SETTINGS,
  isExperimentalFeatureEnabled,
  type Settings,
  type TaskDetail,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSquashOverlapsFileScope, FileScopeViolationError } from "../../merger.js";
import type { WorkflowLegacySeams } from "../../workflow-node-handlers.js";
import { WorkflowAuthoritativeDriver } from "../../workflow-authoritative-driver.js";
import { observeWorkflowParity } from "../../workflow-parity-observer.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

const readyParity = {
  observed: 5,
  agreed: 5,
  drift: 0,
  agreeRate: 1,
  driftFieldCounts: {},
  recentDrift: [],
};

// FNXC:WorkflowInterpreterCutover 2026-07-01-21:35: BUILTIN_CODING_WORKFLOW_IR graduated to include
// default-on optional groups (plan-review, browser-verification, code-review). Disabling them via
// enabledWorkflowSteps:[] keeps the authoritative driver's seam-only run from routing into those group
// nodes (which WorkflowAuthoritativeDriver's hardcoded runCustomNode rejects). NOTE: this does NOT rescue
// the three tests that require the graph to reach merge — the IR also gained an ALWAYS-ON `completion-summary`
// custom node that the driver's runCustomNode throws on ("unexpected custom node ... completion-summary"),
// so a clean run cannot complete. That is a product gap in workflow-authoritative-driver.ts (owned by the
// lead), not a test-side staleness; those three tests are left failing pending a driver fix or retirement.
const baseTask = {
  id: "FN-5770",
  column: "in-progress",
  steps: [],
  review: null,
  mergeDetails: null,
  enabledWorkflowSteps: [],
} as unknown as TaskDetail;

function settingsWith(flags: Record<string, boolean>, overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    experimentalFeatures: {
      ...(DEFAULT_SETTINGS.experimentalFeatures ?? {}),
      ...flags,
    },
  } as Settings;
}

function createStore(options: {
  settings?: Settings;
  selection?: { workflowId: string; stepIds: string[] } | undefined;
  task?: TaskDetail;
  paritySummary?: typeof readyParity | null;
} = {}) {
  return {
    getSettings: vi.fn(async () => options.settings ?? settingsWith({ workflowInterpreterAuthoritative: true })),
    getTask: vi.fn(async () => options.task ?? baseTask),
    getTaskWorkflowSelection: vi.fn(() => options.selection),
    getWorkflowParitySummary: vi.fn(() => (
      options.paritySummary === null ? undefined : options.paritySummary ?? readyParity
    )),
  };
}

function createExecutor(seams: WorkflowLegacySeams) {
  return {
    createAuthoritativeWorkflowSeams: vi.fn(() => seams),
  };
}

describe("workflow interpreter authoritative cutover", () => {
  it("is a strict no-op when the cutover flag is off", async () => {
    const store = createStore({
      settings: settingsWith({ workflowInterpreterAuthoritative: false }),
    });
    const executor = createExecutor({
      planning: vi.fn(async () => ({ outcome: "success" as const })),
      execute: vi.fn(async () => ({ outcome: "success" as const })),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: vi.fn(async () => ({ outcome: "success" as const })),
    });

    const result = await new WorkflowAuthoritativeDriver({ store, executor }).maybeRun(baseTask as any);

    expect(result.handled).toBe(false);
    expect(result.disposition).toBe("fell-back");
    expect(executor.createAuthoritativeWorkflowSeams).not.toHaveBeenCalled();
  });

  it("falls back when parity summary is missing even if the cutover flag is on", async () => {
    const store = createStore({
      paritySummary: null,
    });
    const executor = createExecutor({
      planning: vi.fn(async () => ({ outcome: "success" as const })),
      execute: vi.fn(async () => ({ outcome: "success" as const })),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: vi.fn(async () => ({ outcome: "success" as const })),
    });

    const result = await new WorkflowAuthoritativeDriver({ store, executor }).maybeRun(baseTask as any);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain("workflow parity summary unavailable");
    expect(executor.createAuthoritativeWorkflowSeams).not.toHaveBeenCalled();
  });

  it("falls back when readiness fails even if the cutover flag is on", async () => {
    const store = createStore({
      paritySummary: { ...readyParity, observed: 4, drift: 1 },
    });
    const executor = createExecutor({
      planning: vi.fn(async () => ({ outcome: "success" as const })),
      execute: vi.fn(async () => ({ outcome: "success" as const })),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: vi.fn(async () => ({ outcome: "success" as const })),
    });

    const result = await new WorkflowAuthoritativeDriver({ store, executor }).maybeRun(baseTask as any);

    expect(result.handled).toBe(false);
    expect(result.reason).toMatch(/drift above zero/);
    expect(executor.createAuthoritativeWorkflowSeams).not.toHaveBeenCalled();
  });

  it("drives execute → review → merge through authoritative seams on a clean run", async () => {
    const calls: string[] = [];
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => {
        calls.push("execute");
        return { outcome: "success" as const };
      },
      review: async () => {
        calls.push("review");
        return { outcome: "success" as const };
      },
      merge: async () => {
        calls.push("merge");
        return { outcome: "success" as const };
      },
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({ store: createStore(), executor }).maybeRun(baseTask as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["execute", "review", "merge"]);
  });

  it("keeps stale dual-observe settings inert while clean parity authorizes seams", async () => {
    const runShadow = vi.fn(async () => ({ observation: {} as any, auditEvents: [] }));
    await observeWorkflowParity({
      settings: settingsWith({ workflowInterpreterDualObserve: true }),
      store: { recordRunAuditEvent: vi.fn() },
      agentId: "agent-test",
      legacy: { taskId: baseTask.id, observation: {} as any, auditEvents: [] },
      runShadow,
    });
    expect(
      isExperimentalFeatureEnabled(
        settingsWith({ workflowInterpreterDualObserve: true }),
        "workflowInterpreterDualObserve",
      ),
    ).toBe(false);
    expect(runShadow).not.toHaveBeenCalled();

    const execute = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute,
      review: async () => ({ outcome: "success" as const }),
      merge: async () => ({ outcome: "success" as const }),
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({
      store: createStore({
        settings: settingsWith({
          workflowInterpreterAuthoritative: true,
          workflowInterpreterDualObserve: true,
        }),
      }),
      executor,
    }).maybeRun(baseTask as any);

    expect(result.handled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps autoMerge:false tasks terminal in review by stopping before merge", async () => {
    const merge = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => ({ outcome: "success" as const }),
      review: async () => ({ outcome: "failure" as const, value: "manual-merge-required" }),
      merge,
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({
      store: createStore({
        settings: settingsWith({ workflowInterpreterAuthoritative: true }, { autoMerge: false }),
      }),
      executor,
    }).maybeRun(baseTask as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("failed");
    expect(merge).not.toHaveBeenCalled();
  });

  it("preserves moveTask hard-cancel semantics by halting downstream seams without setting userPaused", async () => {
    const review = vi.fn(async () => ({ outcome: "success" as const }));
    const merge = vi.fn(async () => ({ outcome: "success" as const }));
    const task = { ...baseTask, userPaused: undefined } as TaskDetail;
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => ({ outcome: "failure" as const, value: "hard-cancel" }),
      review,
      merge,
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({
      store: createStore({ task }),
      executor,
    }).maybeRun(task as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("failed");
    expect(review).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(task.userPaused).toBeUndefined();
  });

  it("routes self-healing style execute failures without divergent downstream lifecycle mutations", async () => {
    const review = vi.fn(async () => ({ outcome: "success" as const }));
    const merge = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => ({ outcome: "failure" as const, value: "recoverable" }),
      review,
      merge,
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({ store: createStore(), executor }).maybeRun(baseTask as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("failed");
    expect(review).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it("immediately rolls back to legacy when the cutover flag is flipped back off", async () => {
    let settings = settingsWith({ workflowInterpreterAuthoritative: true });
    const store = createStore();
    store.getSettings.mockImplementation(async () => settings);
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => ({ outcome: "success" as const }),
      review: async () => ({ outcome: "success" as const }),
      merge: async () => ({ outcome: "success" as const }),
      schedule: async () => ({ outcome: "success" as const }),
    });
    const driver = new WorkflowAuthoritativeDriver({ store, executor });

    const first = await driver.maybeRun(baseTask as any);
    settings = settingsWith({ workflowInterpreterAuthoritative: false });
    const second = await driver.maybeRun(baseTask as any);

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(executor.createAuthoritativeWorkflowSeams).toHaveBeenCalledTimes(1);
  });

  it("defers to existing selected custom workflows instead of double-driving", async () => {
    const executor = createExecutor({
      planning: async () => ({ outcome: "success" as const }),
      execute: async () => ({ outcome: "success" as const }),
      review: async () => ({ outcome: "success" as const }),
      merge: async () => ({ outcome: "success" as const }),
      schedule: async () => ({ outcome: "success" as const }),
    });

    const result = await new WorkflowAuthoritativeDriver({
      store: createStore({ selection: { workflowId: "WF-123", stepIds: [] } }),
      executor,
    }).maybeRun(baseTask as any);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain("workflow selection already present");
    expect(executor.createAuthoritativeWorkflowSeams).not.toHaveBeenCalled();
  });
});

const describeIfGit = hasGit ? describe : describe.skip;

describeIfGit("workflow interpreter authoritative cutover + file-scope invariants", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()!.cleanup();
    }
  });

  async function createRealDriverFixture() {
    const fx = await makeReliabilityFixture({
      taskId: "FN-5770-FS",
      task: {
        column: "in-progress",
      },
    });
    fixtures.push(fx);
    vi.spyOn(fx.store, "parseFileScopeFromPrompt").mockResolvedValue(["packages/engine/src/**"]);
    let mergeChecked = false;

    const driver = new WorkflowAuthoritativeDriver({
      store: {
        getSettings: async () => settingsWith({ workflowInterpreterAuthoritative: true }),
        getTask: (taskId) => fx.store.getTask(taskId) as Promise<TaskDetail>,
        getTaskWorkflowSelection: () => undefined,
        getWorkflowParitySummary: () => readyParity,
      },
      executor: createExecutor({
        planning: async () => ({ outcome: "success" as const }),
        execute: async () => ({ outcome: "success" as const }),
        review: async () => ({ outcome: "success" as const }),
        merge: async () => {
          mergeChecked = true;
          await assertSquashOverlapsFileScope({
            store: fx.store,
            rootDir: fx.rootDir,
            taskId: fx.task.id,
            task: await fx.store.getTask(fx.task.id) as any,
          });
          return { outcome: "success" as const };
        },
        schedule: async () => ({ outcome: "success" as const }),
      }),
    });

    return { fx, driver, wasMergeChecked: () => mergeChecked };
  }

  it("trips FileScopeViolationError under interpreter authority for off-scope staged changes", async () => {
    const { fx, driver, wasMergeChecked } = await createRealDriverFixture();
    await mkdir(join(fx.rootDir, "packages/core/src"), { recursive: true });
    await writeFile(join(fx.rootDir, "packages/core/src/offscope.txt"), "x\n", "utf-8");
    git(fx.rootDir, "git add packages/core/src/offscope.txt");

    const result = await driver.maybeRun(fx.task as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("failed");
    expect(result.graphResult?.outcome).toBe("failure");
    expect(wasMergeChecked()).toBe(true);
  });

  it("preserves the squash/merge contract when staged changes stay inside file scope", async () => {
    const { fx, driver, wasMergeChecked } = await createRealDriverFixture();
    await mkdir(join(fx.rootDir, "packages/engine/src"), { recursive: true });
    await writeFile(join(fx.rootDir, "packages/engine/src/inscope.txt"), "ok\n", "utf-8");
    git(fx.rootDir, "git add packages/engine/src/inscope.txt");

    const result = await driver.maybeRun(fx.task as any);

    expect(result.handled).toBe(true);
    expect(result.disposition).toBe("completed");
    expect(wasMergeChecked()).toBe(true);
  });
});
