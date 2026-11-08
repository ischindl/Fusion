/*
FNXC:ReviewSweepReadColumnProjection 2026-11-08-07:55 (RUFU-871):
`findReviewLaneCandidates` reads the WHOLE board, unfiltered, every 15 s, and the read-attribution
windows list it among the top `listTasks` callers (`findReviewLaneCandidates < runPass < tick`).
Allocation sampling over 60 s of ordinary production traffic measured 788 MB allocated with 90 % of it
inside the PostgreSQL driver — `DataRow` 417 MB (53 %) for whole materialized rows and `fromJson` 276 MB
(35 %) for their jsonb columns — so the column list this read sends is the cost, and after RUFU-615
dropped `log` the rest of the heavy set was still being transferred and discarded.

The read now declares `workflowStepResults` as the only wide member it reads. Two things can silently
undo that, and both fail here:

1. the declaration disappears or widens — asserted on the options the sweep actually passes to the
   store, not on a copy of them, because RUFU-615/RUFU-627's rule is that the executed SELECT is the
   observable; and
2. a future edit starts reading one of the dropped fields off the rows. That is asserted behaviorally:
   a card whose only distinguishing content is comment/description/step/attachment/source payload must
   land in the same classification bucket whether or not those columns were transferred. A consumer that
   began to depend on them would classify the projected card differently.

The enumeration that makes the narrowing safe (which fields the sweep and its callees dereference) is at
the call site, and `review-verdict-state.ts` is the only callee that reads a wide field at all.
*/
import { describe, expect, it, vi } from "vitest";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";
import type { TaskStore } from "@fusion/core";

/** The columns a `[workflowStepResults]` declaration stops selecting. */
const DROPPED_COLUMNS = [
  "description", "summary", "steps", "attachments", "comments", "steeringComments",
  "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId",
  "sourceParentTaskId", "sourceMetadata", "sourceIssueProvider", "sourceIssueRepository",
  "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt",
] as const;

function reviewCard(index: number, extra: Record<string, unknown> = {}) {
  return {
    id: `RUFU-87${index}`,
    // The resolved default board's review lane. `findReviewLaneCandidates` keeps only cards whose column
    // equals that lane, so the fixture must sit in it or the equality below compares two empty lists.
    column: "in-review",
    updatedAt: "2026-11-08T00:00:00.000Z",
    paused: false,
    userPaused: false,
    // The kept wide member: `hasRecordedCodeReviewVerdict` and the pending-lease arm both read it.
    workflowStepResults: [{ stepId: "code-review", stepName: "Code Review", status: "passed", verdict: "APPROVE" }],
    enabledWorkflowSteps: ["code-review"],
    reviewLevel: null,
    noCommitsExpected: false,
    ...extra,
  };
}

function heavyPayload(card: Record<string, unknown>) {
  const stamp = "2026-11-08T00:00:00.000Z";
  return {
    ...card,
    description: "requirement sentence that some future consumer might want to grep ".repeat(6),
    summary: "a reviewer summary",
    steps: [{ id: "s1", name: "implement", status: "done", required: true }],
    attachments: [{ name: "evidence.png", url: "https://example.invalid/1" }],
    comments: [{ id: "c1", author: "reviewer", body: "the finding", createdAt: stamp }],
    steeringComments: [{ id: "sc1", author: "operator", body: "steer left", createdAt: stamp }],
    sourceType: "agent",
    sourceAgentId: "agent-1",
    sourceMetadata: { planEvidence: { fingerprint: "fp" }, fusionBranchContext: { source: "planning", assignmentMode: "per-task-derived" } },
  };
}

function projected(card: Record<string, unknown>) {
  const copy = { ...card };
  for (const column of DROPPED_COLUMNS) delete copy[column];
  return copy;
}

function sweepReturning(cards: Record<string, unknown>[], listTasks?: vi.Mock) {
  const store = {
    getProjectId: () => "proj_test",
    getSettings: async () => ({}),
    listTasks: listTasks ?? vi.fn(async () => cards),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionsAsync: async (ids: string[]) => new Map(ids.map((id) => [id, undefined])),
    getWorkflowDefinition: async () => ({ ir: { nodes: [], edges: [] } }),
    asyncLayer: { projectId: "proj_test", transactionImmediate: async () => [] },
  } as unknown as TaskStore;
  const sweep = new ReviewDispatchSweep({
    store,
    agentStore: { listAgents: async () => [] } as never,
    heartbeatMonitor: {} as never,
    now: () => Date.parse("2026-11-08T00:00:00.000Z"),
    e4LogCooldownMs: 300_000,
  });
  return sweep as unknown as { findReviewLaneCandidates: () => Promise<Array<{ task: { id: string } }>> };
}

describe("review sweep read projection (RUFU-871)", () => {
  it("asks the store for exactly the wide member it reads, alongside its existing narrowing", async () => {
    const listTasks = vi.fn(async () => [] as Record<string, unknown>[]);
    await sweepReturning([], listTasks).findReviewLaneCandidates();
    expect(listTasks).toHaveBeenCalled();
    const options = listTasks.mock.calls[0]![0] as {
      slim?: boolean;
      derive?: boolean;
      excludeLog?: boolean;
      fields?: readonly string[];
    };
    expect(options.slim).toBe(true);
    expect(options.derive).toBe(false);
    expect(options.excludeLog).toBe(true);
    // Widening this list re-adds a per-card payload to a 15 s whole-board read; the members that are
    // genuinely read are enumerated at the call site.
    expect(options.fields).toEqual(["workflowStepResults"]);
  });

  it("finds the same review-lane cards whether or not the dropped columns were transferred", async () => {
    const cards = [reviewCard(1), reviewCard(2), reviewCard(3, { column: "todo" })];
    const wide = await sweepReturning(cards.map(heavyPayload)).findReviewLaneCandidates();
    const narrow = await sweepReturning(cards.map(projected)).findReviewLaneCandidates();
    const ids = (rows: Array<{ task: { id: string } }>) => rows.map((row) => row.task.id).sort();
    // The premise: the lane filter found cards at all, so the equality is not two empty lists.
    expect(ids(wide)).toHaveLength(2);
    expect(ids(narrow)).toEqual(ids(wide));
  });
});
