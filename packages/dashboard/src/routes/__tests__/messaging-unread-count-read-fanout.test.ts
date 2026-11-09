// @vitest-environment node

/*
FNXC:MailboxBadgeReadFanout 2026-11-09-14:52 (RUFU-907):
`GET /api/messages/unread-count` answers 119 bytes. Measured on production (dashboard pid up 1 h 02 m,
load 19-45, process pinned at 90-113 % CPU) it took a 1,56 s median over 5 rounds (min 1,14 / max 2,60)
against 0,07 s for an authenticated in-memory endpoint and a 51 ms process-wide request p50 — so the
payload is not the cost, the number of serially-awaited PostgreSQL round trips is. The route awaited
`getMailbox`, then the pending-approval read, then `getDashboardInboxCategoryCounts`, one after
another; each await re-enters the same saturated pool and event loop.

These tests assert CALL COUNTS AND DISPATCH ORDER ON THE SEAM, never wall time:
- each aggregate reader runs exactly once per request (the fan-out must not duplicate work);
- every reader is dispatched before any of them settles (proof they are concurrent, not sequential);
- the response body is the same shape the serial version produced.
*/

import express from "express";
import { DASHBOARD_USER_ID, type DashboardInboxCategory, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerMessagingScriptRoutes } from "../register-messaging-scripts.js";
import type { ApiRoutesContext } from "../types.js";

const categoryCounts: Record<DashboardInboxCategory, number> = {
  message: 4,
  recommendation: 2,
  artifact: 1,
};

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Builds the messaging router over a MessageStore whose two aggregate readers are gated: each call
 * records that it started, then waits until the test releases it. That makes dispatch ORDER observable
 * synchronously, which a wall-clock assertion never is on a loaded machine.
 */
function setupGated() {
  const dispatchOrder: string[] = [];
  const settleOrder: string[] = [];
  const gates: Array<() => void> = [];

  const gate = (name: string, value: unknown) => async () => {
    dispatchOrder.push(name);
    const waiter = deferred();
    gates.push(() => waiter.resolve(value));
    await waiter.promise;
    settleOrder.push(name);
    return value;
  };

  const messageStore = {
    getMailbox: vi.fn(gate("mailbox", { unreadCount: 7 })),
    getDashboardInboxCategoryCounts: vi.fn(gate("categoryCounts", categoryCounts)),
    getInbox: vi.fn(async () => []),
  };

  const store = { getRootDir: () => "/test-rufu-907" } as unknown as TaskStore;
  const context = {
    router: express.Router(),
    store,
    getProjectContext: async () => ({ store, engine: { getMessageStore: () => messageStore }, projectId: undefined }),
    rethrowAsApiError: (error: unknown): never => {
      throw error;
    },
    runtimeLogger: { warn: vi.fn() },
    planningLogger: {},
    chatLogger: {},
  } as unknown as ApiRoutesContext;
  registerMessagingScriptRoutes(context);

  const app = express();
  app.use(express.json());
  app.use("/api", context.router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return { app, messageStore, dispatchOrder, settleOrder, releaseAll: () => gates.forEach((release) => release()) };
}

/** Let every already-dispatched await continuation run, without resolving the gated readers. */
async function drainMicrotasks(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await Promise.resolve();
  }
}

describe("messaging badge reads are dispatched once and concurrently", () => {
  it("issues every unread-count aggregate once instead of awaiting them one after another", async () => {
    const { app, messageStore, dispatchOrder, settleOrder, releaseAll } = setupGated();

    const pending = request(app, "GET", "/api/messages/unread-count");
    await drainMicrotasks();

    // All three aggregates are in flight at once. Under the previous serial order the second reader
    // had not been called yet, so dispatchOrder would have held exactly one entry here.
    // The pending-approval aggregate is the third; it degrades to 0 when the store has no async layer,
    // which this harness deliberately does not provide, so only the two gated readers are recorded.
    expect(dispatchOrder).toEqual(["mailbox", "categoryCounts"]);
    expect(settleOrder).toEqual([]);

    releaseAll();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      unreadCount: 7,
      pendingApprovalCount: 0,
      categoryUnreadCounts: categoryCounts,
    });
    expect(messageStore.getMailbox).toHaveBeenCalledTimes(1);
    expect(messageStore.getDashboardInboxCategoryCounts).toHaveBeenCalledTimes(1);
    expect(messageStore.getMailbox).toHaveBeenCalledWith(DASHBOARD_USER_ID, "user");
    expect(messageStore.getDashboardInboxCategoryCounts).toHaveBeenCalledWith(DASHBOARD_USER_ID, "user");
  });

  it("issues every inbox aggregate once and concurrently, keeping the payload shape", async () => {
    const { app, messageStore, dispatchOrder, settleOrder, releaseAll } = setupGated();

    const pending = request(app, "GET", "/api/messages/inbox?limit=20");
    await drainMicrotasks();

    expect(dispatchOrder).toEqual(["mailbox", "categoryCounts"]);
    expect(settleOrder).toEqual([]);

    releaseAll();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      messages: [],
      total: 0,
      unreadCount: 7,
      categoryUnreadCounts: categoryCounts,
    });
    expect(messageStore.getInbox).toHaveBeenCalledTimes(1);
    expect(messageStore.getMailbox).toHaveBeenCalledTimes(1);
    expect(messageStore.getDashboardInboxCategoryCounts).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:MailboxBadgeReadFanout 2026-11-09-14:52 (RUFU-907):
  Concurrency must not invent a new failure mode. Each arm keeps its own swallow contract, so an arm
  that used to degrade alone still degrades alone now that the arms share one `Promise.all`.
  */
  it.each(["categoryCounts", "mailbox"] as const)(
    "degrades the %s arm exactly as the serial route did",
    async (failingArm) => {
      const { app, messageStore, releaseAll } = setupGated();
      if (failingArm === "categoryCounts") {
        messageStore.getDashboardInboxCategoryCounts = vi.fn(async () => {
          throw new Error("category counts unavailable");
        });
      } else {
        messageStore.getMailbox = vi.fn(async () => {
          throw new Error("mailbox unavailable");
        });
      }

      const pending = request(app, "GET", "/api/messages/unread-count");
      await drainMicrotasks();
      releaseAll();
      const response = await pending;

      if (failingArm === "categoryCounts") {
        // The serial route dropped the key and still answered 200; so must this one.
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ unreadCount: 7, pendingApprovalCount: 0 });
      } else {
        // The serial route let a mailbox failure propagate to the error boundary; unchanged.
        expect(response.status).toBe(500);
      }
    },
  );
});
