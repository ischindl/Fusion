/*
FNXC:ReadQueueCoverage 2026-10-02-09:46 (RUFU-479 follow-up):
The read queue bounded only requests routed through `api()`, so `activeReadCount()` reached 10 on a cold
board mount while the ceiling is 4: five GET call sites fetched directly and joined the same burst that
must be won by `/tasks/page`. These tests pin the coverage rule behaviorally — a routed call site is
observable as queue occupancy — and pin the one call site that must NEVER be routed: the chat event
stream, which stays open for the life of a conversation and would hold a slot until someone closed it.

The last case is a characterization test, not an aspiration: it asserts that a never-settling queued read
really does occupy a slot forever, which is exactly why long-lived streams stay outside the queue.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_READS,
  activeReadCount,
  queuedReadCount,
  scheduleRead,
} from "../api/client/read-scheduler.js";
import { fetchAiSession, fetchAiSessions } from "../api/planning/ai-sessions.js";
import { listDiscussionCategories } from "../api/system/report.js";
import { fetchAgentLogsWithMeta } from "../api/tasks/task-content.js";
import { fetchTaskDetail } from "../api/tasks/tasks.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A fetch that stays open until the test releases it, so queue occupancy is observable.
 * `releaseAll` must keep draining: releasing the in-flight batch is what lets the queue dispatch the
 * next waiter, and a helper that only resolves the batch it saw at call time leaves that job hanging.
 */
function blockingFetch() {
  const pending: Array<() => void> = [];
  const impl = vi.fn(() => {
    const d = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
      text: () => Promise<string>;
      headers: Headers;
    }>();
    pending.push(() =>
      d.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
        headers: new Headers(),
      }),
    );
    return d.promise;
  });
  return {
    impl,
    releaseAll: async () => {
      for (let pass = 0; pass < 10 && pending.length > 0; pass++) {
        const batch = pending.splice(0, pending.length);
        batch.forEach((release) => release());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("call sites routed through the read queue", () => {
  it("routes every direct-GET call site through the queue, and bounds them at the ceiling", async () => {
    const { impl, releaseAll } = blockingFetch();
    vi.stubGlobal("fetch", impl);

    // One call per routed site. A site that still fetches directly is invisible to the queue, so the
    // counts below would fall short instead of matching the bound-plus-one-waiting shape.
    const calls = [
      fetchAiSessions("proj_x"),
      fetchAiSession("sess_1"),
      listDiscussionCategories(),
      fetchAgentLogsWithMeta("RUFU-1"),
      fetchTaskDetail("RUFU-1"),
    ];
    await flush();

    expect(impl).toHaveBeenCalledTimes(MAX_CONCURRENT_READS); // only the bound is in flight
    expect(activeReadCount()).toBe(MAX_CONCURRENT_READS);
    expect(queuedReadCount()).toBe(1); // the fifth read waits its turn

    await releaseAll();
    await Promise.allSettled(calls);
    await flush();
    expect(impl).toHaveBeenCalledTimes(calls.length);
    expect(activeReadCount()).toBe(0);
    expect(queuedReadCount()).toBe(0);
  });

  it("never lets the routed sites exceed the ceiling when they all fire at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }));

    await Promise.allSettled(
      Array.from({ length: 12 }, () => fetchAgentLogsWithMeta("RUFU-1")),
    );

    expect(maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
    expect(maxInFlight).toBeGreaterThan(1); // the batch really did overlap
    expect(activeReadCount()).toBe(0);
  });
});

describe("the call site that must stay out of the queue", () => {
  it("a never-settling queued read holds its slot indefinitely — so streams are never routed here", async () => {
    let release!: () => void;
    const neverSettles = new Promise<{ ok: boolean }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    vi.stubGlobal("fetch", vi.fn(async () => neverSettles));

    const held = scheduleRead("background", () => fetch("/chat/rooms/1/events"));
    await flush();
    // A long-lived stream would sit here for the whole conversation, so the bound would become a
    // concurrency cap on open streams rather than on in-flight requests.
    expect(activeReadCount()).toBe(1);
    expect(queuedReadCount()).toBe(0);

    release();
    await held;
    await flush();
    expect(activeReadCount()).toBe(0);
  });
});
