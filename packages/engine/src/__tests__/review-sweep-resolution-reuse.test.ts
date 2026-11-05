/*
FNXC:ReviewSweepResolutionReuse 2026-11-05-22:40 (RUFU-584):
`findReviewLaneCandidates` ticks every 15 s and walks every card on the board. It passed a per-task
`selectionCache` but `undefined` for `irCache`, so a pass cost one `task_workflow_selection` read per card
plus one workflow-IR resolution per card, while the board holds a handful of distinct workflows. The
read-attribution sampler named this exact sweep as the dominant producer — one 5-minute window recorded
`361/6581` and `252/5280` reads stacked under `findReviewLaneCandidates < runPass < tick`.

This is asserted as READ COUNTS, not as behaviour: the whole point of the change is that a pass must not
issue (cards) round trips, and a consumer that never looks at the discarded results cannot notice their
absence — which is precisely why the two column-narrowing fixes before this one measured null while this
site kept producing the frames that hold the heap.

`getWorkflowDefinition` is the IR read; its count is what proves the IR cache is threaded.
`getTaskWorkflowSelectionAsync` (singular) is the per-card read the batch prefill must displace.
*/
import { describe, expect, it } from "vitest";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";

type Counters = { batch: number; batchIds: string[]; singular: number; definitions: string[] };

function makeSweep(counters: Counters) {
  // 6 cards across 2 distinct workflows: reuse must be measured against 2, never against 6.
  const cards = Array.from({ length: 6 }, (_, i) => ({
    id: `RUFU-90${i}`,
    column: "review",
    updatedAt: "2026-11-05T00:00:00.000Z",
    paused: 0,
    userPaused: 0,
  }));
  const selectionFor = (id: string) => ({ workflowId: i2w(id), stepIds: [] });
  // NOT `builtin:*`: a builtin id resolves from the compiled-in catalogue without touching
  // `getWorkflowDefinition`, which made an earlier version of this fixture measure nothing at all — it
  // passed with the IR cache absent. Custom ids force the real definition read the cache exists to skip.
  function i2w(id: string): string {
    return Number(id.slice(-1)) % 2 === 0 ? "wf-alpha" : "wf-beta";
  }
  const store = {
    getProjectId: () => "proj_test",
    listTasks: async () => cards,
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async (id: string) => {
      counters.singular += 1;
      return selectionFor(id);
    },
    getTaskWorkflowSelectionsAsync: async (ids: string[]) => {
      counters.batch += 1;
      counters.batchIds = ids;
      return new Map(ids.map((id) => [id, selectionFor(id)]));
    },
    getWorkflowDefinition: async (id: string) => {
      counters.definitions.push(id);
      /*
      The definition must be FOUND, not absent. `workflow-ir-resolver-coalescing.test.ts` pins the opposite
      case on purpose: three concurrent resolutions of a missing definition coalesce to one read, the cache
      stays empty, and a later resolution retries — “keeps missing and failed definitions retryable”. An
      earlier version of this fixture returned undefined, which is why it measured 6 reads even with the IR
      cache threaded: a miss is deliberately never cached, so it could not demonstrate reuse.
      */
      return { ir: { nodes: [], edges: [] } };
    },
    // `latestTaskEnteredReviewAt` reads through the async layer; an empty row set means "no recorded entry".
    asyncLayer: { transactionImmediate: async () => [] },
  } as never;

  const sweep = new ReviewDispatchSweep({
    store,
    agentStore: { listAgents: async () => [] } as never,
    heartbeatMonitor: {} as never,
    now: () => Date.parse("2026-11-05T00:00:00.000Z"),
    e4LogCooldownMs: 300_000,
  });
  return sweep as unknown as {
    findReviewLaneCandidates: () => Promise<unknown[]>;
  };
}

describe("review sweep resolution reuse (RUFU-584)", () => {
  it("prefills workflow selections with ONE batch read instead of one per card", async () => {
    const counters: Counters = { batch: 0, batchIds: [], singular: 0, definitions: [] };
    const candidates = await makeSweep(counters).findReviewLaneCandidates();

    expect(counters.batch).toBe(1);
    expect(counters.batchIds).toHaveLength(6);
    expect(counters.singular).toBe(0);
    // The scan still has to find its cards: an optimisation that quietly stopped dispatching would be worse.
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("resolves the workflow IR once per distinct workflow, not once per card", async () => {
    const counters: Counters = { batch: 0, batchIds: [], singular: 0, definitions: [] };
    await makeSweep(counters).findReviewLaneCandidates();

    // 6 cards, 2 distinct workflows: 6 means the cache is not threaded, 2 means each workflow resolved once.
    expect(counters.definitions).toEqual(expect.arrayContaining(["wf-alpha", "wf-beta"]));
    expect(counters.definitions.length).toBe(2);
  });
});
