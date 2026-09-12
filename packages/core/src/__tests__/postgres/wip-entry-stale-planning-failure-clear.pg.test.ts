// @vitest-environment node
/*
FNXC:PlanningFailureClear 2026-09-12-13:26:
RUFU-228 symptom test (store seam). RUFU-225's card reached the WIP lane through the graph column
boundary (plan-review passed after an FN-8592 stranded-hold reseed) while still carrying the
terminal planning failure `status:"failed"` + `PLANNING_FAILED_EXHAUSTED: …` from the superseded
planning attempt. The board then rendered one live card as two stacked cards: the active WIP card
plus the red `.card-error` band for a failure the card had already recovered from.

These scenarios drive the EXACT option shape the executor's workflow column boundary emits
(`moveSource:"engine"`, `lifecycleReason:"workflow-graph-node-column"`,
`workflowMoveSource:"workflow-graph"`, `bypassGuards:true`, `preserveProgress:true`) against the
real store, per the RUFU-228 Symptom Verification contract:

  - Scenario 1 (symptom): a forward planning → WIP crossing of a stale terminal planning failure
    clears status+error and keeps `task:moved` provenance. Pre-fix this fails — both fields survive.
  - Scenario 2 (review-lane guardrail): a REAL current failure carried by a WIP card handed to
    review must survive — the merge gate reads status/error there. The review crossing drives the
    production handoff route (in-progress → in-review); the default IR has no todo → in-review
    adjacency, so the handoff is the faithful mover into the review lane.
  - Scenario 3 (non-terminal guardrail): `needs-replan` / null status with an error is untouched —
    only the terminal `failed` park is stale on forward advance.
  - Scenario 4 (unrelated-field guardrail): blockedBy / overlapBlockedBy / pause / step progress
    survive the crossing — the clear touches `status` and `error` only.

Pattern copied from `lifecycle-move-provenance-emit.test.ts` (SharedPgTaskStoreHarness).
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const STALE_PLANNING_ERROR =
  "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage";

/** The exact option shape produced by the executor's workflow column boundary. */
const GRAPH_BOUNDARY_MOVE = {
  moveSource: "engine",
  lifecycleReason: "workflow-graph-node-column",
  workflowMoveSource: "workflow-graph",
  bypassGuards: true,
  preserveProgress: true,
} as const;

pgDescribe("stale planning failure clear on WIP entry (real move path)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_wip_stale_clear",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  type MovedPayload = {
    from: string;
    to: string;
    workflowMoveSource?: string;
    lifecycleReason?: string;
  };

  const captureMoved = (
    store: ReturnType<SharedPgTaskStoreHarness["store"]>,
  ): { events: MovedPayload[]; stop: () => void } => {
    const events: MovedPayload[] = [];
    const listener = (data: MovedPayload) => {
      events.push(data);
    };
    store.on("task:moved", listener as never);
    return { events, stop: () => store.off("task:moved", listener as never) };
  };

  /** Park a task in the planning lane with the given transient failure state. */
  const seedPlanningFailure = async (
    store: ReturnType<SharedPgTaskStoreHarness["store"]>,
    patch: { status?: string; error?: string },
  ) => {
    const task = await store.createTask({ description: "stale planning failure RUFU-228" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.updateTask(task.id, patch);
    return store.getTask(task.id);
  };

  it("symptom: forward planning → WIP crossing clears the stale terminal planning failure", async () => {
    const store = h.store();
    const seeded = await seedPlanningFailure(store, { status: "failed", error: STALE_PLANNING_ERROR });
    expect(seeded.column).toBe("todo");
    expect(seeded.status).toBe("failed");
    expect(seeded.error).toBe(STALE_PLANNING_ERROR);

    const captured = captureMoved(store);
    try {
      await store.moveTask(seeded.id, "in-progress", {
        ...GRAPH_BOUNDARY_MOVE,
        workflowMoveMetadata: { fromColumn: "todo", nodeId: "execute" },
      });
    } finally {
      captured.stop();
    }

    const row = await store.getTask(seeded.id);
    // The card is live in the work lane…
    expect(row.column).toBe("in-progress");
    // …without the stale terminal failure that rendered the red band beneath it.
    expect(row.status ?? null).toBeNull();
    expect(row.error ?? null).toBeNull();

    // Existing provenance behavior must survive the clear.
    const forward = captured.events.find((event) => event.to === "in-progress");
    expect(forward?.workflowMoveSource).toBe("workflow-graph");
    expect(forward?.lifecycleReason).toBe("workflow-graph-node-column");
  });

  it("review guardrail: a current WIP failure survives handoff into the review lane", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "live execution failure RUFU-228" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "engine", bypassGuards: true });
    // Mid-work failure — the legitimate in-progress error the retry is about.
    await store.updateTask(task.id, { status: "failed", error: "EXECUTION_FAILED: build broke" });

    await store.moveTask(task.id, "in-review", { ...GRAPH_BOUNDARY_MOVE });

    const row = await store.getTask(task.id);
    expect(row.column).toBe("in-review");
    // The merge gate reads status/error in review — handoff must not erase them.
    expect(row.status).toBe("failed");
    expect(row.error).toBe("EXECUTION_FAILED: build broke");
  });

  it("non-terminal guardrail: needs-replan status is untouched by the forward crossing", async () => {
    const store = h.store();
    const seeded = await seedPlanningFailure(store, { status: "needs-replan", error: STALE_PLANNING_ERROR });

    await store.moveTask(seeded.id, "in-progress", {
      ...GRAPH_BOUNDARY_MOVE,
      workflowMoveMetadata: { fromColumn: "todo", nodeId: "execute" },
    });

    const row = await store.getTask(seeded.id);
    expect(row.column).toBe("in-progress");
    expect(row.status).toBe("needs-replan");
    expect(row.error).toBe(STALE_PLANNING_ERROR);
  });

  it("non-terminal guardrail: null status with an error keeps the error (only failed clears)", async () => {
    const store = h.store();
    const seeded = await seedPlanningFailure(store, { error: "PLAN_WARNING: non-terminal note" });
    expect(seeded.status ?? null).toBeNull();

    await store.moveTask(seeded.id, "in-progress", {
      ...GRAPH_BOUNDARY_MOVE,
      workflowMoveMetadata: { fromColumn: "todo", nodeId: "execute" },
    });

    const row = await store.getTask(seeded.id);
    expect(row.column).toBe("in-progress");
    expect(row.status ?? null).toBeNull();
    expect(row.error).toBe("PLAN_WARNING: non-terminal note");
  });

  it("unrelated-field guardrail: blockedBy/overlap/pause/step progress survive the crossing", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "unrelated fields RUFU-228" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.updateTask(task.id, {
      status: "failed",
      error: STALE_PLANNING_ERROR,
      blockedBy: "FN-9001",
      overlapBlockedBy: "FN-9002",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
    });
    await store.updateTask(task.id, {
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
      ],
    });

    await store.moveTask(task.id, "in-progress", {
      ...GRAPH_BOUNDARY_MOVE,
      workflowMoveMetadata: { fromColumn: "todo", nodeId: "execute" },
    });

    const row = await store.getTask(task.id);
    expect(row.column).toBe("in-progress");
    // Only the stale terminal failure clears…
    expect(row.status ?? null).toBeNull();
    expect(row.error ?? null).toBeNull();
    // …everything else the guard must not own survives.
    expect(row.blockedBy).toBe("FN-9001");
    expect(row.overlapBlockedBy).toBe("FN-9002");
    expect(row.paused).toBe(true);
    expect(row.pausedReason).toBe("branch-conflict-unrecoverable");
    expect(row.steps.map((step) => step.status)).toEqual(["done", "in-progress"]);
  });
});
