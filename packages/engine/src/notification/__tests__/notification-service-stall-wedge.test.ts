import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";

/*
FNXC:NotificationTestHarness 2026-07-30-23:50 (inherited from notification-service.test.ts):
`debug` MUST be in this mock — production moved suppression traces from `schedulerLog.log` to
`schedulerLog.debug`, and a service whose start() throws asserts nothing.
*/
vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/*
FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
Symptom harness for the review-lane stall population: a merge refusal writes no `status`, no
`pausedReason` and no `error`, so the legacy status-keyed wedge classifier bails on
`task.status !== "failed"` and the card sits in review announcing nothing. Every case below drives a
PRODUCTION ENTRY POINT by EMITTING a store event (the service subscribes to task-moved / task-updated;
calling a private handler would prove nothing) and asserts one wedged-task dispatch plus one mailbox row
carrying the canonical blocker sentence and an action naming the operator's next step.

The store harness is copied from `notification-service.test.ts` (the file whose fake store already owns
a real on/off/emit emitter) and extended with the store's wedge CAS trio — the episode claim, the pending
mark, and the pending clear — because "one message per episode" is a CAS property, not a service
property: a fake store without them would assert a collapse that production does not have.
*/
type Listener = (...args: any[]) => void | Promise<void>;
function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const tasks = new Map<string, Task>();
  let currentSettings: Settings = {
    ntfyEnabled: true,
    ntfyTopic: "topic",
    ...settings,
  } as Settings;

  const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    on(event: string, listener: Listener) {
      const bucket = getBucket(event);
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off(event: string, listener: Listener) {
      getBucket(event).delete(listener);
    },
    emit(event: string, payload: unknown) {
      for (const listener of getBucket(event)) {
        void listener(payload);
      }
    },
    getSettings: vi.fn(async () => currentSettings),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    setTask(task: Task) {
      tasks.set(task.id, task);
    },
    setSettings(next: Partial<Settings>) {
      currentSettings = { ...currentSettings, ...next } as Settings;
    },
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "Task title",
    description: "Task desc",
    status: "todo",
    column: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    ...overrides,
  } as Task;
}
describe("NotificationService review-lane stall wedges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createStallStore(settings: Partial<Settings> = {}) {
    const store = createStore(settings);
    let episodeSeq = 0;
    const claimTaskWedgeNotificationEpisode = vi.fn(async (taskId: string, reasonKey: string | null) => {
      const current = await store.getTask(taskId);
      if (!current) return { claimed: false };
      const prior = current.wedgeNotification;
      if (reasonKey === null) {
        if (!prior || prior.status === "resolved") return { claimed: false };
        store.setTask({ ...current, wedgeNotification: { ...prior, status: "resolved", transitionedAt: new Date().toISOString() } });
        return { claimed: false };
      }
      if (prior?.status === "active" && prior.reasonKey === reasonKey) return { claimed: false };
      const now = Date.now();
      const lastNotifiedAtByReason = Object.fromEntries(Object.entries(prior?.lastNotifiedAtByReason ?? {}).filter(([, stamp]) => {
        const notifiedAt = Date.parse(stamp as string);
        return Number.isFinite(notifiedAt) && now - notifiedAt < 6 * 60 * 60 * 1000;
      }));
      const episodeId = `ep-${++episodeSeq}`;
      const suppressed = reasonKey in lastNotifiedAtByReason;
      if (!suppressed) lastNotifiedAtByReason[reasonKey] = new Date(now).toISOString();
      store.setTask({
        ...current,
        wedgeNotification: {
          reasonKey,
          episodeId,
          status: "active",
          transitionedAt: new Date(now).toISOString(),
          ...(Object.keys(lastNotifiedAtByReason).length > 0 ? { lastNotifiedAtByReason } : {}),
        },
      });
      return suppressed ? { claimed: false } : { episodeId, claimed: true };
    });
    const markTaskWedgeNotificationPending = vi.fn(async (
      taskId: string,
      descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string; gate?: string },
      options?: { staleAfterMs?: number },
    ) => {
      const now = new Date().toISOString();
      const current = await store.getTask(taskId);
      if (!current) return { since: now, armed: false, restamped: false };
      const prior = current.wedgeNotification;
      const pending = prior?.pending;
      if (prior?.status === "active" && prior.reasonKey === descriptor.reasonKey) {
        return { since: pending?.since ?? now, armed: false, restamped: false };
      }
      const pendingSince = pending ? Date.parse(pending.since) : Number.NaN;
      const stale = pending?.reasonKey === descriptor.reasonKey
        && typeof options?.staleAfterMs === "number"
        && Number.isFinite(options.staleAfterMs)
        && Number.isFinite(pendingSince)
        && Date.now() - pendingSince > options.staleAfterMs;
      if (pending?.reasonKey === descriptor.reasonKey && !stale) {
        return { since: pending.since, armed: false, restamped: false };
      }
      store.setTask({
        ...current,
        wedgeNotification: prior
          ? { ...prior, pending: { since: now, ...descriptor } }
          : { reasonKey: descriptor.reasonKey, episodeId: "", status: "resolved", transitionedAt: now, pending: { since: now, ...descriptor } },
      });
      return { since: now, armed: true, restamped: pending != null };
    });
    const clearTaskWedgeNotificationPending = vi.fn(async (taskId: string, reasonKey?: string) => {
      const current = await store.getTask(taskId);
      const prior = current?.wedgeNotification;
      if (!current || !prior?.pending || (reasonKey !== undefined && prior.pending.reasonKey !== reasonKey)) return false;
      const { pending: _pending, ...withoutPending } = prior;
      store.setTask({ ...current, wedgeNotification: withoutPending });
      return true;
    });
    Object.assign(store, {
      claimTaskWedgeNotificationEpisode,
      markTaskWedgeNotificationPending,
      clearTaskWedgeNotificationPending,
      recordRunAuditEvent: vi.fn(async () => undefined),
    });
    return store;
  }

  const MERGE_BLOCKER_REASON = "task has a pre-merge approval recorded against different content";
  const GATE_PENDING_REASON = "task has enabled pre-merge workflow steps that never ran";

  function reviewStall(overrides: Partial<Task> = {}): Task {
    return task({
      id: "FN-review-stall",
      column: "in-review",
      status: null,
      stallReason: { code: "merge-blocker", reason: MERGE_BLOCKER_REASON, observedAt: new Date().toISOString() },
      ...overrides,
    } as Task);
  }

  async function stallSetup(options: { wedgeNotificationSettleMs?: number; settings?: Partial<Settings> } = {}) {
    const store = createStallStore(options.settings ?? {});
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
    const service = new NotificationService(store as any, {
      messageStore: { on: () => undefined, sendMessageOnce } as any,
      wedgeNotificationSettleMs: options.wedgeNotificationSettleMs ?? 0,
    });
    service.registerProvider({
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    });
    await service.start();
    return { store, service, sendNotification, sendMessageOnce };
  }

  it("announces a review-lane merge refusal once through the provider and mailbox channels", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall();
    store.setTask(stalled);

    store.emit("task:updated", stalled);

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendMessageOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(MERGE_BLOCKER_REASON),
        metadata: expect.objectContaining({ kind: "task-wedge", taskId: "FN-review-stall", wedgeReason: "stall:merge-blocker" }),
      }),
      expect.stringMatching(/^task-wedge:.+/),
    );
    const delivered = (sendMessageOnce.mock.calls as unknown as Array<[{ content: string }]>)[0][0];
    expect(delivered.content).toContain("Open the card and clear the blocker");
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({
      taskId: "FN-review-stall",
      metadata: expect.objectContaining({ wedgeReason: "stall:merge-blocker" }),
    })));
    await service.stop();
  });

  it("holds a sustained review-lane refusal to exactly one alert across repeated updates", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall();
    store.setTask(stalled);

    for (let update = 0; update < 4; update += 1) {
      store.emit("task:updated", stalled);
      await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect((await store.getTask("FN-review-stall"))?.wedgeNotification?.status).toBe("active");
    await service.stop();
  });

  it("announces a pre-merge gate that never ran with the run-the-gate action", async () => {
    const { store, service, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall({
      id: "FN-gate-never-ran",
      stallReason: { code: "pre-merge-gate-pending", reason: GATE_PENDING_REASON, observedAt: new Date().toISOString() },
    });
    store.setTask(stalled);

    store.emit("task:updated", stalled);

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    const delivered = (sendMessageOnce.mock.calls as unknown as Array<[{ content: string }]>)[0][0];
    expect(delivered.content).toContain(GATE_PENDING_REASON);
    expect(delivered.content).toContain("Run the pending review gate from the card");
    await service.stop();
  });

  it("resolves the active stall episode once the card visibly moves on", async () => {
    const { store, service, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall();
    store.setTask(stalled);
    store.emit("task:updated", stalled);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    // Derive the advance from the LIVE row: the delivery wrote durable episode evidence there, and
    // a snapshot-derived fixture would silently erase the very state under test.
    const delivered = (await store.getTask("FN-review-stall"))!;
    expect(delivered.wedgeNotification?.status).toBe("active");
    const merged = { ...delivered, column: "done", status: "merged" } as Task;
    store.setTask(merged);
    store.emit("task:updated", merged);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await store.getTask("FN-review-stall"))?.wedgeNotification?.status).toBe("resolved");
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("clears a held stall hold without delivering when the operator resets the card to todo", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup({ wedgeNotificationSettleMs: 60_000 });
    const stalled = reviewStall();
    store.setTask(stalled);

    store.emit("task:updated", stalled);
    await vi.waitFor(async () => expect((await store.getTask("FN-review-stall"))?.wedgeNotification?.pending?.reasonKey).toBe("stall:merge-blocker"));

    // Keep the durable hold evidence intact and change ONLY the operator's reset, so clearing it
    // is proof of the lifecycle resolution rather than of a fixture that dropped the marker.
    const held = (await store.getTask("FN-review-stall"))!;
    const reset = { ...held, column: "todo", status: "queued", stallReason: undefined } as Task;
    store.setTask(reset);
    store.emit("task:updated", reset);
    await vi.advanceTimersByTimeAsync(60_000);

    const settled = await store.getTask("FN-review-stall");
    expect(settled?.wedgeNotification?.pending).toBeUndefined();
    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    await service.stop();
  });

  it("announces a stalled card the moment it ARRIVES in review, with the push channel off", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
    The reported symptom is arrival silence: entry into review is a `task:moved`, and the review branch
    used to end at the review notification, so the wedge path was never reached and the card sat silent
    until someone opened the board. The enqueue is placed before the `notificationsEnabled` return, so
    the store here has the push lane OFF (`ntfyEnabled: false`, no provider registered) and the mailbox
    is the only channel — asserting the mailbox alert proves the ordering, not just the intent.

    FNXC:TaskWedgeNotifications 2026-09-03-06:10 (RUFU-180 code-review P0):
    This case only proves production reachability while the emitted payload stays production-shaped
    (no `stallReason` — see the hydration note on the emit below) and the hydrated field lives on the
    store row, which is where `maybeNotifyTaskWedge`'s live re-read actually looks.
    */
    const store = createStallStore({ ntfyEnabled: false });
    const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any, {
      messageStore: { on: () => undefined, sendMessageOnce } as any,
      wedgeNotificationSettleMs: 0,
    });
    await service.start();

    const stalled = reviewStall({ column: "in-progress" });
    store.setTask(stalled);

    // The move itself carries the stalled card into the review lane; nothing writes the row afterwards.
    //
    // FNXC:TaskWedgeNotifications 2026-09-03-06:10 (RUFU-180 code-review P0):
    // The payload is production-shaped WITHOUT `stallReason`: the production `task:moved` emitter
    // reads the moving row through `store.readTaskForMove` (moves.ts), which converts a raw DB row
    // (`rowToTask(pgRowToTaskRow(...))`) and NEVER runs stall hydration — only `getTask`/`listTasks`
    // hydrate (reads.ts). The hydrated copy lives on the store row exactly where production's live
    // re-read inside `maybeNotifyTaskWedge` finds it. An earlier revision injected `stallReason`
    // into this payload and gated the trigger on it, which made the test pass while the production
    // trigger was dead; asserting delivery from the store row is what actually proves reachability.
    const movedPayload = { ...stalled } as Task;
    delete (movedPayload as { stallReason?: unknown }).stallReason;
    store.emit("task:moved", { task: movedPayload, from: "in-progress", to: "in-review" });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendMessageOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ kind: "task-wedge", taskId: "FN-review-stall", wedgeReason: "stall:merge-blocker" }),
      }),
      expect.stringMatching(/^task-wedge:.+/),
    );
    // The push lane is off, so no provider event may have been attempted for this arrival.
    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not announce an arrival that carries no stall reason", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup();
    const arriving = task({ id: "FN-clean-arrival", column: "in-progress" });
    store.setTask(arriving);

    store.emit("task:moved", { task: arriving, from: "in-progress", to: "in-review" });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledWith("in-review", expect.objectContaining({ taskId: "FN-clean-arrival" })));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    await service.stop();
  });

  it("collapses a burst of moves and updates on the same unchanged stalled row into ONE message", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-04:58 (RUFU-180):
    Loop bound for the widened discovery: the wedge CAS writes must never fan into a task-updated
    feedback loop, and a re-dispatch that re-observes the SAME unchanged stalled row (engine restart,
    merge re-attempt, repeated board touches) must not repeat the announcement. This fake store's
    mark/claim do not emit events, so the invariant is asserted at the delivery level: an interleaved
    burst of task-moved-into-review and task-updated across a timer horizon yields exactly one
    provider dispatch and one mailbox row.
    */
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall();
    store.setTask(stalled);

    // FNXC:TaskWedgeNotifications 2026-09-03-06:10 (RUFU-180 code-review P0): production-shaped
    // moved payload — no `stallReason` (the move emitter never hydrates it; see the arrival case
    // above). The store row keeps the hydrated field, so every collapse here is proven against
    // the same live-read the production trigger performs, not against a payload field production
    // never sends.
    const movedPayload = { ...stalled } as Task;
    delete (movedPayload as { stallReason?: unknown }).stallReason;

    for (let burst = 0; burst < 5; burst += 1) {
      store.emit("task:moved", { task: movedPayload, from: "in-progress", to: "in-review" });
      store.emit("task:updated", stalled);
      await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    // The wedge lane alone proves the loop bound; the one extra provider call is the pre-existing
    // in-review arrival notification, which its own dedupe likewise holds to a single send.
    const wedgeDispatches = (sendNotification.mock.calls as unknown as Array<[string]>).filter(([event]) => event === "task-wedged");
    expect(wedgeDispatches).toHaveLength(1);
    await service.stop();
  });

  it("never invents an alert for a clean review card, a dependency-blocker, or a progressing card", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await stallSetup();
    const clean = reviewStall({ id: "FN-clean", stallReason: undefined } as Partial<Task>);
    const dependency = reviewStall({
      id: "FN-dependency",
      column: "todo",
      stallReason: { code: "dependency-blocker", reason: "task is waiting on 1 unmet dependency", observedAt: new Date().toISOString() },
    });
    const progressing = reviewStall({ id: "FN-progressing", status: "reviewing" });
    for (const card of [clean, dependency, progressing]) {
      store.setTask(card);
      store.emit("task:updated", card);
    }
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    await service.stop();
  });

  it("keeps the terminal-failed descriptor byte-identical for a failed card that also carries a stall reason", async () => {
    /*
    Auto-recovery stays ON in production for a generic terminal failure, so its recovery budget
    withholds the first alert. Turn the lane off to ask the question this case is about: when a card
    carries BOTH the legacy failed markers and a stall reason, which descriptor reaches the operator.
    */
    const { store, service, sendMessageOnce } = await stallSetup({ settings: { autoRecovery: { mode: "off" } } });
    const failedStall = reviewStall({
      id: "FN-failed-stall",
      status: "failed",
      error: "opaque terminal failure",
      mergeRetries: 5,
    } as Partial<Task>);
    store.setTask(failedStall);

    store.emit("task:updated", failedStall);

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    const delivered = (sendMessageOnce.mock.calls as unknown as Array<[{ content: string }]>)[0][0];
    expect(delivered.content).toContain("The task entered a terminal failed state and needs operator intervention.");
    expect(delivered.content).not.toContain(MERGE_BLOCKER_REASON);
    expect(sendMessageOnce).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^task-wedge:.+/));
    await service.stop();
  });

  it("opens a second episode under store CAS parity when the reason key transitions on the same unmerged card", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-03:17 (RUFU-180):
    Two-key episode semantics is owned by the shared wedge CAS trio, not by this suite: the real
    store grants a new episode only when the incoming reasonKey is absent from the per-reason
    cooldown map, and the fake store above mirrors that shape verbatim. merge-blocker ->
    held-human-review on the same null-status review card is a real operator-visible state change
    (the refusal became a human decision), so a NEW alert must fire under the new key; re-observing
    the SAME new key must then collapse to nothing — a hand-rolled rule in either direction here
    would drift from store.ts:1978.
    */
    const { store, service, sendMessageOnce } = await stallSetup();
    const stalled = reviewStall();
    store.setTask(stalled);
    store.emit("task:updated", stalled);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    const firstEpisode = (await store.getTask("FN-review-stall"))!;
    expect(firstEpisode.wedgeNotification?.reasonKey).toBe("stall:merge-blocker");

    const transitioned = {
      ...firstEpisode,
      stallReason: { code: "held-human-review", reason: "the review lane is waiting on a human decision before this card can merge", observedAt: new Date().toISOString() },
    } as Task;
    store.setTask(transitioned);
    store.emit("task:updated", transitioned);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));

    const second = (sendMessageOnce.mock.calls as unknown as Array<[{ metadata: { wedgeReason?: string } }]>) [1][0];
    expect(second.metadata.wedgeReason).toBe("stall:held-human-review");
    expect((await store.getTask("FN-review-stall"))?.wedgeNotification?.reasonKey).toBe("stall:held-human-review");

    // Re-observing the same new key collapses: the active same-key episode refuses a new claim.
    store.emit("task:updated", transitioned);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessageOnce).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("announces a stall under test mode too, because the wedge channel never rides a model lane", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-03:17 (RUFU-180):
    Test mode forces AI MODEL lanes to mock/scripted; wedge notification is a deterministic
    mailbox+provider channel. Asserting delivery under `testMode: true` pins that no wedge behavior
    depends on the model setting — the settings-interaction row of the data-state matrix.
    */
    const { store, service, sendMessageOnce } = await stallSetup({ settings: { testMode: true } });
    const stalled = reviewStall();
    store.setTask(stalled);
    store.emit("task:updated", stalled);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendMessageOnce).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ kind: "task-wedge", wedgeReason: "stall:merge-blocker" }) }),
      expect.stringMatching(/^task-wedge:.+/),
    );
    await service.stop();
  });
});
