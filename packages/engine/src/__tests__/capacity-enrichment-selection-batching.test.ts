import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { persistedTopLevelAgentTaskIdsFromStore } from "../concurrency/concurrency.js";

/*
FNXC:WorkflowSelectionBatching 2026-11-06-20:42 (RUFU-871):
The capacity sweep enriches every candidate card, and enrichment resolved one workflow selection PER CARD.
The read-attribution seam measured 63,210 `workflowSelection` reads in one 5-minute window on a board with
zero running cards, and the resolver's memo counters proved only ~28 % came from callers owning no cache —
so the remaining traffic was passes x cards, and the fix is one batched read per pass, not another cache.

These assertions are about query COUNT, which is the only thing that distinguishes a batched fill from an
N+1 fill: both warm the same caller-owned pass cache and both preserve the "next pass must observe writes"
contract that makes a pass cache correct.
*/

const BUILTIN_IR = { version: "v2", id: "builtin:coding", nodes: [], edges: [], columns: [] };

function board(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `RUFU-${i}`,
    title: `card ${i}`,
    description: "",
    column: "in-progress",
  })) as unknown as Task[];
}

function storeFor(options: { selections?: boolean } = {}) {
  const state = { batches: 0, singles: 0, batchSizes: [] as number[] };
  const store = {
    ...(options.selections === false
      ? {}
      : {
          getTaskWorkflowSelectionsAsync: vi.fn(async (ids: string[]) => {
            state.batches += 1;
            state.batchSizes.push(ids.length);
            return new Map<string, { workflowId: string; stepIds: string[] }>();
          }),
        }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => ({ ir: BUILTIN_IR })),
  };
  return { store, state };
}

describe("capacity enrichment batches its workflow-selection reads (RUFU-871)", () => {
  it("reads N cards in one query instead of N", async () => {
    const { store, state } = storeFor();

    await persistedTopLevelAgentTaskIdsFromStore(store as never, board(24));

    expect(state.batches).toBe(1);
    expect(state.batchSizes).toEqual([24]);
    // The per-card single read must not be used at all once the pass cache is warm.
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("keeps the caller's pass cache authoritative and still fills it in one query", async () => {
    const { store, state } = storeFor();
    const callerCache = new Map<string, { workflowId: string; stepIds: string[] } | undefined>();

    await persistedTopLevelAgentTaskIdsFromStore(store as never, board(10), { selectionCache: callerCache });

    expect(state.batches).toBe(1);
    // The caller's cache is the one that got filled, so a later step in the same sweep reuses it.
    expect(callerCache.size).toBe(10);
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("falls back to per-card reads when the store has no batch read, without losing correctness", async () => {
    const { store, state } = storeFor({ selections: false });

    await expect(persistedTopLevelAgentTaskIdsFromStore(store as never, board(3))).resolves.toBeDefined();

    expect(state.batches).toBe(0);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(3);
  });

  it("does not add a batch read for a single-card caller", async () => {
    const { store, state } = storeFor();

    await persistedTopLevelAgentTaskIdsFromStore(store as never, board(1));

    expect(state.batches).toBe(0);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(1);
  });
});
