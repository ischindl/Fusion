/**
 * RUFU-496 — `/api/engine/status` may only claim what it can prove.
 *
 * The reported defect: `connected` was one synchronous `getEngine()` lookup, `starting` was derived
 * from a MANAGER-LOOKUP MISS rather than a real startup, and `canStart` was the constant `true`. The
 * three claims were mutually contradictory for a working project, so the reporter read a running
 * project as an outage and filed a false alarm.
 *
 * These cases pin the payload directly (the same computation the GET route answers with) across every
 * state the reason vocabulary can name, and assert the FORBIDDEN triple `{connected:false,
 * starting:true, canStart:true}` never appears for any of them.
 */
// @vitest-environment node

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import type { EngineStartAttemptInfo, EngineStartFailureRecord, EngineStartStage } from "@fusion/engine";
import { buildEngineStatusPayload } from "../server.js";
import type { EngineStatusReason } from "../server.js";

/*
FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
The status poll must be answerable from ALREADY-OPEN stores only. Mocking the resolver keeps that
rule provable rather than merely intended: `getOrCreateProjectStore` throws here, so any code path
that reaches for a cold project store to answer a liveness question fails the suite loudly. The
open-store count is a per-double number so each case states its own liveness evidence.
*/
const registry: { entries: Array<{ projectId: string; store: TaskStore }> } = { entries: [] };

vi.mock("../project-store-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../project-store-resolver.js")>();
  return {
    ...actual,
    listRegisteredProjectStores: vi.fn(() => registry.entries),
    countRunningAgentsInStore: vi.fn(async (store: TaskStore) => (store as unknown as { __count: number }).__count),
    countRunningAgentsInRegisteredProjectStores: vi.fn(async () => ({})),
    getOrCreateProjectStore: vi.fn(() => {
      throw new Error("STATUS_MUST_NOT_OPEN_A_PROJECT_STORE");
    }),
  };
});

/** Store double: only the liveness count matters, so the count is the double. */
function storeWithRunningAgents(count: number): TaskStore {
  return { __count: count } as unknown as TaskStore;
}

function attempt(overrides: Partial<EngineStartAttemptInfo> = {}): EngineStartAttemptInfo {
  return {
    startedAt: Date.now() - 7_500,
    stage: "runtime-start",
    promise: Promise.resolve(),
    ...overrides,
  };
}

function failure(overrides: Partial<EngineStartFailureRecord> = {}): EngineStartFailureRecord {
  return {
    at: Date.now() - 20_000,
    stage: "singleton-acquire",
    message: "Engine start did not settle within its deadline",
    timedOut: true,
    ...overrides,
  };
}

interface ManagerDouble {
  getEngine: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
  getExternalEngineIds: ReturnType<typeof vi.fn>;
  getStartAttempt: ReturnType<typeof vi.fn>;
  getLastStartFailure: ReturnType<typeof vi.fn>;
  ensureEngine: ReturnType<typeof vi.fn>;
  resumeProject: ReturnType<typeof vi.fn>;
}

function managerDouble(opts: {
  engine?: unknown;
  externalIds?: string[];
  attempt?: EngineStartAttemptInfo | null;
  failure?: EngineStartFailureRecord | null;
} = {}): ManagerDouble {
  return {
    getEngine: vi.fn(() => opts.engine),
    has: vi.fn(() => Boolean(opts.engine) || Boolean(opts.attempt)),
    getExternalEngineIds: vi.fn(() => new Set(opts.externalIds ?? [])),
    getStartAttempt: vi.fn(() => opts.attempt ?? undefined),
    getLastStartFailure: vi.fn(() => opts.failure ?? undefined),
    ensureEngine: vi.fn(async () => opts.engine ?? {}),
    resumeProject: vi.fn(async () => {}),
  };
}

function coreDouble(projectStatus: string | null = "active", defaultProjectId?: string) {
  return {
    getProject: vi.fn(async (id: string) =>
      projectStatus === null ? undefined : { id, path: `/tmp/${id}`, status: projectStatus }),
    getDefaultProjectId: vi.fn(async () => defaultProjectId),
  };
}

/** The forbidden triple, spelled out once so every case asserts against the same contract. */
function expectNoContradictoryTriple(payload: Record<string, unknown>) {
  expect(
    payload.connected === false && payload.starting === true && payload.canStart === true,
    `forbidden {{connected:false, starting:true, canStart:true}} for ${JSON.stringify(payload.reason)}`,
  ).toBe(false);
  /*
   * FNXC:EngineStatusTruth 2026-11-07-15:25 (RUFU-496):
   * The full invariant, not just the reported triple. `canStart` is computed as "no handle, no
   * external owner, no running lanes, not paused, no attempt in flight", which means a payload that
   * offers a start can never simultaneously claim the project is live or starting. Asserting only the
   * reported triple would let the mirror-image contradiction ("connected AND free to start again")
   * ship, which is the same false offer wearing a different face.
   */
  expect(
    payload.canStart === true && (payload.connected === true || payload.starting === true),
    `forbidden {{canStart:true while connected/starting}} for ${JSON.stringify(payload.reason)}`,
  ).toBe(false);
}

beforeEach(() => {
  registry.entries = [];
});

describe("buildEngineStatusPayload — ownership and liveness", () => {
  it("reports the ordinary no-engine, no-attempt, no-lanes state as genuinely startable", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble() as never, centralCore: coreDouble() as never },
    );

    expect(payload.connected).toBe(false);
    expect(payload.starting).toBe(false);
    expect(payload.canStart).toBe(true);
    expect(payload.reason).toBe("not-started");
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("reports a project with a live handle as connected and never startable", async () => {
    const engine = { getTaskStore: () => storeWithRunningAgents(0) };
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble({ engine }) as never, centralCore: coreDouble() as never },
    );

    expect(payload.connected).toBe(true);
    expect(payload.engineHandle).toBe(true);
    expect(payload.starting).toBe(false);
    expect(payload.canStart).toBe(false);
    // The healthy state carries no alarm reason at all.
    expect(payload.reason).toBeUndefined();
    // An idle-but-live project answers 0 rather than nothing: the store IS open.
    expect(payload.runningAgentCount).toBe(0);
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("reports a project owned by another process as connected and never startable", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      {
        engineManager: managerDouble({ externalIds: ["proj_aaa"] }) as never,
        centralCore: coreDouble() as never,
      },
    );

    expect(payload.connected).toBe(true);
    expect(payload.externallyOwned).toBe(true);
    expect(payload.engineHandle).toBe(false);
    expect(payload.canStart).toBe(false);
    expect(payload.reason).toBe("externally-owned");
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("reports an externally owned project as the reason even when a stale failure exists", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      {
        engineManager: managerDouble({ externalIds: ["proj_aaa"], failure: failure() }) as never,
        centralCore: coreDouble() as never,
      },
    );

    expect(payload.reason).toBe("externally-owned");
    expect(payload.connected).toBe(true);
  });

  it("reports a project whose lanes are proven running as connected, never startable, and why", async () => {
    // No engine handle in THIS process: the proof of life is the already-open store's agent rows.
    registry.entries = [{ projectId: "proj_aaa", store: storeWithRunningAgents(2) }];
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble() as never, centralCore: coreDouble() as never },
    );

    expect(payload.connected).toBe(true);
    expect(payload.runningAgentCount).toBe(2);
    expect(payload.engineHandle).toBe(false);
    expect(payload.canStart).toBe(false);
    // This is the exact state the old payload rendered as a false outage.
    expect(payload.reason).toBe("live-without-handle");
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496) - SYMPTOM VERIFICATION:
   * The reported reproduction, as an assertion. `getEngine()` returns falsy for a project whose
   * durable work is demonstrably in flight, and the old payload answered
   * `{connected:false, starting:true, canStart:true}` - "not running, currently starting, free to
   * start again" - which is what made a running project look like an outage. The contract that kills
   * it: liveness proven from the store makes `connected` true, `starting` false, `canStart` false, and
   * names the state as `live-without-handle` rather than presenting it as not running.
   */
  it("does not present a handle-miss on a live project as not running (reported symptom)", async () => {
    registry.entries = [{ projectId: "proj_e70af3a5554a4f03", store: storeWithRunningAgents(1) }];
    const payload = await buildEngineStatusPayload(
      "proj_e70af3a5554a4f03",
      { engineManager: managerDouble() as never, centralCore: coreDouble() as never },
    );

    expect(payload.connected, "a live project must never read as disconnected").toBe(true);
    expect(payload.starting).toBe(false);
    expect(payload.canStart, "a live project must never be offered for another start").toBe(false);
    expect(payload.reason).not.toBe("not-started");
    expect(payload.reason).toBe("live-without-handle");
    // The old derivation produced `starting:true` from exactly this lookup miss. Prove the miss happened.
    expect(payload.engineHandle).toBe(false);
  });

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496) - SURFACE ENUMERATION (mesh / multi-node):
   * A project whose work runs on another NODE is indistinguishable from a genuinely idle one: the
   * singleton lock is per-host and no store is open here. The honest answer is to claim nothing -
   * `runningAgentCount` stays absent - rather than fabricate a cross-node liveness verdict.
   */
  it("claims nothing about a project it can neither see nor own, and says the count is unknown", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_remote_node",
      { engineManager: managerDouble() as never, centralCore: coreDouble("active") as never },
    );

    expect(payload.engineHandle).toBe(false);
    expect(payload.externallyOwned).toBe(false);
    expect("runningAgentCount" in payload).toBe(false);
    expect(payload.connected).toBe(false);
    expect(payload.reason).toBe("not-started");
  });
});

describe("buildEngineStatusPayload — unknown is not zero", () => {
  it("leaves runningAgentCount absent rather than 0 when no store is open for the project", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble() as never, centralCore: coreDouble("active") as never },
    );

    expect("runningAgentCount" in payload).toBe(false);
    expect(payload.runningAgentCount).toBeUndefined();
    // An unknown count contributes no liveness claim, so the project stays startable.
    expect(payload.connected).toBe(false);
    expect(payload.canStart).toBe(true);
  });

  it("never opens a project store to answer a status request", async () => {
    const resolver = await import("../project-store-resolver.js");

    await buildEngineStatusPayload(
      "proj_unopened",
      { engineManager: managerDouble() as never, centralCore: coreDouble("active") as never },
    );

    expect(resolver.getOrCreateProjectStore).not.toHaveBeenCalled();
  });

  it("counts from the launch default store only when the central id matches the request", async () => {
    const defaultStore = storeWithRunningAgents(1);
    const payload = await buildEngineStatusPayload(
      "proj_default",
      { engineManager: managerDouble() as never, centralCore: coreDouble("active", "proj_default") as never },
      defaultStore,
    );

    expect(payload.runningAgentCount).toBe(1);
    expect(payload.reason).toBe("live-without-handle");

    const other = await buildEngineStatusPayload(
      "proj_other",
      { engineManager: managerDouble() as never, centralCore: coreDouble("active", "proj_default") as never },
      defaultStore,
    );
    expect("runningAgentCount" in other).toBe(false);
  });
});

describe("buildEngineStatusPayload — a real start attempt", () => {
  it("reports starting with age and stage, and withholds the offer to start", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      {
        engineManager: managerDouble({ attempt: attempt({ stage: "singleton-acquire" }) }) as never,
        centralCore: coreDouble() as never,
      },
    );

    expect(payload.starting).toBe(true);
    expect(payload.reason).toBe("starting");
    expect(payload.canStart).toBe(false);
    expect(payload.connected).toBe(false);
    expect(payload.startingStage).toBe("singleton-acquire");
    expect(typeof payload.startingAgeMs).toBe("number");
    expect(payload.startingAgeMs).toBeGreaterThanOrEqual(7_500);
    expect(payload.startingSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("never reports canStart while starting, for every stage the attempt can be blocked on", async () => {
    const stages: EngineStartStage[] = [
      "registry-read",
      "working-directory",
      "startup-concurrency",
      "singleton-acquire",
      "runtime-start",
      "started-hook",
      "complete",
    ];

    for (const stage of stages) {
      const payload = await buildEngineStatusPayload(
        "proj_aaa",
        {
          engineManager: managerDouble({ attempt: attempt({ stage }) }) as never,
          centralCore: coreDouble() as never,
        },
      );
      expect(payload.starting).toBe(true);
      expect(payload.canStart).toBe(false);
      expect(payload.startingStage).toBe(stage);
      expectNoContradictoryTriple(payload as Record<string, unknown>);
    }
  });

  it("reports a recorded start failure with its reason instead of a bare not-started", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      {
        engineManager: managerDouble({ failure: failure({ stage: "runtime-start" }) }) as never,
        centralCore: coreDouble() as never,
      },
    );

    expect(payload.reason).toBe("start-failed");
    expect(payload.connected).toBe(false);
    expect(payload.starting).toBe(false);
    // Backoff has released the project, so a manual start is genuinely offered again.
    expect(payload.canStart).toBe(true);
    expect(payload.lastStartFailure?.stage).toBe("runtime-start");
    expect(payload.lastStartFailure?.timedOut).toBe(true);
    expect(payload.lastStartFailure?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("prefers a live attempt over a stale failure record", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      {
        engineManager: managerDouble({ attempt: attempt(), failure: failure() }) as never,
        centralCore: coreDouble() as never,
      },
    );

    expect(payload.reason).toBe("starting");
    expect(payload.starting).toBe(true);
    expect(payload.canStart).toBe(false);
  });
});

describe("buildEngineStatusPayload — ownership boundaries and unchanged states", () => {
  it("reports a deliberately paused project as paused: not startable, but resumable", async () => {
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble() as never, centralCore: coreDouble("paused") as never },
    );

    expect(payload.reason).toBe("paused");
    // Starting is the wrong verb for a paused project; the resume path owns it.
    expect(payload.canStart).toBe(false);
    expect(payload.canResume).toBe(true);
    expectNoContradictoryTriple(payload as Record<string, unknown>);
  });

  it("withholds the offer to start when the registry row cannot be read", async () => {
    const unreadableCore = {
      getProject: vi.fn(async () => {
        throw new Error("registry unreachable");
      }),
      getDefaultProjectId: vi.fn(async () => undefined),
    };
    const payload = await buildEngineStatusPayload(
      "proj_aaa",
      { engineManager: managerDouble() as never, centralCore: unreadableCore as never },
    );

    // An unreadable registry is not a claim that the engine is down.
    expect(payload.connected).toBe(false);
    expect(payload.canStart).toBe(false);
  });

  it("keeps the dashboard-only and no-project states unchanged", async () => {
    const dashboardOnly = await buildEngineStatusPayload("proj_aaa", undefined);
    expect(dashboardOnly.reason).toBe("dashboard-only");
    expect(dashboardOnly.connected).toBe(false);
    expect(dashboardOnly.starting).toBe(false);
    expect(dashboardOnly.canStart).toBe(false);

    const noProject = await buildEngineStatusPayload(undefined, { engineManager: managerDouble() as never });
    expect(noProject.reason).toBe("no-project");
    expect(noProject.connected).toBe(false);
    expect(noProject.starting).toBe(false);
    expect(noProject.canStart).toBe(false);
    expect("projectId" in noProject).toBe(false);
  });
});

describe("buildEngineStatusPayload — the forbidden triple is unrepresentable", () => {
  /**
   * Rather than trust the ladder's wording, enumerate every state the vocabulary can name and check
   * the triple against each one. A future state added to the ladder has to be added here too.
   */
  const states: Array<{ name: string; manager: () => ManagerDouble; core: () => unknown }> = [
    { name: "not-started", manager: () => managerDouble(), core: () => coreDouble("active") },
    { name: "starting", manager: () => managerDouble({ attempt: attempt() }), core: () => coreDouble("active") },
    { name: "start-failed", manager: () => managerDouble({ failure: failure() }), core: () => coreDouble("active") },
    {
      name: "externally-owned",
      manager: () => managerDouble({ externalIds: ["proj_aaa"] }),
      core: () => coreDouble("active"),
    },
    { name: "live-without-handle", manager: () => managerDouble(), core: () => coreDouble("active") },
    { name: "paused", manager: () => managerDouble(), core: () => coreDouble("paused") },
    { name: "handle", manager: () => managerDouble({ engine: { getTaskStore: () => storeWithRunningAgents(0) } }), core: () => coreDouble("active") },
    { name: "dashboard-only", manager: () => undefined as never, core: () => coreDouble("active") },
  ];

  for (const state of states) {
    it(`never offers a start while claiming the project is live or starting - state: ${state.name}`, async () => {
      if (state.name === "live-without-handle") registry.entries = [{ projectId: "proj_aaa", store: storeWithRunningAgents(3) }];
      const manager = state.manager();
      const payload = state.name === "dashboard-only"
        ? await buildEngineStatusPayload("proj_aaa", undefined)
        : await buildEngineStatusPayload("proj_aaa", { engineManager: manager as never, centralCore: state.core() as never });

      expectNoContradictoryTriple(payload as Record<string, unknown>);
      registry.entries = [];
    });
  }

  it("never offers a start for a global read that names no project", async () => {
    // The no-project branch is reached by a dashboard opened without a project selection.
    expectNoContradictoryTriple(
      (await buildEngineStatusPayload(undefined, { engineManager: managerDouble() as never })) as Record<string, unknown>,
    );
  });

  it("names every reason the payload can carry from the declared vocabulary", async () => {
    const declared: EngineStatusReason[] = [
      "dashboard-only",
      "no-project",
      "not-started",
      "starting",
      "start-failed",
      "externally-owned",
      "live-without-handle",
      "paused",
    ];
    expect(declared).toContain("dashboard-only");
    expect(declared).toContain("no-project");

    const payloads = await Promise.all([
      buildEngineStatusPayload("proj_aaa", { engineManager: managerDouble({ attempt: attempt() }) as never, centralCore: coreDouble() as never }),
      buildEngineStatusPayload("proj_aaa", { engineManager: managerDouble({ failure: failure() }) as never, centralCore: coreDouble() as never }),
      buildEngineStatusPayload("proj_aaa", { engineManager: managerDouble({ externalIds: ["proj_aaa"] }) as never, centralCore: coreDouble() as never }),
      buildEngineStatusPayload("proj_aaa", { engineManager: managerDouble() as never, centralCore: coreDouble("paused") as never }),
    ]);

    for (const payload of payloads) {
      expect(declared).toContain(payload.reason as EngineStatusReason);
    }
  });
});
