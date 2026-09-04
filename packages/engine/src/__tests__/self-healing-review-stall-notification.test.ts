import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

/*
FNXC:TaskWedgeNotifications 2026-09-03-02:39 (RUFU-180):
Symptom harness (B): a review-lane card whose merge refusal left it with null status, no pausedReason
and no error sits in review with NOTHING further ever written to its row, so no task-updated/task-moved
event can ever wake the notifier. The only production path left for that standing condition is this
bounded self-healing sweep, exercised here with NO event at all — driven straight through
`reconcileReviewStallWedgeNotifications()` with a real NotificationService attached (pattern:
`self-healing-pending-wedge-notification.test.ts`).

This file is also the non-quarantined mirror of the sweep behavior the quarantined
`self-healing-pending-wedge-notification.test.ts` covers for pending marks: that file is excluded from
the `engine-default` project by the quarantine ledger, so acceptance for the NEW sweep must live in a
file the merge gate actually runs.
*/
const { getActiveNotificationServiceMock, auditorAuditMock } = vi.hoisted(() => ({
  getActiveNotificationServiceMock: vi.fn(),
  auditorAuditMock: vi.fn(async () => undefined),
}));
vi.mock("../util/notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/notifier.js")>();
  return { ...actual, getActiveNotificationService: getActiveNotificationServiceMock };
});
/*
FNXC:TaskWedgeNotifications 2026-09-03-03:41 (RUFU-180):
`reconcilePendingWedgeNotifications` audits through createRunAuditor; the mirror restart case
inspects those rows, so the factory is intercepted the same way the quarantined
`self-healing-pending-wedge-notification.test.ts` does it. The Step-3 discovery sweep above is
unaffected: `emitBoundedRunAudit` writes the store sink directly (proven by the hostile-sink case).
*/
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return { ...actual, createRunAuditor: vi.fn(() => ({ database: auditorAuditMock })) };
});

import { SelfHealingManager } from "../self-healing.js";
import { NotificationService } from "../notification/notification-service.js";

const GATE_PENDING_REASON = "task has enabled pre-merge workflow steps that never ran";

function stalledTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    column: "in-review",
    status: null,
    paused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [],
    stallReason: {
      code: "pre-merge-gate-pending",
      reason: GATE_PENDING_REASON,
      observedAt: new Date(Date.now() - 45_000).toISOString(),
    },
    ...overrides,
  } as Task;
}

function createHarness(task: Task, settings: Partial<Settings> = {}) {
  let current = task;
  const dispatch = vi.fn(async () => ({ success: true, providerId: "test" }));
  const sendMessageOnce = vi.fn(async () => ({ message: {} as unknown, inserted: true }));
  const recordRunAuditEvent = vi.fn(async () => undefined);
  let episodeSeq = 0;

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      ntfyEnabled: true,
      ntfyTopic: "test",
      ...settings,
    } as Settings)),
    getTask: vi.fn(async () => current),
    listTasks: vi.fn(async () => [current]),
    recordRunAuditEvent,
    claimTaskWedgeNotificationEpisode: vi.fn(async (taskId: string, reasonKey: string | null) => {
      const prior = current.wedgeNotification;
      if (reasonKey === null) {
        if (!prior || prior.status === "resolved") return { claimed: false };
        current = { ...current, wedgeNotification: { ...prior, status: "resolved", transitionedAt: new Date().toISOString() } };
        return { claimed: false };
      }
      if (prior?.status === "active" && prior.reasonKey === reasonKey) return { claimed: false };
      const episodeId = `ep-${++episodeSeq}`;
      current = {
        ...current,
        wedgeNotification: { reasonKey, episodeId, status: "active", transitionedAt: new Date().toISOString() },
      };
      return { claimed: true, episodeId };
    }),
    markTaskWedgeNotificationPending: vi.fn(async (
      taskId: string,
      descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string },
    ) => {
      const since = new Date().toISOString();
      const prior = current.wedgeNotification;
      if (prior?.status === "active" && prior.reasonKey === descriptor.reasonKey) {
        return { since: prior.pending?.since ?? since, armed: false, restamped: false };
      }
      if (prior?.pending?.reasonKey === descriptor.reasonKey) {
        return { since: prior.pending.since, armed: false, restamped: false };
      }
      current = {
        ...current,
        wedgeNotification: prior
          ? { ...prior, pending: { since, ...descriptor } }
          : {
              reasonKey: descriptor.reasonKey,
              episodeId: "",
              status: "resolved",
              transitionedAt: since,
              pending: { since, ...descriptor },
            },
      };
      return { since, armed: true, restamped: prior?.pending != null };
    }),
    clearTaskWedgeNotificationPending: vi.fn(async () => {
      const prior = current.wedgeNotification;
      if (!prior?.pending) return false;
      const { pending: _pending, ...withoutPending } = prior;
      current = { ...current, wedgeNotification: withoutPending };
      return true;
    }),
    on: vi.fn(),
    off: vi.fn(),
  }) as unknown as TaskStore;

  const service = new NotificationService(store as never, {
    messageStore: { on: () => undefined, sendMessageOnce: sendMessageOnce as never } as never,
    wedgeNotificationSettleMs: 1_000,
  });
  service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: dispatch });

  return {
    service,
    store,
    dispatch,
    sendMessageOnce,
    recordRunAuditEvent,
    getTask: () => current,
    manager: () => new SelfHealingManager(store, { rootDir: "/repo" }),
  };
}

describe("reconcile review stall wedge notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveNotificationServiceMock.mockReset();
  });

  it("discovers a standing review-lane stall with no event and announces it exactly once", async () => {
    vi.useFakeTimers();
    const h = createHarness(stalledTask("FN-STAND-GATE"));
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);
    const manager = h.manager();

    // Pass 1 marks the durable hold and arms the settle window; nothing is delivered yet.
    await expect(manager.reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.getTask().wedgeNotification?.pending?.reasonKey).toBe("stall:pre-merge-gate-pending");

    // The settle window elapses; the pending completion reclassifies with the composed authority and delivers.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-STAND-GATE" }));
    expect(h.sendMessageOnce).toHaveBeenCalledTimes(1);
    const mail = (h.sendMessageOnce as unknown as { mock: { calls: Array<[Record<string, unknown>, string]> } }).mock.calls[0]![0];
    expect(mail.metadata).toEqual(expect.objectContaining({ kind: "task-wedge", taskId: "FN-STAND-GATE", wedgeReason: "stall:pre-merge-gate-pending" }));
    expect(typeof mail.content).toBe("string");
    expect(mail.content as string).toContain(GATE_PENDING_REASON);
    expect(mail.content as string).toMatch(/reset the card to todo/i);

    // Repeated passes on the unchanged state must never become a second alert (storm bound).
    await manager.reconcileReviewStallWedgeNotifications();
    await manager.reconcileReviewStallWedgeNotifications();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.sendMessageOnce).toHaveBeenCalledTimes(1);

    await h.service.stop();
    vi.useRealTimers();
  });

  it("audits each candidate with ids, counts, and outcomes only", async () => {
    const h = createHarness(stalledTask("FN-STAND-AUDIT"));
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await h.manager().reconcileReviewStallWedgeNotifications();

    expect(h.recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const row = (h.recordRunAuditEvent as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]![0];
    expect(row).toEqual(expect.objectContaining({
      agentId: "self-healing",
      mutationType: "task:reconcile-review-stall-notification",
      target: "FN-STAND-AUDIT",
    }));
    expect(row.metadata).toEqual(expect.objectContaining({
      taskId: "FN-STAND-AUDIT",
      reasonKey: "stall:pre-merge-gate-pending",
    }));
    expect(typeof row.metadata.outcome).toBe("string");
    expect(typeof row.metadata.stallAgeMs).toBe("number");
    // The blocker sentence lives on the task row and the mailbox message, never in run-audit metadata.
    expect(JSON.stringify(row.metadata)).not.toContain(GATE_PENDING_REASON);
    await h.service.stop();
  });

  it("never selects a dependency-blocker card", async () => {
    const h = createHarness(stalledTask("FN-STAND-DEP", {
      column: "todo",
      status: "blocked" as Task["status"],
      stallReason: { code: "dependency-blocker", reason: "waiting on FN-BLOCKER", observedAt: new Date().toISOString() },
    }));
    const spy = vi.spyOn(h.service, "notifyTaskStallWedge");
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.sendMessageOnce).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
    await h.service.stop();
  });

  it("delivers nothing for a paused review card that still carries an alertable stall code", async () => {
    // The sweep selects by code alone, but the paused/awaiting-input world owns its own announcement:
    // the service must suppress and leave NO pending hold behind.
    const h = createHarness(stalledTask("FN-STAND-PAUSED", { paused: true }));
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.sendMessageOnce).not.toHaveBeenCalled();
    expect(h.store.markTaskWedgeNotificationPending).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-STAND-PAUSED", outcome: "unavailable" }),
    }));
    await h.service.stop();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-09-03-08:18 (RUFU-180 code-review):
  Enumerated symptom assertion — "the same card with a live recovery owner emits nothing at all".
  Recovery ownership is NOT a stall-derivation suppression: `deriveTaskStallReason` never reads
  `nextRecoveryAt`/`recoveryRetryCount`, so the sweep legitimately selects the row and the withhold
  belongs to `NotificationService`'s `describeTaskRecoveryOwner` gate. Non-vacuous control: the first
  case in this file delivers for the identical row WITHOUT these two fields, so silence here can only
  come from the recovery-owner gate, and the service spy proves the candidate was actually classified
  rather than filtered out of the sweep.
  */
  it("delivers nothing for a stalled review card a live recovery owner already owns", async () => {
    const h = createHarness(stalledTask("FN-STAND-RECOVERY-OWNER", {
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const spy = vi.spyOn(h.service, "notifyTaskStallWedge");
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.sendMessageOnce).not.toHaveBeenCalled();
    expect(h.store.markTaskWedgeNotificationPending).not.toHaveBeenCalled();
    expect(h.getTask().wedgeNotification).toBeUndefined();
    expect(h.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-STAND-RECOVERY-OWNER", outcome: "unavailable" }),
    }));
    await h.service.stop();
  });

  it("still completes and delivers when the audit sink rejects (FN-9175 hostile sink)", async () => {
    vi.useFakeTimers();
    const h = createHarness(stalledTask("FN-STAND-SINK-THROWS"));
    h.store.recordRunAuditEvent = vi.fn(async () => {
      throw new Error("audit sink down");
    });
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.service.stop();
    vi.useRealTimers();
  });

  it("still completes and delivers when the store has no audit sink at all", async () => {
    vi.useFakeTimers();
    const h = createHarness(stalledTask("FN-STAND-SINK-ABSENT"));
    (h.store as { recordRunAuditEvent?: unknown }).recordRunAuditEvent = undefined;
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.service.stop();
    vi.useRealTimers();
  });

  it("defers the candidate and still audits when no notification service is active", async () => {
    getActiveNotificationServiceMock.mockReturnValue(undefined);
    const h = createHarness(stalledTask("FN-STAND-DEFERRED"));

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-STAND-DEFERRED", outcome: "deferred" }),
    }));
  });

  it("records a failed outcome without rejecting when the service throws", async () => {
    getActiveNotificationServiceMock.mockReturnValue({
      notifyTaskStallWedge: vi.fn(async () => {
        throw new Error("service unavailable");
      }),
    });
    const h = createHarness(stalledTask("FN-STAND-THROW"));

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(h.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-STAND-THROW", outcome: "failed" }),
    }));
  });

  it("selects candidates by the stall code alone, never by a review-column literal", async () => {
    // A workflow-renamed review lane: the authority already resolved lane membership into the code,
    // so the sweep must announce it without ever reading the column name.
    const h = createHarness(stalledTask("FN-STAND-RENAMED", { column: "waiting-on-human" as Task["column"] }));
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    expect(h.getTask().wedgeNotification?.pending?.reasonKey).toBe("stall:pre-merge-gate-pending");
    await h.service.stop();
  });

  it("skips a clean review card that carries no stall reason", async () => {
    const clean = stalledTask("FN-STAND-CLEAN");
    delete (clean as { stallReason?: unknown }).stallReason;
    const h = createHarness(clean);
    const spy = vi.spyOn(h.service, "notifyTaskStallWedge");
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
    await h.service.stop();
  });

  it("announces a held-human-review stall exactly once ever across two sweep passes over a timer horizon", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-03:17 (RUFU-180):
    The data-state matrix's loudest row: a project with autoMerge Off hydrates held-human-review on
    EVERY such card, so a per-tick announcement would storm the board. Both collapse mechanisms —
    the same-key pending mark and the active-episode claim — must hold across passes: pass one
    announces, pass two (after the settle timer fired and a 10-minute horizon) must add nothing.
    ""exactly one alert ever"" is deliberately asserted via counts, not by pinning the second
    pass's outcome enum, which belongs to the service's suppression contract.
    */
    vi.useFakeTimers();
    const held = stalledTask("FN-STAND-HELD", {
      stallReason: { code: "held-human-review", reason: "auto-merge is held for a human decision while the project keeps review terminal-until-merged", observedAt: new Date().toISOString() },
    });
    const h = createHarness(held);
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(h.manager().reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.sendMessageOnce).toHaveBeenCalledTimes(1);
    const row = await h.store.getTask("FN-STAND-HELD");
    expect(row?.wedgeNotification).toMatchObject({ status: "active", reasonKey: "stall:held-human-review" });
    expect(row?.wedgeNotification?.pending).toBeUndefined();
    await h.service.stop();
    vi.useRealTimers();
  });

  it("mirrors the quarantined restart lifecycle: a persisted stall-key pending hold survives the sweep as a restamped hold, then delivers exactly once", async () => {
    /*
    FNXC:TaskWedgeNotifications 2026-09-03-03:41 (RUFU-180):
    Non-quarantined mirror of the acceptance case added to
    `self-healing-pending-wedge-notification.test.ts` (file excluded by the quarantine ledger, so
    this lane must carry the same guarantee): a review-lane card that persisted its pending marker
    with a `stall:` reasonKey before a restart must be RE-CLASSIFIED by the composed classifier in
    runPendingWedgeCompletion — the legacy-only answer for a null-status row is null, which cleared
    the hold and silently dropped the operator's only alert. Hold kept (rearmed), delivered once
    after the horizon, no other stall-typed audit event from this sweep.
    */
    auditorAuditMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const since = new Date(Date.now() - 5_000).toISOString();
    let task = {
      id: "FN-WEDGE-STALL-RESTART",
      title: "FN-WEDGE-STALL-RESTART",
      description: "",
      column: "in-review",
      status: null,
      paused: false,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: since,
      updatedAt: since,
      stallReason: { code: "merge-blocker", reason: "the review lane refuses to merge this card: contract tests are red on the branch", observedAt: since },
      wedgeNotification: {
        reasonKey: "stall:merge-blocker",
        episodeId: "",
        status: "resolved",
        transitionedAt: since,
        pending: {
          since,
          reasonKey: "stall:merge-blocker",
          source: "auto",
          reason: "the review lane refuses to merge this card: contract tests are red on the branch",
          action: "Fix the named merge blocker on the branch and let the review lane re-attempt the merge.",
        },
      },
    } as unknown as Task;
    const dispatch = vi.fn(async () => ({ success: true, providerId: "test" }));
    const sendMessageOnce = vi.fn(async () => ({ message: {} as unknown, inserted: true }));
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ntfyEnabled: true, ntfyTopic: "test", wedgeNotificationSettleMs: 1_000, maintenanceIntervalMs: 1_000 } as Settings)),
      getTask: vi.fn(async () => task),
      listTasks: vi.fn(async () => [task]),
      markTaskWedgeNotificationPending: vi.fn(async (_id: string, descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string }) => {
        const restamped = new Date().toISOString();
        task = { ...task, wedgeNotification: { ...task.wedgeNotification!, pending: { since: restamped, ...descriptor } } };
        return { since: restamped, armed: true, restamped: true };
      }),
      clearTaskWedgeNotificationPending: vi.fn(async () => {
        const { pending: _pending, ...wedge } = task.wedgeNotification!;
        task = { ...task, wedgeNotification: wedge };
        return true;
      }),
      claimTaskWedgeNotificationEpisode: vi.fn(async (taskId: string, reasonKey: string | null) => {
        if (reasonKey === null) return { claimed: false };
        task = { ...task, wedgeNotification: { reasonKey, episodeId: `${taskId}:${reasonKey}`, status: "active", transitionedAt: new Date().toISOString() } };
        return { claimed: true, episodeId: `${taskId}:${reasonKey}` };
      }),
      on: vi.fn(),
      off: vi.fn(),
    }) as unknown as TaskStore;
    const service = new NotificationService(store as never, {
      messageStore: { on: () => undefined, sendMessageOnce: sendMessageOnce as never } as never,
      wedgeNotificationSettleMs: 1_000,
    });
    service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: dispatch });
    await service.start();
    getActiveNotificationServiceMock.mockReturnValue(service);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcilePendingWedgeNotifications()).resolves.toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(task.wedgeNotification?.pending).toBeDefined();
    expect(auditorAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-pending-wedge-notification",
      metadata: expect.objectContaining({ taskId: "FN-WEDGE-STALL-RESTART", reasonKey: "stall:merge-blocker", outcome: "rearmed" }),
    }));

    await vi.advanceTimersByTimeAsync(1_001);
    await manager.reconcilePendingWedgeNotifications();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(task.wedgeNotification?.pending).toBeUndefined();
    expect(auditorAuditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "delivered" }) }));

    const auditTypes = (auditorAuditMock.mock.calls as unknown as Array<[{ type?: string }]>).map(([event]) => event.type);
    expect(auditTypes.filter((type) => String(type).includes("stall"))).toEqual([]);
    await service.stop();
    vi.useRealTimers();
  });
});
