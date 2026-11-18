import { describe, expect, it } from "vitest";
import { TASK_SLIM_PROJECTION } from "../task-store/async/async-persistence.js";
import { BOARD_FEED_DROPPED_COLUMNS, BOARD_SOURCE_METADATA_KEYS, resolveBoardFeedProjection } from "../postgres/board-feed.js";
import { compactBoardFeedRow, BOARD_DESCRIPTION_PREVIEW_CHARS } from "../task-store/reads.js";
import type { Task } from "../types.js";

/*
FNXC:BoardReadProjection 2026-11-18-06:05 (RUFU-479) — the lane page pays for a whole card and renders a badge.
This is the card's OWN cost witness, held to the numbers on the card: a board page costs ~9 s server-side and
~12.4 KB of response per card, and the lane page — the read the board actually issues per column — materialised
every column a card can never render.

LIVE BASELINE (read-only queries against the deployed board, project `proj_9326d74a133b421a`, 911 live rows,
first 100 cards of the page order, no mutation):

  whole_row (all columns, as `to_jsonb` transfers them)   6 351 249 B   63.5 KB per card
    log                             3 826 300 B  60.2%   already excluded by `excludeLog` (RUFU-615)
    workflow_step_results             623 658 B  9.8%
    summary                           410 024 B   6.5%   transferred, parsed, then DISCARDED by compaction
    description                       163 498 B   2.6%
    source_metadata                    94 787 B   1.5%
    comments + steering_comments       46 038 B   0.7%   transferred, parsed, then DISCARDED
    steps                              40 492 B   0.6%
    attachments                           491 B   0.0%

  after `excludeLog`: 2 524 949 B per 100-card page. The board-feed projection then removes the fields that
  compaction was discarding after the fact, measured on the same page order:
  1 402 058 B (wide columns of the page) -> 848 198 B (projected) = 1.65x fewer bytes, for
  +1.49 ms of PostgreSQL execution time (2.83 ms -> 4.32 ms) on a page the deployed node answers in
  8.79-10.79 s.

What this file proves WITHOUT a server is the half of that claim a fixture can prove: the lane/board/searched
feed selects none of the fields it discards, and the shape it does select is materially smaller. Timing claims
above are live measurements, not reproduced here — `read-column-cost.pg.test.ts` and
`lane-read-projection-parity.pg.test.ts` are the gated halves.
*/

/** A card shaped like the board's own worst case: a real spec, a review history, and stall metadata. */
function heavyTask(id: string): Task {
  return {
    id,
    title: `Card ${id}`,
    description: "spec paragraph. ".repeat(600),
    summary: "a completion summary of 500-1000 characters".repeat(15),
    column: "in-progress",
    status: null,
    steps: [{ name: "implement", status: "done" }],
    stepReports: [{ stepName: "implement", report: "r".repeat(4000) }],
    recommendations: [{ id: "rec-1", summary: "x".repeat(2000) }],
    comments: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, body: "comment body ".repeat(120) })),
    steeringComments: Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, body: "steering body ".repeat(120) })),
    workflowStepResults: [
      { workflowStepId: "code-review", name: "Code Review", status: "passed", verdict: "APPROVE", notes: "n".repeat(3000), findings: [{ id: "f1", detail: "d".repeat(2000) }] },
      { workflowStepId: "plan-review", name: "Plan Review", status: "passed", verdict: "APPROVE", notes: "p".repeat(2000) },
    ],
    sourceMetadata: {
      agentName: "Workflow Executor",
      issueUrl: "https://github.com/runfusion/fusion/issues/479",
      wipAdmissionStall: { firstAt: "2026-11-18T04:00:00.000Z", stallCode: "wip-admission-throttled" },
      fusionBranchContext: { assignmentMode: "exclusive", branch: `fusion/${id}` },
      // Keys the board renders nothing for. A worker may still need them, which is why they stay on
      // GET /api/tasks/:id and are simply not part of a card's payload.
      planningSessionLog: Array.from({ length: 40 }, (_, i) => ({ seq: i, text: "planner chatter ".repeat(60) })),
      oversizedKey: "y".repeat(20000),
    },
    tokenUsage: 12345,
    tokenUsageCostUsd: 1.23,
    dependencies: [],
    createdAt: "2026-11-18T04:00:00.000Z",
    updatedAt: "2026-11-18T04:30:00.0000Z",
  } as unknown as Task;
}

const projected = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });

describe("lane/board feed read cost (RUFU-479)", () => {
  it("selects none of the heavy fields the compaction pass discards", () => {
    const selected = new Set(Object.keys(projected));
    for (const dropped of BOARD_FEED_DROPPED_COLUMNS) {
      expect(selected.has(dropped), `the board feed still selects "${dropped}"`).toBe(false);
    }
    // The live baseline above puts `summary` and both comment arrays at 456 KB per 100-card page, all of
    // it transferred and parsed for a card that renders neither.
    expect(selected.has("summary")).toBe(false);
    expect(selected.has("comments")).toBe(false);
    expect(selected.has("steeringComments")).toBe(false);
    expect(selected.has("stepReports")).toBe(false);
    expect(selected.has("recommendations")).toBe(false);
  });

  it("does not select the log column the lane page already excludes", () => {
    // RUFU-615: `log` is 60% of live-row bytes. The lane page asked for it to be excluded at the SELECT
    // long before this card; this assertion is the bound that keeps a future reader from re-adding it.
    expect(Object.keys(projected)).not.toContain("log");
    expect(Object.keys(projected)).toContain("logRecent");
    expect(Object.keys(projected)).toContain("timingTotalMs");
  });

  it("keeps the fields a card face and its memo comparator actually reason about", () => {
    const selected = new Set(Object.keys(projected));
    for (const carried of ["id", "title", "description", "column", "status", "steps", "workflowStepResults", "attachments", "sourceMetadata"]) {
      expect(selected.has(carried), `the board feed no longer selects "${carried}"`).toBe(true);
    }
  });

  it("ships a materially smaller row for the same card than the wide feed did", () => {
    const wide = JSON.stringify(heavyTask("RUFU-479")).length;
    const card = heavyTask("RUFU-479");
    // The projected row has no `summary`/`comments`/`steeringComments`/`stepReports`/`recommendations`
    // columns at all, so hydrating from it yields a Task without those fields; `sourceMetadata` arrives
    // already key-projected by PostgreSQL.
    const narrowed = { ...card } as Task;
    for (const key of BOARD_FEED_DROPPED_COLUMNS) delete (narrowed as Record<string, unknown>)[key];
    narrowed.sourceMetadata = Object.fromEntries(
      Object.entries(card.sourceMetadata ?? {}).filter(([key]) => BOARD_SOURCE_METADATA_KEYS.includes(key as never)),
    );
    const projectedBytes = JSON.stringify(narrowed).length;

    expect(projectedBytes).toBeLessThan(wide * 0.5);
    // The projection is a SUBSET: it must never invent a field the wide feed did not carry.
    expect(Object.keys(narrowed).every((key) => key in card)).toBe(true);
    // And compaction is now a no-op on the projected row except for the description preview cap.
    const beforeCompaction = JSON.stringify(narrowed);
    compactBoardFeedRow(narrowed, { includeTokenUsage: false });
    expect(narrowed.description.length).toBeLessThanOrEqual(BOARD_DESCRIPTION_PREVIEW_CHARS);
    expect(JSON.stringify(narrowed).length).toBeLessThan(beforeCompaction.length);
  });
});
