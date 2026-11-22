/**
 * RUFU-834 — symptom verification for the inert failed merge node.
 *
 * The symptom being encoded (Original symptom, from the card): a review-lane card sits `in-review` with
 * plan-review and code-review approved, `status` NULL, `error` empty, `mergeRetries` 0, and its `merge`
 * workflow work item `failed`. It looks healthy, nothing re-drives it, and its file-scope lease freezes
 * every overlapping card. Measured: RUFU-293 inert for 14 days with 104 cards waiting on
 * `file-scope:RUFU-293` (144 `held` rows across three such cards).
 *
 * PART ONE (control) asserts the three facts that made the state inert. They must stay true: this task
 * adds a named owner, it does not widen the generic pumps. If a control turns green-by-widening, the
 * fix has become the defect RUFU-272 warns about.
 *
 * PART TWO (assertion that the symptom is gone) drives the real seam — `SelfHealingManager
 * .reconcileInertMergeNode()` — and requires the failure to become claimable, the `failed` row to
 * survive as the record it is, and the paired audit row to exist. The lease-freeze half asserts the
 * release owner's real behavior, not this seam's intention.
 *
 * FNXC:MergeNodeReArm 2026-11-22-00:24 (RUFU-834, reconciled with RUFU-832):
 * The lease sentence in the symptom above is the MEASURED state at the time this card was written.
 * RUFU-832 has since landed on main and a review-trait column answers `none` at `classifyFileScopeLease`,
 * so an inert review card no longer freezes new overlapping work; it still holds its checkout and branch.
 * The lease assertions below therefore state that current contract, and the surviving defect this seam
 * owns — a terminal `failed` merge row with no re-entry owner, so the merge never runs — is unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  fileScopeLeaseBlocksCandidate,
  taskHoldsUnmergedCheckout,
  type Task,
  type WorkflowWorkItem,
} from "@fusion/core";
import { readFileSync } from "node:fs";
import { classifyFileScopeLease } from "../scheduler.js";
import {
  releaseFileScopeWaitingContinuations,
  FILE_SCOPE_CONTINUATION_WAIT_PREFIX,
} from "../runtimes/in-process-runtime.js";
import { attemptExecutionRearm } from "../executor/execution-rearm.js";
import { evaluateStrandedContinuationReclaim } from "../workflows/stranded-continuation-reclaim.js";
import { SelfHealingManager } from "../self-healing.js";

const MIN = 60_000;
const FOURTEEN_DAYS_AGO = new Date(Date.now() - 14 * 24 * 60 * MIN).toISOString();

const INERT = "RUFU-834";
const FOLLOWER = "RUFU-999";

function mergeIr() {
  return {
    version: "v2",
    columns: [
      { id: "todo", name: "Todo", role: "todo", traits: [{ trait: "intake" }] },
      { id: "in-progress", name: "WIP", role: "wip", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "Review", role: "review", traits: [{ trait: "merge-blocker" }] },
      { id: "done", name: "Done", role: "done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "step-execute", kind: "step-execute", column: "in-progress" },
      { id: "plan-review", kind: "optional-group", column: "in-review", config: { name: "Plan Review", defaultOn: true } },
      { id: "code-review", kind: "optional-group", column: "in-review", config: { name: "Code Review", defaultOn: true } },
      { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } },
      { id: "cleanup", kind: "end", column: "done" },
    ],
    edges: [],
  } as any;
}

/** The card exactly as RUFU-293 presented: healthy on every field a status gate reads. */
function inertCard(overrides: Record<string, unknown> = {}) {
  return {
    id: INERT,
    title: "inert failed merge node",
    column: "in-review",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    worktree: `.fusion/worktrees/${INERT}`,
    branch: `fusion/${INERT}`,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    steps: [{ id: "0", title: "Preflight", status: "done" }],
    workflowStepResults: [
      { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
    ],
    mergeDetails: { mergeRetries: 0, commitSha: null },
    dependencies: [],
    createdAt: FOURTEEN_DAYS_AGO,
    updatedAt: FOURTEEN_DAYS_AGO,
    ...overrides,
  } as any;
}

/** The dead merge row: `failed`, fourteen days old, no lease, no active sibling. */
function deadMergeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-merge", runId: `${INERT}:merge`, taskId: INERT, nodeId: "merge", kind: "task",
    state: "failed", attempt: 1, retryAfter: null, leaseOwner: null, leaseExpiresAt: null,
    lastError: "workflow-graph-node-failed", blockedReason: null,
    createdAt: FOURTEEN_DAYS_AGO, updatedAt: FOURTEEN_DAYS_AGO,
    ...overrides,
  } as any;
}

describe("RUFU-834 symptom control: the three facts that made a failed merge node inert", () => {
  it("the due-poll never claims a failed row — neither the active-state enumeration nor the pump's own filter admits it", () => {
    // Fact 1 of the control: `failed` is not a work state, so the enumerations that drive claiming
    // never name it. This is a claim-set fact, not a source-text fact.
    expect(ACTIVE_WORKFLOW_WORK_ITEM_STATES).not.toContain("failed");
    expect(ACTIVE_WORKFLOW_WORK_ITEM_STATES).toEqual(expect.arrayContaining(["runnable", "retrying", "held"]));

    // And the pump's own due read is an explicit allowlist of the two claimable states. This scan is a
    // call-site allowlist guard: it is what the RUFU-834 pointer comment at that site promises, and a
    // widened filter there would give every terminal row a re-entry with no evidence and no budget.
    const pump = readFileSync("src/runtimes/in-process-runtime.ts", "utf8");
    expect(pump).toContain('states: ["runnable", "retrying"]');
    expect(pump).not.toMatch(/states: \[[^\]]*"failed"/);
  });

  it("RUFU-308's execution re-arm refuses this card twice, and writes nothing", async () => {
    const card = inertCard();
    const store: any = {
      getTask: vi.fn(async () => card),
      replaceActiveTaskWorkflowContinuation: vi.fn(async () => card),
      updateTaskAtomic: vi.fn(async () => null),
      getSettings: vi.fn(async () => ({ integrationBranch: "main" })),
      getRootDir: () => "/repo",
      listWorkflowWorkItemsForTask: vi.fn(async () => [deadMergeRow()]),
    };
    const deps: any = {
      store,
      emptinessProver: { proveTask: async () => new Map([["", "occupied"]]) },
      hasLiveExecutionSurface: () => false,
    };

    // Guard 1: the lane. RUFU-308's re-arm is the WIP-lane owner.
    const wrongLane = await attemptExecutionRearm(deps, { taskId: INERT, failedNode: "merge", reason: "step-failed", wipColumn: "in-progress" });
    expect(wrongLane.outcome).toBe("not-eligible");
    expect(wrongLane.detail).toContain("not the WIP lane");

    // Guard 2: the node. Put the same card in the WIP lane and the dead `merge` node is still not a
    // step-execute owner, so the same seam still refuses — the gap is the intersection, not one guard.
    const inWip = inertCard({ column: "in-progress" });
    store.getTask = vi.fn(async () => inWip);
    const wrongNode = await attemptExecutionRearm(deps, {
      taskId: INERT, failedNode: "merge", reason: "step-failed", wipColumn: "in-progress",
    });
    expect(wrongNode.outcome).toBe("not-eligible");
    expect(wrongNode.detail).toContain("not a step-execute node");

    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("stranded-continuation-reclaim refuses the failed row by design", () => {
    // Fact 3 of the control: the generic stranded sweep's terminal-state exclusion. Widening it is the
    // tempting wrong fix, and this assertion is what makes that temptation visible.
    const verdict = evaluateStrandedContinuationReclaim({
      item: deadMergeRow() as WorkflowWorkItem,
      taskTerminal: false,
      taskMissing: false,
      taskPaused: false,
      live: false,
      enginePaused: false,
      stalenessMs: 14 * 24 * 60 * 60 * 1000,
      graceMs: 15 * 60 * 1000,
      now: Date.now(),
    } as any);
    expect(verdict.action).toBe("none");
    expect(verdict.reason).toBe("scheduler-owned");
  });
});

describe("RUFU-834 symptom assertion: the failed merge node is now claimable again", () => {
  function sweepStore(options: { card?: any; rows?: any[] } = {}) {
    const card = options.card ?? inertCard();
    const rows = options.rows ?? [deadMergeRow()];
    const seeded: any[] = [];
    const auditRows: any[] = [];
    const tasks = [card];
    const applyPatch = (id: string, patch: any) => {
      const target = tasks.find((task) => task.id === id);
      if (!target) return null;
      const { sourceMetadataPatch, ...rest } = patch ?? {};
      Object.assign(target, rest);
      if (sourceMetadataPatch) {
        target.sourceMetadata = { ...(target.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(sourceMetadataPatch)) {
          if (value === null) delete target.sourceMetadata[key];
          else target.sourceMetadata[key] = value;
        }
      }
      return target;
    };
    const store: any = {
      recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => { auditRows.push(event); }),
      getRootDir: () => "/repo",
      getSettings: vi.fn(async () => ({ autoMerge: true, integrationBranch: "main" })),
      listTasks: vi.fn(async (input: any) => tasks.slice(input?.offset ?? 0, (input?.offset ?? 0) + (input?.limit ?? tasks.length))),
      listWorkflowWorkItemsForTasks: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, rows]))),
      listWorkflowWorkItemsForTask: vi.fn(async () => rows),
      getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
      getTaskWorkflowSelection: () => ({ workflowId: "custom:mergeflow", stepIds: ["plan-review", "code-review"] }),
      getWorkflowDefinition: async () => ({ ir: mergeIr() }),
      updateTask: vi.fn(async (id: string, patch: any) => applyPatch(id, patch)),
      updateTaskAtomic: vi.fn(async (id: string, reducer: any) => {
        const current = tasks.find((task) => task.id === id);
        if (!current) return null;
        const patch = reducer(current);
        return patch ? applyPatch(id, patch) : null;
      }),
      replaceActiveTaskWorkflowContinuation: vi.fn(async (input: any) => { seeded.push(input); return input; }),
      transitionWorkflowWorkItem: vi.fn(async () => null),
      logEntry: vi.fn(async () => undefined),
      logEntryOnce: vi.fn(async () => true),
      moveTask: vi.fn(async () => undefined),
    };
    return { store, card, rows, seeded, auditRows };
  }

  function managerFor(store: any) {
    return new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set<string>(),
      isTaskActive: () => false,
      checkoutEmptinessProver: { proveTask: async () => new Map([["", "occupied"]]) },
    } as any);
  }

  it("re-arms the fourteen-day-old dead row into the pump's own claim set", async () => {
    const { store, card, seeded, rows, auditRows } = sweepStore();
    const manager = managerFor(store);
    await expect(manager.reconcileInertMergeNode()).resolves.toBe(1);

    // (a) the failure became claimable again — installed INTO the claim set the due poll reads.
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ taskId: INERT, nodeId: "merge", kind: "task", state: "retrying" });
    expect(typeof seeded[0].retryAfter).toBe("string");
    expect(new Date(seeded[0].retryAfter).getTime()).toBeGreaterThan(Date.now() - 1_000);
    expect(ACTIVE_WORKFLOW_WORK_ITEM_STATES).toContain(seeded[0].state);

    // (b) the failed row SURVIVES. The re-entry is a new continuation installed by the sanctioned
    // primitive; the verdict row is never rewritten, or the record of what failed would be laundered.
    expect(rows[0].state).toBe("failed");
    expect(rows[0].lastError).toBe("workflow-graph-node-failed");
    expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);

    // (c) the paired audit row exists, ids/counts/fixed enums only.
    const rearmed = auditRows.find((row) => row.mutationType === "task:merge-rearmed");
    expect(rearmed, JSON.stringify(auditRows.map((row) => row.mutationType))).toBeDefined();
    expect(rearmed.metadata).toMatchObject({ taskId: INERT, nodeId: "merge", outcome: "rearmed", evidence: "occupied" });
    // No prose, no paths, no SHAs: every value is an id, a count, or a fixed enum.
    for (const [key, value] of Object.entries(rearmed.metadata as Record<string, unknown>)) {
      expect(["taskId", "nodeId", "reason", "attempt", "attemptLimit", "evidence", "outcome"], key).toContain(key);
      if (typeof value === "string") {
        expect(value.length, `${key} is implausibly long for a fixed enum`).toBeLessThan(64);
        expect(value, `${key} looks like a path`).not.toMatch(/\/(worktrees|\.git)\//);
      }
    }

    // and the card itself never moved lane or gained a status, which is what makes this an execution
    // re-arm rather than a lifecycle move (RUFU-308's distinction).
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(card.column).toBe("in-review");
    expect(card.status).toBeNull();
    manager.stop();
  });

  it("still holds its unmerged checkout while inert, claims no scheduling lease from the review lane, and the release owner frees rows already parked on its blocker", async () => {
    const holder = inertCard();
    const follower = {
      id: FOLLOWER, column: "in-progress", createdAt: new Date().toISOString(), columnMovedAt: new Date().toISOString(),
      worktree: null, title: "waiting", status: null, error: null, dependencies: [],
    } as any;

    /*
    FNXC:MergeNodeReArm 2026-11-22-00:24 (RUFU-834, reconciled with RUFU-832):
    The card measured before this seam was built was an ACTIVE lease holder while inert — 104 cards
    answered `held` with `file-scope:RUFU-293`. RUFU-832 has since landed and a review-trait column now
    answers `none`: a card parked in review writes nothing, so it may no longer make an overlapping card
    wait. That retires the FREEZE half of the original symptom; it does not retire this card's defect,
    which was that nothing owned its re-entry, so its merge never ran and its work never landed.

    So this asserts the two facts the seam actually rests on now: the unmerged CHECKOUT is still held
    (that is the sweep's page-cheap pre-filter and the proof the delivery is unlanded — RUFU-832 keeps
    the branch and worktree because the merger reads them), while the scheduling claim is released, so a
    new overlapping card is never frozen by an inert one. Rows already parked on a `file-scope:<id>`
    wait predate that release and still need the release owner below, which is why exhaustion has to
    terminalize rather than spin.
    */
    expect(taskHoldsUnmergedCheckout(holder as Task)).toBe(true);
    const inertClassification = classifyFileScopeLease(holder as Task, [holder as Task, follower]);
    expect(inertClassification.kind).toBe("none");
    expect(fileScopeLeaseBlocksCandidate(holder as Task, follower, inertClassification)).toBe(false);

    // The release owner exists and works: given a committed release for that blocker, a held row whose
    // wait names it returns to the claim set. This is the half the card's terminalization feeds.
    const heldRow: any = {
      id: "row-held", taskId: FOLLOWER, kind: "task", state: "held",
      leaseOwner: null, leaseExpiresAt: null, blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}${INERT}`,
    };
    const transitions: any[] = [];
    const followerStore: any = {
      getTask: async () => follower,
      listWorkflowWorkItemsForTask: async () => [heldRow],
      transitionWorkflowWorkItem: async (id: string, to: string, patch: any) => {
        transitions.push({ id, to, patch });
        return { id, state: to, leaseOwner: patch.leaseOwner ?? null };
      },
    };
    const released = await releaseFileScopeWaitingContinuations(followerStore, [{ taskId: FOLLOWER, blockerId: INERT }]);
    expect(released).toEqual(["row-held"]);
    expect(transitions[0]).toMatchObject({ id: "row-held", to: "runnable" });
    expect(transitions[0].patch).toMatchObject({ expectedState: "held", expectedLeaseOwner: null, blockedReason: null });

    // And the freeze ends where the merge is allowed to finish: a landed card is no longer a holder at
    // all, which is the outcome this seam exists to make reachable instead of waited out.
    const landed = { ...inertCard(), column: "done", mergeDetails: { mergeRetries: 0, commitSha: "0123456", mergeConfirmed: true } };
    const landedClassification = classifyFileScopeLease(landed as Task, [landed as Task, follower]);
    expect(landedClassification.kind).toBe("none");
    expect(fileScopeLeaseBlocksCandidate(landed as Task, follower, landedClassification)).toBe(false);
  });

  it("spends its own budget and terminalizes rather than re-arming forever, in the same lane", async () => {
    const built = sweepStore();
    const manager = managerFor(built.store);
    for (let pass = 0; pass < 20; pass += 1) {
      await manager.reconcileInertMergeNode();
      built.store.replaceActiveTaskWorkflowContinuation.mockClear();
    }
    const card = built.card;
    expect(card.column).toBe("in-review");
    expect(card.status).toBe("failed");
    expect(String(card.error).startsWith("MERGE_REARM_EXHAUSTED:")).toBe(true);
    expect(built.store.moveTask).not.toHaveBeenCalled();
    // The park is announced once, not once per pass.
    const terminalized = built.auditRows.filter((row) => row.mutationType === "task:merge-rearm-exhausted");
    expect(terminalized.length).toBe(1);
    expect(terminalized[0].metadata).toMatchObject({ outcome: "exhausted", column: "in-review" });
    manager.stop();
  });
});
