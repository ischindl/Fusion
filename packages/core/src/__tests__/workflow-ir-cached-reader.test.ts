/*
FNXC:WorkflowIrHoist 2026-11-08-06:07 (RUFU-871):
`createCachedWorkflowIrReader` is the synchronous half of hoisting workflow-IR resolution out of a
per-card loop. The engine-side evidence (that it removes the per-card await, and by how much) is in
`packages/engine/src/__tests__/hold-release-sweep-evaluate-cost.test.ts`; this file pins the reader's
own contract, which is the part that could be silently WRONG rather than merely slow.

The reader answers from an already-warm cache and must NEVER guess. Three shapes, and the two misses
are load-bearing:
 - the card's IR is cached → that exact object, the same one the async resolver returns;
 - the selection cache has no ENTRY for the card → `undefined`. An absent entry is not an absent
   selection: the async resolver would go read the store, and answering the default here would fold a
   card into a workflow pool it was never assigned to. This is the one way this seam could change a
   release decision, so it is asserted from both directions.
 - the card's workflow is not cached (a missing, malformed, or throwing definition is deliberately
   never written to `irCache`) → `undefined`, and the async path keeps its documented fail-soft.
*/
import { describe, expect, it, vi } from "vitest";
import {
  createCachedWorkflowIrReader,
  resolveWorkflowIrById,
  type WorkflowIr,
  type WorkflowSelectionCache,
} from "../workflows/workflow-ir-resolver.js";

const PROJECT = "proj-reader";

function ir(id: string): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      { id: "hold", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "wip", label: "WIP", traits: [{ trait: "wip", config: { limit: 1 } }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(definitions: Record<string, WorkflowIr | undefined>, projectScope = PROJECT) {
  const store = {
    getWorkflowSettingsProjectId: vi.fn(() => projectScope),
    getWorkflowDefinition: vi.fn(async (workflowId: string) => {
      const resolved = definitions[workflowId];
      return resolved ? { ir: resolved } : undefined;
    }),
  };
  return store;
}

describe("createCachedWorkflowIrReader", () => {
  it("returns the cached IR for a selected workflow — the same object the async resolver returned", async () => {
    const store = storeWith({ "custom:a": ir("custom:a") });
    const irCache = new Map<string, WorkflowIr>();
    const asyncIr = await resolveWorkflowIrById(store, "custom:a", irCache);
    const selectionCache: WorkflowSelectionCache = new Map([
      ["CARD-1", { workflowId: "custom:a", stepIds: [] }],
    ]);

    const read = createCachedWorkflowIrReader(store, irCache, selectionCache);
    expect(read("CARD-1")).toBe(asyncIr);
  });

  it("answers the default workflow for a card the store gave no selection for", async () => {
    const store = storeWith({});
    const irCache = new Map<string, WorkflowIr>();
    const asyncIr = await resolveWorkflowIrById(store, "builtin:coding", irCache);
    const selectionCache: WorkflowSelectionCache = new Map([["CARD-1", undefined]]);

    expect(createCachedWorkflowIrReader(store, irCache, selectionCache)("CARD-1")).toBe(asyncIr);
  });

  it("does NOT answer for a card the selection cache has no entry for, even with the default cached", async () => {
    const store = storeWith({});
    const irCache = new Map<string, WorkflowIr>();
    await resolveWorkflowIrById(store, "builtin:coding", irCache);
    // The default IR IS warm (some other card needed it). The entry, not the value, is what's missing.
    expect(irCache.size).toBe(1);
    const selectionCache: WorkflowSelectionCache = new Map([["OTHER", undefined]]);

    expect(createCachedWorkflowIrReader(store, irCache, selectionCache)("CARD-1")).toBeUndefined();
  });

  it("does NOT answer for a workflow whose definition could not be resolved, and keeps it retryable", async () => {
    const store = storeWith({ "custom:gone": undefined });
    const irCache = new Map<string, WorkflowIr>();
    const selectionCache: WorkflowSelectionCache = new Map([
      ["CARD-1", { workflowId: "custom:gone", stepIds: [] }],
    ]);
    const degraded = await resolveWorkflowIrById(store, "custom:gone", irCache);
    // A fallback is never cached, so the cache stays empty and the reader stays silent.
    expect(irCache.size).toBe(0);
    expect(createCachedWorkflowIrReader(store, irCache, selectionCache)("CARD-1")).toBeUndefined();
    // And the async path re-reads the definition rather than throwing or serving a cached fallback:
    // the retry is the behaviour the uncached path relies on, so it must still reach the store.
    const before = (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await resolveWorkflowIrById(store, "custom:gone", irCache)).toEqual(degraded);
    expect((store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
  });

  it("reads the project scope once per reader, not once per card", async () => {
    const store = storeWith({ "custom:a": ir("custom:a") });
    const irCache = new Map<string, WorkflowIr>();
    await resolveWorkflowIrById(store, "custom:a", irCache);
    const selectionCache: WorkflowSelectionCache = new Map(
      Array.from({ length: 235 }, (_unused, index) => [`CARD-${index}`, { workflowId: "custom:a", stepIds: [] }]),
    );
    (store.getWorkflowSettingsProjectId as ReturnType<typeof vi.fn>).mockClear();

    const read = createCachedWorkflowIrReader(store, irCache, selectionCache);
    // The construction itself is the ONE scope read; the 235 lookups below must add none.
    expect(store.getWorkflowSettingsProjectId).toHaveBeenCalledTimes(1);
    (store.getWorkflowSettingsProjectId as ReturnType<typeof vi.fn>).mockClear();
    for (const [id] of selectionCache) expect(read(id)).toBeDefined();

    // Zero per card. Before the hoist a 235-card board paid 235 of these inside the sweep's loop.
    expect(store.getWorkflowSettingsProjectId).toHaveBeenCalledTimes(0);
  });

  it("never serves one project's graph to another project's reader", async () => {
    const sharedIr = ir("custom:a");
    const storeA = storeWith({ "custom:a": sharedIr }, "proj-a");
    const storeB = storeWith({ "custom:a": sharedIr }, "proj-b");
    const cacheA = new Map<string, WorkflowIr>();
    await resolveWorkflowIrById(storeA, "custom:a", cacheA);
    const selectionCache: WorkflowSelectionCache = new Map([
      ["CARD-1", { workflowId: "custom:a", stepIds: [] }],
    ]);

    // The same warm cache, read under a different project scope, is a miss — the key carries the scope.
    expect(createCachedWorkflowIrReader(storeB, cacheA, selectionCache)("CARD-1")).toBeUndefined();
    expect(createCachedWorkflowIrReader(storeA, cacheA, selectionCache)("CARD-1")).toBe(sharedIr);
  });
});
