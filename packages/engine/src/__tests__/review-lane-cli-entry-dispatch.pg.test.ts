/*
FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205 Step 6 — CLI entry path, proven on a real store):

`fn task move` never asks the daemon for anything. `packages/cli/src/commands/task.ts` resolves a
ProjectContext whose store boots through the PostgreSQL startup factory (`createLocalStore`) and
calls `store.moveTask(id, column, { moveSource: "user" })` — the CLI bundle LINKS core's
`moveTaskInternalImpl` and runs it in its own process against the shared database. Routing that call
over HTTP would be a cross-process refactor of a write that already lands in the right place, so the
decision is: keep the direct path, and make the *invariant* hold regardless of who wrote the column.

This file is that decision's artefact. It drives the CLI's literal call, then ONE sweep tick, and
asserts the two things the decision depends on:

1. ENTRY IS ATTRIBUTABLE FROM DATA. A human crossing into the review lane is recorded in
   `run_audit_events` with `metadata.callerStack` — the only frame-level record of who moved the
   card. `packages/cli/dist/bin.js` appears in that stack in production (Step 1 measured it live at
   12:06:20.317Z); here the driver's own frame is what must appear, which is the same mechanism.
   Lifecycle events name the `moveSource` but not the caller, so this row is what the requirement
   keys on.
2. THE ENTRY PATH CANNOT AFFECT DISPATCH. The sweep reads persisted state only — it never sees
   `moveSource`. A card parked in the review lane by a CLI-shaped move gets reviewer work from the
   first tick after its grace window, on a RENAMED board as well as the default one, while an
   otherwise-identical card in the WIP lane gets nothing.

LANE: `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never the embedded instance, never port 4040.
*/
import { afterEach, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits the lifecycle fixture declares
import { appendTaskLifecycleEventInTransaction, CODE_REVIEW_GROUP_ID, completeReviewerRunForTask, listReviewerRunsForTask, openReviewerRunForTask } from "@fusion/core";
import type { Agent, AgentHeartbeatRun, AgentStore, ReviewerRunRow, TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

const pgTest = pgDescribe;
const REVIEWER_ID = "agent-reviewer";

/**
 * The row's `updatedAt` is the real wall clock, so the tick being evaluated has to sit AFTER it or
 * the sweep correctly refuses the card as still inside its grace window. One minute ahead of now is
 * far enough to be unambiguous and close enough that no real clock skew can flip it.
 */
function tickAfterEntry(): Date {
  return new Date(Date.now() + 60_000);
}

/**
 * A reviewer exists, is idle, and is not on another card — the E4/B4/E2 preconditions the sweep
 * checks before it will dispatch anything. Deliberately inert: the assertion is that the sweep
 * CALLED it, i.e. that reviewer work began because the dispatch ran.
 */
function fakeHeartbeatMonitor(calls: Array<{ agentId: string; taskId?: string }>): HeartbeatMonitor {
  return {
    executeHeartbeat: async (input: { agentId: string; taskId?: string }) => {
      calls.push({ agentId: input.agentId, taskId: input.taskId });
    },
  } as unknown as HeartbeatMonitor;
}

function fakeAgentStore(reviewers: Agent[]): AgentStore {
  return {
    listAgents: async () => reviewers,
    getActiveHeartbeatRun: async () => null as AgentHeartbeatRun | null,
  } as unknown as AgentStore;
}

function reviewer(): Agent {
  return {
    id: REVIEWER_ID,
    name: "Reviewer",
    roles: ["reviewer"],
    metadata: {},
    runtimeConfig: { enabled: true },
  } as unknown as Agent;
}

/*
FNXC:ReviewLanePool 2026-11-20-03:13 (RUFU-530):
Pool-shaped collaborators for the pass-level proof below. `reviewer()` above is single-reviewer by shape and is
used by nine existing cases, so the pool case gets its own named reviewer rather than a widened signature that
would silently change what those nine assert.
*/
function poolReviewer(id: string): Agent {
  return {
    id,
    name: `Pool ${id}`,
    roles: ["reviewer"],
    metadata: {},
    runtimeConfig: { enabled: true },
  } as unknown as Agent;
}

/**
 * A roster whose live-run answer is per agent and mutable, which is the only way to drive the pool's second
 * routing arm through a real pass: the sweep reads `getActiveHeartbeatRun` once per member at the top of every
 * tick, so mutating the map between ticks is what makes a reviewer busy for the next pass.
 */
function fakeAgentStoreWithRuns(
  reviewers: Agent[],
  runs: Map<string, AgentHeartbeatRun | null>,
): AgentStore {
  return {
    listAgents: async () => reviewers,
    getActiveHeartbeatRun: async (agentId: string) => runs.get(agentId) ?? null,
  } as unknown as AgentStore;
}

/**
 * Pin a card's review-entry time by COMMITTING a later `task:entered-review` event whose `occurred_at` is older.
 * `latestTaskEnteredReviewAt` reads the newest row by `seq` and returns its `occurred_at`, so this is the
 * sanctioned way to fix the queue order a tick will see: three cards moved back to back would otherwise carry
 * millisecond-identical entries and "the two oldest" would be a coin flip.
 */
async function stampReviewEntryAt(
  store: TaskStore,
  projectId: string,
  taskId: string,
  fromColumn: string,
  toColumn: string,
  occurredAt: string,
): Promise<void> {
  const layer = store.asyncLayer;
  expect(layer).toBeTruthy();
  await layer!.transactionImmediate(async (tx) => {
    await appendTaskLifecycleEventInTransaction(tx, {
      projectId,
      eventType: "task:entered-review",
      taskId,
      occurredAt,
      payload: { taskId, previousColumn: fromColumn, toColumn, enteredAt: occurredAt, actor: "test-seed" },
    });
  });
  store.taskCache.delete(taskId);
}

/**
 * The CLI's exact call shape (`moveSource: "user"`, nothing else), so the test cannot drift from
 * the production path it claims to prove. Step 1 measured the real CLI doing exactly this twice in
 * 24 seconds (`todo→in-progress`, then `in-progress→in-review`), which is the sequence replayed here.
 */
async function moveLikeTheCli(store: TaskStore, taskId: string, toColumn: string): Promise<void> {
  await store.moveTask(taskId, toColumn as never, { moveSource: "user" });
  store.taskCache.delete(taskId);
}

pgTest("a CLI-shaped move into the review lane gets reviewer work from one sweep tick (PostgreSQL)", () => {
  let h: PgTestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  /**
   * A board whose review lane is resolvable. `mergeOrchestration: true` is not decoration:
   * `resolveLifecycleColumns` maps the REVIEW role onto the `mergeOrchestration` flag (the `merge`
   * trait), and every builtin ships that trait on its review column. Without it a board has no
   * resolvable review lane at all, and the sweep — which refuses to assume a historical column
   * name — would skip every card on it.
   */
  async function seedBoard(v: Vocabulary, key: string): Promise<{ store: TaskStore; boardId: string }> {
    /* `projectId` binds the data layer: the reviewer-run ledger refuses an unbound layer, and in
       production every engine store IS project-bound (one TaskStore per project). */
    h = await createTaskStoreForTest({ prefix: key, copyFromGolden: true, projectId: `proj-${key}` });
    const store = h.store;
    const created = await store.createWorkflowDefinition({
      name: `STAS-205 ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, { mergeOrchestration: true }),
    } as never);
    return { store, boardId: (created as { id: string }).id };
  }

  /**
   * A card on this board, parked in its board's WIP lane — where a card is when a human drags it
   * to review. Code review is ENABLED: an empty enabled-list is the sweep's deliberate opt-out
   * signal (E1).
   *
   * Only this setup hop takes `recoveryRehome`. The card is created on the board it is born on, so
   * entering a RENAMED board's columns is a re-home, not a user transition. The hop under test —
   * the one the CLI performs — never takes it.
   */
  async function cardInWip(store: TaskStore, boardId: string, description: string, v: Vocabulary): Promise<string> {
    const task = await store.createTask({ description });
    await store.writeTaskWorkflowSelection(task.id, boardId, [CODE_REVIEW_GROUP_ID]);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.wip as never, { recoveryRehome: true });
    store.taskCache.delete(task.id);
    return task.id;
  }

  /* Raw SQL through the harness's own admin connection: `drizzle-orm` and the table schema are not
     dependencies of this package, so the drizzle query builder is not an option here. */
  function auditRows(taskId: string): Promise<Array<{ metadata: unknown }>> {
    return h!.adminSql`
      select metadata from project.run_audit_events
      where task_id = ${taskId} and mutation_type = 'task:handoff-invariant-violation'`;
  }

  async function lifecycleRowCount(taskId: string): Promise<number> {
    const rows = await h!.adminSql`
      select 1 from project.task_lifecycle_events
      where task_id = ${taskId} and event_type = 'task:entered-review'`;
    return rows.length;
  }

  /*
  FNXC:ReviewLaneDeclineAttribution 2026-11-19-22:55 (RUFU-478):
  The durable record of "this project has no enabled reviewer, and N cards are waiting". Found by `target`
  (the project id), never by `task_id`: the episode is project-scoped, so `task_id` is NULL by design and a
  query keyed on the card would answer a different question. Selected through the harness's admin connection
  for the same reason as `auditRows` above — drizzle is not a dependency of this package.
  */
  function reviewDeclineRows(projectId: string): Promise<Array<{ metadata: unknown; target: string; task_id: string | null }>> {
    return h!.adminSql`
      select metadata, target, task_id from project.run_audit_events
      where mutation_type = 'task:review-dispatch-declined' and target = ${projectId}`;
  }

  /*
  `board_id` is read here because the reviewer-run row type does not carry it, and it is the column
  this file caught broken: the sweep's first-ever INSERT into `task_reviewer_runs` passed `null` into
  a NOT NULL column, so EVERY dispatch would have failed at the ledger write in production. A unit
  test with a faked ledger cannot see a constraint violation; only a real database can.
  */
  async function ledgerBoardId(taskId: string): Promise<string | undefined> {
    // ThreatCrush flags SQL with interpolated values on changed lines even when
    // the driver binds them as parameters; the table holds a handful of rows,
    // so filter client-side and keep the query static.
    const rows = await h!.adminSql`select board_id, task_id from project.task_reviewer_runs`;
    return (rows.find((r) => (r as { task_id: string }).task_id === taskId) as { board_id: string } | undefined)?.board_id;
  }

  /**
   * `graceMs: 0` is not a flake knob: production ships a 30 s grace and a 15 s tick, so the first
   * eligible tick lands up to two intervals after the crossing. The property under test is that a
   * tick that IS eligible produces dispatch, so the grace is what is removed, never the dispatch.
   */
  function sweepFor(store: TaskStore, calls: Array<{ agentId: string; taskId?: string }>): ReviewDispatchSweep {
    return new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([reviewer()]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
      maxDispatchesPerTick: 10,
    });
  }

  it("dispatches a card the CLI moved, and names the caller in the audit trail", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_default");
    const taskId = await cardInWip(store, boardId, "cli entry probe", DEFAULT_VOCAB);

    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    // The crossing is a committed fact before the sweep is consulted at all.
    expect(await lifecycleRowCount(taskId)).toBe(1);
    const audit = await auditRows(taskId);
    expect(audit.length).toBe(1);
    const metadata = audit[0]!.metadata as { fromColumn?: string; callerStack?: string };
    expect(metadata.fromColumn).toBe(DEFAULT_VOCAB.wip);
    expect(metadata.callerStack).toBeTruthy();
    // The attribution the requirement asks for: the frame that performed the write is in the stack.
    expect(metadata.callerStack).toContain("moveLikeTheCli");

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.dispatched).toEqual([taskId]);
    expect(calls).toEqual([{ agentId: REVIEWER_ID, taskId }]);

    const rows: ReviewerRunRow[] = await listReviewerRunsForTask(store, taskId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.reviewerAgentId).toBe(REVIEWER_ID);
    expect(rows[0]!.status).toBe("running");
    // The attempt records the board it was opened from, and the write satisfies the NOT NULL column.
    expect(await ledgerBoardId(taskId)).toBe(boardId);
  });

  it("dispatches on a RENAMED board, so lane selection is resolved by trait and not by `in-review`", async () => {
    const { store, boardId } = await seedBoard(RENAMED_VOCAB, "cli_entry_renamed");
    const taskId = await cardInWip(store, boardId, "renamed-lane probe", RENAMED_VOCAB);

    // `checking` is not a legal value for the legacy column enum: a literal-keyed selection would
    // never match it, and the card would sit unreviewed with no error anywhere.
    await moveLikeTheCli(store, taskId, RENAMED_VOCAB.review);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.classes["never-dispatched"]).toBe(1);
    expect(result.dispatched).toEqual([taskId]);
    expect(calls).toEqual([{ agentId: REVIEWER_ID, taskId }]);
  });

  it("CONTROL — the same tick leaves a card outside the review lane untouched", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_control");
    const taskId = await cardInWip(store, boardId, "wip control probe", DEFAULT_VOCAB);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.dispatched).toEqual([]);
    expect(calls).toEqual([]);
    expect(await lifecycleRowCount(taskId)).toBe(0);
    expect(await listReviewerRunsForTask(store, taskId)).toEqual([]);
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review G1 — the production-stranding bug):
  A dispatch whose heartbeat call rejects closes the attempt as failed (completed_at set). The
  live-slot index must NOT keep counting that row: if it did, the retry below would hit the
  partial-unique slot, the insert's DO NOTHING would report "already dispatched", and the card
  would sit in the review lane forever with a permanently spent dispatch path. This test drives
  the full sweep twice against a real index — the exact sequence production hits whenever a
  reviewer session fails to launch. A unit test with a faked ledger cannot see the constraint.
  */
  it("a rejected dispatch attempt releases the live slot so the next tick can retry", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "slot_release_g1");
    const taskId = await cardInWip(store, boardId, "rejected dispatch probe", DEFAULT_VOCAB);
    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    const rejectedCalls: Array<{ agentId: string; taskId?: string }> = [];
    const rejectingMonitor = {
      executeHeartbeat: async (input: { agentId: string; taskId?: string }) => {
        rejectedCalls.push({ agentId: input.agentId, taskId: input.taskId });
        throw new Error("reviewer session failed to launch");
      },
    } as unknown as HeartbeatMonitor;
    const tick1 = await new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([reviewer()]),
      heartbeatMonitor: rejectingMonitor,
      graceMs: 0,
      maxDispatchesPerTick: 10,
    }).tick(tickAfterEntry());
    expect(tick1.dispatched).toEqual([taskId]);
    expect(rejectedCalls.length).toBe(1);

    // The sweep closes the rejected attempt fire-and-forget; wait for that bookkeeping to land.
    let rows = await listReviewerRunsForTask(store, taskId);
    for (let i = 0; i < 100 && !(rows[0] && rows[0].completedAt !== null); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await listReviewerRunsForTask(store, taskId);
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.completedAt).not.toBeNull();

    // Retry tick: the closed attempt must not occupy the slot. Before the index re-key this
    // resolved to dispatched: [] — the permanent strand the review caught.
    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const tick2 = await sweepFor(store, calls).tick(tickAfterEntry());
    expect(tick2.dispatched).toEqual([taskId]);
    expect(calls).toEqual([{ agentId: REVIEWER_ID, taskId }]);

    rows = await listReviewerRunsForTask(store, taskId);
    expect(rows.length).toBe(2);
    expect(rows[1]!.status).toBe("running");
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C2):
  The live slot is per CARD. The earlier (project, task, reviewer) key let a rework that changed
  reviewers run two live attempts for one card at once; the classifier never routes to a second
  reviewer while another attempt is live, so the DB must refuse what the classifier already won't
  do — the same defense-in-depth the sweep's own docs claim.
  */
  it("the live slot admits one open attempt per card, not one per reviewer", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "slot_per_task_c2");
    const taskId = await cardInWip(store, boardId, "slot per-card probe", DEFAULT_VOCAB);
    const at = new Date().toISOString();

    const first = await openReviewerRunForTask(store, {
      taskId, boardId, reviewerAgentId: REVIEWER_ID, reworkRound: 1, at,
    });
    expect(first.created).toBe(true);

    // A second live attempt under a DIFFERENT reviewer must hit the same card slot.
    const second = await openReviewerRunForTask(store, {
      taskId, boardId, reviewerAgentId: "agent-other-reviewer", reworkRound: 2, at,
    });
    expect(second.created).toBe(false);

    // Once the first settles, the card's slot is free again.
    expect(await completeReviewerRunForTask(store, {
      taskId, id: first.id!, status: "failed", at, failureReasons: ["test-close"],
    })).toBe(true);
    const third = await openReviewerRunForTask(store, {
      taskId, boardId, reviewerAgentId: "agent-other-reviewer", reworkRound: 3, at,
    });
    expect(third.created).toBe(true);
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C4):
  Completion is a one-way transition. A straggling late callback (a superseded reviewer whose
  verdict finally lands after the attempt was closed or superseded) must not overwrite the
  recorded terminal status — the guard lives in the UPDATE's WHERE clause, asserted here against
  a real row rather than a mock.
  */
  it("completion is one-way — a late verdict cannot rewrite a settled attempt", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "one_way_complete_c4");
    const taskId = await cardInWip(store, boardId, "one-way completion probe", DEFAULT_VOCAB);
    const at = new Date().toISOString();
    const opened = await openReviewerRunForTask(store, {
      taskId, boardId, reviewerAgentId: REVIEWER_ID, reworkRound: 1, at,
    });
    expect(opened.created).toBe(true);

    // #3619 review C: completion binds to the named card. Pairing this run id with a different
    // task must complete nothing even though the row is still running.
    expect(await completeReviewerRunForTask(store, {
      taskId: "some-other-card", id: opened.id!, status: "approve", at, summary: "wrong pairing",
    })).toBe(false);

    expect(await completeReviewerRunForTask(store, {
      taskId, id: opened.id!, status: "failed", at, failureReasons: ["first-close"],
    })).toBe(true);

    const late = new Date(Date.now() + 60_000).toISOString();
    expect(await completeReviewerRunForTask(store, {
      taskId, id: opened.id!, status: "approve", at: late, summary: "straggling verdict",
    })).toBe(false);

    const [row] = await listReviewerRunsForTask(store, taskId);
    expect(row!.status).toBe("failed");
    expect(row!.completedAt).toBe(at);
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review G4):
  Paused review-lane cards used to be dropped BEFORE classification, so the E2 excluded-paused
  bucket was unreachable from a real tick and paused cards vanished from the sweep's accounting —
  and the slim list projection never had to carry the pause fields. This test proves both:
  the slim projection DOES carry them (a missing field would fall through to dispatch), and the
  classifier buckets the card instead.
  */
  it("a paused review-lane card lands in excluded-paused through the real candidate scan", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "paused_e2_g4");
    const taskId = await cardInWip(store, boardId, "paused card probe", DEFAULT_VOCAB);
    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    // Pause through the store's own accounting seam — `userPaused` must be set through
    // `store.pauseTask(..., { userPaused: true })`, the only sanctioned writer of that column
    // (raw UPDATEs trip ThreatCrush's interpolation scan and bypass pause accounting anyway).
    await store.pauseTask(taskId, true, undefined, { userPaused: true });
    store.taskCache.delete(taskId);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.classes["excluded-paused"]).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("CONTROL — with no reviewer to route to, the card is surfaced (E4) and nothing is dispatched", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_no_reviewer");
    const taskId = await cardInWip(store, boardId, "no-reviewer probe", DEFAULT_VOCAB);

    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const sweep = new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
    });
    const result = await sweep.tick(tickAfterEntry());

    expect(result.classes["no-reviewer"]).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(calls).toEqual([]);
    // Surfaced, not silently skipped: the entry event still exists for the operator to find.
    expect(await lifecycleRowCount(taskId)).toBe(1);
    /*
    FNXC:ReviewLaneDeclineAttribution 2026-11-19-22:55 (RUFU-478):
    The E4 state was previously a `log.warn` and nothing else, which is why 214 identical warn lines could not
    be attributed to a project without reading the code. The row is the durable half. It is durable on return
    because the recorder awaits the OUTCOME seam (a direct write), not the void lane whose accepted emit is
    only queued into the sink drain — so no `flushRunAuditSink()` is needed here, and adding one would prove
    nothing about the lane actually used. Switching the emitter to the buffered lane therefore REQUIRES
    draining before this query, or the assertion below starts racing a 25 ms window.
    */
    const declines = await reviewDeclineRows("proj-cli_entry_no_reviewer");
    expect(declines).toHaveLength(1);
    expect(declines[0]!.task_id).toBeNull();
    expect(declines[0]!.target).toBe("proj-cli_entry_no_reviewer");
    const decline = declines[0]!.metadata as Record<string, unknown>;
    expect(decline.reasonCode).toBe("no-enabled-reviewer");
    expect(decline.enabledReviewerCount).toBe(0);
    expect(decline.waitingCount).toBe(1);
    expect(decline.candidateTaskIds).toEqual([taskId]);
  });

  /*
  FNXC:ReviewLaneDeclineAttribution 2026-11-19-22:55 (RUFU-478):
  Positive control. Without it the decline row would be evidence that "a tick happened" rather than evidence
  of the decline, and the original report — a review lane that looked dead everywhere — is precisely the
  misreading that a tick-ran row would keep making possible.
  */
  it("a project WITH an enabled reviewer writes no review-dispatch decline (PostgreSQL)", async () => {
    const key = "cli_entry_decline_control";
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, key);
    const taskId = await cardInWip(store, boardId, "decline positive control", DEFAULT_VOCAB);

    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const sweep = new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([reviewer()]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
    });
    const result = await sweep.tick(tickAfterEntry());

    // The lane is alive: work was dispatched, so there is nothing to decline.
    expect(calls).toHaveLength(1);
    expect(result.dispatched).toContain(taskId);
    expect(await reviewDeclineRows(`proj-${key}`)).toHaveLength(0);
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-16:20 (#3619 review E):
  Grace keys on the committed `task:entered-review` event, not `task.updatedAt`. The edit below
  lands AFTER the 45 s-old entry event, so a `updatedAt`-keyed grace would keep this card starving
  in awaiting-handoff while the committed entry says it has waited past the 30 s window: a comment
  on a waiting card must not indefinitely defer reviewer work.
  */
  it("grace keys on the committed entry event, not on a late edit (PostgreSQL)", async () => {
    const key = "entry_grace_e";
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, key);
    const taskId = await cardInWip(store, boardId, "entry grace probe", DEFAULT_VOCAB);
    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    // Commit an entry event 45 s old with a HIGHER seq than the move's own event — the reader
    // takes the latest event, which is what "current review entry" means.
    const layer = store.asyncLayer;
    expect(layer).toBeTruthy();
    const enteredAt = new Date(Date.now() - 45_000).toISOString();
    await layer!.transactionImmediate(async (tx) => {
      await appendTaskLifecycleEventInTransaction(tx, {
        projectId: `proj-${key}`,
        eventType: "task:entered-review",
        taskId,
        occurredAt: enteredAt,
        payload: {
          taskId,
          previousColumn: DEFAULT_VOCAB.wip,
          toColumn: DEFAULT_VOCAB.review,
          enteredAt,
          actor: "test-seed",
        },
      });
    });
    // A comment-like edit lands now: `updatedAt` is fresh, the entry is not.
    await store.updateTask(taskId, { description: "edited like a comment would" });
    store.taskCache.delete(taskId);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    // Default 30 s grace — the production cadence is what this bug is about.
    const sweep = new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([reviewer()]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      maxDispatchesPerTick: 10,
    });
    const result = await sweep.tick(new Date(Date.now() + 1_000));
    expect(result.classes["awaiting-handoff"]).toBe(0);
    expect(result.dispatched).toEqual([taskId]);
  });

  /*
  FNXC:ReviewLanePool 2026-11-20-03:13 (RUFU-530):
  The positive control for the sentence the docs now carry: the POOL is the concurrency, the per-tick constant
  (4) is only a ceiling above it. One enabled reviewer asked for ten dispatches still moves exactly one card,
  because a reviewer holds one session at a time — the behaviour that must NOT have changed when the cap became
  4. The existing single-reviewer cases each hold one card, so none of them could see a second card waiting.
  */
  it("CONTROL — one enabled reviewer still moves exactly one card per tick with the ceiling at 10 (PostgreSQL)", async () => {
    const key = "pool_one_reviewer";
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, key);
    const only = poolReviewer("agent-pool-solo");

    const older = await cardInWip(store, boardId, "pool solo older probe", DEFAULT_VOCAB);
    const newer = await cardInWip(store, boardId, "pool solo newer probe", DEFAULT_VOCAB);
    await moveLikeTheCli(store, older, DEFAULT_VOCAB.review);
    await moveLikeTheCli(store, newer, DEFAULT_VOCAB.review);
    const stampBase = Date.now();
    for (const [taskId, minutesAgo] of [[older, 4], [newer, 2]] as const) {
      await stampReviewEntryAt(
        store,
        `proj-${key}`,
        taskId,
        DEFAULT_VOCAB.wip,
        DEFAULT_VOCAB.review,
        new Date(stampBase - minutesAgo * 60_000).toISOString(),
      );
    }

    const runs = new Map<string, AgentHeartbeatRun | null>([[only.id, null]]);
    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStoreWithRuns([only], runs),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
      maxDispatchesPerTick: 10,
    }).tick(tickAfterEntry());

    expect(result.dispatched).toEqual([older]);
    expect(calls).toEqual([{ agentId: only.id, taskId: older }]);
    // The waiting card is counted and untouched, not dispatched and not reported as a missing reviewer.
    expect(result.classes["never-dispatched"]).toBe(2);
    expect(result.classes["no-reviewer"]).toBe(0);
    expect(await listReviewerRunsForTask(store, newer)).toHaveLength(0);
    expect(await reviewDeclineRows(`proj-${key}`)).toHaveLength(0);
  });

  /*
  FNXC:ReviewLanePool 2026-11-20-03:13 (RUFU-530):
  The reachability gap the merged change left open. Before this case the pool's routing was proven only by the
  pure resolver (`review-lane-pool-dispatch.test.ts` asserts `resolveReviewSlot` directly and reaches pool
  resolution through a private cast), so nothing ever drove the SHIPPED `tick()` with two enabled reviewers. That
  is the shape a mock cannot see: a two-reviewer pass has to survive the real `task_reviewer_runs` write, whose
  live slot is per CARD (`task_reviewer_runs_live_unique`), and a routing bug that opened two live attempts for
  ONE card would have read green in every pure-resolver test.

  The contract under test is the one the old single-reviewer rule destroyed: pool size IS the lane's concurrency,
  so with two enabled reviewers and three waiting cards the two OLDEST go to two DIFFERENT reviewers in one pass,
  each with its own durable ledger attribution. The second pass pins the other half: a saturated pool is a
  NAMED wait (`review-in-flight` for the card its reviewer is running, `reviewer-busy` for the card whose pool is
  busy elsewhere, and the still-unattempted card stays counted as `never-dispatched` while the tick's `!free`
  guard withholds the dispatch), never a silent skip and never E4. `no-reviewer` belongs to zero reviewers only
  (RUFU-478), which is why it is asserted zero here rather than merely unmentioned.
  */
  it("two enabled reviewers dispatch the two oldest cards to two different reviewers, and a saturated pool names the wait (PostgreSQL)", async () => {
    const key = "pool_two_reviewers";
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, key);
    const [first, second] = [poolReviewer("agent-pool-a"), poolReviewer("agent-pool-b")];

    /*
     * The fixture's WIP lane is capacity-gated by the `wip` trait's `limitSetting: "maxConcurrent"` and the
     * store default is 2, so a THREE-card review queue cannot be assembled without raising it. This is the
     * established writer for that limit (`workflow-lifecycle-live-e2e.pg.test.ts:708`), not a bypass: the moves
     * still run the real admission judge, and nothing in the sweep reads `maxConcurrent`.
     */
    await store.updateSettings({ maxConcurrent: 5 });

    const oldest = await cardInWip(store, boardId, "pool oldest probe", DEFAULT_VOCAB);
    const middle = await cardInWip(store, boardId, "pool middle probe", DEFAULT_VOCAB);
    const youngest = await cardInWip(store, boardId, "pool youngest probe", DEFAULT_VOCAB);
    for (const taskId of [oldest, middle, youngest]) {
      await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);
    }
    // Entry order is fixed AFTER the moves, because the reader takes the highest-seq event per card.
    const stampBase = Date.now();
    for (const [taskId, minutesAgo] of [[oldest, 3], [middle, 2], [youngest, 1]] as const) {
      await stampReviewEntryAt(
        store,
        `proj-${key}`,
        taskId,
        DEFAULT_VOCAB.wip,
        DEFAULT_VOCAB.review,
        new Date(stampBase - minutesAgo * 60_000).toISOString(),
      );
    }

    const runs = new Map<string, AgentHeartbeatRun | null>([[first.id, null], [second.id, null]]);
    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const sweep = new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStoreWithRuns([first, second], runs),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
      maxDispatchesPerTick: 10,
    });

    const pass1 = await sweep.tick(tickAfterEntry());

    // Oldest-first queue, and the pool — not the per-tick ceiling of 4 — is what let two cards move.
    expect(pass1.dispatched).toEqual([oldest, middle]);
    expect(calls.map((call) => call.taskId)).toEqual([oldest, middle]);
    expect(new Set(calls.map((call) => call.agentId)).size).toBe(2);
    expect(pass1.classes["no-reviewer"]).toBe(0);
    // All three cards were CLASSIFIED even though only two moved: the third is counted, not dropped.
    expect(pass1.classes["never-dispatched"]).toBe(3);

    /*
     * Durable attribution, not an in-memory one: one live attempt per dispatched card, naming two different
     * reviewers. Two live rows for ONE card is the failure shape this file exists to catch, and only a real
     * index can see it.
     */
    const rowsOldest = await listReviewerRunsForTask(store, oldest);
    const rowsMiddle = await listReviewerRunsForTask(store, middle);
    expect(rowsOldest).toHaveLength(1);
    expect(rowsMiddle).toHaveLength(1);
    expect(rowsOldest[0]!.status).toBe("running");
    expect(rowsMiddle[0]!.status).toBe("running");
    expect(rowsOldest[0]!.reviewerAgentId).not.toBe(rowsMiddle[0]!.reviewerAgentId);
    expect([rowsOldest[0]!.reviewerAgentId, rowsMiddle[0]!.reviewerAgentId].sort()).toEqual([first.id, second.id].sort());
    // The board the attempt was opened from still satisfies the NOT NULL column on the second routing arm.
    expect(await ledgerBoardId(oldest)).toBe(boardId);
    expect(await listReviewerRunsForTask(store, youngest)).toHaveLength(0);

    // A pool of two is capacity, so RUFU-478's durable decline row must NOT be written for it.
    expect(await reviewDeclineRows(`proj-${key}`)).toHaveLength(0);

    // Saturate the pool: one reviewer runs THIS board's oldest card, the other works on another card entirely.
    runs.set(first.id, { agentId: first.id, taskId: oldest, status: "active" } as unknown as AgentHeartbeatRun);
    runs.set(second.id, { agentId: second.id, taskId: "OTHER-BOARD-CARD", status: "active" } as unknown as AgentHeartbeatRun);

    const pass2 = await sweep.tick(tickAfterEntry());

    expect(pass2.dispatched).toEqual([]);
    expect(calls).toHaveLength(2); // no launcher call was added by a pass with no free slot
    expect(pass2.classes["review-in-flight"]).toBe(1); // the oldest card keeps the session it already has
    expect(pass2.classes["reviewer-busy"]).toBe(1); // the middle card waits on a busy pool, named as a wait
    expect(pass2.classes["never-dispatched"]).toBe(1); // the youngest is still in the accounting
    expect(pass2.classes["no-reviewer"]).toBe(0); // a busy pool is never reported as a missing reviewer
    expect(await listReviewerRunsForTask(store, youngest)).toHaveLength(0);
  });
});

