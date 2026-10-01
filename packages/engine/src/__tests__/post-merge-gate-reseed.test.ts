/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
A merge-confirmed card can sit in `in-review` forever because the enabled gate-mode post-merge group
never reported: the merge ran on the `merge-attempt` success edge, finalization refused, the run
ended, and nothing put the card back in front of the node. Measured on the production board
2026-09-25 as `Auto-merge finalization deferred for DGXS-313 / ROZV-290 … 'post-merge-verification'
has not reported`, with RUFU-220 and ROZV-286 parked the same way while their commits sat on `main`.

This lane must repair that WITHOUT three failure modes, and each has its own test below:
- it may not fabricate evidence — only a `missing` gate is seeded; an existing row carrying a real
  negative verdict is a review decision and re-running it would be a machine overruling a gate;
- it may not move the card — lifecycle containment (FN-207/FN-217) means the seeded continuation
  names the column the card actually stands in;
- it may not loop — finalize retries constantly, so the durable per-(task, gate) budget is what
  stops a gate that dies identically from burning model budget until the operator arrives.
*/
import { describe, expect, it, vi } from "vitest";
import { IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON, type Task, type TaskStore } from "@fusion/core";

import {
  MAX_POST_MERGE_GATE_RESEED_ATTEMPTS,
  postMergeGateReseedLogMarker,
  resumeMissingPostMergeGate,
} from "../merge/post-merge-gate-reseed.js";

const GATE_ID = "post-merge-verification";

const ir = {
  version: "v2",
  id: "builtin:coding",
  name: "Coding",
  nodes: [
    { id: "merge-attempt", kind: "action", column: "in-review" },
    {
      id: GATE_ID,
      kind: "optional-group",
      // The node's OWN column is the post-merge/complete lane — deliberately different from the
      // column the card stands in, so the in-place assertion below cannot pass by accident.
      column: "done",
      config: {
        phase: "post-merge",
        defaultOn: true,
        template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
      },
    },
  ],
  edges: [],
  columns: [
    { id: "in-review", label: "In review", traits: [] },
    { id: "done", label: "Done", traits: ["complete"] },
  ],
} as never;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-306",
    column: "in-review",
    title: "Landed but unfinalized",
    description: "",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: [GATE_ID],
    workflowStepResults: [],
    /*
    FNXC:PostMergeRecovery 2026-10-01-09:01: the merged guard is upstream's `mergeConfirmed` (FN-9442) — the
    SHA alone used to be this seam's proof, but every caller proves landing before asking, so the fixture
    carries the durable confirmation the real row carries.
    */
    mergeDetails: { mergeConfirmed: true, commitSha: "c1321d86936e6187ff8b5c769d2c15e204c4a3cb" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

interface FakeOptions {
  seedResult?: { seeded: boolean; reason?: string };
  selectionReads?: boolean;
}

function fakeStore(options: FakeOptions = {}) {
  const calls = {
    seed: [] as Array<Record<string, unknown>>,
    logged: [] as string[],
    audits: [] as Array<Record<string, unknown>>,
    selectionReads: 0,
  };
  const store = {
    getSettings: async () => ({}),
    getTaskWorkflowSelectionAsync: async () => null,
    getTaskWorkflowSelection: async () => null,
    getTaskWorkflowSelection: () => {
      if (options.selectionReads === false) return undefined;
      calls.selectionReads += 1;
      return { workflowId: "builtin:coding", stepIds: [] };
    },
    getWorkflowDefinition: async () => ({ ir }),
    listWorkflowWorkItemsForTask: async () => [],
    seedWorkspaceCodeReviewContinuationIfIdle: async (input: Record<string, unknown>) => {
      calls.seed.push(input);
      return options.seedResult ?? { seeded: true };
    },
    logEntry: async (_id: string, action: string) => { calls.logged.push(action); },
    recordRunAuditEvent: async (event: Record<string, unknown>) => { calls.audits.push(event); },
    getTask: async () => null,
  };
  return { store: store as unknown as TaskStore, calls };
}

describe("resumeMissingPostMergeGate", () => {
  it("seeds the unreported gate in place, keeps the card's own column, and records one marker", async () => {
    const { store, calls } = fakeStore();

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("seeded");
    expect(result.reason).toBe("seeded");
    expect(calls.seed).toHaveLength(1);
    const seed = calls.seed[0]!;
    expect(seed.nodeId).toBe(GATE_ID);
    expect(seed.state).toBe("runnable");
    // Lifecycle containment: the seed must name where the card actually stands, never a lane it is
    // being pushed back into.
    expect(seed.sourceColumn).toBe("in-review");
    expect(seed.targetColumn).toBe("in-review");
    expect(seed.targetColumn).not.toBe(ir.nodes[1].column);
    expect(calls.logged.filter((line) => line.startsWith(postMergeGateReseedLogMarker(GATE_ID)))).toHaveLength(1);
    expect(calls.audits.some((event) => event.mutationType === "task:merge-unrun-post-merge-gate-reseeded")).toBe(true);
  });

  it("refuses to re-run a gate that produced a real negative verdict", async () => {
    const { store, calls } = fakeStore();
    const decided = task({
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "failed", verdict: "REVISE" }],
    } as never);

    const result = await resumeMissingPostMergeGate(store, decided, { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("not-seeded");
    expect(result.reason).toBe("gate-not-resumable");
    expect(calls.seed).toHaveLength(0);
    expect(calls.logged).toHaveLength(0);
  });

  it("stops after the durable per-gate budget, because finalize retries forever", async () => {
    const marker = postMergeGateReseedLogMarker(GATE_ID);
    const spent = task({
      log: Array.from({ length: MAX_POST_MERGE_GATE_RESEED_ATTEMPTS }, (_, index) => ({
        action: `${marker} attempt ${index}`,
      })),
    } as never);
    const { store, calls } = fakeStore();

    const result = await resumeMissingPostMergeGate(store, spent, { source: "self-healing", contract: undefined });

    expect(result.reason).toBe("rerun-budget-exhausted");
    expect(result.priorAttemptCount).toBe(MAX_POST_MERGE_GATE_RESEED_ATTEMPTS);
    expect(calls.seed).toHaveLength(0);
  });

  it("treats every operator hold as absolute, and admits only the stall park it is undoing", async () => {
    const held = [
      task({ userPaused: true } as never),
      task({ autoMerge: false } as never),
      task({ paused: true, pausedReason: "operator-hold" } as never),
    ];
    for (const card of held) {
      const { store, calls } = fakeStore();
      const result = await resumeMissingPostMergeGate(store, card, { source: "self-healing", contract: undefined });
      expect(result.reason).toBe("operator-held");
      expect(calls.seed).toHaveLength(0);
    }

    const parkedByOurOwnLane = task({ paused: true, pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON } as never);
    const admitted = fakeStore();
    expect((await resumeMissingPostMergeGate(admitted.store, parkedByOurOwnLane, { source: "self-healing", contract: undefined })).outcome).toBe("seeded");
  });

  it("demands landed proof before touching the graph, and stays silent without a selection read", async () => {
    const withoutProof = fakeStore();
    expect((await resumeMissingPostMergeGate(withoutProof.store, task({ mergeDetails: {} } as never), { source: "self-healing", contract: undefined })).reason)
      .toBe("no-merge-proof");
    // An empty mergeDetails object must not even start workflow resolution.
    expect(withoutProof.calls.selectionReads).toBe(0);

    const blind = fakeStore({ selectionReads: false });
    const blindStore = Object.assign(blind.store, { getTaskWorkflowSelection: undefined }) as unknown as TaskStore;
    expect((await resumeMissingPostMergeGate(blindStore, task(), { source: "self-healing", contract: undefined })).reason).toBe("gate-not-resumable");
  });

  it("reports an idle-seed refusal as a refusal and logs no budget marker", async () => {
    const { store, calls } = fakeStore({ seedResult: { seeded: false, reason: "active-continuation" } });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("not-seeded");
    expect(result.reason).toBe("active-continuation");
    expect(calls.logged).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
  });
});
