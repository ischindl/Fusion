/*
FNXC:WorkflowPromptOverrideMemo 2026-11-07-15:50 (RUFU-871):
Acceptance for the TTL+epoch bound on the prompt-override read inside `resolveWorkflowIrById`.

Production measured the read one layer BELOW the workflow-selection read: one `/api/tasks/page` request
sampled 243 `task_workflow_selection` selects AND 69 `select "overrides" from "project"."workflow_prompt_overrides"`.
Every resolution of a BUILT-IN workflow applies project-scoped overrides, and the override-applied IR is only
cached per caller pass, so a caller that owns no `irCache` paid one overrides SELECT per card — the shape the
RUFU-871 selection memo left behind.

Every case here asserts the STORE CALL COUNT, never timing: a memo and a coalescer are indistinguishable by
latency in a test, and the production defect is sequential (each resolution awaits before the next starts).
The counter-ratchet case is "N cards, one read": if the bound is removed, `overridesCalls` grows with the card
count and every one of these goes red.

The other half of the contract is that the memo must never beat correctness: a local override/definition write
(moving `workflowDefinitionEpoch()`), a disabled TTL, or an elapsed TTL must all reach the store, and the
sync-only reader path must stay exactly as live-per-call as it was.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promptOverridesMemoRegistryRefused,
  promptOverridesMemoSizeForStore,
  promptOverridesMemoStats,
  PROMPT_OVERRIDES_MEMO_MAX,
  resolveWorkflowIrForTask,
  setSelectionMemoTtlMsForTests,
} from "../workflows/workflow-ir-resolver.js";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";

const BUILTIN_ID = "builtin:coding";
/** Reuses the selection memo's bound on purpose — one TTL source of truth, one disable switch. */
const DEFAULT_TTL_MS = 500;

/** A prompt-bearing node id of the real built-in graph, so the override assertion is about shipped text. */
const promptNodeId = ((): string => {
  const ir = getBuiltinWorkflow(BUILTIN_ID)!.ir as { nodes: Array<{ id: string; kind: string; config?: { prompt?: string } }> };
  const node = ir.nodes.find((n) => (n.kind === "prompt" || n.kind === "gate") && typeof n.config?.prompt === "string");
  if (!node) throw new Error("built-in coding workflow has no prompt-bearing node");
  return node.id;
})();

interface FakeStoreOptions {
  /** Overrides returned per call index, so a write between reads can be modelled. */
  overrides?: (callIndex: number) => Record<string, string>;
  /** Exposes a definition epoch the way `TaskStore` does, so epoch invalidation is exercised. */
  epoch?: () => number;
  projectId?: string;
  /** Only the synchronous reader exists — the SQLite/embedder path. */
  syncOnly?: boolean;
  /** The async read throws, modelling a transient failure. */
  failing?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const state = { calls: 0, syncCalls: 0, keys: [] as string[], syncKeys: [] as string[] };
  const store = {
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: BUILTIN_ID, stepIds: [] as string[] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingsProjectId: () => options.projectId ?? "proj-1",
    ...(options.syncOnly
      ? {
          getWorkflowPromptOverrides: vi.fn((workflowId: string, projectId: string) => {
            state.syncCalls += 1;
            state.syncKeys.push(`${workflowId}|${projectId}`);
            return options.overrides?.(state.syncCalls - 1) ?? {};
          }),
        }
      : {
          getWorkflowPromptOverridesAsync: vi.fn(async (workflowId: string, projectId: string) => {
            const index = state.calls;
            state.calls += 1;
            state.keys.push(`${workflowId}|${projectId}`);
            if (options.failing) throw new Error("prompt override read failed");
            return options.overrides?.(index) ?? {};
          }),
        }),
    ...(options.epoch ? { workflowDefinitionEpoch: options.epoch } : {}),
  };
  return { store, state };
}

async function resolve(store: ReturnType<typeof fakeStore>["store"], taskId: string): Promise<Awaited<ReturnType<typeof resolveWorkflowIrForTask>>> {
  return resolveWorkflowIrForTask(store as never, taskId);
}

const waitMacrotask = () => new Promise<void>((done) => setTimeout(done, 1));

afterEach(() => {
  setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
});

describe("prompt-override read memo (RUFU-871)", () => {
  it("serves a 40-card pass over one built-in workflow from ONE overrides read", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore();

    for (let i = 0; i < 40; i += 1) await resolve(store, `RUFU-${i}`);

    // The ratchet: 40 distinct cards, one project-scoped override map. Without the memo this is 40.
    expect(state.calls).toBe(1);
    expect(promptOverridesMemoSizeForStore(store)).toBe(1);
  });

  it("memorises the EMPTY override map, because an uncustomised project is the common N+1", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore({ overrides: () => ({}) });

    await resolve(store, "RUFU-1");
    await resolve(store, "RUFU-2");

    expect(state.calls).toBe(1);
  });

  it("serves the operator's override text, not just a cached call count", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store } = fakeStore({ overrides: () => ({ [promptNodeId]: "PROJECT CUSTOM PROMPT" }) });

    const ir = await resolve(store, "RUFU-1");
    const served = await resolve(store, "RUFU-2");

    const promptOf = (nodeId: string) => (served.nodes.find((n) => n.id === nodeId) as { config?: { prompt?: string } }).config?.prompt;
    expect(promptOf(promptNodeId)).toBe("PROJECT CUSTOM PROMPT");
    expect(ir.nodes.length).toBe(served.nodes.length);
  });

  it("drops the memo the moment this process writes an override (definition epoch moves)", async () => {
    setSelectionMemoTtlMsForTests(60_000);
    let epoch = 11;
    const { store, state } = fakeStore({
      epoch: () => epoch,
      overrides: (callIndex) => ({ [promptNodeId]: callIndex === 0 ? "OLD TEXT" : "NEW TEXT" }),
    });

    const first = await resolve(store, "RUFU-1");
    expect((first.nodes.find((n) => n.id === promptNodeId) as { config?: { prompt?: string } }).config?.prompt).toBe("OLD TEXT");
    expect(state.calls).toBe(1);

    // `updateWorkflowPromptOverrides` bumps the definition epoch; an entry from the old epoch is a miss.
    epoch += 1;
    const second = await resolve(store, "RUFU-2");

    expect(state.calls).toBe(2);
    expect((second.nodes.find((n) => n.id === promptNodeId) as { config?: { prompt?: string } }).config?.prompt).toBe("NEW TEXT");
  });

  it("re-reads after the TTL elapses, which is the bound on a write made by another process", async () => {
    setSelectionMemoTtlMsForTests(1);
    const { store, state } = fakeStore();

    await resolve(store, "RUFU-1");
    await waitMacrotask();
    await resolve(store, "RUFU-2");

    expect(state.calls).toBe(2);
  });

  it("keeps the documented live-per-call behaviour when the memo is disabled", async () => {
    setSelectionMemoTtlMsForTests(0);
    const { store, state } = fakeStore();

    await resolve(store, "RUFU-1");
    await resolve(store, "RUFU-2");

    expect(state.calls).toBe(2);
    expect(promptOverridesMemoSizeForStore(store)).toBe(0);
  });

  it("never remembers a failed read, so a transient failure is retried not served as {}", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore({ failing: true });

    await expect(resolve(store, "RUFU-1")).rejects.toThrow("prompt override read failed");
    await expect(resolve(store, "RUFU-2")).rejects.toThrow("prompt override read failed");

    expect(state.calls).toBe(2);
    expect(promptOverridesMemoSizeForStore(store)).toBe(0);
  });

  it("keys the entry by (workflow, project), so one store serves both without bleed", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore();

    await resolve(store, "RUFU-1");
    // A second project scope on the same store is a distinct entry, not a hit.
    (store as unknown as { getWorkflowSettingsProjectId: () => string }).getWorkflowSettingsProjectId = () => "proj-2";
    await resolve(store, "RUFU-2");

    expect(state.calls).toBe(2);
    expect(state.keys).toEqual([`${BUILTIN_ID}|proj-1`, `${BUILTIN_ID}|proj-2`]);
    expect(promptOverridesMemoSizeForStore(store)).toBe(2);
  });

  it("leaves the synchronous reader path live-per-call and unchanged", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore({ syncOnly: true, overrides: () => ({ [promptNodeId]: "SYNC PROMPT" }) });

    const first = await resolve(store, "RUFU-1");
    const second = await resolve(store, "RUFU-2");

    expect(state.syncCalls).toBe(2);
    expect(promptOverridesMemoSizeForStore(store)).toBe(0);
    for (const ir of [first, second]) {
      expect((ir.nodes.find((n) => n.id === promptNodeId) as { config?: { prompt?: string } }).config?.prompt).toBe("SYNC PROMPT");
    }
  });

  it("bounds the memo at PROMPT_OVERRIDES_MEMO_MAX entries", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const { store, state } = fakeStore();
    const projectIds = Array.from({ length: PROMPT_OVERRIDES_MEMO_MAX + 3 }, (_, i) => `proj-${i}`);

    for (const projectId of projectIds) {
      (store as unknown as { getWorkflowSettingsProjectId: () => string }).getWorkflowSettingsProjectId = () => projectId;
      await resolve(store, "RUFU-1");
    }

    expect(state.calls).toBe(PROMPT_OVERRIDES_MEMO_MAX + 3);
    expect(promptOverridesMemoSizeForStore(store)).toBe(PROMPT_OVERRIDES_MEMO_MAX);
  });

  it("publishes its own hit rate, because store-seam reads cannot show whether the memo was asked", async () => {
    setSelectionMemoTtlMsForTests(DEFAULT_TTL_MS);
    const before = promptOverridesMemoStats();
    const { store } = fakeStore();

    await resolve(store, "RUFU-1");
    await resolve(store, "RUFU-2");

    const after = promptOverridesMemoStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
    expect(promptOverridesMemoRegistryRefused()).toBe(false);
  });

  it("counts an entry dropped by a local write separately from a TTL lapse", async () => {
    setSelectionMemoTtlMsForTests(60_000);
    let epoch = 4;
    const { store } = fakeStore({ epoch: () => epoch });
    const before = promptOverridesMemoStats();

    await resolve(store, "RUFU-1");
    epoch += 1;
    await resolve(store, "RUFU-2");

    expect(promptOverridesMemoStats().staleEpoch - before.staleEpoch).toBe(1);
  });
});
