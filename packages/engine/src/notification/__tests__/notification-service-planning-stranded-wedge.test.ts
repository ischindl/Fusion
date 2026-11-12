import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task } from "@fusion/core";

import { NotificationService } from "../notification-service.js";

/*
FNXC:PlanningStrandedRetry 2026-11-10-23:22 (RUFU-575):
A descriptor is not an alert. The wedge classifier returning a named descriptor for a stranded planning
card proved nothing on its own: between `task:updated` and the operator's inbox sit the service's own
"This card has progressed" re-checks, and the one that actually decides is the pending revalidation in
`runPendingWedgeCompletion` — which production ALWAYS runs, because `wedgeNotificationSettleMs` defaults
to 300000 (5 min, `packages/core/src/config/settings-schema.ts`) while every existing wedge suite passes
`0` explicitly and therefore drives the immediate branch instead. That revalidation cleared the armed
episode two ways for this population: the card stands in `todo`, which is a hold-role lane, and its
status is a non-failed string. Both legs fire for a card that has demonstrably gone nowhere.

So this file drives the PRODUCTION settle window (300000, the schema default) and asserts the message
actually reaches the mailbox, which is the delivery half of the acceptance the classifier tests cannot
speak to. The store fake is the one `notification-service-stall-wedge.test.ts` documents as required:
the episode CAS trio, because "one message per episode" is a store property, and a fake without it would
assert a collapse production does not have.

The must-stay-green neighbour for this narrowing is
`notification-service-stall-wedge.test.ts > "clears a held stall hold without delivering when the
operator resets the card to todo"` — a `queued` card in `todo` whose reset must STILL clear, because it
carries no planning-exhaustion evidence. That case is the reason this narrowing keys on the row's own
evidence and never on the lane or the status word.
*/

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** The production default settle window (`wedgeNotificationSettleMs` in the settings schema). */
const PRODUCTION_SETTLE_MS = 300_000;

/** The verbatim sentence SANE-282 / SANE-524 carry. */
const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";

type Listener = (...args: any[]) => void | Promise<void>;

function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const tasks = new Map<string, Task>();
  let currentSettings = { ntfyEnabled: true, ntfyTopic: "topic", ...settings } as Settings;
  const bucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    on(event: string, listener: Listener) {
      const set = bucket(event);
      set.add(listener);
      listeners.set(event, set);
    },
    off(event: string, listener: Listener) {
      bucket(event).delete(listener);
    },
    emit(event: string, payload: unknown) {
      for (const listener of bucket(event)) void listener(payload);
    },
    getSettings: vi.fn(async () => currentSettings),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    setTask(next: Task) {
      tasks.set(next.id, next);
    },
  };
}

/**
 * The store's wedge CAS trio (claim / mark-pending / clear-pending), copied from
 * notification-service-stall-wedge.test.ts for the reason stated in that file's note.
 */
function createCasStore(settings: Partial<Settings> = {}) {
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

function strandedPlanningTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-575-DELIVERY",
    title: "Card stranded by an exhausted planning run",
    description: "Task desc",
    column: "todo",
    status: "queued",
    error: SPEC_TIMEOUT_ERROR,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    ...overrides,
  } as Task;
}

/** The first mailbox row the service tried to write, typed for the two fields this file asserts. */
interface MailboxMessage {
  content: string;
  metadata: Record<string, unknown>;
}

function firstMailboxMessage(send: ReturnType<typeof vi.fn>): MailboxMessage {
  const calls = send.mock.calls as unknown as Array<[MailboxMessage]>;
  return calls[0][0];
}

async function setup(options: { wedgeNotificationSettleMs?: number } = {}) {
  const store = createCasStore();
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
  const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, {
    messageStore: { on: () => undefined, sendMessageOnce } as any,
    wedgeNotificationSettleMs: options.wedgeNotificationSettleMs ?? PRODUCTION_SETTLE_MS,
  });
  service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
  await service.start();
  return { store, service, sendNotification, sendMessageOnce };
}

describe("NotificationService delivers the planning-exhaustion wedge through the production settle window (RUFU-575)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("arms the pending episode for a `queued` planning-exhausted card", async () => {
    const { store, service, sendMessageOnce } = await setup();
    const stranded = strandedPlanningTask();
    store.setTask(stranded);

    store.emit("task:updated", stranded);
    await vi.waitFor(async () => {
      expect((await store.getTask("FN-575-DELIVERY"))?.wedgeNotification?.pending?.reasonKey).toBe("planning-spec-exhausted");
    });
    // Nothing is delivered before the settle window elapses — the wait is the point of the window.
    expect(sendMessageOnce).not.toHaveBeenCalled();
    await service.stop();
  });

  it("delivers exactly one alert once the production settle window elapses on an unmoved card", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await setup();
    const stranded = strandedPlanningTask();
    store.setTask(stranded);

    store.emit("task:updated", stranded);
    await vi.advanceTimersByTimeAsync(PRODUCTION_SETTLE_MS + 1_000);

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    const delivered = firstMailboxMessage(sendMessageOnce);
    expect(delivered.metadata).toMatchObject({ kind: "task-wedge", taskId: "FN-575-DELIVERY", wedgeReason: "planning-spec-exhausted" });
    expect(delivered.content).toMatch(/planning run exhausted/i);
    // The action sentence the operator reads must name the verb that works, not "inspect the error".
    expect(delivered.content).toMatch(/Retry/);
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({
      taskId: "FN-575-DELIVERY",
      metadata: expect.objectContaining({ wedgeReason: "planning-spec-exhausted" }),
    })));

    const settled = await store.getTask("FN-575-DELIVERY");
    expect(settled?.wedgeNotification?.status).toBe("active");
    expect(settled?.wedgeNotification?.pending).toBeUndefined();
    await service.stop();
  });

  it("holds a sustained stranded card to ONE alert across repeated updates and further windows", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await setup();
    const stranded = strandedPlanningTask();
    store.setTask(stranded);

    store.emit("task:updated", stranded);
    await vi.advanceTimersByTimeAsync(PRODUCTION_SETTLE_MS + 1_000);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    for (let update = 0; update < 3; update += 1) {
      // The live row keeps drifting between the incident statuses; the episode identity must not.
      const live = (await store.getTask("FN-575-DELIVERY"))!;
      const drifted = { ...live, status: update % 2 === 0 ? "needs-replan" : "queued" } as Task;
      store.setTask(drifted);
      store.emit("task:updated", drifted);
      await vi.advanceTimersByTimeAsync(PRODUCTION_SETTLE_MS + 1_000);
    }

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("delivers nothing for a `queued` card with no exhaustion evidence — the scheduler's own stamp", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await setup();
    // The capacity throttle this task's own card logged: progressing, and correctly silent.
    const throttled = strandedPlanningTask({ id: "FN-575-THROTTLED", error: "maxConcurrent capacity exhausted: used=12/12" });
    store.setTask(throttled);

    store.emit("task:updated", throttled);
    await vi.advanceTimersByTimeAsync(PRODUCTION_SETTLE_MS * 2);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    expect((await store.getTask("FN-575-THROTTLED"))?.wedgeNotification).toBeUndefined();
    await service.stop();
  });

  it("delivers nothing while a scheduled recovery owns the next attempt", async () => {
    const { store, service, sendNotification, sendMessageOnce } = await setup();
    const owned = strandedPlanningTask({ id: "FN-575-OWNED", nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(), recoveryRetryCount: 1 });
    store.setTask(owned);

    store.emit("task:updated", owned);
    await vi.advanceTimersByTimeAsync(PRODUCTION_SETTLE_MS * 2);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    await service.stop();
  });
});
