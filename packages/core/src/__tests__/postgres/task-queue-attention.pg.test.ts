/*
FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
The attention order against a REAL PostgreSQL database, and the only place the SQL half of the ladder is
executed. The unit suites around it prove the TypeScript half ranks a hydrated row a certain way, but the
arms here are jsonb predicates - a correlated `EXISTS` over `WITH ORDINALITY`, `jsonb_exists`,
`jsonb_typeof` guards, a `~ '\S'` text test - and each of those can be syntactically fine and semantically
wrong, including wrong in the direction that matters: ranking a calm card as urgent. No fake store
evaluates any of them.

WHY EVERY GATED CASE SITS IN `in-review` AND NOT IN `todo`. Measured against a live board before this file
was written, the required-gate arm matches 519 `todo` cards and 10 of ~12 `in-review` cards, because a card
that has never produced a result row for a required step IS the shape the merge door blocks on. A lane the
vocabulary does not call review-owned has the arm OFF, so it cannot demonstrate the arm at all; a lane that
does has it ON, so a card that is merely waiting there must declare a PASSED verdict to count as idle.

Every fixture names its own `enabledWorkflowSteps` rather than inheriting what `createTask` seeded, so a
card's tier depends on exactly one step's latest row and a change to the built-in board's step list cannot
silently move a fixture.
*/
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { resolveTaskColumnEntryAt } from "../../tasks/task-queue-order.js";
import { resolveAttentionTier, sqlAttentionTier } from "../../tasks/task-attention.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

/** Durable-column patches only: every signal below is one `UPDATE` away, never a hydrated derivation. */
type SignalPatch = Partial<
  Pick<
    Task,
    | "error"
    | "status"
    | "awaitingApprovalReason"
    | "humanPlanApproval"
    | "humanMergeApproval"
    | "pausedReason"
    | "blockedBy"
    | "overlapBlockedBy"
    | "enabledWorkflowSteps"
    | "workflowStepResults"
  >
>;

/** The one required gate every review-lane fixture declares, so tier 1 has exactly one input. */
const ONE_GATE = ["code-review"];

pgTest("Board attention order (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_attention",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const store = () => h.store();

  /** Create a card, place it, then apply its durable attention signals. A review card hops through WIP. */
  async function seed(label: string, patch: SignalPatch = {}, column = "todo"): Promise<Task> {
    let task = await store().createTask({ description: label });
    if (column !== task.column) {
      if (column === "in-review") task = await store().moveTask(task.id, "in-progress" as never);
      task = await store().moveTask(task.id, column as never);
    }
    if (Object.keys(patch).length === 0) return task;
    return await store().updateTask(task.id, patch as Partial<Task>);
  }

  /** A review-lane card whose single required gate holds exactly these verdict rows, oldest first. */
  function gateFixture(label: string, statuses: string[], patch: SignalPatch = {}): Promise<Task> {
    return seed(
      label,
      {
        enabledWorkflowSteps: ONE_GATE,
        workflowStepResults: statuses.map((status) => ({ workflowStepId: ONE_GATE[0]!, status })),
        ...patch,
      },
      "in-review",
    );
  }

  /**
   * A card that waits on another one, written straight to the durable column.
   *
   * Deliberately NOT through the store's dependency writer, which the rest of this file avoids for one
   * reason: that writer resolves and links the target, re-seeds hold lanes, and obeys WIP capacity - so a
   * fixture that only wants a dependency edge ends up moving cards into lanes it never came to test, and
   * the run dies on `column at capacity (2/2)` while asserting nothing about capacity. What the ORDER
   * expression reads is the jsonb array's length, and `blocked_by` / `overlap_blocked_by` above are set the
   * same plain way. A real edge and this edge are the same bytes to a `jsonb_array_length` predicate; they
   * are not the same bytes to the board, which is why the target id here is a placeholder.
   */
  async function waitsOn(waiter: Task, blockerId = "FN-9001"): Promise<Task> {
    /*
    `h.adminSql` on the SHARED harness is a getter-function (`() => Sql`), so it has to be called before it
    is tagged. Tagging the getter itself type-checks - a function is a legal template tag - issues no query
    at all, and leaves the fixture silently un-signalled: the first run of this file read three tier-5 cards
    as idle for exactly that reason, and every one of them looked like a ladder bug rather than a no-op.
    */
    await h.adminSql()`
      UPDATE project.tasks SET dependencies = ${JSON.stringify([blockerId])}::jsonb WHERE id = ${waiter.id}`;
    /*
    Prove the write landed. A no-op UPDATE is silent, and a fixture that never signalled reads back as a
    ladder bug - three cards came back idle for exactly that reason on this file's first run. Asserting the
    premise here means a future harness change fails with "the dependency array did not land" instead of
    failing an ordering expectation that was never about ordering.
    */
    const [landed] = await h.adminSql()`SELECT dependencies FROM project.tasks WHERE id = ${waiter.id}`;
    const written = (landed as { dependencies?: unknown } | undefined)?.dependencies;
    if (!Array.isArray(written) || written.length !== 1) {
      throw new Error(
        `waitsOn: the dependency array did not land on ${waiter.id} (got ${JSON.stringify(written)}).`,
      );
    }
    return waiter;
  }

  /** A waiting card in a plain lane: the tier's only signal is the durable dependency array. */
  async function seedWaiter(label: string, column = "todo", settledGate = false): Promise<Task> {
    const waiter = await seed(
      label,
      settledGate
        ? {
            enabledWorkflowSteps: ONE_GATE,
            workflowStepResults: [{ workflowStepId: ONE_GATE[0]!, status: "passed" }],
          }
        : {},
      column,
    );
    return await waitsOn(waiter);
  }

  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  /** Read one whole lane in the attention order, at a page size above every fixture in this file. */
  async function readAttention(columns: string[], reviewScope = false, limit = 60): Promise<Task[]> {
    const page = await store().listTaskQueuePage({ columns, order: "attention", reviewScope, limit });
    return page.tasks;
  }

  it("lifts one failed card out of two hundred idle cards onto the first page", async () => {
    // The acceptance measurement: the failure was created LAST, so creation-ascending puts it last and a
    // page of 5 never carried it. Ordering applied BEFORE the LIMIT is the only thing that can fix that.
    for (let index = 0; index < 200; index++) await seed(`idle-${index}`);
    const broken = await seed("broken", { error: "merge failed: lock held" });

    const page = await store().listTaskQueuePage({ columns: ["todo"], order: "attention", limit: 5 });
    expect(page.tasks[0]?.id).toBe(broken.id);
    // The page is still full and `total` still counts the whole lane: the ladder selects ORDER, never
    // membership, which is why column counts cannot move.
    expect(page.tasks).toHaveLength(5);
    expect(page.total).toBe(201);
  });

  it("ranks every tier the ungated lane can see, and keeps the gate arm off it", async () => {
    const idle = await seed("t6-idle");
    const dependency = await seedWaiter("t5-dependency");
    const paused = await seed("t4-paused", { pausedReason: "error-unrecoverable" });
    const approval = await seed("t2-approval", { awaitingApprovalReason: "human-plan-approval" });
    // A card whose required gate has produced nothing. In `todo` that is the NORMAL state - 519 live cards
    // look like this - so with the arm off it stays idle, and the same shape in a review lane is tier 1.
    const neverRanGate = await seed("t6-gate-ungated", { enabledWorkflowSteps: ONE_GATE });
    const broken = await seed("t0-error", { error: "boom" });

    const ordered = ids(await readAttention(["todo"]));
    expect(ordered).toEqual([broken.id, approval.id, paused.id, dependency.id, idle.id, neverRanGate.id]);
  });

  it("ranks a blocked required gate between an error and an approval in a review lane", async () => {
    const idlePassed = await gateFixture("t6-passed", ["passed"]);
    const dependency = await seedWaiter("t5-dependency", "in-review", true);
    const paused = await gateFixture("t4-paused", ["passed"], { pausedReason: "error-unrecoverable" });
    const approval = await gateFixture("t2-approval", ["passed"], { awaitingApprovalReason: "human-plan-approval" });
    const unrun = await seed("t1-unrun", { enabledWorkflowSteps: ONE_GATE }, "in-review");
    const failedGate = await gateFixture("t1-failed", ["failed"]);
    const broken = await gateFixture("t0-error", ["failed"], { error: "boom" });

    const ordered = ids(await readAttention(["in-review"], true));
    expect(ordered).toEqual([
      broken.id,
      unrun.id,
      failedGate.id,
      approval.id,
      paused.id,
      dependency.id,
      idlePassed.id,
    ]);
    /*
    A failed verdict and a gate that never ran are ONE tier, so their relative order is arrival and nothing
    else - which is the assertion that the ladder has seven buckets rather than one per gate shape. An
    earlier draft of this file expected the failed card first and that expectation was wrong: the ladder
    does not rank severity inside a tier, and ranking a never-run gate below a failed one is exactly the
    kind of over-precision the tier vocabulary deliberately does not claim.
    */
    expect(ordered.indexOf(unrun.id)).toBeLessThan(ordered.indexOf(failedGate.id));
  });

  it("refuses the gate arm for a lane the vocabulary does not call review-owned", async () => {
    const gate = await seed("gate", { enabledWorkflowSteps: ONE_GATE });
    const idle = await seed("idle");

    // Gate not claimed: idle by arrival.
    expect(ids(await readAttention(["todo"]))).toEqual([gate.id, idle.id]);
    /*
    Gate CLAIMED for `todo` and REFUSED: `todo` is not a review lane, so the page comes back identical. A
    client cannot talk the read into ranking a backlog by gates it has not reached - that would be
    over-ranking, the one direction the ladder forbids - and the client's claim is never trusted.
    */
    expect(ids(await readAttention(["todo"], true))).toEqual([gate.id, idle.id]);
  });

  it("reads the LATEST row per step id, so a re-ran gate that passed stops asking for attention", async () => {
    // The same two rows in the opposite array order. jsonb preserves array element order, so
    // `WITH ORDINALITY` plus `ORDER BY ord DESC LIMIT 1` is the SQL spelling of the client's `.at(-1)`.
    const reworked = await gateFixture("failed-last", ["passed", "failed"]);
    const repaired = await gateFixture("passed-last", ["failed", "passed"]);

    const ordered = ids(await readAttention(["in-review"], true));
    expect(ordered[0]).toBe(reworked.id);
    expect(ordered.slice(1)).toEqual([repaired.id]);
  });

  it("treats a missing verdict row as attention and a non-blocking verdict as not", async () => {
    const missingRow = await seed("gate-missing", { enabledWorkflowSteps: ONE_GATE }, "in-review");
    const pending = await gateFixture("gate-pending", ["pending"]);
    const advisory = await gateFixture("gate-advisory", ["advisory_failure"]);
    const waived = await gateFixture("gate-waived", ["skipped"]);

    const ordered = ids(await readAttention(["in-review"], true));
    // The two blocking shapes lead, in creation order. `advisory_failure` is non-blocking by contract and
    // `skipped` is usually an audited operator waiver, so neither may float a settled card to the top of
    // the lane, and each stays where arrival puts it - which is the whole point of excluding them.
    expect(ordered.slice(0, 2)).toEqual([missingRow.id, pending.id]);
    expect(ordered.slice(2)).toEqual([advisory.id, waived.id]);
  });

  it("reads a corrupt step array as no verdict rows instead of throwing", async () => {
    const settled = await gateFixture("settled-passed", ["passed"]);
    const corrupt = await gateFixture("corrupt-results", ["passed"]);
    /*
    Written through raw SQL on purpose: the store's own writer would refuse a non-array, so the only way to
    get a corrupt value into the column - which is exactly what the `jsonb_typeof` guards exist for - is to
    go around the writer. The declared reading is "no verdict rows", which for a required gate is the
    missing-row case, tier 1: the corrupt card must therefore come OUT FIRST, ahead of a card whose gate
    genuinely passed. If the guard were missing, `jsonb_array_elements` on a scalar would raise and the
    whole lane read would die, and if the corruption were read as "no signal" the corrupt card would land
    last. This expectation is the difference between the two.
    */
    await h.adminSql()`
      UPDATE project.tasks SET workflow_step_results = '"not-an-array"'::jsonb WHERE id = ${corrupt.id}`;
    // Same premise check as `waitsOn`: the corruption IS the fixture, so prove it is in the column.
    const [corruptRow] = await h.adminSql()`
      SELECT jsonb_typeof(workflow_step_results) AS kind FROM project.tasks WHERE id = ${corrupt.id}`;
    if ((corruptRow as { kind?: string } | undefined)?.kind !== "string") {
      throw new Error(
        `corrupt-results: the column is ${JSON.stringify((corruptRow as { kind?: string } | undefined)?.kind)}, not a jsonb scalar.`,
      );
    }

    const ordered = ids(await readAttention(["in-review"], true));
    expect(ordered).toEqual([corrupt.id, settled.id]);
    /*
    And the two halves of the ladder must agree about the corrupt row rather than merely survive it: the
    client classifier carries its own `Array.isArray` guard for the same reason, so a corrupt list costs the
    same tier on both sides and the cursor key a page break mints stays the honest one.
    */
    const hydrated = await store().getTask(corrupt.id);
    expect(resolveAttentionTier(hydrated!, { reviewScope: true })).toBe(1);
  });

  it("separates an armed approval from a decided one, including a decision that is null", async () => {
    const planArmed = await seed("plan-armed", { humanPlanApproval: { enabled: true, generation: 1 } as never });
    const mergeArmed = await seed("merge-armed", { humanMergeApproval: { enabled: true, generation: 3 } as never });
    const decided = await seed("plan-decided", {
      humanPlanApproval: { enabled: true, generation: 1, decision: { approved: true } } as never,
    });
    /*
    `decision: null` still means the KEY exists, so a decision was made and recorded as none. The jsonb
    spelling is `jsonb_exists(...)`, the function form rather than the `?` operator, because the read is a
    parameterised statement; it agrees with the client's `hasOwnProperty`.
    */
    const decidedNull = await seed("plan-decided-null", {
      humanPlanApproval: { enabled: true, generation: 1, decision: null } as never,
    });
    const disabled = await seed("approval-disabled", { humanPlanApproval: { enabled: false, generation: 1 } as never });
    const idle = await seed("idle");

    const ordered = ids(await readAttention(["todo"]));
    expect(ordered.slice(0, 2)).toEqual([planArmed.id, mergeArmed.id]);
    expect(ordered.slice(2)).toEqual([decided.id, decidedNull.id, disabled.id, idle.id]);
  });

  it("ranks a pause ahead of a dependency wait and treats an empty list as no wait", async () => {
    const emptyList = await seed("deps-empty", { dependencies: [] });
    const deps = await seedWaiter("deps-list");
    const overlap = await seed("overlap", { overlapBlockedBy: "fusion/rufu-0000" });
    const blankText = await seed("blocked-blank", { blockedBy: "   " });
    const paused = await seed("paused", { pausedReason: "error-retry-exhausted" });
    const idle = await seed("idle");

    const ordered = ids(await readAttention(["todo"]));
    expect(ordered[0]).toBe(paused.id);
    /*
    The two real waits first, in creation order, then the three cards carrying NO wait: a whitespace-only
    blocker text and an EMPTY dependency list are blank on both halves of the ladder and must not float a
    card that is simply idle. An earlier draft of this expectation put the empty-list card among the
    waiters because it was created first; the ladder says otherwise, and the ladder is the contract - a
    zero-length array is not a wait, and arrival only orders cards that share a tier.
    */
    expect(ordered.slice(1, 3)).toEqual([deps.id, overlap.id]);
    expect(ordered.slice(3)).toEqual([emptyList.id, blankText.id, idle.id]);
  });

  it("ranks the declared stall-deadlock divergence as a pause, never as a review stall", async () => {
    /*
    The ONE declared divergence, pinned rather than excluded. `stallReason` is a hydrated derivation, so
    SQL cannot see tier 3 and reads this card's `paused_reason` instead: the client ranks it 3, the server
    ranks it 4. Under-rank only, which is the direction the ladder's contract allows, and it is pinned here
    because a key minted at 3 would silently skip every real tier-4 row sitting between the two.
    */
    const deadlock = await seed("stall-deadlock", { pausedReason: "in-review-stall-deadlock" });
    const approval = await seed("approval-owed", { awaitingApprovalReason: "human-plan-approval" });
    const dependency = await seedWaiter("dependency-wait");

    const ordered = ids(await readAttention(["todo"]));
    expect(ordered).toEqual([approval.id, deadlock.id, dependency.id]);
    // And the two halves genuinely disagree on this row, which is what makes it the declared case.
    expect(sqlAttentionTier(deadlock)).toBe(4);
  });

  it("keeps the Boost bucket first and ranks the tier inside it", async () => {
    const idle = await seed("idle");
    const broken = await seed("broken", { error: "boom" });
    const boosted = await seed("boosted");
    const boost = await store().boostTask(boosted.id, {
      requestId: "req-boost",
      workflowId: "builtin:coding",
      expectedColumn: boosted.column,
      expectedColumnEntryAt: resolveTaskColumnEntryAt(boosted),
    });
    expect(boost.ok).toBe(true);

    // A deliberate Boost keeps the head even against a failure: attention ranks INSIDE the bucket.
    expect(ids(await readAttention(["todo"]))).toEqual([boosted.id, broken.id, idle.id]);
  });

  it("walks every page of a mixed lane with no gap and no duplicate", async () => {
    for (let index = 0; index < 12; index++) {
      const extra: SignalPatch =
        index % 6 === 0
          ? { error: `boom ${index}` }
          : index % 6 === 1
            ? { awaitingApprovalReason: "human-plan-approval" }
            : index % 6 === 2
              ? { pausedReason: "error-unrecoverable" }
              : {};
      /*
      Only the tier-1 card carries an unrun gate; every other card holds a PASSED verdict. A non-blocking
      gate on a tier-2 card would pull it up into tier 1 and collapse the very spread the walk has to
      cross to prove the tier survived the continuation.
      */
      await gateFixture(`mixed-${index}`, index % 6 === 4 ? [] : ["passed"], extra);
    }
    // Two cards wait on a dependency, appended after the ladder so the tier spread stays one per tier.
    for (const label of ["wait-6", "wait-12"]) await seedWaiter(label, "in-review", true);

    const expected = ids(await readAttention(["in-review"], true, 60));
    expect(expected).toHaveLength(14);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await store().listTaskQueuePage({
        columns: ["in-review"],
        order: "attention",
        reviewScope: true,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...ids(page.tasks));
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Every card exactly once, in the order one big read produced: the tier term survived the
    // continuation, which is the one thing a page walk can silently lose.
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(14);
  });

  it("rejects a cursor minted under a different gate instead of interleaving two orders", async () => {
    for (let index = 0; index < 6; index++) {
      await gateFixture(`r-${index}`, index % 2 === 0 ? ["failed"] : ["passed"]);
    }
    const gated = await store().listTaskQueuePage({
      columns: ["in-review"],
      order: "attention",
      reviewScope: true,
      limit: 2,
    });
    expect(gated.nextCursor).toBeTruthy();

    /*
    The gate is part of the ORDER, so it belongs to the lane signature the cursor is bound to: the first
    page was selected with the step arm on, and continuing it with the arm off would resume on a tier the
    first page never contained. Rejecting forces a clean restart at the head, which is what the sibling
    cross-order rejection already does.
    */
    const replayed = await store()
      .listTaskQueuePage({ columns: ["in-review"], order: "attention", limit: 2, cursor: gated.nextCursor! })
      .catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(TypeError);
    expect((replayed as TypeError).message).toBe("Invalid task queue cursor");

    // Replaying it faithfully keeps walking, which proves the refusal is about the gate and not the key.
    const continued = await store().listTaskQueuePage({
      columns: ["in-review"],
      order: "attention",
      reviewScope: true,
      limit: 2,
      cursor: gated.nextCursor!,
    });
    expect(continued.tasks).toHaveLength(2);
    expect(ids(continued.tasks)).not.toEqual(ids(gated.tasks));
  });

  it("selects the same membership as the queue order, so column counts cannot move", async () => {
    await seed("broken", { error: "boom" });
    await seed("paused", { pausedReason: "error-unrecoverable" });
    for (let index = 0; index < 4; index++) await seed(`idle-${index}`);

    const attention = await store().listTaskQueuePage({ columns: ["todo"], order: "attention", limit: 60 });
    const queue = await store().listTaskQueuePage({ columns: ["todo"], order: "queue", limit: 60 });
    expect(attention.total).toBe(queue.total);
    expect(ids(attention.tasks).sort()).toEqual(ids(queue.tasks).sort());
  });

  it("mutates nothing while ordering, because a ranking rule is not a lifecycle action", async () => {
    /*
    The requirement says presentation-only: no lifecycle, no card mutation. The dangerous version of that
    claim is invisible in a unit test, because a `SELECT ... ORDER BY` cannot mutate anything in the
    abstract - what has to be proven is that the REAL lane read does not smuggle a write along with it.
    A lane read carries real machinery around it: a keyset cursor is minted, boost effectiveness is
    resolved against a workflow, and the review-scope arm resolves the project's column vocabulary. Any
    one of those could have grown a write and the board would still have looked correct.

    So the assertion is a whole-row snapshot of every field the ladder is allowed to READ, taken before and
    after a full page walk including a cursor continuation. `updated_at` is in the list deliberately: it
    is the field every writer in this store bumps, so it is how a smuggled write becomes visible even when
    the smuggler changes nothing else.
    */
    const broken = await seed("m-broken", { error: "boom" });
    const paused = await seed("m-paused", { pausedReason: "error-unrecoverable" });
    const waiter = await seedWaiter("m-waiter");
    await seed("m-idle-1");
    await seed("m-idle-2");

    const snapshot = async () => await h.adminSql()`
      SELECT id, status, error, paused, paused_reason, awaiting_approval_reason, dependencies,
             enabled_workflow_steps, source_metadata, updated_at
      FROM project.tasks
      WHERE id IN (${broken.id}, ${paused.id}, ${waiter.id})
      ORDER BY id`;

    const before = await snapshot();
    const first = await store().listTaskQueuePage({ columns: ["todo"], order: "attention", limit: 2 });
    await store().listTaskQueuePage({ columns: ["todo"], order: "attention", limit: 2, cursor: first.nextCursor! });
    await store().listTaskQueuePage({ columns: ["in-review"], order: "attention", reviewScope: true, limit: 2 });

    expect(await snapshot()).toEqual(before);
  });

  it("leaves the dispatch-consumed queue order exactly where it was", async () => {
    const arrival: Task[] = [];
    for (let index = 0; index < 5; index++) {
      arrival.push(await seed(`q-${index}`, index === 2 ? { error: "boom" } : {}));
    }
    const boosted = arrival[4]!;
    await store().boostTask(boosted.id, {
      requestId: "req-q",
      workflowId: "builtin:coding",
      expectedColumn: boosted.column,
      expectedColumnEntryAt: resolveTaskColumnEntryAt(boosted),
    });

    /*
    Registering `attention-order` touched the same ORDER BY dispatch as `queue-order`, the order the engine
    dispatch reads. This is its guard: boost first, then plain arrival - the failure stays LAST, because
    attention is not part of that contract and must not silently become one here.
    */
    const page = await store().listTaskQueuePage({ columns: ["todo"], order: "queue", limit: 60 });
    expect(ids(page.tasks)).toEqual([boosted.id, arrival[0]!.id, arrival[1]!.id, arrival[2]!.id, arrival[3]!.id]);
    // And the attention order over the same rows lifts that failure just behind the boost and ahead of the
    // two idle cards created before it, which is the difference this whole card exists to make.
    const attention = await store().listTaskQueuePage({ columns: ["todo"], order: "attention", limit: 60 });
    expect(ids(attention.tasks)).toEqual([boosted.id, arrival[2]!.id, arrival[0]!.id, arrival[1]!.id, arrival[3]!.id]);
  });
});
