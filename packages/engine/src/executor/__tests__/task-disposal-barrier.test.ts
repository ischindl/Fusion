import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitTaskDisposalBarrier,
  hasTaskDisposalBarrier,
  registerTaskDisposal,
  resetTaskDisposalBarrierForTests,
} from "../task-disposal-barrier.js";
import { trackTaskDisposal } from "../track-task-disposal.js";

/*
FNXC:AssigneeTransferAtomicity 2026-09-21-20:36 (RUFU-260):
The disposal barrier gives hosts WITHOUT executor lifecycle authority (the heartbeat monitor) a way
to wait for in-flight teardown at their one acquisition seam. Contract proven here:
  - a published teardown gates awaiters until it settles, then removes itself;
  - successive teardowns CHAIN, and a teardown published DURING a wait extends that wait;
  - `trackTaskDisposal` (the single registration point) publishes the SAME wrapped promise, so
    every teardown branch (assignee transfer, user move, delete) is observable for free;
  - a rejecting teardown releases waiters (waiting is bounded by settlement, not success).
*/

describe("task disposal barrier", () => {
  afterEach(() => {
    resetTaskDisposalBarrierForTests();
  });

  it("an absent barrier resolves immediately", async () => {
    await expect(awaitTaskDisposalBarrier("fn-none")).resolves.toBeUndefined();
    expect(hasTaskDisposalBarrier("fn-none")).toBe(false);
  });

  it("gates a waiter until the published teardown settles, then removes itself", async () => {
    let settle: () => void = () => {};
    const teardown = new Promise<void>((resolve) => { settle = resolve; });
    registerTaskDisposal("fn-a", teardown);
    expect(hasTaskDisposalBarrier("fn-a")).toBe(true);

    let released = false;
    const waiter = awaitTaskDisposalBarrier("fn-a").then(() => { released = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);

    settle();
    await waiter;
    expect(released).toBe(true);
    await Promise.resolve();
    expect(hasTaskDisposalBarrier("fn-a")).toBe(false);
  });

  it("extends the wait for a teardown published DURING the wait", async () => {
    let settle1: () => void = () => {};
    registerTaskDisposal("fn-b", new Promise<void>((resolve) => { settle1 = resolve; }));

    let released = false;
    const waiter = awaitTaskDisposalBarrier("fn-b").then(() => { released = true; });

    // A second teardown registers while the first is still settling (e.g. move immediately
    // after an assignee-transfer abort).
    await Promise.resolve();
    let settle2: () => void = () => {};
    registerTaskDisposal("fn-b", new Promise<void>((resolve) => { settle2 = resolve; }));

    settle1();
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toBe(false);

    settle2();
    await waiter;
    expect(released).toBe(true);
  });

  it("releases waiters when a teardown rejects (settlement, not success, bounds the wait)", async () => {
    registerTaskDisposal("fn-c", Promise.reject(new Error("teardown exploded")));
    await expect(awaitTaskDisposalBarrier("fn-c")).resolves.toBeUndefined();
  });

  it("trackTaskDisposal publishes the same wrapped promise to the barrier", async () => {
    const pendingTaskDisposals = new Map<string, Promise<void>>();
    let settle: () => void = () => {};
    const disposal = new Promise<void>((resolve) => { settle = resolve; });

    trackTaskDisposal({ pendingTaskDisposals }, "fn-d", disposal);
    expect(pendingTaskDisposals.has("fn-d")).toBe(true);
    expect(hasTaskDisposalBarrier("fn-d")).toBe(true);

    let released = false;
    const waiter = awaitTaskDisposalBarrier("fn-d").then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);

    settle();
    await waiter;
    expect(released).toBe(true);
    await Promise.resolve();
    expect(hasTaskDisposalBarrier("fn-d")).toBe(false);
    expect(pendingTaskDisposals.has("fn-d")).toBe(false);
  });

  it("trackTaskDisposal swallows a rejecting disposal into the log, not the barrier", async () => {
    const logger = await import("../../logger.js");
    const warn = vi.spyOn(logger.executorLog, "warn").mockImplementation(() => {});
    try {
      const pendingTaskDisposals = new Map<string, Promise<void>>();
      trackTaskDisposal({ pendingTaskDisposals }, "fn-e", Promise.reject(new Error("boom")));
      await awaitTaskDisposalBarrier("fn-e");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    } finally {
      warn.mockRestore();
    }
  });
});
