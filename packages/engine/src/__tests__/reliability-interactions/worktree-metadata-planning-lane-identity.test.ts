/**
 * FNXC:PlanningLaneWorktreeIdentity 2026-11-18-19:20 (RUFU-893, Step 4):
 * THE DECISION TABLE AS THE SWEEP ACTUALLY RUNS IT. `planning-lane-worktree-identity.test.ts` proves the
 * pure rule over stated observations; this file proves the wiring that feeds it — that the sweep spends its
 * probes on planning-lane candidates and nobody else, that a `clear` writes exactly the three-field pointer
 * patch with the column and status untouched, that a `refuse` writes NOTHING to the row, and that the
 * refusal is audible through exactly the two surfaces it is allowed to speak through: one History line and
 * one deduped audit row whose metadata is a closed four-key set.
 *
 * The probes are injected through the manager's own seams rather than mocked at `node:child_process`, so a
 * broken git command cannot hide here — the real commands are characterized separately against a real
 * repository in `self-healing-planning-worktree-identity.pg.test.ts`.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";
import { withBranchWriteProvenance } from "../branch-write-provenance-store-stub.js";

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn<[string], boolean>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

const ROOT_DIR = "/repo";
const MANAGED_ROOT = "/repo/.fusion/worktrees";

/** The stated git answers one case wants. Every field defaults to the refusal direction. */
interface ProbeVerdicts {
  ref?: "present" | "absent" | "unknown";
  registration?: "registered" | "absent" | "unknown";
  containment?: "contained" | "divergent" | "unknown";
  divergentCommitCount?: number;
}

interface HarnessOptions {
  /** Overrides the role-resolved planning lanes; `null` stands for an unreadable vocabulary. */
  planningColumns?: ReadonlySet<string> | null;
  /** Workflow-definition rows, for the renamed-board and untraited-board cases. */
  definitions?: Array<{ id: string; ir: unknown }>;
  /** Which persisted paths the filesystem answers present for. Default: nothing is on disk. */
  exists?: (path: string) => boolean;
  probeError?: boolean;
}

interface Harness {
  store: TaskStore & EventEmitter;
  manager: SelfHealingManager;
  patches: Array<{ id: string; patch: Partial<Task> }>;
  auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
  history: Array<{ taskId: string; message: string }>;
  probeCalls: string[];
  passes: () => Promise<number>;
  passesWith: (includeTaskIds: Set<string>) => Promise<number>;
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

/**
 * A manager whose three git verdicts are stated by the case, so the table is exercised verdict-first. The
 * call log is part of the assertion surface: the spec forbids per-card git for any other lane.
 */
class StatedProbesManager extends SelfHealingManager {
  constructor(
    store: TaskStore & EventEmitter,
    rootDir: string,
    private readonly verdicts: ProbeVerdicts,
    private readonly harness: HarnessOptions,
    private readonly calls: string[],
  ) {
    super(store, { rootDir });
  }

  protected override async resolvePlanningLaneIdentityColumns(): Promise<ReadonlySet<string> | null> {
    if (this.harness.planningColumns !== undefined) return this.harness.planningColumns;
    if (this.harness.definitions) {
      return super.resolvePlanningLaneIdentityColumns();
    }
    return super.resolvePlanningLaneIdentityColumns();
  }

  protected override async probePlanningLaneBranchPresence(branch: string) {
    this.calls.push(`ref:${branch}`);
    return this.verdicts.ref ?? "unknown";
  }

  protected override async probePlanningLaneBranchRegistration(branch: string) {
    this.calls.push(`registration:${branch}`);
    return this.verdicts.registration ?? "unknown";
  }

  protected override async probePlanningLaneBranchContainment(branch: string) {
    this.calls.push(`containment:${branch}`);
    if (this.harness.probeError) throw new Error("probe exploded");
    return {
      verdict: this.verdicts.containment ?? "unknown",
      ...(this.verdicts.divergentCommitCount !== undefined
        ? { uniqueCommitCount: this.verdicts.divergentCommitCount }
        : {}),
    };
  }
}

function harness(
  tasks: Task[],
  verdicts: ProbeVerdicts = {},
  options: HarnessOptions = {},
  registered = new Map<string, string>(),
): Harness {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const patches: Array<{ id: string; patch: Partial<Task> }> = [];
  const auditRows: Harness["auditRows"] = [];
  const history: Harness["history"] = [];
  const probeCalls: string[] = [];
  const settings: Partial<Settings> = { globalPause: false, enginePaused: false, worktreesDir: MANAGED_ROOT };

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => [...map.values()]),
    updateTask: vi.fn(withBranchWriteProvenance(async (id: string, patch: Partial<Task>) => {
      const current = map.get(id);
      if (!current) throw new Error(`no such task ${id}`);
      if (id.endsWith("-STORE-REFUSES")) throw new Error("store write refused");
      patches.push({ id, patch });
      const next = { ...current, ...patch } as Task;
      map.set(id, next);
      return next;
    })),
    getTask: vi.fn(async (id: string) => map.get(id)),
    moveTask: vi.fn(async () => { throw new Error("a pointer clear must never move a column"); }),
    logEntry: vi.fn(async (id: string, message: string) => { history.push({ taskId: id, message }); }),
    recordRunAuditEvent: vi.fn(async (row: { mutationType: string; metadata: Record<string, unknown> }) => {
      auditRows.push({ mutationType: row.mutationType, metadata: row.metadata });
    }),
    ...(options.definitions
      ? { listWorkflowDefinitions: vi.fn(async () => options.definitions) }
      : {}),
  }) as unknown as TaskStore & EventEmitter;

  vi.spyOn(worktreePoolModule, "getRegisteredWorktreeBranchMap").mockResolvedValue(registered);
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation(options.exists ?? (() => false));

  const manager = new StatedProbesManager(store, ROOT_DIR, verdicts, options, probeCalls);
  return {
    store,
    manager,
    patches,
    auditRows,
    history,
    probeCalls,
    passes: () => manager.reconcileTaskWorktreeMetadata(),
    passesWith: (includeTaskIds) => manager.reconcileTaskWorktreeMetadata({ includeTaskIds }),
  };
}

/** The pointer patch this sweep is allowed to write, and nothing else. */
const CLEAR_PATCH = { worktree: null, branch: null, branchWriteOrigin: "engine" } as const;

const REFUSED = "task:reconcile-planning-lane-worktree-identity-no-action";
const CLEARED = "task:auto-recover-worktree-metadata-cleared";

describe("reliability interactions: planning-lane worktree identity gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("the two proofs that clear", () => {
    it("clears a phantom pointer when git says the ref does not exist", async () => {
      const h = harness([task("RUFU-893-A", {
        worktree: `${MANAGED_ROOT}/rufu-893-a`,
        branch: "fusion/rufu-893-a",
      })], { ref: "absent", registration: "absent" });

      expect(await h.passes()).toBe(1);
      expect(h.patches).toEqual([{ id: "RUFU-893-A", patch: CLEAR_PATCH }]);
      expect(await h.store.getTask("RUFU-893-A")).toMatchObject({
        column: "todo",
        worktree: null,
        branch: null,
      });
      expect(h.auditRows.map((r) => r.mutationType)).toEqual([CLEARED]);
      expect(h.history).toHaveLength(1);
      expect(h.history[0]!.message).toContain("no branch, no commit and no directory was touched");
    });

    it("clears when the ref is present but its tip is already contained in the integration branch", async () => {
      const h = harness([task("RUFU-893-B", {
        worktree: `${MANAGED_ROOT}/rufu-893-b`,
        branch: "fusion/rufu-893-b",
      })], { ref: "present", registration: "absent", containment: "contained" });

      expect(await h.passes()).toBe(1);
      expect(h.patches[0]!.patch).toMatchObject(CLEAR_PATCH);
      expect(h.history[0]!.message).toContain("already contained in the integration branch");
    });

    it("asks git at most one probe set per card and never for a lane that is not planning", async () => {
      const h = harness([
        task("RUFU-893-C", { worktree: `${MANAGED_ROOT}/rufu-893-c`, branch: "fusion/rufu-893-c" }, ),
        task("RUFU-893-D", { column: "in-progress", worktree: `${MANAGED_ROOT}/rufu-893-d`, branch: "fusion/rufu-893-d" }),
        task("RUFU-893-E", { column: "in-review", worktree: `${MANAGED_ROOT}/rufu-893-e`, branch: "fusion/rufu-893-e" }),
        task("RUFU-893-F", { column: "done", worktree: `${MANAGED_ROOT}/rufu-893-f`, branch: "fusion/rufu-893-f" }),
      ], { ref: "absent", registration: "absent" });

      await h.passes();
      expect(h.probeCalls).toEqual(["ref:fusion/rufu-893-c", "registration:fusion/rufu-893-c"]);
    });
  });

  describe("the divergent refusal, which is the whole reason this gate exists", () => {
    const divergent = { ref: "present" as const, registration: "absent" as const, containment: "divergent" as const, divergentCommitCount: 3 };

    it("keeps both pointers and names the outstanding commits on the card", async () => {
      const h = harness([task("RUFU-1044", {
        worktree: `${MANAGED_ROOT}/rufu-1044`,
        branch: "fusion/rufu-1044",
      })], divergent);

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(await h.store.getTask("RUFU-1044")).toMatchObject({
        worktree: `${MANAGED_ROOT}/rufu-1044`,
        branch: "fusion/rufu-1044",
      });
      expect(h.history).toHaveLength(1);
      const line = h.history[0]!.message;
      expect(line).toContain("fusion/rufu-1044");
      expect(line).toContain("NOT contained");
      expect(line).toContain("3 commits");
    });

    it("emits one refusal row whose metadata cannot carry a branch name, a path, or a sha", async () => {
      const h = harness([task("RUFU-1044", {
        worktree: `${MANAGED_ROOT}/rufu-1044`,
        branch: "fusion/rufu-1044",
      })], divergent);

      await h.passes();
      const refusal = h.auditRows.find((r) => r.mutationType === REFUSED);
      expect(refusal).toBeDefined();
      expect(Object.keys(refusal!.metadata).sort()).toEqual(["code", "column", "outcome", "taskId"]);
      expect(refusal!.metadata).toEqual({
        taskId: "RUFU-1044",
        column: "todo",
        code: "ref-divergent",
        outcome: "withheld",
      });
      for (const value of Object.values(refusal!.metadata)) {
        expect(String(value)).not.toContain("fusion/");
        expect(String(value)).not.toContain(MANAGED_ROOT);
      }
    });

    it("announces a standing refusal once per (card, code) across repeated passes", async () => {
      const h = harness([task("RUFU-1044", {
        worktree: `${MANAGED_ROOT}/rufu-1044`,
        branch: "fusion/rufu-1044",
      })], divergent);

      expect(await h.passes()).toBe(0);
      expect(await h.passes()).toBe(0);
      expect(await h.passes()).toBe(0);
      expect(h.auditRows.filter((r) => r.mutationType === REFUSED)).toHaveLength(1);
      expect(h.history).toHaveLength(1);
    });
  });

  describe("refusals that withhold the destructive action", () => {
    async function refusesWith(
      id: string,
      overrides: Partial<Task>,
      verdicts: ProbeVerdicts,
      code: string,
      options: HarnessOptions = {},
    ) {
      const h = harness([task(id, { worktree: `${MANAGED_ROOT}/${id.toLowerCase()}`, branch: `fusion/${id.toLowerCase()}`, ...overrides })], verdicts, options);
      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows.find((r) => r.mutationType === REFUSED)?.metadata).toMatchObject({ code, outcome: "withheld" });
      expect(h.history).toHaveLength(1);
      return h;
    }

    it("refuses when a probe could not answer rather than reading silence as absence", async () => {
      await refusesWith("RUFU-893-U", {}, { ref: "unknown" }, "probe-unknown");
    });

    it("refuses when the ref is present but containment could not be measured", async () => {
      await refusesWith("RUFU-893-U2", {}, { ref: "present", registration: "absent", containment: "unknown" }, "probe-unknown");
    });

    it("refuses a present directory that sits outside the managed worktrees root", async () => {
      const h = harness(
        [task("RUFU-893-P", { worktree: "/home/operator/scratch/wt", branch: "fusion/rufu-893-p" })],
        { ref: "present", registration: "absent", containment: "contained" },
        { exists: (p) => p === "/home/operator/scratch/wt" },
      );

      /* Containment says `contained`, and the path rule still wins: acquisition can rebuild a path it can
      derive, and it can never rediscover one whose only pointer this pass dropped. */
      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows.find((r) => r.mutationType === REFUSED)?.metadata).toMatchObject({
        code: "unmanaged-path-present",
      });
      expect(h.history[0]!.message).toContain("OUTSIDE Fusion's managed worktrees root");
    });

    it("refuses a paused card, whose owner is the operator who paused it", async () => {
      await refusesWith("RUFU-893-H", { paused: true, pausedReason: "branch-conflict-recovery-exhausted" }, { ref: "absent" }, "held-or-live");
    });

    it("refuses a card still holding a checkout claim", async () => {
      await refusesWith("RUFU-893-K", { checkedOutBy: "agent-abc" }, { ref: "absent" }, "held-or-live");
    });

    it("refuses a workspace card, which the workspace lane owns", async () => {
      await refusesWith(
        "RUFU-893-W",
        { workspaceWorktrees: { "packages/engine": "/repo/packages/engine" } },
        { ref: "absent" },
        "workspace-card",
      );
    });

    it("refuses a branch an operator named, which this sweep neither clears nor deletes", async () => {
      await refusesWith(
        "RUFU-893-O",
        { branch: "feature/operator-picked", branchContext: { branchOverride: { branch: "feature/operator-picked", requestedBy: "operator" } } as never },
        { ref: "absent" },
        "operator-branch",
      );
    });

    it("refuses every candidate when the lane vocabulary cannot be read, instead of concluding nothing is a planning card", async () => {
      const h = harness([task("RUFU-893-V", {
        worktree: `${MANAGED_ROOT}/rufu-893-v`,
        branch: "fusion/rufu-893-v",
      })], { ref: "absent", registration: "absent" }, { planningColumns: null });

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows.find((r) => r.mutationType === REFUSED)?.metadata).toMatchObject({ code: "lane-vocabulary-unreadable" });
    });

    it("contains a probe that throws, and records the refusal rather than a crash", async () => {
      const h = harness([task("RUFU-893-T", {
        worktree: `${MANAGED_ROOT}/rufu-893-t`,
        branch: "fusion/rufu-893-t",
      })], { ref: "present", registration: "absent" }, { probeError: true });

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
    });
  });

  describe("the shapes this pass must not reach, before any probe is spent", () => {
    it("leaves a branch-only pointer in a WIP or review lane completely alone", async () => {
      const h = harness([
        task("RUFU-450-1", { column: "in-progress", worktree: null, branch: "fusion/rufu-450-1" }),
        task("RUFU-450-2", { column: "in-review", worktree: null, branch: "fusion/rufu-450-2" }),
      ], { ref: "absent" });

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows).toEqual([]);
      expect(h.probeCalls).toEqual([]);
    });

    it("leaves a complete-lane card to the completion fan-out during the periodic pass", async () => {
      const h = harness([task("RUFU-893-DONE", {
        column: "done",
        worktree: `${MANAGED_ROOT}/rufu-893-done`,
        branch: "fusion/rufu-893-done",
      })], { ref: "absent" });

      expect(await h.passes()).toBe(0);
      expect(h.auditRows).toEqual([]);
      expect(h.probeCalls).toEqual([]);
    });

    it("leaves an executing card, an externally blocked card, and a live-session path alone", async () => {
      const storeTasks = [
        task("RUFU-893-X", { worktree: `${MANAGED_ROOT}/rufu-893-x`, branch: "fusion/rufu-893-x" }),
        task("RUFU-893-Y", {
          worktree: `${MANAGED_ROOT}/rufu-893-y`,
          branch: "fusion/rufu-893-y",
          status: "blocked",
          externalBlock: { origin: "host-resource", code: "DISK_FULL", message: "disk full", observedAt: new Date().toISOString() },
        } as Partial<Task>),
      ];
      const h = harness(storeTasks, { ref: "absent" });
      (h.manager as unknown as { options: { getExecutingTaskIds: () => Set<string> } }).options.getExecutingTaskIds = () => new Set(["RUFU-893-X"]);

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows).toEqual([]);
    });

    it("keeps a branch-only planning pointer while a live checkout still names the branch", async () => {
      const h = harness(
        [task("RUFU-893-R", { worktree: null, branch: "fusion/rufu-893-r" })],
        { ref: "present", registration: "registered" },
        {},
        new Map([["fusion/rufu-893-r", `${MANAGED_ROOT}/rufu-893-r`]]),
      );

      expect(await h.passes()).toBe(0);
      expect(h.patches).toEqual([]);
      expect(h.auditRows).toEqual([]);
      /* The registration fact came from the pass's own inventory read, so no per-card probe was needed. */
      expect(h.probeCalls).toEqual([]);
    });
  });

  describe("the stranded-branch shape this sweep used to be blind to", () => {
    it("clears a card that claims a branch and no worktree once git says the ref is gone", async () => {
      /*
      The pre-work measurement, inverted: the same fixture (branch set, worktree null, ref absent) was
      asserted STANDING on the pre-change tree, because the entry gate was `if (!task.worktree) continue;`.
      18 of the 28 planning-lane mirrors measured on this project were in exactly this shape.
      */
      const h = harness([task("RUFU-254", { worktree: null, branch: "fusion/rufu-254" })], { ref: "absent", registration: "absent" });

      expect(await h.passes()).toBe(1);
      expect(h.patches).toEqual([{ id: "RUFU-254", patch: CLEAR_PATCH }]);
      expect((h.store.moveTask as never as { mock: { calls: unknown[] } }).mock.calls).toEqual([]);
    });

    it("refuses the same shape when that branch still carries undelivered commits", async () => {
      const h = harness([task("RUFU-893-SB", { worktree: null, branch: "fusion/rufu-893-sb" })], {
        ref: "present", registration: "absent", containment: "divergent", divergentCommitCount: 12,
      });

      expect(await h.passes()).toBe(0);
      expect(await h.store.getTask("RUFU-893-SB")).toMatchObject({ branch: "fusion/rufu-893-sb" });
      expect(h.history[0]!.message).toContain("12 commits");
    });
  });

  describe("the board vocabulary the lanes are named by", () => {
    it("recognises a renamed intake column instead of skipping it the way a literal id did", async () => {
      const h = harness([task("RUFU-893-Q", {
        column: "queue",
        worktree: `${MANAGED_ROOT}/rufu-893-q`,
        branch: "fusion/rufu-893-q",
      })], { ref: "absent", registration: "absent" }, {
        definitions: [{
          id: "custom:renamed",
          ir: {
            id: "custom:renamed",
            nodes: [],
            edges: [],
            columns: [
              { id: "queue", name: "Queue", traits: [{ trait: "intake" }] },
              { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
              { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
            ],
          },
        }],
      });

      expect(await h.passes()).toBe(1);
      expect(h.patches[0]!.id).toBe("RUFU-893-Q");
    });

    it("still finds the lane on a board that expresses no lifecycle trait at all", async () => {
      const h = harness([task("RUFU-893-N", {
        column: "backlog",
        worktree: `${MANAGED_ROOT}/rufu-893-n`,
        branch: "fusion/rufu-893-n",
      })], { ref: "absent", registration: "absent" }, {
        definitions: [{
          id: "custom:untraited",
          ir: {
            id: "custom:untraited",
            nodes: [],
            edges: [],
            columns: [
              { id: "backlog", name: "Backlog", traits: [] },
              { id: "doing", name: "Doing", traits: [] },
              { id: "closed", name: "Closed", traits: [] },
            ],
          },
        }],
      });

      /* `untraitedProject: "declared-columns"` is what admits this board; without it `backlog` is invisible. */
      expect(await h.passes()).toBe(1);
      expect(h.patches[0]!.id).toBe("RUFU-893-N");
    });
  });

  describe("containment of one card's failure", () => {
    it("does not let one refusing store write cost its siblings their clears", async () => {
      /*
      The RUFU-448 shape, reproduced on this sweep: before the change the whole card loop sat in the pass's
      single `try`, so the first refusing `updateTask` ended the pass and returned 0 — every card after it
      in board order went unexamined while the pass reported a clean zero. That is the same
      "standing pointer, no evidence anybody looked" symptom this card was filed for.
      */
      const h = harness([
        task("RUFU-893-BAD-STORE-REFUSES", {
          worktree: `${MANAGED_ROOT}/rufu-893-bad`,
          branch: "fusion/rufu-893-bad",
        }),
        task("RUFU-893-GOOD", {
          worktree: `${MANAGED_ROOT}/rufu-893-good`,
          branch: "fusion/rufu-893-good",
        }),
      ], { ref: "absent", registration: "absent" });

      expect(await h.passes()).toBe(1);
      expect(h.patches.map((p) => p.id)).toEqual(["RUFU-893-GOOD"]);
      expect(await h.store.getTask("RUFU-893-BAD-STORE-REFUSES")).toMatchObject({
        worktree: `${MANAGED_ROOT}/rufu-893-bad`,
      });
    });

    it("still clears when the audit sink itself is unreachable", async () => {
      const h = harness([task("RUFU-893-SINK", {
        worktree: `${MANAGED_ROOT}/rufu-893-sink`,
        branch: "fusion/rufu-893-sink",
      })], { ref: "absent", registration: "absent" });
      (h.store.recordRunAuditEvent as never as { mockImplementation: (fn: () => Promise<never>) => void })
        .mockImplementation(async () => { throw new Error("audit store unreachable"); });

      expect(await h.passes()).toBe(1);
      expect(h.patches[0]!.patch).toMatchObject(CLEAR_PATCH);
    });
  });

  describe("the completion fan-out is a different authority, not a gated planning clear", () => {
    it("clears a named card even while its ref is divergent, because completion owns that identity", async () => {
      /*
      `reconcileCompletedTask` clears the pointers and THEN deletes the branch, and a squash-merged tip
      stays a non-ancestor of `main` forever, so gating the fan-out on containment would refuse honest
      completions forever. Pinned here so a later tightening of the gate cannot silently capture it.
      */
      const h = harness([task("RUFU-893-FANOUT", {
        column: "done",
        worktree: `${MANAGED_ROOT}/rufu-893-fanout`,
        branch: "fusion/rufu-893-fanout",
      })], { ref: "present", registration: "absent", containment: "divergent", divergentCommitCount: 4 });

      expect(await h.passesWith(new Set(["RUFU-893-FANOUT"]))).toBe(1);
      expect(h.patches[0]!.patch).toMatchObject(CLEAR_PATCH);
      expect(h.probeCalls).toEqual([]);
      expect(h.history[0]!.message).toContain("as part of completing this card");
    });

    it("does not newly admit the branch-only shape through the fan-out", async () => {
      /*
      `post-merge-producer-surface.ts` documents that landed cards deliberately keep a stale branch name,
      and that lane's own tests assert it. The widening is scoped to the planning lane, so a completion
      fan-out still sees exactly the candidate set it saw before this change.
      */
      const h = harness([task("RUFU-893-FANOUT-BRANCH", {
        column: "done",
        worktree: null,
        branch: "fusion/rufu-893-fanout-branch",
      })], { ref: "absent" });

      expect(await h.passesWith(new Set(["RUFU-893-FANOUT-BRANCH"]))).toBe(0);
      expect(h.patches).toEqual([]);
    });
  });
});
