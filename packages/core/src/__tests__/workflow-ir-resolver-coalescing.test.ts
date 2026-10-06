import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowIrById,
  resolveWorkflowIrForTaskWithProvenance,
  SELECTION_READ_CONCURRENCY,
  type WorkflowDefinitionReadTally,
} from "../workflows/workflow-ir-resolver.js";

const customIr = { version: "v2", id: "custom:big", nodes: [], edges: [], columns: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function storeFor(getWorkflowDefinition = vi.fn(async () => ({ ir: customIr }))) {
  return {
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition,
  };
}

/**
 * Store fake for the SELECTION read, with concurrency accounting.
 * `resolveWorkflowIrForTaskWithProvenance` needs nothing else when the selection names a built-in,
 * so a built-in id keeps these tests about selection reads instead of definition reads.
 */
function selectionStore(select: (taskId: string) => Promise<{ workflowId: string; stepIds: string[] } | undefined>) {
  const state = { calls: 0, inFlight: 0, maxInFlight: 0 };
  return {
    state,
    store: {
      getTaskWorkflowSelectionAsync: vi.fn(async (taskId: string) => {
        state.calls += 1;
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          return await select(taskId);
        } finally {
          state.inFlight -= 1;
        }
      }),
      getWorkflowDefinition: vi.fn(async () => ({ ir: customIr })),
    },
  };
}

const codingSelection = { workflowId: "builtin:coding", stepIds: [] };

describe("uncached selection-read coalescing (RUFU-588)", () => {
  it("collapses concurrent uncached callers for one task onto a single read", async () => {
    const gate = deferred<{ workflowId: string; stepIds: string[] } | undefined>();
    const { store, state } = selectionStore(() => gate.promise);
    const pending = Promise.all(
      Array.from({ length: 50 }, () => resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1")),
    );
    await Promise.resolve();
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(1);
    gate.resolve(codingSelection);
    const resolutions = await pending;
    expect(resolutions).toHaveLength(50);
    expect(resolutions.every((r) => r.source === "selection")).toBe(true);
  });

  it("does not retain the selection after the read settles, so a later call still sees an edit", async () => {
    let current: { workflowId: string; stepIds: string[] } | undefined = codingSelection;
    const { store, state } = selectionStore(async () => current);
    await resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1");
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(1);
    // The coalescer must be empty now; if it cached the value this second call would be free.
    current = { workflowId: "custom:big", stepIds: [] };
    await resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1");
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
  });

  it("bounds in-flight distinct-task reads instead of admitting one query per row", async () => {
    const { store, state } = selectionStore(async () => codingSelection);
    const total = SELECTION_READ_CONCURRENCY * 3;
    await Promise.all(
      Array.from({ length: total }, (_unused, i) => resolveWorkflowIrForTaskWithProvenance(store, `RUFU-${i}`)),
    );
    // Every task still got its read (no value was shared across DIFFERENT tasks), but never more
    // than the bound at once — that bound is what keeps 48 callers from becoming 48 parked frames.
    expect(state.calls).toBe(total);
    expect(state.maxInFlight).toBeLessThanOrEqual(SELECTION_READ_CONCURRENCY);
    expect(state.maxInFlight).toBeGreaterThan(1);
  });

  it("keeps a failing uncached read retryable rather than coalescing the failure in", async () => {
    let fail = true;
    const { store } = selectionStore(async () => {
      if (fail) throw new Error("transient postgres failure");
      return codingSelection;
    });
    await expect(resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1")).resolves.toMatchObject({ source: "default" });
    fail = false;
    await resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1");
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
  });

  it("keeps the caller-owned cache path untouched, so a shared pass cache still skips the coalescer", async () => {
    const { store } = selectionStore(async () => codingSelection);
    const sharedPassCache = new Map();
    await resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1", undefined, sharedPassCache);
    await resolveWorkflowIrForTaskWithProvenance(store, "RUFU-1", undefined, sharedPassCache);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledOnce();
  });
});

describe("workflow IR resolver coalescing", () => {
  it("coalesces fifty concurrent custom workflow reads sharing a pass cache", async () => {
    const read = deferred<{ ir: typeof customIr } | undefined>();
    const store = storeFor(vi.fn(() => read.promise));
    const cache = new Map();
    const tally: WorkflowDefinitionReadTally = { definitions: 0 };
    const pending = Promise.all(Array.from({ length: 50 }, () => resolveWorkflowIrById(store, "custom:big", cache, tally)));
    await Promise.resolve();
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(tally.definitions).toBe(1);
    read.resolve({ ir: customIr });
    await expect(pending).resolves.toEqual(Array.from({ length: 50 }, () => customIr));
  });

  it("keeps uncached single-row callers live", async () => {
    const store = storeFor();
    await Promise.all(Array.from({ length: 3 }, () => resolveWorkflowIrById(store, "custom:big")));
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(3);
  });

  it("does not share inflight reads across caller cache objects or project scopes", async () => {
    const store = storeFor();
    await Promise.all([
      resolveWorkflowIrById(store, "custom:big", new Map()),
      resolveWorkflowIrById(store, "custom:big", new Map()),
    ]);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(2);
    const first = storeFor();
    const second = storeFor();
    Object.assign(first, { getWorkflowSettingsProjectId: () => "one" });
    Object.assign(second, { getWorkflowSettingsProjectId: () => "two" });
    const shared = new Map();
    await Promise.all([resolveWorkflowIrById(first, "custom:big", shared), resolveWorkflowIrById(second, "custom:big", shared)]);
    expect(first.getWorkflowDefinition).toHaveBeenCalledOnce();
    expect(second.getWorkflowDefinition).toHaveBeenCalledOnce();
  });

  it.each([undefined, new Error("temporary")])("keeps missing and failed definitions retryable", async (result) => {
    const getter = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const store = storeFor(getter);
    const cache = new Map();
    await Promise.all(Array.from({ length: 3 }, () => resolveWorkflowIrById(store, "custom:missing", cache)));
    expect(getter).toHaveBeenCalledTimes(1);
    expect(cache).toHaveLength(0);
    await resolveWorkflowIrById(store, "custom:missing", cache);
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it("reports only issued custom reads", async () => {
    const store = storeFor();
    const tally: WorkflowDefinitionReadTally = { definitions: 0 };
    await resolveWorkflowIrById(store, "builtin:coding", new Map(), tally);
    await resolveWorkflowIrForTaskWithProvenance(store, "absent", new Map(), new Map(), tally);
    await resolveWorkflowIrById(store, "custom:big", new Map([["custom:big", customIr]]), tally);
    expect(tally.definitions).toBe(0);
    await resolveWorkflowIrById(store, "custom:big", new Map(), tally);
    expect(tally.definitions).toBe(1);
  });
});
