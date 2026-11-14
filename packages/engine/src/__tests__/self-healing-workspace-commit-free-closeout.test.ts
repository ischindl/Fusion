/*
 * Surface enumeration (docs/testing.md checklist): the engine reconcile arm plus the two operator surfaces
 * that render its verdict (`fn task reconcile` in task-reconcile.test.ts and the HTTP route in
 * routes-task-retry-stale-merge-status.test.ts). No desktop/mobile UI and no streaming/provider path
 * derives from this verdict.
 *
 * FNXC:ZeroCommitWorkspaceDelivery 2026-11-14-02:10 (RUFU-599):
 * The SANE-482 triangle. A workspace card the land lane recorded as delivered COMMIT-FREE (every declared
 * repository's branch tip already an ancestor of its own integration branch, so no commit was authored)
 * met three lanes reading three different facts: the merge door asked for post-merge evidence that had
 * never reported, the unproven-approval repair answers nothing for a workspace card by design, and
 * `reconcileLandedReviewTask` refused with the bare word `workspace`. One card, three refusals, no door.
 * These cases pin the one verdict the fence now gives — finalise on the recorded delivery when nothing is
 * owed, name the owed gate when something is — and the four shapes that must keep the old refusal.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { confirmRecordedLandingProof } from "../merge/zero-commit-finalization-guard.js";
import { COMMIT_FREE_DELIVERY_REASON } from "../merge/workspace-commit-free-delivery.js";

const STALL_ERROR = "In-review stall deadlock: completed-review-status-none repeated 3× without progress. Manual action required.";

/** The delivery the workspace land lane records for a board whose repositories were all already integrated. */
const RECORDED_DELIVERY = {
  mergedAt: "2026-11-13T10:00:00.000Z",
  mergeConfirmed: true,
  noOpMerge: true,
  noOpReason: COMMIT_FREE_DELIVERY_REASON,
  workspaceCommitFreeBasis: {
    saneca: "zero-ahead",
    "lager-manager": "zero-ahead",
    "lager-2026": "absent",
  },
  workspaceCommitFreeBranchTipShas: {
    saneca: "a11d1111a11d1111",
    "lager-manager": "b22c2222b22c2222",
  },
};

/** SANE-482's row: parked by the engine's own stall disposition in the review lane, delivery recorded. */
function deliveredWorkspaceCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-482",
    title: "Workspace card delivered commit-free",
    description: "RUFU-599 symptom card",
    column: "in-review",
    status: "failed",
    error: STALL_ERROR,
    paused: true,
    pausedReason: "in-review-stall-deadlock",
    autoMerge: true,
    branch: "fusion/sane-482",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceWorktrees: {
      saneca: { worktreePath: ".worktrees/sane", branch: "fusion/sane-482", baseBranch: "main" },
      "lager-manager": { worktreePath: ".worktrees/sane", branch: "fusion/sane-482", baseBranch: "main" },
      "lager-2026": { worktreePath: ".worktrees/sane", branch: "fusion/sane-482", baseBranch: "main" },
    },
    repositoryScope: { state: "confirmed", repositories: ["saneca", "lager-manager", "lager-2026"] },
    mergeDetails: { ...RECORDED_DELIVERY },
    ...overrides,
  } as Task;
}

function storeFor(
  initial: Task,
  options: {
    audit?: "present" | "absent" | "throw" | "reject" | "hang";
    beforeAtomic?: (row: Task) => Task;
    selection?: { workflowId: string; stepIds: string[] };
  } = {},
) {
  const auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const record = options.audit === "absent"
    ? undefined
    : vi.fn(async (input: { mutationType: string; metadata: Record<string, unknown> }) => {
      if (options.audit === "throw") throw new Error("sink exploded");
      if (options.audit === "reject") return await Promise.reject(new Error("sink rejected"));
      if (options.audit === "hang") return await new Promise<never>(() => undefined);
      auditRows.push({ mutationType: input.mutationType, metadata: input.metadata });
    });
  let row = initial;
  const store = Object.assign(new EventEmitter(), {
    getTask: vi.fn(async () => row),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true } as Settings)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (!column || row.column === column ? [row] : [])),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      row = { ...row, ...patch } as Task;
      return row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const current = options.beforeAtomic ? options.beforeAtomic(row) : row;
      const patch = updater(current);
      if (!patch) return null;
      row = { ...current, ...patch } as Task;
      return row;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      row = { ...row, column } as Task;
      return row;
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      row = { ...row, log: [...(row.log ?? []), { action }] } as Task;
    }),
    ...(record ? { recordRunAuditEvent: record } : {}),
    ...(options.selection ? {
      getTaskWorkflowSelection: vi.fn(() => options.selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => options.selection),
    } : {}),
  }) as unknown as TaskStore & EventEmitter & {
    row: Task;
    auditRows: typeof auditRows;
    moveTask: ReturnType<typeof vi.fn>;
    logEntry: ReturnType<typeof vi.fn>;
  };
  Object.defineProperty(store, "row", { get: () => row });
  return { store, auditRows };
}

/** Builds a manager whose singular git-probe seams are booby-trapped: this arm must never reach them. */
function managerFor(store: TaskStore) {
  const manager = new SelfHealingManager(store, { rootDir: "/repo" });
  const singularProbe = vi.fn(async () => {
    throw new Error("the recorded-delivery closeout must not run a singular branch probe");
  });
  Object.assign(manager, {
    emitTaskMerged: vi.fn(),
    isBranchTipMisboundToTask: singularProbe,
    findAlreadyMergedTaskCommit: singularProbe,
    hasUnlandedTaskOwnedContent: singularProbe,
    resolveSelfHealingMergeTarget: singularProbe,
  });
  return { manager, singularProbe };
}

function reconcile(manager: SelfHealingManager) {
  return manager.reconcileLandedReviewTask("SANE-482", { source: "manual", requireAutoMergeEligible: true });
}

describe("reconcileLandedReviewTask recorded commit-free workspace delivery (RUFU-599)", () => {
  it("closes the card on the recorded delivery, clears the engine park, and writes no invented sha", async () => {
    const { store, auditRows } = storeFor(deliveredWorkspaceCard());
    const { manager, singularProbe } = managerFor(store);

    const result = await reconcile(manager);

    expect(result).toEqual({
      outcome: "workspace-delivery-closed",
      repoCount: 3,
      dischargedCount: 2,
      repos: [
        { repo: "saneca", basis: "zero-ahead" },
        { repo: "lager-manager", basis: "zero-ahead" },
        { repo: "lager-2026", basis: "absent" },
      ],
    });
    expect(store.row.column).toBe("done");
    // The engine-authored stall park and the red state are lifted in the same write as the move.
    expect(store.row).toMatchObject({ status: null, error: null, paused: false, pausedReason: null, branch: null });
    // RUFU-504's rule holds on the closeout too: the delivery record stands as written, with no sha added.
    expect(store.row.mergeDetails).toEqual(RECORDED_DELIVERY);
    expect(store.row.mergeDetails?.commitSha).toBeUndefined();
    expect(singularProbe).not.toHaveBeenCalled();
    expect(auditRows.filter((row) => row.mutationType === "task:reconcile-workspace-landed-review")).toHaveLength(1);
    expect(auditRows[0].metadata).toMatchObject({ taskId: "SANE-482", source: "manual", repoCount: 3, dischargedCount: 2, outcome: "discharged", basisSource: "recorded" });
    // The close is stated to the operator as a delivery verdict, never as an approval.
    const history = (store.row.log ?? []).map((entry) => entry.action).join("\n");
    expect(history).toContain("recorded commit-free delivery");
    expect(history).toContain("no gate was waived");
  });

  it("names the owed post-merge gate instead of closing, and writes nothing", async () => {
    const { store, auditRows } = storeFor(deliveredWorkspaceCard({
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "skipped" }],
    }), { selection: { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] } });
    const { manager } = managerFor(store);

    await expect(reconcile(manager)).resolves.toEqual({
      outcome: "ineligible", reason: "post-merge-evidence-pending",
    });
    expect(store.row).toMatchObject({ column: "in-review", status: "failed", paused: true });
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it("refuses the close while a required content-review gate is unapproved (FN-180 holds)", async () => {
    const { store, auditRows } = storeFor(deliveredWorkspaceCard({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "code-review", status: "failed", reviewKind: "code" }],
    }), { selection: { workflowId: "builtin:coding", stepIds: ["code-review"] } });
    const { manager } = managerFor(store);

    const result = await reconcile(manager);

    expect(result).toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(store.row.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it.each([
    ["no recorded delivery kind", { noOpReason: undefined }],
    ["an unproven repository in the basis", { workspaceCommitFreeBasis: { saneca: "zero-ahead", "lager-manager": "unproven" } }],
    ["an all-absent basis (nothing was measured)", { workspaceCommitFreeBasis: { saneca: "absent" }, workspaceCommitFreeBranchTipShas: {} }],
    ["a zero-ahead claim with no recorded tip", { workspaceCommitFreeBranchTipShas: {} }],
  ] as const)("keeps the byte-identical `workspace` refusal for a record that is %s", async (_name, override) => {
    const { store, auditRows } = storeFor(deliveredWorkspaceCard({
      mergeDetails: { ...RECORDED_DELIVERY, ...override },
    }));
    const { manager } = managerFor(store);

    await expect(reconcile(manager)).resolves.toEqual({ outcome: "ineligible", reason: "workspace" });
    expect(store.row).toMatchObject({ column: "in-review", status: "failed", paused: true, mergeDetails: { ...RECORDED_DELIVERY, ...override } });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it("never lifts a user hold for this shape", async () => {
    const { store } = storeFor(deliveredWorkspaceCard({ userPaused: true }));
    const { manager } = managerFor(store);

    // `paused` is the refusal this row answers with: a user hold also sets `paused`, and that guard
    // stands ahead of the `userPaused` one. What matters is that neither may be lifted here.
    await expect(reconcile(manager)).resolves.toEqual({ outcome: "ineligible", reason: "paused" });
    expect(store.row.userPaused).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("loses the race when the row changed under the close and moves nothing", async () => {
    const { store, auditRows } = storeFor(deliveredWorkspaceCard(), {
      beforeAtomic: (row) => ({ ...row, mergeDetails: { ...row.mergeDetails, mergeTargetBranch: "main" } } as Task),
    });
    const { manager } = managerFor(store);

    await expect(reconcile(manager)).resolves.toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(store.row.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it.each(["throw", "reject", "absent", "hang"] as const)("closes the card unchanged when the audit sink %ss", async (audit) => {
    const { store } = storeFor(deliveredWorkspaceCard(), { audit });
    const { manager } = managerFor(store);

    await expect(reconcile(manager)).resolves.toMatchObject({ outcome: "workspace-delivery-closed" });
    expect(store.row.column).toBe("done");
  });
});

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-14-02:10 (RUFU-599) — the triangle, asserted as a table:
The defect was never one wrong verdict; it was three correct refusals that no lane combined. For the
delivered shape the reconcile lane now answers, so at most two refusals can stand at once; for a card
without a record the third corner stays exactly where RUFU-357 left it.
*/
describe("the three-corner triangle has no card shape that holds all three refusals", () => {
  it.each([
    ["recorded commit-free delivery", { mergeDetails: { ...RECORDED_DELIVERY } }, false],
    ["no recorded delivery", { mergeDetails: { mergeConfirmed: true, commitSha: "f66f6666f66f6666" } }, true],
  ] as const)("a %s card leaves the reconcile corner %s", async (_name, overrides, stillRefused) => {
    const { store } = storeFor(deliveredWorkspaceCard(overrides));
    const { manager } = managerFor(store);

    const result = await reconcile(manager);
    const reconcileRefusedWorkspace = result.outcome === "ineligible"
      && (result as { reason?: string }).reason === "workspace";

    expect(reconcileRefusedWorkspace).toBe(stillRefused);
  });
});

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-14-02:10 (RUFU-599):
The finalize side of the same fact. A recorded commit-free delivery names no sha, so the lane's corroboration
step has nothing to contain-check in the integration branch and must hand the proof through as read — while
a card with no record still hands through nothing. This is the seam every zero-commit finalize lane reads,
so the reconcile verdict above and the finalize evidence below cannot disagree.
*/
describe("confirmRecordedLandingProof over a recorded commit-free workspace delivery", () => {
  it("passes the recorded delivery through as proof, needing no containment probe", async () => {
    const card = deliveredWorkspaceCard();
    await expect(confirmRecordedLandingProof({
      task: card,
      repoDir: "/repo",
      integrationBranch: "main",
    })).resolves.toEqual({ kind: "workspace-commit-free" });
  });

  it("still reports no proof for a merge-confirmed workspace card that recorded no delivery", async () => {
    const card = deliveredWorkspaceCard({
      mergeDetails: { mergeConfirmed: true, noOpMerge: true },
    });
    await expect(confirmRecordedLandingProof({
      task: card,
      repoDir: "/repo",
      integrationBranch: "main",
    })).resolves.toBeNull();
  });
});
