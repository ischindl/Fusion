import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowIrForTaskWithProvenance,
  selectionMemoRegistryRefused,
  selectionMemoSizeForStore,
  selectionMemoStats,
  setSelectionMemoTtlMsForTests,
  UNCACHED_SELECTION_MEMO_MAX,
} from "../workflows/workflow-ir-resolver.js";

/*
FNXC:WorkflowSelectionMemo 2026-11-06-18:35 (RUFU-871):
Acceptance for the TTL bound on the resolver's no-cache selection read.

The coalescer and the concurrency bound already cover CONCURRENT duplicate reads. What they cannot cover is
the shape production actually has: ~50 call sites own no pass cache, so their reads are SEQUENTIAL and
distinct — 86,307 `workflowSelection` reads in one 5-minute window (288/s) on a board with zero running
cards. So every test here issues its reads one after another and asserts the store call count, which is the
only thing that distinguishes a memo from a coalescer.

The other half of the contract is that the memo must NOT win against correctness: an in-process selection
write, a disabled TTL, or an elapsed TTL all have to reach the store. `workflowSelectionEpoch()` is a
process-local counter, so the TTL is what bounds a write made by another process; both bounds are asserted.
*/

const codingSelection = { workflowId: "builtin:coding", stepIds: [] as string[] };
const DEFAULT_TTL_MS = 500;

interface FakeStoreOptions {
  /** Selection handed back per call; may vary by call index to model a write between reads. */
  select?: (callIndex: number, taskId: string) => { workflowId: string; stepIds: string[] } | undefined;
  /** Exposes an epoch the way `TaskStore` does, so epoch invalidation is exercised. */
  epoch?: () => number;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const state = { calls: 0, taskIds: [] as string[] };
  const store = {
    getTaskWorkflowSelectionAsync: vi.fn(async (taskId: string) => {
      const index = state.calls;
      state.calls += 1;
      state.taskIds.push(taskId);
      return options.select ? options.select(index, taskId) : codingSelection;
    }),
    getWorkflowDefinition: vi.fn(async () => ({ ir: { version: "v2", id: "builtin:coding", nodes: [], edges: [], columns: [] } })),
    ...(options.epoch ? { workflowSelectionEpoch: options.epoch } : {}),
  };
  return { store, state };
}

async function resolve(store: Record<string, unknown>, taskId = "RUFU-871"): Promise<void> {
  await resolveWorkflowIrForTaskWithProvenance(store as never, taskId);
}

const waitMacrotask = () => new Promise<void>((done) => setTimeout(done, 1));

afterEach(() => {
  setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
});

describe("uncached selection-read memo (RUFU-871)", () => {
  it("serves sequential uncached resolutions of one task from one read", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore();

    await resolve(store);
    await resolve(store);
    await resolve(store);

    // The coalescer cannot do this: each of these awaited before the next started.
    expect(state.calls).toBe(1);
    expect(selectionMemoSizeForStore(store as never)).toBe(1);
  });

  it("remembers an ABSENT selection, because absent selections are the N+1", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore({ select: () => undefined });

    await resolve(store);
    await resolve(store);

    expect(state.calls).toBe(1);
  });

  it("re-reads after the TTL elapses, which is the bound on a cross-process write", async () => {
    setSelectionMemoTtlMsForTests(1);
    const { store, state } = fakeStore({ select: (callIndex) => (callIndex === 0 ? codingSelection : { ...codingSelection, workflowId: "builtin:coding" }) });

    await resolve(store);
    await waitMacrotask();
    await resolve(store);

    expect(state.calls).toBe(2);
  });

  it("drops the memo the moment this process writes a selection (epoch moves)", async () => {
    setSelectionMemoTtlMsForTests(60_000);
    let epoch = 7;
    const { store, state } = fakeStore({
      epoch: () => epoch,
      select: (callIndex) => (callIndex === 0 ? codingSelection : { workflowId: "builtin:coding-2", stepIds: [] }),
    });

    await resolve(store);
    expect(state.calls).toBe(1);

    // A selection write through this store bumps the epoch; a memo entry from the old epoch is a miss.
    epoch += 1;
    await resolve(store);

    expect(state.calls).toBe(2);
  });

  it("keeps the documented live-per-call behaviour when the memo is disabled", async () => {
    setSelectionMemoTtlMsForTests(0);
    const { store, state } = fakeStore();

    await resolve(store);
    await resolve(store);

    expect(state.calls).toBe(2);
    expect(selectionMemoSizeForStore(store as never)).toBe(0);
  });

  it("bounds the memo itself at UNCACHED_SELECTION_MEMO_MAX entries", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore();

    for (let i = 0; i < UNCACHED_SELECTION_MEMO_MAX + 5; i += 1) {
      await resolve(store, `RUFU-${i}`);
    }

    expect(state.calls).toBe(UNCACHED_SELECTION_MEMO_MAX + 5);
    expect(selectionMemoSizeForStore(store as never)).toBe(UNCACHED_SELECTION_MEMO_MAX);
  });

  it("does not leak one store's selections into another store's resolution", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const first = fakeStore({ select: () => codingSelection });
    const second = fakeStore({ select: () => undefined });

    await resolve(first.store);
    await resolve(second.store);

    expect(first.state.calls).toBe(1);
    expect(second.state.calls).toBe(1);
    expect(selectionMemoSizeForStore(second.store as never)).toBe(1);
  });

  it("publishes its own hit rate, because store-seam reads cannot show whether the memo was asked", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const before = selectionMemoStats();
    const { store } = fakeStore();

    await resolve(store);
    await resolve(store);

    const after = selectionMemoStats();
    // One fresh read, one served from the memo.
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
    // The counters must be visible on /metrics, not only in process memory.
    expect(selectionMemoRegistryRefused()).toBe(false);
  });

  it("counts an entry dropped by a local selection write separately from a TTL lapse", async () => {
    setSelectionMemoTtlMsForTests(60_000);
    let epoch = 3;
    const { store } = fakeStore({ epoch: () => epoch });
    const before = selectionMemoStats();

    await resolve(store);
    epoch += 1;
    await resolve(store);

    expect(selectionMemoStats().staleEpoch - before.staleEpoch).toBe(1);
  });
});
