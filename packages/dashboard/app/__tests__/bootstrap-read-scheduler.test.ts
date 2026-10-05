/**
 * FNXC:BoardBootstrap 2026-10-02-02:12:
 * A cold dashboard mount fired ~20 distinct GETs at once (measured: 19 concurrent at t≈0.9s, each
 * then 13–17s, cards visible at 14–19s). The fix bounds concurrent reads and dispatches the two
 * board-gating endpoints first. These tests pin the invariant, not the reported repro: every read
 * path through `api()` obeys the bound, mutations never queue, and a cancelled read cannot hold a
 * slot it never used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_READS,
  activeReadCount,
  queuedReadCount,
  readPriorityClass,
  scheduleRead,
} from "../api/client/read-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  expect(activeReadCount()).toBe(0);
  expect(queuedReadCount()).toBe(0);
});

describe("readPriorityClass", () => {
  it("marks the board-gating endpoints critical, query string or not", () => {
    expect(readPriorityClass("/tasks/page")).toBe("critical");
    expect(readPriorityClass("/tasks/page?projectId=proj_1&limit=100")).toBe("critical");
    expect(readPriorityClass("/api/tasks/board-workflows?partial=1&taskIds=RUFU-457")).toBe("critical");
    expect(readPriorityClass("/settings/global")).toBe("critical");
  });

  it("treats chrome endpoints as background so they cannot outrank the board", () => {
    for (const path of [
      "/agents/stats?projectId=proj_1",
      "/messages/unread-count",
      "/stash-recovery/orphans",
      "/tasks/done?limit=50",
    ]) {
      expect(readPriorityClass(path)).toBe("background");
    }
  });
});

describe("scheduleRead", () => {
  it("never exceeds the read bound no matter how many reads mount at once", async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_READS + 8 }, () => deferred<number>());
    const results = gates.map((gate, index) =>
      scheduleRead(`background-${index}` as "background", () => gate.promise),
    );
    await flush();
    expect(activeReadCount()).toBe(MAX_CONCURRENT_READS);
    expect(queuedReadCount()).toBe(gates.length - MAX_CONCURRENT_READS);

    for (const [index, gate] of gates.entries()) {
      gate.resolve(index);
      await flush();
    }
    await expect(Promise.all(results)).resolves.toHaveLength(gates.length);
  });

  it("dispatches a board-critical read ahead of background reads already queued", async () => {
    // Priority can only be observed while capacity is exhausted, which is exactly
    // the cold-mount condition this exists for.
    const blockers = Array.from({ length: MAX_CONCURRENT_READS }, () => deferred<string>());
    const running = blockers.map((gate) => scheduleRead("background", () => gate.promise));
    await flush();
    expect(activeReadCount()).toBe(MAX_CONCURRENT_READS);

    const order: string[] = [];
    const background = ["b1", "b2"].map((id) =>
      scheduleRead("background", async () => {
        order.push(id);
        return id;
      }),
    );
    const critical = scheduleRead("critical", async () => {
      order.push("critical");
      return "critical";
    });
    await flush();
    expect(order).toEqual([]);

    // Freeing ONE slot must hand it to the critical read even though two
    // background reads were queued first. Each of these short reads then frees
    // its own slot, so the whole queue drains.
    blockers.forEach((gate) => gate.resolve("done"));
    await Promise.all([...running, critical, ...background]);
    await flush();
    expect(order).toEqual(["critical", "b1", "b2"]);
  });

  it("releases the slot when a read fails, so one error cannot wedge the queue", async () => {
    const failing = scheduleRead("background", async () => {
      throw new Error("server 500");
    });
    await expect(failing).rejects.toThrow("server 500");
    await flush();

    const gates = Array.from({ length: MAX_CONCURRENT_READS + 2 }, () => deferred<number>());
    const pending = gates.map((gate, index) =>
      scheduleRead("background", () => gate.promise),
    );
    await flush();
    expect(activeReadCount()).toBe(MAX_CONCURRENT_READS);
    for (const gate of gates) gate.resolve(1);
    await Promise.all(pending);
  });

  it("drops a read aborted while queued and never runs it", async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_READS + 1 }, () => deferred<number>());
    const queuedGate = gates[MAX_CONCURRENT_READS];
    const running = gates.map((gate, index) =>
      scheduleRead(`background${index}` as "background", () => gate.promise),
    );
    await flush();

    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = scheduleRead("background", async () => {
      cancelledRan = true;
      return 1;
    }, controller.signal);
    await flush();
    // One already-queued gate plus this aborted read.
    expect(queuedReadCount()).toBe(2);

    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    expect(cancelledRan).toBe(false);
    expect(queuedReadCount()).toBe(1);

    for (const gate of gates) gate.resolve(1);
    await Promise.all([...running, queuedGate.promise]);
  });

  it("rejects an already-aborted read without occupying capacity", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(
      scheduleRead("critical", async () => {
        ran = true;
        return 1;
      }, controller.signal),
    ).rejects.toBeDefined();
    expect(ran).toBe(false);
    expect(activeReadCount()).toBe(0);
  });
});

describe("api() read queueing", () => {
  async function withStubBurst() {
    const { api } = await import("../api/client/client.js");
    let inFlight = 0;
    let peak = 0;
    const postFired: string[] = [];
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        postFired.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", stub);
    const reads = Array.from({ length: MAX_CONCURRENT_READS + 6 }, (_, index) =>
      api<{ ok: boolean }>(`/agents/stats?index=${index}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = api<{ ok: boolean }>("/tasks/RUFU-1/comment", { method: "POST", body: "{}" });
    await Promise.all([...reads, write]);
    vi.unstubAllGlobals();
    return { peak, postFired, stub };
  }

  it("caps concurrent GETs and lets a POST through while reads are queued", async () => {
    const { peak, postFired, stub } = await withStubBurst();
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
    expect(peak).toBeGreaterThan(1);
    expect(postFired).toHaveLength(1);
    expect(stub).toHaveBeenCalledTimes(MAX_CONCURRENT_READS + 7);
  });
});
