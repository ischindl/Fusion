/*
FNXC:ReviewLaneDeclineAttribution 2026-11-19-22:55 (RUFU-478):
A project whose review lane has no enabled reviewer was warn-only state: 214 identical
`E4: no enabled reviewer agent exists` lines over ~7 hours on the deployed node, none carrying a project id,
while 12 of 24 projects simply have no enabled reviewer. Logs rotate, so "which projects can nobody review,
and for how long?" was unanswerable and a configuration state was filed as a dead engine. This file pins the
durable half: `task:review-dispatch-declined`, one row per project episode.

Driven through `tick()` — never through the recorder's private helpers — because the claim is REACHABILITY:
an emit that only a unit call could produce would be exactly as useless as the warn line it replaces.

The shape assertions are the RUFU-430 guard, not ceremony. That event's first emit omitted the NOT NULL
`target`, every row was rejected, the bounded seam swallowed the rejection, and production kept zero rows
while the code looked shipped. `run_audit_events.domain` has no CHECK constraint either, so only these
assertions keep the row writable.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";
import {
  resetReviewDispatchDeclineSignaturesForTests,
  retainedReviewDispatchDeclineSignatureCount,
} from "../scheduling/review-dispatch-decline-audit.js";

const TICK_AT = Date.parse("2026-11-19T00:00:00.000Z");
/** The project binding of the fake data layer; distinct from the sweep's attribution target on purpose. */
const LAYER_PROJECT_ID = "proj_layer_bound";

interface CapturedEmit {
  agentId?: string;
  runId?: string;
  domain?: string;
  mutationType?: string;
  target?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

function reviewCard(id: string) {
  return {
    id,
    column: "in-review",
    updatedAt: "2026-11-18T00:00:00.000Z",
    paused: 0,
    userPaused: 0,
  } as never;
}

function reviewer(id: string): Agent {
  return { id, roles: ["reviewer"], runtimeConfig: { enabled: true } } as unknown as Agent;
}

/** A reviewer busy on SOMEONE ELSE'S card: the pool is non-empty, so this card is not dispatched. */
function busyElsewhere(agentId: string): AgentHeartbeatRun {
  return { agentId, taskId: "OTHER-CARD", status: "active" } as unknown as AgentHeartbeatRun;
}

interface HarnessOptions {
  /** What the store answers for project attribution; `null` is the no-project host shape. */
  projectId?: string | null;
  /** Reviewer roster the sweep resolves. Default: nobody enabled — the decline itself. */
  roster?: Agent[];
  /** Roster read behaviour override (a rejecting read is an infrastructure failure, not a gap). */
  listAgents?: () => Promise<Agent[]>;
  /** How many review-lane cards wait behind the decline. */
  waiting?: number;
  /** Explicit card ids, when the ids themselves are under test. */
  cards?: string[];
  /** The `recordRunAuditEvent` sink behaviour. Default: a capturing resolve. */
  sink?: (input: CapturedEmit) => unknown;
  /** Host carries only the buffered drain method (no direct write) — the outcome lane must report absent. */
  bufferedOnly?: boolean;
  /** Host carries no audit method at all — the RUFU-430 "sink absent" shape. */
  noSink?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const captured: CapturedEmit[] = [];
  const ids = options.cards ?? Array.from({ length: options.waiting ?? 1 }, (_, i) => `RUFU-47${i}`);
  const roster = options.roster ?? [];

  const store: Record<string, unknown> = {
    getProjectId: () => options.projectId ?? null,
    getSettings: async () => ({}),
    listTasks: async () => ids.map(reviewCard),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async (taskId: string) => ({ workflowId: "builtin:coding", stepIds: [], taskId }),
    getTaskWorkflowSelectionsAsync: async (taskIds: string[]) => new Map(
      taskIds.map((taskId) => [taskId, { workflowId: "builtin:coding", stepIds: [] }]),
    ),
    // The reviewer-run ledger and the review-entry clock both read through the async layer; an empty row
    // set means "no prior attempt, no recorded entry", which is the shape that reaches a dispatch decision.
    asyncLayer: {
      projectId: LAYER_PROJECT_ID,
      transactionImmediate: async () => [] as unknown[],
    },
  };
  if (!options.noSink) {
    store.recordRunAuditEvent = options.sink
      ? ((input: CapturedEmit) => options.sink!(input) as never)
      : ((input: CapturedEmit) => { captured.push(input); return undefined; });
  }
  if (options.bufferedOnly) {
    delete store.recordRunAuditEvent;
    store.recordRunAuditEventBuffered = () => ({ accepted: true, queued: true, spilled: false, queueDepth: 1 });
  }

  const heartbeat = vi.fn(async () => undefined);
  const sweep = new ReviewDispatchSweep({
    store: store as never,
    agentStore: {
      listAgents: options.listAgents ?? (async () => roster),
      getActiveHeartbeatRun: async (agentId: string) => (roster.length ? busyElsewhere(agentId) : null),
    } as never,
    heartbeatMonitor: { executeHeartbeat: heartbeat } as never,
    now: () => TICK_AT,
    e4LogCooldownMs: 300_000,
  });

  return { sweep, captured, heartbeat, store };
}

describe("review-lane decline attribution (RUFU-478)", () => {
  beforeEach(() => {
    resetReviewDispatchDeclineSignaturesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writes one attributable row when review-lane cards wait with no enabled reviewer", async () => {
    const { sweep, captured } = makeHarness({ projectId: "proj_alpha", cards: ["RUFU-478"] });

    const result = await sweep.tick(new Date(TICK_AT));

    // Reachability from the production entry point, measured rather than assumed.
    expect(result.classes["no-reviewer"]).toBe(1);
    expect(captured).toHaveLength(1);
    const row = captured[0]!;
    // RUFU-430: an emit whose shape the store rejects lands NOTHING while the code looks shipped.
    expect(row.mutationType).toBe("task:review-dispatch-declined");
    expect(row.domain).toBe("database");
    expect(row.target).toBe("proj_alpha");
    expect(row.target).toBeTruthy();
    expect(row.agentId).toBe("system");
    expect(row.runId).toMatch(/^review-dispatch-decline-proj_alpha-/);
    // Project-scoped: `task_id` stays NULL so "which projects" is a `group by target`, not a card scan.
    expect(row.taskId).toBeUndefined();
    expect(row.metadata).toEqual({
      reasonCode: "no-enabled-reviewer",
      enabledReviewerCount: 0,
      waitingCount: 1,
      candidateTaskIds: ["RUFU-478"],
    });
  });

  it("emits nothing when no card sits in the review lane, so an idle lane is never noise", async () => {
    const { sweep, captured } = makeHarness({ projectId: "proj_idle", cards: [] });

    await sweep.tick(new Date(TICK_AT));

    // The candidate early return is what makes `waitingCount` a real queue depth everywhere else.
    expect(captured).toHaveLength(0);
    expect(retainedReviewDispatchDeclineSignatureCount()).toBe(0);
  });

  it("caps the metadata at 20 waiting ids while reporting the true queue depth", async () => {
    const { sweep, captured } = makeHarness({ projectId: "proj_deep", waiting: 25 });

    await sweep.tick(new Date(TICK_AT));

    expect(captured).toHaveLength(1);
    const metadata = captured[0]!.metadata as Record<string, unknown>;
    expect(metadata.waitingCount).toBe(25);
    expect((metadata.candidateTaskIds as string[]).length).toBe(20);
  });

  it("collapses a lane that stays unconfigured into one row across ticks", async () => {
    const { sweep, captured } = makeHarness({ projectId: "proj_steady" });

    await sweep.tick(new Date(TICK_AT));
    await sweep.tick(new Date(TICK_AT + 15_000));
    await sweep.tick(new Date(TICK_AT + 30_000));

    // The 214-warn-line flood is the thing being replaced; a per-tick row would repeat it in the audit table.
    expect(captured).toHaveLength(1);
  });

  it("writes no row when a reviewer exists — including the two-reviewer pool RUFU-530 dispatches", async () => {
    for (const roster of [[reviewer("agent-one")], [reviewer("agent-one"), reviewer("agent-two")]]) {
      resetReviewDispatchDeclineSignaturesForTests();
      const { sweep, captured, heartbeat } = makeHarness({ projectId: "proj_reviewed", roster });

      await sweep.tick(new Date(TICK_AT));

      expect(captured).toHaveLength(0);
      expect(heartbeat).not.toHaveBeenCalled();
    }
  });

  it("re-arms after a repair, so a project that loses its reviewer again is recorded again", async () => {
    const { sweep, captured } = makeHarness({ projectId: "proj_rearmed" });

    await sweep.tick(new Date(TICK_AT));
    expect(captured).toHaveLength(1);

    // Repaired: the pool is non-empty, so the episode is forgotten (no extra roster read — the pool is in hand).
    const repaired = makeHarness({ projectId: "proj_rearmed", roster: [reviewer("agent-new")] });
    await repaired.sweep.tick(new Date(TICK_AT + 60_000));
    expect(repaired.captured).toHaveLength(0);

    // Regression after the repair is a NEW fact and must not be swallowed by the first episode.
    await sweep.tick(new Date(TICK_AT + 120_000));
    expect(captured).toHaveLength(2);
  });

  it("still records against a stable target when the store cannot name a project", async () => {
    const { sweep, captured } = makeHarness({ projectId: null, cards: ["RUFU-478"] });

    await sweep.tick(new Date(TICK_AT));

    expect(captured).toHaveLength(1);
    // Empty string would satisfy the NOT NULL column and still be unattributable.
    expect(captured[0]!.target).toBe("unknown-project");
    expect(captured[0]!.runId).toMatch(/^review-dispatch-decline-unknown-project-/);
  });

  it("records no configuration gap when the roster read itself fails", async () => {
    const { sweep, captured } = makeHarness({
      projectId: "proj_broken_read",
      listAgents: async () => { throw new Error("roster unreachable"); },
    });

    // `runPass()` has no try/catch around the pool resolution, so the tick rejects — the interval handler is
    // what keeps a runtime alive. The invariant under test is the ABSENCE of a row: an infrastructure failure
    // must never be written as "this project has no reviewer".
    await expect(sweep.tick(new Date(TICK_AT))).rejects.toThrow("roster unreachable");
    expect(captured).toHaveLength(0);
  });

  describe("hostile sinks cannot change the sweep", () => {
    const hostileSinks: Array<[string, (input: CapturedEmit) => unknown]> = [
      ["throwing", () => { throw new Error("audit store unreachable"); }],
      ["rejecting", () => Promise.reject(new Error("audit store rejected"))],
      ["late-settling", () => new Promise((resolve) => { setTimeout(() => resolve(undefined), 5_000); })],
    ];

    for (const [name, sink] of hostileSinks) {
      it(`survives a ${name} sink and still classifies the card`, async () => {
        const { sweep, captured, heartbeat } = makeHarness({ projectId: `proj_${name}`, sink });

        const result = await sweep.tick(new Date(TICK_AT));

        expect(result.classes["no-reviewer"]).toBe(1);
        expect(result.dispatched).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
        // A throwing sink is reported by the seam, not by an emitted row the caller never got.
        void captured;
      });
    }

    it("survives a host with no audit method at all", async () => {
      const { sweep, captured, heartbeat } = makeHarness({ projectId: "proj_no_sink", noSink: true });

      const result = await sweep.tick(new Date(TICK_AT));

      // The seam answers `absent`; the sweep's own verdict about the card is untouched by that.
      expect(result.classes["no-reviewer"]).toBe(1);
      expect(captured).toHaveLength(0);
      expect(heartbeat).not.toHaveBeenCalled();
    });

    it("bounds a hanging sink without delaying the classification", async () => {
      vi.useFakeTimers();
      let settled = false;
      const { sweep, heartbeat } = makeHarness({
        projectId: "proj_hanging",
        sink: () => new Promise<void>(() => { /* never settles */ }),
      });

      const pending = sweep.tick(new Date(TICK_AT)).then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(2_100);
      const result = await pending;

      expect(settled).toBe(true);
      expect(result.classes["no-reviewer"]).toBe(1);
      expect(result.dispatched).toEqual([]);
      expect(heartbeat).not.toHaveBeenCalled();
    });

    it("attempts the decline on a buffered-only host and changes nothing when it cannot record", async () => {
      const { sweep, captured, heartbeat } = makeHarness({ projectId: "proj_buffered_only", bufferedOnly: true });

      const result = await sweep.tick(new Date(TICK_AT));

      // The outcome lane writes through `recordRunAuditEvent` only; a drain-only host answers `absent`.
      expect(captured).toHaveLength(0);
      expect(result.classes["no-reviewer"]).toBe(1);
      expect(result.dispatched).toEqual([]);
      expect(heartbeat).not.toHaveBeenCalled();
    });
  });
});
