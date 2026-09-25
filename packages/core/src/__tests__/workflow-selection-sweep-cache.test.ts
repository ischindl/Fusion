/*
FNXC:SelfHealingReadShape 2026-09-25-13:27 (RUFU-312 step 2):
The engine's recovery sweeps resolve a card's workflow IR for every row they iterate. The IR cache does
NOT short-circuit the selection read — `resolveWorkflowIrForTaskWithProvenance` reads
`task_workflow_selection` first — so an N-row sweep issued N SELECTs. Measured on the production board
2026-09-25: 82-131 concurrent identical selection SELECTs at all times with 0 tasks executing, from 24
project engines each running sweeps with 68 resolver sites.

This pins the mechanism the sweeps now use, at the seam they use it through, so the fix cannot be
reverted by a caller-side refactor that keeps passing an IR cache but drops the selection cache:

1. One `prefetchWorkflowSelections` call is ONE batched read for the whole id set, and a card with no
   selection row is cached as `undefined` rather than re-read.
2. Resolving every prefetched id afterwards issues ZERO further selection reads.
3. Without the selection cache, the same N resolutions are N reads — the N+1 this change removed.
*/
import { describe, expect, it } from "vitest";
import {
  prefetchWorkflowSelections,
  resolveWorkflowIrForTask,
  type WorkflowIr,
  type WorkflowSelection,
  type WorkflowSelectionCache,
} from "../workflows/workflow-ir-resolver.js";

const BUILTIN_DEFAULT_IR = {
  version: "v2",
  id: "builtin:coding",
  nodes: [],
  edges: [],
  columns: [{ id: "todo", label: "Todo", traits: [] }],
} as unknown as WorkflowIr;

interface ReadShapeFake {
  store: {
    getTaskWorkflowSelection(_taskId: string): WorkflowSelection | undefined;
    getTaskWorkflowSelectionsAsync?(_ids: readonly string[]): Promise<Map<string, WorkflowSelection>>;
    getWorkflowDefinition(workflowId: string): Promise<{ ir: WorkflowIr } | undefined>;
  };
  singles: number;
  batched: number;
}

function makeFakeStore(ids: string[], opts: { withBatchReader: boolean }): ReadShapeFake {
  const selection: WorkflowSelection = { workflowId: "custom:sweep", stepIds: [] };
  // The tally must live ON the returned object: a spread of a counter object snapshots zeros, which
  // would make every read-shape assertion here pass vacuously.
  const shape: ReadShapeFake = { singles: 0, batched: 0 } as ReadShapeFake;
  const store: ReadShapeFake["store"] = {
    getTaskWorkflowSelection() {
      shape.singles += 1;
      return selection;
    },
    async getWorkflowDefinition(workflowId: string) {
      return workflowId === "custom:sweep" ? { ir: BUILTIN_DEFAULT_IR } : undefined;
    },
  };
  if (opts.withBatchReader) {
    store.getTaskWorkflowSelectionsAsync = async (wanted: readonly string[]) => {
      shape.batched += 1;
      // Every third card has no selection row: the batch must still cover it (cached `undefined`) so
      // an absent selection does not fall back into an N+1.
      const present = wanted.filter((_, index) => index % 3 !== 0);
      return new Map(present.map((id) => [id, selection]));
    };
  }
  shape.store = store;
  return shape;
}

describe("sweep-scoped workflow selection cache", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `RUFU-${100 + i}`);

  it("hydrates a whole sweep with one batched read and keeps absent rows cached", async () => {
    const fake = makeFakeStore(ids, { withBatchReader: true });
    const cache: WorkflowSelectionCache = new Map();

    const tally = await prefetchWorkflowSelections(fake.store, ids, cache);

    expect(tally).toEqual({ batched: 1, singles: 0 });
    expect(cache.size).toBe(ids.length);
    expect(fake.singles).toBe(0);
  });

  it("resolves every prefetched card without issuing a further selection read", async () => {
    const fake = makeFakeStore(ids, { withBatchReader: true });
    const cache: WorkflowSelectionCache = new Map();
    await prefetchWorkflowSelections(fake.store, ids, cache);
    expect(fake.singles).toBe(0);

    const irCache = new Map<string, WorkflowIr>();
    for (const id of ids) {
      await resolveWorkflowIrForTask(fake.store as never, id, irCache, cache);
    }

    expect(fake.singles).toBe(0);
    expect(fake.batched).toBe(1);
  });

  it("still reads one selection per card when the cache is not threaded (the N+1 being removed)", async () => {
    const fake = makeFakeStore(ids, { withBatchReader: true });

    const irCache = new Map<string, WorkflowIr>();
    for (const id of ids) {
      await resolveWorkflowIrForTask(fake.store as never, id, irCache);
    }

    expect(fake.singles).toBe(ids.length);
    expect(fake.batched).toBe(0);
  });
});
