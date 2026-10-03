/*
FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
The review lane could not exceed one concurrent review: `DEFAULT_MAX_DISPATCHES_PER_TICK` was 1 AND a second
enabled reviewer made resolution return null (bucket E4), so the configuration an operator would write to speed
reviews up was the configuration that stopped them. Measured on saneca: 18 cards sat in review behind one
enabled reviewer at ~6 reviews/hour. These tests pin the replacement contract — pool size IS the concurrency,
each reviewer still runs one session at a time, and routing never hands a card to a reviewer that already holds
a run.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import {
  classifyReviewCard,
  resolveReviewSlot,
  ReviewDispatchSweep,
} from "../scheduling/review-dispatch-sweep.js";

function reviewer(id: string): Agent {
  return { id, roles: ["reviewer"], runtimeConfig: { enabled: true } } as unknown as Agent;
}

function run(agentId: string, taskId: string): AgentHeartbeatRun {
  return { agentId, taskId } as unknown as AgentHeartbeatRun;
}

/** A card with no ledger history, so classification reaches the dispatch decision. */
function eligibleCard(id: string, enteredAt = "2026-10-03T10:00:00.000Z") {
  return { id, updatedAt: enteredAt, column: "in-review" } as never;
}

describe("review lane pool routing", () => {
  it("routes two eligible cards to two different reviewers instead of serialising behind one", () => {
    const [a, b] = [reviewer("agent-a"), reviewer("agent-b")];
    const pool = [a, b];
    const busy = new Map<string, AgentHeartbeatRun | null>([
      [a.id, null],
      [b.id, null],
    ]);
    const allocated = new Set<string>();

    const first = resolveReviewSlot({ pool, busyRunByReviewer: busy, allocatedThisTick: allocated, taskId: "T-1" });
    expect(first.chosen?.id).toBe("agent-a");
    // The dispatch-authorising value: a free reviewer must present no run to the classifier.
    expect(first.activeRun).toBeNull();
    allocated.add(first.free!.id);

    const second = resolveReviewSlot({ pool, busyRunByReviewer: busy, allocatedThisTick: allocated, taskId: "T-2" });
    expect(second.chosen?.id).toBe("agent-b");
    expect(second.activeRun).toBeNull();
    expect(second.chosen?.id).not.toBe(first.chosen?.id);
  });

  it("gives the second card no reviewer when only one reviewer is enabled", () => {
    const only = reviewer("agent-a");
    const busy = new Map<string, AgentHeartbeatRun | null>([[only.id, null]]);
    const allocated = new Set<string>([only.id]);

    const slot = resolveReviewSlot({ pool: [only], busyRunByReviewer: busy, allocatedThisTick: allocated, taskId: "T-2" });
    // No free slot, and nothing busy elsewhere to hand over as `reviewer-busy`.
    expect(slot.free).toBeNull();
    expect(slot.chosen).toBeNull();
  });

  it("counts an undispatched card instead of dropping it when every reviewer is busy",
    () => {
      const [a, b] = [reviewer("agent-a"), reviewer("agent-b")];
      const busy = new Map<string, AgentHeartbeatRun | null>([
        [a.id, run(a.id, "OTHER-1")],
        [b.id, run(b.id, "OTHER-2")],
      ]);

      const slot = resolveReviewSlot({ pool: [a, b], busyRunByReviewer: busy, allocatedThisTick: new Set(), taskId: "T-9" });
      // The tick's own guard is `!free`, so this card cannot be dispatched this pass — and it stays VISIBLE
      // in the sweep's accounting as never-dispatched rather than vanishing from it.
      expect(slot.free).toBeNull();
      expect(slot.activeRun?.taskId).toBe("OTHER-1");

      const decision = classifyReviewCard({
        task: eligibleCard("T-9"),
        rows: [],
        activeRun: slot.activeRun,
        reviewerFound: true,
        now: Date.parse("2026-10-03T12:00:00.000Z"),
        graceMs: 30_000,
        startLatencyMs: 120_000,
        maxAttempts: 3,
      });
      expect(decision.bucket).toBe("never-dispatched");
    });

  /*
  FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
  `reviewer-busy` is the B3/B4 classification for a card that ALREADY has a live ledger row while the reviewer
  works elsewhere — that is the shape the pool must not double-dispatch.
  */
  it("classifies a card with a live attempt as reviewer-busy while its reviewer works on another card", () => {
    const a = reviewer("agent-a");
    const busy = new Map<string, AgentHeartbeatRun | null>([[a.id, run(a.id, "OTHER-1")]]);
    const slot = resolveReviewSlot({ pool: [a], busyRunByReviewer: busy, allocatedThisTick: new Set(), taskId: "T-8" });

    const decision = classifyReviewCard({
      task: eligibleCard("T-8"),
      rows: [{ taskId: "T-8", startedAt: "2026-10-03T11:58:00.000Z", completedAt: null, invalidatedAt: null, status: "running" } as never],
      activeRun: slot.activeRun,
      reviewerFound: true,
      now: Date.parse("2026-10-03T12:00:00.000Z"),
      graceMs: 30_000,
      startLatencyMs: 120_000,
      maxAttempts: 3,
    });
    expect(decision.bucket).toBe("reviewer-busy");
    expect(decision.dispatch).toBe(false);
  });

  it("keeps a reviewer already working on a card attached to it", () => {
    const a = reviewer("agent-a");
    const busy = new Map<string, AgentHeartbeatRun | null>([[a.id, run(a.id, "T-3")]]);

    const slot = resolveReviewSlot({ pool: [a], busyRunByReviewer: busy, allocatedThisTick: new Set(), taskId: "T-3" });
    expect(slot.chosen?.id).toBe("agent-a");
    expect(slot.activeRun?.taskId).toBe("T-3");

    const decision = classifyReviewCard({
      task: eligibleCard("T-3"),
      rows: [{ taskId: "T-3", startedAt: "2026-10-03T11:59:00.000Z", completedAt: null, invalidatedAt: null, status: "running" } as never],
      activeRun: slot.activeRun,
      reviewerFound: true,
      now: Date.parse("2026-10-03T12:00:00.000Z"),
      graceMs: 30_000,
      startLatencyMs: 120_000,
      maxAttempts: 3,
    });
    expect(decision.bucket).toBe("review-in-flight");
  });

  it("dispatches when a free reviewer exists — the invariant the old single-reviewer rule destroyed", () => {
    const [a, b] = [reviewer("agent-a"), reviewer("agent-b")];
    const busy = new Map<string, AgentHeartbeatRun | null>([
      [a.id, run(a.id, "OTHER")],
      [b.id, null],
    ]);

    const slot = resolveReviewSlot({ pool: [a, b], busyRunByReviewer: busy, allocatedThisTick: new Set(), taskId: "T-4" });
    const decision = classifyReviewCard({
      task: eligibleCard("T-4"),
      rows: [],
      activeRun: slot.activeRun,
      reviewerFound: true,
      now: Date.parse("2026-10-03T12:00:00.000Z"),
      graceMs: 30_000,
      startLatencyMs: 120_000,
      maxAttempts: 3,
    });
    expect(slot.free?.id).toBe("agent-b");
    expect(decision.bucket).toBe("never-dispatched");
    expect(decision.dispatch).toBe(true);
  });
});

/*
FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
The symptom this card was filed for: a second enabled reviewer produced
`E4: 2 enabled reviewer agents cover the review lane; refusing to pick one` and the lane stopped dispatching
entirely. Resolution must return the pool and must not warn for >1.
*/
describe("review lane pool resolution", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function makeSweep(agents: unknown[]) {
    return new ReviewDispatchSweep({
      store: { getProjectId: () => "proj_pool_check" } as never,
      agentStore: { listAgents: async () => agents } as never,
      heartbeatMonitor: {} as never,
      now: () => 1_000_000,
    });
  }

  const poolOf = async (sweep: ReviewDispatchSweep) =>
    await (sweep as unknown as { resolveReviewerPool: () => Promise<unknown[]> }).resolveReviewerPool();

  it("resolves both reviewers and does not declare a configuration gap", async () => {
    const sweep = makeSweep([
      { id: "agent-a", roles: ["reviewer"], runtimeConfig: { enabled: true } },
      { id: "agent-b", roles: ["reviewer"], runtimeConfig: { enabled: true } },
    ]);
    const pool = await poolOf(sweep);
    expect(pool.map((agent) => (agent as Agent).id)).toEqual(["agent-a", "agent-b"]);

    const written = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(written).not.toContain("E4");
    expect(written).not.toContain("refusing to pick one");
    /*
     * The pool size is surfaced on the sweep's own rate-limited line, but at info severity, which the logger
     * routes by marker rather than to console.warn — so it is deliberately NOT asserted from this test. What is
     * asserted is the invariant: two enabled reviewers must not be reported as a configuration gap.
     */
  });

  it("keeps the E4 gap for zero enabled reviewers — that one is a real misconfiguration", async () => {
    const pool = await poolOf(makeSweep([{ id: "agent-a", roles: ["reviewer"], runtimeConfig: { enabled: false } }]));
    expect(pool).toHaveLength(0);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("no enabled reviewer agent exists");
  });
});
