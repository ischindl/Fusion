/**
 * FNXC:BoardReadProjection 2026-11-18-06:15 (RUFU-479) — one card, one shape, whichever endpoint listed it.
 *
 * The board reaches the same `TaskCard` through FOUR store reads: the whole-board page
 * (`listCurrentTasksPage` with no query), the searched page (the same method with a query — the arm a user
 * types into, so the hottest one), the per-lane page (`listTaskQueuePage`, the read the board issues per
 * column), and the Done page (`listCompletedTasks`). Each of them independently decides which columns to
 * ask PostgreSQL for, and until this card only two of the four asked for the board shape:
 *
 *   * the whole-board arm compacted since FNXC:BoardFeedCompaction 2026-09-17 and projected once
 *     `FUSION_BOARD_FEED_PROJECTION` existed,
 *   * the searched arm compacted but transferred the wide `TASK_SLIM_PROJECTION` and threw the fields
 *     away after the driver had built them,
 *   * the lane arm did neither, so it shipped `summary`, both comment arrays and every step body,
 *   * the Done arm compacted only because RUFU-378 added the option at its route.
 *
 * That asymmetry is the defect class this file closes: a card whose payload depends on which endpoint
 * happened to list it. It is also invisible to any test that exercises one arm — which is how three of the
 * four stayed wide while a fourth was fixed twice. The assertion is therefore cross-arm: the SAME card,
 * reached through every arm, must present the identical set of present-and-absent fields, and none of the
 * arms may carry a field the board-feed compaction exists to discard.
 *
 * Gated on a live PostgreSQL harness because the claim is about the SQL each arm builds — the pg-free half
 * of the contract (which columns the projection selects, and what that costs in bytes) is
 * `../lane-read-cost.test.ts`, and the row→`Task` hydration parity is `../../postgres/__tests__/board-feed.test.ts`.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/** Fields the board feed must never carry, in any arm. Bodies stay on `GET /api/tasks/:id`. */
const NEVER_ON_A_CARD = ["summary", "comments", "steeringComments", "stepReports", "recommendations"] as const;

/** The present-field key set of a `Task`, normalised so `undefined` and absent are one state. */
function presentKeys(task: Record<string, unknown>): string[] {
  return Object.keys(task).filter((key) => task[key] !== undefined).sort();
}

pgTest("every board-facing read answers the same column set for the same card", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lane_read_parity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A card heavy in exactly the fields the board feed discards, so an un-projected arm cannot hide. */
  async function seedHeavyCard(taskId: string, column: string, title: string) {
    const store = h.store();
    await store.createTaskWithReservedId(
      {
        description: "board-shape probe card",
        title,
        column: column as never,
        summary: "a completion summary no card renders",
        comments: [{ id: "c1", body: "a comment body no card renders" }] as never,
        steeringComments: [{ id: "s1", body: "a steering body no card renders" }] as never,
        stepReports: [{ stepName: "implement", report: "a step body no card renders" }] as never,
      },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    return store;
  }

  it("the whole-board arm, the searched arm, and the lane arm agree field-for-field", async () => {
    const store = await seedHeavyCard("FN-LANEPAR-1", "in-progress", "Laneparity anchor card");

    const board = await store.listCurrentTasksPage({ limit: 50 });
    const lane = await store.listTaskQueuePage({ columns: ["in-progress"], order: "queue", limit: 50 });
    const searched = await store.listCurrentTasksPage({ query: "Laneparity", limit: 50 });

    const boardCard = board.tasks.find((task) => task.id === "FN-LANEPAR-1");
    const laneCard = lane.tasks.find((task) => task.id === "FN-LANEPAR-1");
    const searchedCard = searched.tasks.find((task) => task.id === "FN-LANEPAR-1");

    // Every arm must actually SEE the card — an arm that stops returning it would satisfy a set equality
    // over two empty lists and call that parity.
    expect(boardCard, "the whole-board page lost the card").toBeTruthy();
    expect(laneCard, "the lane page lost the card").toBeTruthy();
    expect(searchedCard, "the searched page lost the card").toBeTruthy();

    const boardKeys = presentKeys(boardCard as unknown as Record<string, unknown>);
    expect(presentKeys(laneCard as unknown as Record<string, unknown>), "the lane page disagrees with the board page").toEqual(boardKeys);
    expect(presentKeys(searchedCard as unknown as Record<string, unknown>), "the searched page disagrees with the board page").toEqual(boardKeys);

    // And the agreed shape is the BOARD shape, not whatever three wide arms happened to share.
    for (const forbidden of NEVER_ON_A_CARD) {
      expect(boardKeys, `an arm carried "${forbidden}" onto a card`).not.toContain(forbidden);
    }
    // The card face and its memo comparator still get what they reason about.
    for (const carried of ["id", "title", "description", "column", "status", "steps", "workflowStepResults"]) {
      expect(boardKeys, `an arm stopped carrying "${carried}"`).toContain(carried);
    }
  });

  it("the Done page agrees with the lane page for the same finished card", async () => {
    const store = await seedHeavyCard("FN-LANEPAR-2", "done", "Doneparity anchor card");

    const done = await store.listCompletedTasks({ limit: 50, slim: true, compactBoardFeed: true });
    const lane = await store.listTaskQueuePage({ columns: ["done"], order: "queue", limit: 50 });

    const doneCard = done.tasks.find((task) => task.id === "FN-LANEPAR-2");
    const laneCard = lane.tasks.find((task) => task.id === "FN-LANEPAR-2");
    expect(doneCard, "the Done page lost the card").toBeTruthy();
    expect(laneCard, "the lane page lost the finished card").toBeTruthy();

    const doneKeys = presentKeys(doneCard as unknown as Record<string, unknown>);
    expect(presentKeys(laneCard as unknown as Record<string, unknown>), "the Done lane disagrees with the lane page").toEqual(doneKeys);
    for (const forbidden of NEVER_ON_A_CARD) {
      expect(doneKeys, `the Done arm carried "${forbidden}" onto a card`).not.toContain(forbidden);
    }
  });

  it("a card's heavy bodies remain reachable on the detail read that a reviewer consumes", async () => {
    const store = await seedHeavyCard("FN-LANEPAR-3", "in-progress", "Detailreach anchor card");
    await store.addComment("FN-LANEPAR-3", "a comment that must survive on the detail read");

    const detail = await store.getTask("FN-LANEPAR-3");
    expect(detail?.summary, "the projection leaked into the detail read").toBe("a completion summary no card renders");
    expect((detail?.comments ?? []).map((comment) => comment.body)).toContain("a comment that must survive on the detail read");
  });

  it("keeps the source_metadata keys a card chip reads while the rest stays off the wire", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "key projection probe", title: "Keyprojection anchor card", column: "todo" },
      { taskId: "FN-LANEPAR-4", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask("FN-LANEPAR-4", {
      sourceMetadata: {
        agentName: "Workflow Executor",
        issueUrl: "https://github.com/runfusion/fusion/issues/479",
        plannerScratchpad: "a payload no card renders",
      },
    });

    const page = await store.listCurrentTasksPage({ limit: 50 });
    const card = page.tasks.find((task) => task.id === "FN-LANEPAR-4");
    expect(card).toBeTruthy();
    expect(card!.sourceMetadata).toMatchObject({ agentName: "Workflow Executor", issueUrl: "https://github.com/runfusion/fusion/issues/479" });
    expect(card!.sourceMetadata).not.toHaveProperty("plannerScratchpad");
  });

  /*
  FNXC:BoardReadProjection 2026-11-18-13:05 (RUFU-479) — the acceptance bound, in bytes, derived from a
  measurement rather than from prose. The figures below are the SECOND reading of the same live page; the
  first (Step 0) is quoted after them because a bound re-derived from a re-measurement has to show both.

  THE BASELINE, MEASURED READ-ONLY AGAINST LIVE PROJECT `proj_9326d74a133b421a`, the first 100-card page,
  wire-shaped (`JSON.stringify` of the row set) at three SELECT shapes the code can actually emit:
    whole row (`select *`)         6 187 083 B   = 61 871 B/card   (Step 0 read: 6 351 249 B = 63 512/card)
    slim (`log`, `search_vector`)  2 228 327 B   = 22 283 B/card
    board feed (what ships)        1 666 134 B   = 16 661 B/card   -> 3.71x cheaper than the whole row
  Per-card distribution of the shipped shape: p50 14 553, p95 40 270, max 85 559. Its remaining cost is
  `workflow_step_results` (49 % of the page), `description` (13 %), `merge_details` (10 %) and
  `modified_files` (8 %) - four columns the board renders or the card face needs, which is why they are
  still in the projection and why the ceiling has to live above them.

  DERIVED CEILINGS, and why the first cut was wrong. This block originally named 12 600 B/card, half the
  Step 0 log-excluded figure. That number is BELOW the live p50 of the shape it was bounding (14 553 B), so
  it was a bound that real data violates - the exact shape of false green this repo keeps stamping out, and
  it would have been discovered first by a CI run against a live-shaped fixture. The ceilings are therefore
  taken from the measured live mean and p95 of the shipped shape instead: ACTIVE 20 000 B/card sits above
  the live mean (16 661) with headroom for a card carrying a real review history, and DONE 10 000 is half
  it. Both still catch the regression class by a factor a human cannot miss: reverting to the whole-row read
  is 61 871 B/card, three times the ceiling, and the columns that make the difference (`log` at 60 % of the
  row, `step_reports`, `summary`) are asserted absent outright below, not merely small.

  WHAT THIS IS AND IS NOT. These are wire-shaped per-card bytes: the test measures the hydrated, compacted
  Task, which is strictly smaller than the row the driver received, so a green run proves the lane read is
  under its ceiling with margin, not that a live page measures 16 661 B exactly. Both bounds are per-card,
  so they hold at any page size and this case measures a dozen cards instead of inserting ten thousand rows
  (the repo's rule against slow tests, arithmetic stated): 1 000 cards at most 20 MB, 10 000 `done` cards at
  most 100 MB, which is 5x the 1 000-card lane the plan names. The live-page figure that would prove the
  latter end belongs to `docs/solutions/performance/idle-board-read-cost-and-poll-discipline.md`.
  */
  it("transfers a lane read under the derived per-card byte ceiling, and a Done card under half of it", async () => {
    const store = h.store();
    const ACTIVE_CEILING_BYTES_PER_CARD = 20_000;
    const DONE_CEILING_BYTES_PER_CARD = 10_000;

    for (let index = 0; index < 12; index += 1) {
      await store.createTaskWithReservedId(
        {
          description: `bounded-cost probe card ${index} with enough description text to be representative of a real card body`,
          title: `Bytebound active card ${index}`,
          column: "in-progress",
          summary: "a completion summary the board feed must not transfer",
          log: Array.from({ length: 40 }, (_unused, line) => ({ action: `step ${line}`, detail: "x".repeat(200) })) as never,
          stepReports: [{ stepName: "implement", report: "y".repeat(4_000) }] as never,
        },
        { taskId: `FN-LANEBYTE-A${index}`, applyDefaultWorkflowSteps: false },
      );
      await store.createTaskWithReservedId(
        {
          description: `bounded-cost done card ${index}`,
          title: `Bytebound done card ${index}`,
          column: "done",
          summary: "a completion summary the done lane must not transfer",
          log: Array.from({ length: 40 }, (_unused, line) => ({ action: `step ${line}`, detail: "x".repeat(200) })) as never,
        },
        { taskId: `FN-LANEBYTE-D${index}`, applyDefaultWorkflowSteps: false },
      );
    }

    const lane = await store.listTaskQueuePage({ columns: ["in-progress"], order: "queue", limit: 50 });
    const done = await store.listCompletedTasks({ limit: 50, slim: true, compactBoardFeed: true });

    expect(lane.tasks.length).toBeGreaterThan(0);
    expect(done.tasks.length).toBeGreaterThan(0);
    const activeBytesPerCard = JSON.stringify(lane.tasks).length / lane.tasks.length;
    const doneBytesPerCard = JSON.stringify(done.tasks).length / done.tasks.length;

    expect(activeBytesPerCard).toBeLessThan(ACTIVE_CEILING_BYTES_PER_CARD);
    expect(doneBytesPerCard).toBeLessThan(DONE_CEILING_BYTES_PER_CARD);
    // The two columns the ceiling is mostly made of must be absent outright, not merely small.
    for (const task of lane.tasks) {
      expect((task as unknown as Record<string, unknown>).log).toBeUndefined();
      expect((task as unknown as Record<string, unknown>).stepReports).toBeUndefined();
    }
  });
});
