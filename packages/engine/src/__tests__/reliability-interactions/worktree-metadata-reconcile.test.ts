import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import type { WorktreeRegistryRead } from "../../worktree/worktree-pointer-state.js";
import { withBranchWriteProvenance } from "../branch-write-provenance-store-stub.js";

/*
FNXC:WorktreePointerState 2026-11-18-03:58 (RUFU-1054):
These cases used to state "git is readable and this path is registered over there" by mocking
`getRegisteredWorktreeBranchMap`, which is the helper whose empty-on-failure arm this card exists to close:
the mock could not tell a readable empty registry from a git that refused to answer, so no failure coverage
was ever possible. They now say it out loud through the injected three-valued read, the same seam production
consults.
*/
function registry(...entries: Array<{ branch: string; worktreePath: string }>): WorktreeRegistryRead {
  return { status: "ok", entries, prunable: [] };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[]): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => [...map.values()]),
    updateTask: vi.fn(withBranchWriteProvenance(async (id: string, patch: Partial<Task>) => {
      map.set(id, { ...(map.get(id) as Task), ...patch });
      return map.get(id);
    })),
    getTask: vi.fn(async (id: string) => map.get(id)),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: worktree metadata reconcile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defers while task is in executingTaskIds (recoverOrphaned/resume interaction)", async () => {
    const store = makeStore([task("FN-1", { column: "in-review", worktree: "/missing", branch: undefined })]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      readWorktreeRegistry: async () => registry({ branch: "fusion/fn-1", worktreePath: "/live" }),
      getExecutingTaskIds: () => new Set(["FN-1"]),
    });

    const repaired = await manager.reconcileTaskWorktreeMetadata();
    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });

  it("rebinds exactly once after deferred pass (acquireTaskWorktree interaction)", async () => {
    const store = makeStore([task("FN-2", { column: "todo", worktree: "/missing", branch: undefined })]);
    let executing = true;
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      readWorktreeRegistry: async () => registry({ branch: "fusion/fn-2", worktreePath: "/live" }),
      getExecutingTaskIds: () => (executing ? new Set(["FN-2"]) : new Set<string>()),
    });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(0);
    executing = false;
    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(1);
    expect((store as any).updateTask).toHaveBeenCalledTimes(1);
  });

  it("rebinds a relocated checkout from the authoritative branch registry without touching branch metadata", async () => {
    const original = task("FN-213", {
      column: "todo",
      worktree: "/missing/old",
      branch: "fusion/fn-213",
    });
    const store = makeStore([original]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      readWorktreeRegistry: async () => registry({ branch: "fusion/fn-213", worktreePath: "/registered/live" }),
    });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(1);

    expect((store as any).updateTask).toHaveBeenCalledWith("FN-213", { worktree: "/registered/live" });
    const patches = (store as any).updateTask.mock.calls.map((call: any[]) => call[1]);
    expect(patches.every((patch: any) => !("branch" in patch))).toBe(true);
    expect(patches.some((patch: any) => patch.worktree === null)).toBe(false);
    expect((await (store as any).getTask("FN-213"))).toMatchObject({
      branch: "fusion/fn-213",
      worktree: "/registered/live",
    });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-rebound",
    }));
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-cleared",
    }));
  });

  it("keeps active-lane pointers when a stale checkout has no registry entry", async () => {
    const store = makeStore([task("FN-214", {
      column: "in-review",
      worktree: "/missing/review",
      branch: "fusion/fn-214",
    })]);
    // Readable, and nothing is registered anywhere: the honest empty answer, which the old mock could not
    // distinguish from a git that refused to answer.
    const manager = new SelfHealingManager(store, { rootDir: "/repo", readWorktreeRegistry: async () => registry() });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(0);

    expect((store as any).updateTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-skipped-active",
    }));
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-cleared",
    }));
  });

  it("runs reconcile before reclaim-stale-active-branches in maintenance ordering", () => {
    const selfHealingPath = fileURLToPath(new URL("../../self-healing.ts", import.meta.url));
    const source = readFileSync(selfHealingPath, "utf8");
    const maintenanceSlice = source.slice(
      source.indexOf("const batch2Fns:"),
      source.indexOf("for (const fn of batch2Fns)"),
    );

    expect(maintenanceSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeLessThan(
      maintenanceSlice.indexOf('"reclaim-stale-active-branches"'),
    );
  });

  it("skips done tasks during periodic reconcile (completion fan-out owns done lifecycle)", async () => {
    const store = makeStore([task("FN-3", { column: "done", worktree: "/missing", branch: undefined })]);

    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      readWorktreeRegistry: async () => registry({ branch: "fusion/fn-3", worktreePath: "/live" }),
    });
    const repaired = await manager.reconcileTaskWorktreeMetadata();

    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorktreePointerState 2026-11-18-03:58 (RUFU-1054):
  The case the mocked map could never express: git refused to answer. An empty map used to be indistinguishable
  from that, and the fall-through arm cleared a card's `worktree` and `branch` on the strength of it.
  */
  it("repairs nothing when the registry cannot be read", async () => {
    const store = makeStore([task("FN-4", { column: "todo", worktree: "/missing", branch: "fusion/fn-4" })]);

    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      readWorktreeRegistry: async () => ({ status: "unreadable" } as WorktreeRegistryRead),
    });
    const repaired = await manager.reconcileTaskWorktreeMetadata();

    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalled();
  });
});

/**
 * FNXC:PlanningLaneWorktreeIdentity 2026-11-18-20:40 (RUFU-893, Step 4):
 * THE SYMPTOM AND ITS ABSENCE, PINNED IN THE SWEEP'S OWN FILE. The five reported cards were planning-lane
 * rows carrying a `branch` and/or a `worktree` that git could not corroborate. Measured on the pre-change
 * tree (`forensics` task document): 28 planning-lane mirrors held such a pointer, 18 of them the branch-only
 * shape, and a full pass repaired ZERO of them, because the entry gate began `if (!task.worktree) continue;`
 * and never looked at a card that claimed only a branch. Both cases below are stated as verdicts over the
 * real git seams so the file keeps its no-subprocess character; the commands themselves are characterized in
 * `self-healing-planning-worktree-identity.real-git.test.ts`.
 *
 * Run against the pre-change code these two assertions fail in opposite directions: the first because the
 * card was never admitted, the second because the clear was unconditional and would have dropped a pointer
 * naming 3 undelivered commits. That is the pair the intake asked to be pinned together.
 */
class StatedProbesManager extends SelfHealingManager {
  constructor(
    store: TaskStore & EventEmitter,
    private readonly verdicts: {
      ref: "present" | "absent" | "unknown";
      registration: "registered" | "absent" | "unknown";
      containment: "contained" | "divergent" | "unknown";
      divergentCommitCount?: number;
    },
  ) {
    /*
    FNXC:WorktreePointerState 2026-11-19-11:50 (RUFU-1054 merge resolution):
    The pass now reads the registry through the three-valued seam instead of `getRegisteredWorktreeBranchMap`,
    and an unreadable read abstains from the whole pass. Left at the bare `{ rootDir }` these two cases would
    shell out to git at a non-existent `/repo`, read `unreadable`, and answer "repaired nothing" for the wrong
    reason — the same intent the removed `getRegisteredWorktreeBranchMap → new Map()` spy stated, now said
    through the seam production actually consults: git answered, and nothing is registered anywhere.
    */
    super(store, { rootDir: "/repo", readWorktreeRegistry: async () => registry() });
  }

  protected override async probePlanningLaneBranchPresence(): Promise<"present" | "absent" | "unknown"> {
    return this.verdicts.ref;
  }

  protected override async probePlanningLaneBranchRegistration(): Promise<"registered" | "absent" | "unknown"> {
    return this.verdicts.registration;
  }

  protected override async probePlanningLaneBranchContainment(): Promise<{
    verdict: "contained" | "divergent" | "unknown";
    uniqueCommitCount?: number;
  }> {
    return {
      verdict: this.verdicts.containment,
      ...(this.verdicts.divergentCommitCount !== undefined ? { uniqueCommitCount: this.verdicts.divergentCommitCount } : {}),
    };
  }
}

describe("reliability interactions: worktree metadata reconcile (RUFU-893 symptom pair)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the branch-only planning pointer the pre-change entry gate never admitted", async () => {
    const store = makeStore([task("RUFU-254", { column: "todo", worktree: null, branch: "fusion/rufu-254" })]);

    const manager = new StatedProbesManager(store, {
      ref: "absent",
      registration: "absent",
      containment: "unknown",
    });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(1);
    expect((store as any).updateTask).toHaveBeenCalledWith("RUFU-254", {
      worktree: null,
      branch: null,
      branchWriteOrigin: "engine",
    });
    /* Metadata hygiene only: no column move, no status write, and the clear is the audit row's whole story. */
    expect((store as any).moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-cleared",
    }));
  });

  it("refuses the same shape while its branch still carries undelivered commits", async () => {
    const store = makeStore([task("RUFU-1044", { column: "todo", worktree: null, branch: "fusion/rufu-1044" })]);

    const manager = new StatedProbesManager(store, {
      ref: "present",
      registration: "absent",
      containment: "divergent",
      divergentCommitCount: 3,
    });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
    expect(await (store as any).getTask("RUFU-1044")).toMatchObject({ branch: "fusion/rufu-1044" });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-planning-lane-worktree-identity-no-action",
      metadata: expect.objectContaining({ code: "ref-divergent", outcome: "withheld" }),
    }));
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-worktree-metadata-cleared",
    }));
  });
});
