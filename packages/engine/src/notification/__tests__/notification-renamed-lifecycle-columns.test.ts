/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (fleet phase — evidence for the notification lifecycle guards):
DIFFERENTIAL: one notification service, one event sequence, two column VOCABULARIES.

`NotificationService` decided which moves are notable by comparing `data.to` against the literals
`in-review` and `done`. On a workflow that names its lanes anything else, both comparisons are simply
false — so the two notifications an operator most relies on (a task reaching review, a task reaching
terminal merge) were SILENTLY not sent. Nothing throws and no log records it; the operator just stops
being told.

The test drives the same store twice, changing only the workflow's column ids, and asserts the same
notifications arrive. `DEFAULT_VOCAB` alone cannot show this — a guard keyed on the literal passes there
for the wrong reason, which is exactly why the shared fixture exists.

REVERT CHECK, measured (both run):
  - `data.to === "in-review"` restored -> "dispatches the review notification on a RENAMED review
    column" fails with 0 calls.
  - `data.to === "done"` restored -> "dispatches the terminal merge notification on a RENAMED complete
    column" fails with 0 calls.
Both pass on the DEFAULT vocabulary before and after, which is the point of running both.
*/
import { describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, Task, TaskMoveLanes, WorkflowIr } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { SelfHealingManager } from "../../self-healing.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "../../__tests__/_workflow-vocabulary-fixture.js";
import { flushAsyncHandlers } from "../../__tests__/_flush-async-handlers.js";

/*
FNXC:TaskWedgeNotifications 2026-09-03-03:41 (RUFU-180):
The standing-sweep trigger hands off through `getActiveNotificationService()`; the sweep tests bind
the fixture service to that registry the same way production self-healing discovers it.
*/
const { getActiveNotificationServiceMock } = vi.hoisted(() => ({ getActiveNotificationServiceMock: vi.fn() }));
vi.mock("../../util/notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../util/notifier.js")>();
  return { ...actual, getActiveNotificationService: getActiveNotificationServiceMock };
});

vi.mock("../../logger.js", () => {
  const double = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() });
  return {
    schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getLogger: double,
    createLogger: double,
  };
});

type MovedListener = (data: { task: Task; from: string; to: string }) => void;
type UpdatedListener = (task: Task, meta?: { lanes?: TaskMoveLanes }) => void;

/**
 * A store that resolves a real workflow IR, so `resolveTaskLifecycleColumns` returns the vocabulary
 * under test rather than failing soft to the legacy ids. Failing soft would make the renamed run
 * indistinguishable from the default one and the differential meaningless.
 */
function fixture(vocab: Vocabulary, serviceOptions?: { wedgeNotificationSettleMs?: number }) {
  /*
  `mergeOrchestration: true` is REQUIRED here, and finding that out was the useful part.

  `resolveLifecycleColumns` keys its `review` role on the `mergeOrchestration` flag
  (`LIFECYCLE_ROLE_FLAGS.review`), NOT on `human-review`. The fixture's review column declares
  `human-review` and adds `merge` only on opt-in — so without this option the resolved `review` is
  `undefined`, the guard falls back to `"in-review"`, and the RENAMED case fails. It did.

  That is not just a fixture detail. It means a custom workflow whose review lane carries ONLY
  `human-review` still gets no review notification, because the role it needs is defined as "the
  merge-orchestration column". The dashboard's own `isReviewColumnRole` treats `mergeBlocker` OR
  `humanReview` as review, so the app and the core resolver disagree about what "review" means.
  Reconciling them changes a shared resolver used well beyond notifications, so it is recorded here
  and in the PR rather than changed under a conversion. The default coding workflow's review column
  does carry merge orchestration, which is why this is a gap on custom boards and not a live outage.
  */
  const ir: WorkflowIr = lifecycleIr(vocab, "notif-lifecycle", { mergeOrchestration: true });
  const movedListeners = new Set<MovedListener>();
  const updatedListeners = new Set<UpdatedListener>();
  let board: Task[] = [];
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    getTaskWorkflowSelection: () => ({ workflowId: "notif-lifecycle", stepIds: [] }),
    getWorkflowDefinition: async (id: string) => (id === "notif-lifecycle" ? { ir } : undefined),
    listTasks: async () => board,
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-06:10 (RUFU-180 code-review P0):
    `maybeNotifyTaskWedge` re-reads the live row through `store.getTask` before classifying, and
    production hydrates the stall reason ONLY on reads (reads.ts) — never on the `task:moved`
    payload (which comes from `readTaskForMove`, a raw row conversion). The board rows are that
    hydrated read output; event payloads in these tests must therefore be production-shaped
    WITHOUT `stallReason` so an arrival assertion proves the live read, not an accidental
    payload field. Before this existed the fixture had no getTask at all and the tests injected
    the reason into the payload, proving a path production never emits.
    */
    getTask: async (id: string) => board.find((candidate) => candidate.id === id),
    on: (event: string, listener: MovedListener | UpdatedListener) => {
      if (event === "task:moved") movedListeners.add(listener as MovedListener);
      if (event === "task:updated") updatedListeners.add(listener as UpdatedListener);
    },
    off: () => undefined,
    emitMoved: (data: { task: Task; from: string; to: string }) => movedListeners.forEach((listener) => listener(data)),
    emitUpdated: (updatedTask: Task, meta?: { lanes?: TaskMoveLanes }) =>
      updatedListeners.forEach((listener) => listener(updatedTask, meta)),
  };

  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  const provider: NotificationProvider = {
    getProviderId: () => "test",
    isEventSupported: () => true,
    sendNotification,
  };
  const service = new NotificationService(store as never, serviceOptions);
  service.registerProvider(provider);

  const task = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-9001",
    title: "Renamed lifecycle",
    description: "",
    column: vocab.wip,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  } as Task);

  return { store, service, sendNotification, task, setBoard: (tasks: Task[]) => { board = tasks; } };
}

/** Both vocabularies, so a literal-keyed guard cannot pass by hitting the legacy ids. */
const VOCABULARIES: ReadonlyArray<readonly [string, Vocabulary]> = [
  ["DEFAULT", DEFAULT_VOCAB],
  ["RENAMED", RENAMED_VOCAB],
];

describe("notification lifecycle guards resolve columns by ROLE, not by id", () => {
  for (const [label, vocab] of VOCABULARIES) {
    it(`dispatches the review notification on a ${label} review column (${vocab.review})`, async () => {
      const { store, service, sendNotification, task } = fixture(vocab);
      await service.start();

      store.emitMoved({ task: task({ column: vocab.review }), from: vocab.wip, to: vocab.review });
      await flushAsyncHandlers();

      /*
      The notification EVENT KIND stays the literal `in-review` on purpose — it is a notification
      channel name in the operator's ntfy config, not a column id. Renaming a board must not rename
      the event, or every existing per-event filter silently stops matching.
      */
      expect(sendNotification).toHaveBeenCalledWith(
        "in-review",
        expect.objectContaining({ taskId: "FN-9001", event: "in-review" }),
      );
      await service.stop();
    });

    it(`dispatches the terminal merge notification on a ${label} complete column (${vocab.complete})`, async () => {
      const { store, service, sendNotification, task } = fixture(vocab);
      await service.start();

      // `isMergeBackedTerminalTask` is the other half of the guard; mergeConfirmed satisfies it.
      const merged = task({ column: vocab.complete, mergeDetails: { mergeConfirmed: true } } as never);
      store.emitMoved({ task: merged, from: vocab.review, to: vocab.complete });
      await flushAsyncHandlers();

      expect(sendNotification).toHaveBeenCalledWith(
        "merged",
        expect.objectContaining({ taskId: "FN-9001", event: "merged" }),
      );
      await service.stop();
    });

    it(`announces a null-status review-lane stall wedge on a ${label} review column (${vocab.review})`, async () => {
      /*
      FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
      A review-lane merge refusal carries `status: null` and a derived `stallReason`, so it reaches an
      operator only through the stall authority. Under a RENAMED vocabulary it must still announce:
      the wedge eligibility check resolves its lanes by lifecycle ROLE, and a stall alert keyed on the
      literal `in-review` would be silent on exactly the custom boards this file exists to cover.

      FNXC:TaskWedgeNotifications 2026-09-03-05:05 (RUFU-180 code-review P0):
      Production-shaped inputs: the hydrated row lives on the board (what `getTask` returns) and the
      emitted payload is the raw row conversion production actually emits. Delivery then provably
      comes from the service's live re-read, the same read every production caller performs.
      */
      // Settle window 0: this differential store carries no pending-marker CAS, so a nonzero default
      // settle would park the hold and return "unavailable" instead of asking the question here.
      const { store, service, sendNotification, task, setBoard } = fixture(vocab, { wedgeNotificationSettleMs: 0 });
      await service.start();

      const stalled = task({
        column: vocab.review,
        status: null,
        stallReason: {
          code: "merge-blocker",
          reason: "task has a pre-merge approval recorded against different content",
          observedAt: "2026-09-03T00:00:00.000Z",
        },
      } as never);
      setBoard([stalled]);
      store.emitUpdated({ ...stalled, stallReason: undefined } as never);
      await flushAsyncHandlers();

      expect(sendNotification).toHaveBeenCalledWith(
        "task-wedged",
        expect.objectContaining({
          taskId: "FN-9001",
          metadata: expect.objectContaining({ wedgeReason: "stall:merge-blocker" }),
        }),
      );
      await service.stop();
    });
  }

  it("leaves a stallReason-less review-lane card silent on a RENAMED review column", async () => {
    // Non-vacuous control: the renamed alert above cannot be explained by "notify on any review card".
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB, { wedgeNotificationSettleMs: 0 });
    await service.start();

    store.emitUpdated(task({ column: RENAMED_VOCAB.review, status: null } as never));
    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("classifies a manual merge hold from emitter-carried renamed review lanes synchronously", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    store.emitUpdated(
      task({ column: RENAMED_VOCAB.review, paused: true, pausedReason: "manual-hold", status: "in-review" }),
      { lanes: { review: RENAMED_VOCAB.review } },
    );

    // No promise turn: the synchronous listener must classify before its queued wedge work runs.
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-9001",
        metadata: expect.objectContaining({
          notificationKind: "manual_merge_hold",
          notificationDedupeKey: "workflow-transition:FN-9001:manual-merge-hold",
        }),
      }),
    );
    await service.stop();
  });

  it("keeps absent or blank review lanes on the existing in-review fallback", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    const held = (column: string) => task({ column, paused: true, pausedReason: "manual-hold", status: "in-review" });
    store.emitUpdated(held(RENAMED_VOCAB.review));
    store.emitUpdated(held(RENAMED_VOCAB.review), { lanes: { review: "" } });
    store.emitUpdated(held("in-review"));
    store.emitUpdated(held("in-review"), { lanes: { review: "" } });
    await flushAsyncHandlers();

    // Only the default-lane holds notify; absent and blank metadata are unknown rather than renamed.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("workflow-notify", expect.anything());
    await service.stop();
  });

  it("preserves marker, failed, and dedupe behavior independently of lane metadata", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    const marker = {
      kind: "manual-merge-hold" as const,
      transitionId: "marker-hold",
      column: RENAMED_VOCAB.review,
      createdAt: "2026-08-01T07:44:00.000Z",
    };
    store.emitUpdated(task({ id: "FN-marker", column: RENAMED_VOCAB.review, status: "in-review", workflowTransitionNotification: marker }));
    store.emitUpdated(task({ id: "FN-failed", column: RENAMED_VOCAB.review, status: "failed", paused: true, pausedReason: "manual-hold" }), { lanes: { review: RENAMED_VOCAB.review } });
    const duplicate = task({ id: "FN-duplicate", column: RENAMED_VOCAB.review, status: "in-review", paused: true, pausedReason: "manual-hold" });
    store.emitUpdated(duplicate, { lanes: { review: RENAMED_VOCAB.review } });
    store.emitUpdated(duplicate, { lanes: { review: RENAMED_VOCAB.review } });
    await flushAsyncHandlers();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({ taskId: "FN-marker", metadata: expect.objectContaining({ notificationDedupeKey: "workflow-transition:FN-marker:marker-hold" }) }),
    );
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({ taskId: "FN-duplicate", metadata: expect.objectContaining({ notificationDedupeKey: "workflow-transition:FN-duplicate:manual-merge-hold" }) }),
    );
    await service.stop();
  });

  it("does not dispatch for a move into a lane that plays no notable role", async () => {
    /*
    Non-vacuous check on both conversions at once: without it, a service that notified on EVERY move
    would satisfy all four cases above. `building` is the renamed WIP lane — a real column, just not
    one either guard is about.
    */
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    store.emitMoved({ task: task({ column: RENAMED_VOCAB.wip }), from: RENAMED_VOCAB.hold, to: RENAMED_VOCAB.wip });
    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  for (const [label, vocab] of VOCABULARIES) {
    it(`${label}: one stalled card is alerted by BOTH discovery triggers on the ${label} review lane and stays silent after the move into the ${label} complete lane`, async () => {
      /*
      FNXC:TaskWedgeNotifications 2026-09-03-03:41 (RUFU-180):
      Renamed-lane differential for the Step-3 discovery pair. Neither trigger reads column
      literals: the arrival path resolves the review role through the IR, and the standing sweep
      routes every candidate through the NotificationService (the sole validation/dispatch
      authority), whose lane gates resolve the renamed vocabulary the same way. The whole card
      lifecycle — sweep alert, arrival re-observation collapse, and terminal-lane silence — must
      hold on `shipped`/`live` exactly as on DEFAULT, which only a per-vocabulary loop can prove.
      */
      const { store, service, sendNotification, task, setBoard } = fixture(vocab, { wedgeNotificationSettleMs: 0 });
      await service.start();
      getActiveNotificationServiceMock.mockReturnValue(service);
      const manager = new SelfHealingManager(store as never, { rootDir: "/repo" });
      const wedges = () => (sendNotification.mock.calls as unknown as Array<[string, { metadata?: { wedgeReason?: string } }]>)
        .filter(([event]) => event === "task-wedged");

      const stalled = {
        ...task({ column: vocab.review }),
        status: null,
        stallReason: { code: "merge-blocker", reason: "the review lane refuses to merge this card: contract tests are red on the branch", observedAt: "2026-09-03T11:55:00.000Z" },
      } as unknown as Task;
      setBoard([stalled]);

      // Trigger B (standing sweep, zero events): the alert fires on the renamed review lane.
      await manager.reconcileReviewStallWedgeNotifications();
      await flushAsyncHandlers();
      expect(wedges()).toHaveLength(1);
      expect(wedges()[0]![1].metadata?.wedgeReason).toBe("stall:merge-blocker");

      // Trigger A (arrival emit) re-observes the same unchanged episode and must collapse, not duplicate.
      // Production shape: the moved payload carries no stall reason (raw readTaskForMove row); the
      // hydrated board row above is what the service's live re-read classifies.
      store.emitMoved({ task: { ...stalled, stallReason: undefined } as Task, from: vocab.wip, to: vocab.review });
      await flushAsyncHandlers();
      expect(wedges()).toHaveLength(1);

      // The same card moving into the renamed COMPLETE lane ends the announcement: the terminal-lane
      // branch resolves without dispatch, and a transitioned reason on the resolved card stays silent.
      const merged = { ...stalled, column: vocab.complete, status: "merged", stallReason: { code: "held-human-review", reason: "the card sits behind an approval that the human operator must decide", observedAt: "2026-09-03T11:58:00.000Z" } } as Task;
      setBoard([merged]);
      store.emitMoved({ task: { ...merged, stallReason: undefined } as Task, from: vocab.review, to: vocab.complete });
      store.emitUpdated(merged);
      await flushAsyncHandlers();
      await manager.reconcileReviewStallWedgeNotifications();
      await flushAsyncHandlers();
      expect(wedges()).toHaveLength(1);

      getActiveNotificationServiceMock.mockReturnValue(undefined);
      await service.stop();
    });

    it(`${label}: review-lane ARRIVAL alerts a stalled card into the ${label} review column without waiting for the next sweep`, async () => {
      const { store, service, sendNotification, task, setBoard } = fixture(vocab, { wedgeNotificationSettleMs: 0 });
      await service.start();

      const arrived = {
        ...task({ column: vocab.review }),
        status: null,
        stallReason: { code: "merge-blocker", reason: "the review lane refuses to merge this card: contract tests are red on the branch", observedAt: "2026-09-03T11:55:00.000Z" },
      } as unknown as Task;
      // Production shape (RUFU-180 P0): the hydrated row lives on the board (what getTask returns);
      // the emitted payload is the raw readTaskForMove conversion, which never carries `stallReason`.
      setBoard([arrived]);
      store.emitMoved({ task: { ...arrived, stallReason: undefined } as unknown as Task, from: vocab.wip, to: vocab.review });
      await flushAsyncHandlers();

      expect(sendNotification).toHaveBeenCalledWith(
        "task-wedged",
        expect.objectContaining({ taskId: "FN-9001", metadata: expect.objectContaining({ wedgeReason: "stall:merge-blocker" }) }),
      );
      await service.stop();
    });
  }
});
