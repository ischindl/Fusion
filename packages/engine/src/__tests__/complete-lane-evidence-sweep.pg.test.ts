/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
STEP 6 — the already-miscompleted cards are an explicit deliverable, not a footnote. RUFU-272 landed
`aa35098cc8`, carries a durable `post-merge-verification / failed / REVISE` row, and stands in `done`; 13
more cards looked identical and 7 more had the gate enabled with ZERO result rows. No sweep named any of
them, and `fn task reconcile` answered "not-in-review", which names nothing true.

These legs pin the two halves of what this sweep is allowed to be:

REPORTED — one run-audit row with a closed metadata set, one History line on the card, one bounded episode
on `sourceMetadata`, so "how many cards are wrongly in Done?" is a query rather than a guess.

REPORT-ONLY — no column move, no status, no pause, no step result, no continuation, no verdict. Lifecycle
containment (FN-207/FN-217) refuses the automatic backward move and fabricating a verdict would launder the
refusal, so the deliverable is the operator's ability to SEE the card, not a machine deciding for them.

Plus the bound: an unchanged finding re-records at most once per refresh floor. RUFU-393 measured one record
per poll for a single wedged card (16 536 rows over 2 d 19 h), and a polled sweep with no floor repeats that.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { Task, WorkflowStepResult } from "@fusion/core";
import { MessageStore, type PostMergeEvidenceContract } from "@fusion/core";
import {
  COMPLETE_LANE_EVIDENCE_FINDING_EVENT,
  COMPLETE_LANE_EVIDENCE_METADATA_KEY,
  COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS,
  collectCompleteColumnIds,
  postMergeFindingState,
  reconcileCompleteLaneGateEvidence,
  shouldRecordEpisode,
  type CompleteLaneEvidenceEpisode,
} from "../notification/complete-lane-evidence-detection.js";
import { createCompleteLaneEvidenceNoticeSender } from "../notification/complete-lane-evidence-notice.js";

const GATE = "post-merge-verification";

const enabled = ["plan-review", "code-review", GATE];

const postMergeRevise = (): WorkflowStepResult => ({
  workflowStepId: GATE,
  status: "failed",
  verdict: "REVISE",
  startedAt: "2026-09-26T22:38:00.000Z",
  completedAt: "2026-09-26T22:45:42.000Z",
});

const cleanGates = (): WorkflowStepResult[] => [
  { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE", completedAt: "2026-09-26T21:00:00.000Z" },
  { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", completedAt: "2026-09-26T21:30:00.000Z" },
];

describe("the complete-lane evidence bound is time-keyed, not pass-keyed (RUFU-349)", () => {
  const episode = (over: Partial<CompleteLaneEvidenceEpisode>): CompleteLaneEvidenceEpisode => ({
    signature: "sig-a",
    state: "refused",
    lane: "post-merge",
    gateIds: [GATE],
    firstAt: "2026-11-08T00:00:00.000Z",
    lastRecordedAt: "2026-11-08T00:00:00.000Z",
    recordCount: 1,
    ...over,
  });
  const t0 = Date.parse("2026-11-08T00:00:00.000Z");

  it("records a card it has never seen", () => {
    expect(shouldRecordEpisode(undefined, "sig-a", t0)).toBe(true);
  });

  it("records a changed finding signature immediately", () => {
    expect(shouldRecordEpisode(episode({}), "sig-b", t0 + 1000)).toBe(true);
  });

  it("withholds an unchanged finding inside the floor and releases it past it", () => {
    expect(shouldRecordEpisode(episode({}), "sig-a", t0 + 60_000)).toBe(false);
    expect(
      shouldRecordEpisode(episode({}), "sig-a", t0 + COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS),
    ).toBe(true);
  });

  it("keys on the complete TRAIT when collecting lanes, never on a `done` literal", () => {
    expect(
      collectCompleteColumnIds([
        {
          columns: [
            { id: "wip", traits: [{ trait: "wip" }] },
            { id: "shipped", traits: [{ trait: "complete" }] },
          ],
        },
        { columns: [{ id: "done", traits: [{ trait: "human-review" }] }] },
      ] as never),
    ).toEqual(["shipped"]);
  });

  /*
  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
  The post-merge requirement authority speaks `resumable` / `blocked(reason)`; this sweep speaks the
  classifier's state enum. These legs pin the translation, because the whole P0 was one arm of that
  translation going missing: `resumable` IS the zero-row population (7 of the 21 measured cards), and an
  unmapped arm silently drops a card out of the reported set. `pending` and `skipped` keep their distinct
  states — a still-running gate and an unwaived skip have different operator remedies — and every other
  blocked reason, `duplicate` included, is a durable answer that is not an approval.
  */
  it("maps every requirement-authority outcome onto a refusing finding state", () => {
    expect(postMergeFindingState({ outcome: "resumable", gateId: GATE })).toBe("missing");
    expect(postMergeFindingState({ outcome: "blocked", gateId: GATE, reason: "pending" })).toBe("in-flight");
    expect(postMergeFindingState({ outcome: "blocked", gateId: GATE, reason: "skipped" })).toBe("unwaived-skip");
    expect(postMergeFindingState({ outcome: "blocked", gateId: GATE, reason: "failed" })).toBe("not-approved");
    expect(postMergeFindingState({ outcome: "blocked", gateId: GATE, reason: "not-approved" })).toBe("not-approved");
    expect(postMergeFindingState({ outcome: "blocked", gateId: GATE, reason: "duplicate" })).toBe("not-approved");
  });
});

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
The two observations the post-merge ladder needs are injectable for a reason, and these fixtures are it.
A pg harness board is a fresh git repo with NO origin, so the derived evidence contract there is `none` and
RUFU-430 exempts every absent CI-shaped gate — the correct shipped answer for such a board, and the reason
these legs state the board fact they are reasoning about instead of inheriting the container's. The
producer surface is injected as `"unknown"` because RUFU-450 reads git for the task ref, which exists only
on a real landing; `"unknown"` is never an exemption, so the leg exercises the absence path rather than the
exemption path. A separate leg below pins the exemption the other way round.
*/
const REPORTER_CONTRACT: PostMergeEvidenceContract = {
  provider: "github-actions",
  source: "declared",
  reason: "operator-declared",
  observedAt: "2026-01-01T00:00:00.000Z",
};

const NO_REPORTER_CONTRACT: PostMergeEvidenceContract = {
  provider: "none",
  source: "declared",
  reason: "operator-declared",
  observedAt: "2026-01-01T00:00:00.000Z",
};

/** `surface: "unknown"` = "we could not ask", which the core rule refuses to read as an exemption. */
const UNPROVEN_SURFACE = { surface: "unknown" as const, mergeConfirmed: true };

/** The observations every absence leg states, so no leg depends on the container's git facts. */
const absenceOptions = {
  contract: REPORTER_CONTRACT,
  producerSurfaceFor: async () => UNPROVEN_SURFACE,
};

pgDescribe("the sweep reports a miscompleted card and touches nothing else (RUFU-349)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu349_sweep",
    projectId: "core-rufu349-sweep",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  let counter = 0;
  async function seedDone(
    rows: WorkflowStepResult[] | null,
    options: { landed?: boolean } = {},
  ): Promise<string> {
    counter += 1;
    const id = `RUFU349SW${counter}`;
    /* The lane is set AT CREATE. `updateTask` is not a lane writer — the store's move seam is — so a seed
       that silently failed to reach `done` would make every leg below assert nothing at all. */
    await h.store().createTaskWithReservedId(
      { description: `miscompleted card ${counter}`, column: "done" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, {
      enabledWorkflowSteps: enabled,
      workflowStepResults: rows,
      /* `landed: false` seeds the shape this sweep must NOT report: a card parked in `done` with no durable
         landing, which is the move-side guard's and the merge blocker's population, not this sweep's. */
      mergeDetails: options.landed === false
        ? { mergeConfirmed: false }
        : { mergeConfirmed: true, commitSha: "aa35098cc8" },
    } as never);
    return id;
  }

  async function rowsFor(id: string): Promise<Array<Record<string, unknown>>> {
    await h.store().flushRunAuditSink();
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${id} AND mutation_type = ${COMPLETE_LANE_EVIDENCE_FINDING_EVENT}`;
    return rows.map((row: { metadata: unknown }) =>
      (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>);
  }

  it("reports a done card whose post-merge gate reported REVISE, with audit row and History line", async () => {
    const store = h.store();
    const created = { id: await seedDone([...cleanGates(), postMergeRevise()]) };

    const summary = await reconcileCompleteLaneGateEvidence(store);
    expect(summary.findings).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(summary.cards).toEqual([created.id]);

    const rows = await rowsFor(created.id);
    expect(rows.length).toBe(1);
    // A closed metadata set: ids, the lane, fixed enums, and counts. Never prose, verdicts, or findings text.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["column", "gateCount", "lane", "outcome", "recordCount", "state", "taskId", "workflowId"].sort(),
    );
    expect(rows[0]).toMatchObject({
      taskId: created.id,
      column: "done",
      lane: "post-merge",
      gateCount: 1,
      outcome: "reported",
    });

    const card = await store.getTask(created.id);
    expect((card?.log ?? []).some((entry) => /complete-lane evidence finding/i.test(entry.action))).toBe(true);
    expect(
      (card?.sourceMetadata as Record<string, unknown>)[COMPLETE_LANE_EVIDENCE_METADATA_KEY],
    ).toMatchObject({ lane: "post-merge", recordCount: 1 });
  });

  it("is REPORT-ONLY: the card keeps its lane, status, and every gate row it already had", async () => {
    const store = h.store();
    const seeded = [...cleanGates(), postMergeRevise()];
    const created = { id: await seedDone(seeded) };

    await reconcileCompleteGateEvidenceOrThrow(store);

    const after = await store.getTask(created.id);
    expect(after?.column).toBe("done");
    expect(after?.status ?? undefined).toBeUndefined();
    expect(Boolean(after?.paused)).toBe(false);
    expect(after?.workflowStepResults).toEqual(seeded);
  });

  it("says nothing about a done card whose gates approved", async () => {
    const store = h.store();
    const created = { id: await seedDone([...cleanGates(), {
      workflowStepId: GATE,
      status: "passed",
      verdict: "APPROVE",
      completedAt: "2026-09-26T22:45:42.000Z",
    }]) };

    expect((await reconcileCompleteLaneGateEvidence(store)).findings).toBe(0);
    expect((await rowsFor(created.id)).length).toBe(0);
  });

  it("withholds a repeat record for an unchanged finding, so a polled sweep cannot flood the store", async () => {
    const store = h.store();
    const created = { id: await seedDone([...cleanGates(), postMergeRevise()]) };

    const base = Date.parse("2026-11-08T00:00:00.000Z");
    expect((await reconcileCompleteLaneGateEvidence(store, { now: base })).recorded).toBe(1);
    const second = await reconcileCompleteLaneGateEvidence(store, { now: base + 60_000 });
    expect(second.findings).toBe(1);
    expect(second.recorded).toBe(0);
    expect(second.suppressed).toBe(1);
    expect((await rowsFor(created.id)).length).toBe(1);

    // Past the floor the same standing condition is recorded again, with a grown counter.
    expect((await reconcileCompleteLaneGateEvidence(store, {
      now: base + COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS,
    })).recorded).toBe(1);
    const rows = await rowsFor(created.id);
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.recordCount)).toEqual([1, 2]);
  });

  /*
  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
  The candidate predicate is a durable landing, not a lane. A card standing in `done` with the SAME refusing
  row but no `mergeConfirmed` proof delivered nothing, so this sweep stays out of it: `getTaskMergeBlocker`
  and the RUFU-406 move guard own that shape, refuse it on every future crossing, and record their own
  refusal. Two authorities announcing one card for one cause is how a report becomes noise an operator
  learns to skip.
  */
  it("says nothing about a card in the same lane that never landed", async () => {
    const store = h.store();
    const created = { id: await seedDone([...cleanGates(), postMergeRevise()], { landed: false }) };

    const summary = await reconcileCompleteLaneGateEvidence(store, absenceOptions);
    expect(summary.findings).toBe(0);
    expect(summary.cards).toEqual([]);
    expect((await rowsFor(created.id)).length).toBe(0);
    const card = await store.getTask(created.id);
    expect(
      (card?.sourceMetadata as Record<string, unknown> | undefined)?.[COMPLETE_LANE_EVIDENCE_METADATA_KEY],
    ).toBeUndefined();
  });

  it("leaves an unrelated sourceMetadata owner's keys intact, because the write is key-level", async () => {
    const store = h.store();
    const created = { id: await seedDone([...cleanGates(), postMergeRevise()]) };
    await store.updateTask(created.id, {
      sourceMetadataPatch: { someoneElsesKey: { kept: true } },
    } as never);

    await reconcileCompleteLaneGateEvidence(store);

    const after = await store.getTask(created.id);
    const meta = after?.sourceMetadata as Record<string, unknown>;
    expect(meta.someoneElsesKey).toEqual({ kept: true });
    expect(meta[COMPLETE_LANE_EVIDENCE_METADATA_KEY]).toBeDefined();
  });
});

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
THE population the classifier could not see: gate enabled, ZERO result rows. `resolveCompleteColumnGateEvidence`
reports a post-merge `missing` only as a durable negative — deliberately, because on the move seam an absent
post-merge row is normal — so mounting the classifier alone named the 14 cards carrying a `failed` row and
said nothing about these. These legs are the regression guard for exactly that blindness: a card that is
LANDDED, owes the gate, and has nothing to show for it must produce one finding row, one History line, and
one notice, and must NOT produce any of those when the card never landed or when the board has no reporter
to ask.
*/
pgDescribe("the sweep names the cards whose required post-merge gate never reported (RUFU-349 P0)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu349_owed",
    projectId: "core-rufu349-owed",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  let counter = 0;
  async function seedLanded(rows: WorkflowStepResult[]): Promise<string> {
    counter += 1;
    const id = `RUFU349OW${counter}`;
    await h.store().createTaskWithReservedId(
      { description: `landed card owed post-merge evidence ${counter}`, column: "done" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, {
      enabledWorkflowSteps: enabled,
      workflowStepResults: rows,
      mergeDetails: { mergeConfirmed: true, commitSha: "bb41c0de11" },
    } as never);
    return id;
  }

  async function findingRows(id: string): Promise<Array<Record<string, unknown>>> {
    await h.store().flushRunAuditSink();
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${id} AND mutation_type = ${COMPLETE_LANE_EVIDENCE_FINDING_EVENT}`;
    return rows.map((row: { metadata: unknown }) =>
      (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>);
  }

  it("reports a landed card with ZERO post-merge result rows, once, with the state that names the absence", async () => {
    const store = h.store();
    const created = { id: await seedLanded(cleanGates()) };

    const summary = await reconcileCompleteLaneGateEvidence(store, absenceOptions);
    expect(summary.findings).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(summary.cards).toEqual([created.id]);

    const rows = await findingRows(created.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      taskId: created.id,
      column: "done",
      lane: "post-merge",
      // `missing`, not `not-approved`: the gate never spoke. The sentence and the remedy differ.
      state: "missing",
      gateCount: 1,
      outcome: "reported",
    });

    const card = await store.getTask(created.id);
    expect((card?.log ?? []).some((entry) => /'post-merge-verification' \(post-merge, missing\)/.test(entry.action ?? ""))).toBe(true);
    expect(
      (card?.sourceMetadata as Record<string, unknown>)[COMPLETE_LANE_EVIDENCE_METADATA_KEY],
    ).toMatchObject({ lane: "post-merge", state: "missing", gateIds: [GATE], recordCount: 1 });
  });

  it("delivers exactly one operator notice per card per day for that absence, through the real mailbox", async () => {
    const store = h.store();
    const mailbox = new MessageStore(null, { asyncLayer: h.layer() });
    const created = { id: await seedLanded(cleanGates()) };
    const noticeFor = createCompleteLaneEvidenceNoticeSender(mailbox);

    const base = Date.parse("2026-11-08T00:00:00.000Z");
    await reconcileCompleteLaneGateEvidence(store, { ...absenceOptions, noticeFor, now: base });
    // Past the record floor the standing condition is recorded again; the DAY-keyed notice is not re-sent.
    await reconcileCompleteLaneGateEvidence(store, {
      ...absenceOptions,
      noticeFor,
      now: base + COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS,
    });

    const notices = (await mailbox.getInbox(DASHBOARD_USER_ID, "user"))
      .filter((message) => message.content.includes(created.id));
    expect(notices.length).toBe(1);
    expect(notices[0]!.content).toContain(GATE);
    expect((notices[0]!.metadata as Record<string, unknown>).state).toBe("missing");
    // The durable half grew while the alarming half stayed bounded.
    expect((await findingRows(created.id)).length).toBe(2);
  });

  it("honours the board's evidence-reporter exemption instead of crying wolf on every landed card", async () => {
    const store = h.store();
    const created = { id: await seedLanded(cleanGates()) };

    /* RUFU-430's fact: a board with no CI reporter never owed this gate. Reporting it per landing is how
       a report-only sweep becomes RUFU-283's ~700-notices-a-day defect. */
    const summary = await reconcileCompleteLaneGateEvidence(store, {
      contract: NO_REPORTER_CONTRACT,
      producerSurfaceFor: async () => UNPROVEN_SURFACE,
    });
    expect(summary.findings).toBe(0);
    expect((await findingRows(created.id)).length).toBe(0);
  });

  it("honours RUFU-450's producer-unreachable exemption for a card that can no longer produce the row", async () => {
    const store = h.store();
    const created = { id: await seedLanded(cleanGates()) };

    const summary = await reconcileCompleteLaneGateEvidence(store, {
      contract: REPORTER_CONTRACT,
      producerSurfaceFor: async () => ({ surface: "ref-absent", mergeConfirmed: true, producerCanRun: false }),
    });
    expect(summary.findings).toBe(0);
    expect((await findingRows(created.id)).length).toBe(0);
  });

  it("still reports the same absence while a producer of the gate could still run", async () => {
    const store = h.store();
    const created = { id: await seedLanded(cleanGates()) };

    const summary = await reconcileCompleteLaneGateEvidence(store, {
      contract: REPORTER_CONTRACT,
      producerSurfaceFor: async () => ({ surface: "ref-divergent", mergeConfirmed: true, producerCanRun: true }),
    });
    expect(summary.findings).toBe(1);
    expect((await findingRows(created.id))[0]).toMatchObject({ state: "missing" });
  });
});

/** A named wrapper so the report-only leg fails loudly rather than swallowing a sweep error into 0. */
async function reconcileCompleteGateEvidenceOrThrow(store: ReturnType<SharedPgTaskStoreHarness["store"]>): Promise<void> {
  await reconcileCompleteLaneGateEvidence(store);
}

/** Keeps the `Task` import meaningful for readers diffing this file against the store's real row shape. */
export type SeededCard = Task;
