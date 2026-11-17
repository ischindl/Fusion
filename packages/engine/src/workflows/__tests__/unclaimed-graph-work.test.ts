/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
The acceptance suite for the pure decision seam. Every code in the closed set gets its own case,
plus the data states the card set was clustered on: `attempt > 0`, `waitReason` NULL vs `"capacity"`,
a `failed` item, and `status` NULL / `"failed"` / `"stuck-killed"` / `"queued"`. A new code with no
case here is a hole the next sweep will fall into, so this file is the ledger of what the seam
promises.
*/
import { describe, expect, it } from "vitest";
import type { WorkflowWorkItem } from "@fusion/core";
import {
  UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS,
  UNCLAIMED_GRAPH_WORK_DRAIN_PROGRESS_GRACE_MS,
  UNCLAIMED_GRAPH_WORK_LEASE_UNTOUCHED_MS,
  UNCLAIMED_GRAPH_WORK_MAX_REDRIVES,
  UNCLAIMED_GRAPH_WORK_STALENESS_MS,
  evaluateUnclaimedGraphWork,
  unclaimedGraphWorkSignature,
  unclaimedWorkMeansStarved,
  type UnclaimedGraphWorkCode,
  type UnclaimedGraphWorkInput,
} from "../unclaimed-graph-work.js";

const NOW = Date.parse("2026-11-17T00:00:00.000Z");
const STALE = new Date(NOW - UNCLAIMED_GRAPH_WORK_STALENESS_MS - 60_000).toISOString();
/** A POSITIVE measurement that the pump is behind. A NULL age means "unobserved", which is not starvation. */
const PUMP_BEHIND_MS = UNCLAIMED_GRAPH_WORK_DRAIN_PROGRESS_GRACE_MS * 3;

const PLANNING_LANES = new Set(["todo", "hold", "triage"]);
const WIP_LANES = new Set(["in-progress"]);

function row(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "WI-1",
    runId: "RUN-1",
    taskId: "RUFU-TEST",
    nodeId: "plan-review",
    kind: "task",
    state: "runnable",
    attempt: 0,
    retryAfter: null,
    deferredSince: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: "RUN-1",
    continuationSequence: 1,
    waitReason: "planning",
    sourceColumn: "todo",
    targetColumn: "in-progress",
    irHash: null,
    principalAgentId: null,
    workflowRole: "triage",
    authorityKind: "role-pool",
    nodeInstanceId: null,
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  };
}

function card(overrides: Partial<UnclaimedGraphWorkInput["task"]> = {}): UnclaimedGraphWorkInput["task"] {
  return {
    id: "RUFU-TEST",
    column: "todo",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    updatedAt: STALE,
    sourceMetadata: null,
    autoMerge: true,
    hasDurableSpec: true,
    ...overrides,
  } as UnclaimedGraphWorkInput["task"];
}

function input(overrides: Partial<UnclaimedGraphWorkInput> = {}): UnclaimedGraphWorkInput {
  return {
    task: card(),
    items: [row()],
    planningColumns: PLANNING_LANES,
    wipColumns: WIP_LANES,
    lanesReadable: true,
    liveness: "idle",
    drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: PUMP_BEHIND_MS },
    nodeSeam: "plan-review",
    now: NOW,
    episode: null,
    ...overrides,
  };
}

/** The episode this seam would have written for a decision, so budget tests state their own history. */
function episodeFor(code: UnclaimedGraphWorkCode, redriveCount: number, nodeSeam = "plan-review") {
  return {
    code,
    firstAt: STALE,
    signature: unclaimedGraphWorkSignature(code, row(), nodeSeam),
    redriveCount,
  };
}

describe("evaluateUnclaimedGraphWork — refusals that name an owner", () => {
  it("refuses when the card's IR cannot say which lanes plan", () => {
    const decision = evaluateUnclaimedGraphWork(input({ lanesReadable: false }));
    expect(decision).toMatchObject({ code: "lane-vocabulary-unreadable", action: "none", owner: "workflow-ir" });
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("refuses a human pause with no timer retry, because only a human can un-pause it", () => {
    expect(evaluateUnclaimedGraphWork(input({ task: card({ userPaused: true }) })))
      .toMatchObject({ code: "operator-held", action: "none", owner: "operator", retryAfterMs: 0 });
    expect(evaluateUnclaimedGraphWork(input({ task: card({ paused: true }) })))
      .toMatchObject({ code: "operator-held", owner: "operator" });
  });

  it("refuses a card whose planning/execution session is live", () => {
    expect(evaluateUnclaimedGraphWork(input({ liveness: "live" })))
      .toMatchObject({ code: "live-session", action: "none", owner: "live-session" });
  });

  it.each([
    ["failed", "operator"],
    ["stuck-killed", "operator"],
    ["queued", "hold-release-sweep"],
    ["needs-replan", "triage"],
    ["planning", "live-session"],
    ["awaiting-approval", "wake-seams"],
  ] as const)("answers owned-elsewhere naming the owner for status %s", (status, owner) => {
    const decision = evaluateUnclaimedGraphWork(input({ task: card({ status }) }));
    expect(decision.code).toBe("owned-elsewhere");
    expect(decision.owner).toBe(owner);
  });

  it("refuses a lane that neither plans nor executes", () => {
    const decision = evaluateUnclaimedGraphWork(input({ task: card({ column: "in-review" }) }));
    expect(decision).toMatchObject({ code: "not-planning-lane", action: "none", owner: "hold-release-sweep" });
  });

  it("refuses a card younger than the staleness floor and says when to look again", () => {
    const fresh = new Date(NOW - 30_000).toISOString();
    const decision = evaluateUnclaimedGraphWork(input({ task: card({ updatedAt: fresh }), items: [row({ updatedAt: fresh })] }));
    expect(decision.code).toBe("not-aged");
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(UNCLAIMED_GRAPH_WORK_STALENESS_MS);
  });

  it("defers every automatic repair while project auto-merge is off", () => {
    expect(evaluateUnclaimedGraphWork(input({ task: card({ autoMerge: false }) })))
      .toMatchObject({ code: "auto-merge-off", action: "none", owner: "operator" });
  });

  it("treats a card with no work item at all as owned elsewhere", () => {
    // An operator Boost creates no row; a pass inventing one here would be writing board state.
    expect(evaluateUnclaimedGraphWork(input({ items: [] })))
      .toMatchObject({ code: "owned-elsewhere", action: "none", owner: "planning-continuation-drain", itemId: undefined });
  });
});

describe("evaluateUnclaimedGraphWork — shape A (an armed planning wait)", () => {
  it("answers due-unclaimed with a redrive when the drain has demonstrably not consumed the row", () => {
    const decision = evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: PUMP_BEHIND_MS } }));
    expect(decision).toMatchObject({ code: "due-unclaimed", action: "redrive", owner: "this-pass" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(true);
  });

  it("does not read an unobservable drain as starvation — no measurement is not evidence", () => {
    // A CLI one-shot and a narrow harness never run the pump. Reading that silence as starvation would
    // rewrite the release sentence in every process that has never had a pump.
    const decision = evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: null } }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", owner: "planning-continuation-drain" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(false);
  });

  it("reports owned-elsewhere for the same row when the drain ran moments ago", () => {
    // RUFU-1050 invariant: the release seam's run promise must survive exactly this shape.
    const decision = evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: 1_000 } }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", action: "none", owner: "planning-continuation-drain" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(false);
  });

  it("reports behind-drain-window when the row never appeared in the due page", () => {
    const decision = evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: false, drainProgressAgeMs: 1_000 } }));
    expect(decision).toMatchObject({ code: "behind-drain-window", action: "none", owner: "drain-window" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(true);
  });

  it("redrives a deferral that has repeated past its own horizon", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({
        state: "retrying",
        retryAfter: new Date(NOW + 45_000).toISOString(),
        deferredSince: new Date(NOW - UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS - 1_000).toISOString(),
      })],
    }));
    expect(decision).toMatchObject({ code: "deferred-repeating", action: "redrive", owner: "this-pass" });
  });

  it("leaves a young deferral to the wake seams that stamped it", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({ state: "retrying", retryAfter: new Date(NOW + 15_000).toISOString(), deferredSince: new Date(NOW - 2_000).toISOString() })],
    }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", action: "none", owner: "wake-seams" });
  });

  it("leaves an unanchored deferral to its stamper — a repeated episode must prove its age", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({ state: "retrying", retryAfter: new Date(NOW + 45_000).toISOString(), deferredSince: null })],
    }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", owner: "wake-seams" });
  });

  it("redrives a lease that keeps extending over a row nobody has finished with", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({
        leaseOwner: "node-1",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        updatedAt: new Date(NOW - UNCLAIMED_GRAPH_WORK_LEASE_UNTOUCHED_MS - 1_000).toISOString(),
      })],
    }));
    expect(decision).toMatchObject({ code: "lease-held", action: "redrive", owner: "this-pass" });
  });

  it("never steals a live lease on a row its holder is still touching", () => {
    const touched = new Date(NOW - 10_000).toISOString();
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({ leaseOwner: "node-1", leaseExpiresAt: new Date(NOW + 60_000).toISOString(), updatedAt: touched })],
      task: card({ updatedAt: touched }),
    }));
    // The touch makes it young AND names the holder as owner; a stolen lease is worse than a wait.
    expect(decision).toMatchObject({ code: "not-aged", owner: "planning-continuation-drain" });
    const aged = evaluateUnclaimedGraphWork(input({
      items: [row({ leaseOwner: "node-1", leaseExpiresAt: new Date(NOW + 60_000).toISOString(), updatedAt: STALE })],
    }));
    expect(aged).toMatchObject({ code: "lease-held", action: "none", owner: "lease-holder" });
  });

  it("answers slot-held when another active row already owns the card's one continuation slot", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row(), row({ id: "WI-2", state: "running", nodeInstanceId: "inst-2" })],
    }));
    expect(decision).toMatchObject({ code: "slot-held", action: "none", owner: "planning-continuation-drain" });
  });

  it("keeps a capacity wait with the hold/release sweep — that row is the legitimate camera", () => {
    const decision = evaluateUnclaimedGraphWork(input({ items: [row({ waitReason: "capacity" })] }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", action: "none", owner: "hold-release-sweep" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(false);
  });

  it("routes an active row with waitReason NULL to the stranded reclaim sweep, never to this pass", () => {
    const decision = evaluateUnclaimedGraphWork(input({ items: [row({ state: "held", waitReason: null })] }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", action: "none", owner: "stranded-continuation-reclaim" });
  });

  it("spends the redrive budget on the unchanged signature and then names the outcome", () => {
    const spent = input({ episode: episodeFor("due-unclaimed", UNCLAIMED_GRAPH_WORK_MAX_REDRIVES) });
    expect(evaluateUnclaimedGraphWork(spent)).toMatchObject({ code: "due-unclaimed", action: "name-terminal", owner: "operator" });
    // A changed row id is a different episode: a repaired card must not inherit the old budget.
    const movedOn = input({ items: [row({ id: "WI-9" })], episode: episodeFor("due-unclaimed", UNCLAIMED_GRAPH_WORK_MAX_REDRIVES) });
    expect(evaluateUnclaimedGraphWork(movedOn)).toMatchObject({ action: "redrive" });
  });
});

describe("evaluateUnclaimedGraphWork — shape B/C (a terminalized row nobody can dispatch)", () => {
  const failedStepExecute = { state: "failed" as const, nodeId: "execute", nodeInstanceId: "step-execute:1", waitReason: null };

  it("classifies a WIP-lane step-execute orphan for the re-arm authority", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      task: card({ column: "in-progress" }),
      items: [row({ ...failedStepExecute, sourceColumn: "in-progress" })],
      nodeSeam: "step-execute",
    }));
    expect(decision).toMatchObject({ code: "terminal-node-orphan", action: "rearm", owner: "execution-rearm" });
    expect(unclaimedWorkMeansStarved(decision)).toBe(true);
  });

  it("routes a planning-lane execute-seam orphan to a replan rather than leaving it merely nameable", () => {
    // RUFU-1044's exact shape: `execute`, attempt 0, waitReason NULL, empty error, no audit row.
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({ ...failedStepExecute, nodeInstanceId: null })],
      nodeSeam: "execute",
    }));
    expect(decision).toMatchObject({ code: "terminal-node-orphan", action: "replan", owner: "triage" });
  });

  it("names a terminal outcome when neither an execution lane nor a durable spec exists", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      task: card({ column: "in-progress" }),
      items: [row({ ...failedStepExecute, sourceColumn: "in-progress" })],
      nodeSeam: "execute",
    }));
    expect(decision).toMatchObject({ code: "terminal-node-orphan", action: "name-terminal", owner: "operator" });
  });

  it.each(["failed", "cancelled"] as const)("treats a terminal %s row with no recovery record as a finding", (state) => {
    const decision = evaluateUnclaimedGraphWork(input({ items: [row({ ...failedStepExecute, state, nodeInstanceId: null })], nodeSeam: "execute" }));
    expect(decision).toMatchObject({ code: "terminal-node-orphan", itemState: state });
  });

  it("does NOT invent a finding when a durable recovery record already announces the failure", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [row({ ...failedStepExecute, nodeInstanceId: null })],
      nodeSeam: "execute",
      terminalRecordExists: true,
    }));
    expect(decision).toMatchObject({ code: "terminal-recorded", action: "none", owner: "operator" });
  });

  it.each([
    ["an exhausted re-arm episode", { sourceMetadata: { executionRearmEpisode: { nodeId: "execute" } } }],
    ["a re-arm exhaustion sentence", { error: "EXECUTION_REARM_EXHAUSTED: budget spent" }],
    ["a planning exhaustion sentence", { error: "PLANNING_RESEED_CYCLE_EXHAUSTED: ceiling" }],
    ["a merge-boundary park sentence", { error: "MERGE_BOUNDARY_UNPROVEN: no proof" }],
  ])("recognizes %s as a durable recovery record", (_label, patch) => {
    const decision = evaluateUnclaimedGraphWork(input({
      task: card(patch as Partial<UnclaimedGraphWorkInput["task"]>),
      items: [row({ ...failedStepExecute, nodeInstanceId: null })],
      nodeSeam: "execute",
    }));
    expect(decision.code).toBe("terminal-recorded");
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
  The mirror table, and the half that was shipping. An admission-stall episode is another sweep's DIAGNOSTIC
  badge (RUFU-273 planning admission, RUFU-393 WIP admission - RUFU-393 says of its own episode that it "is a
  state record that refuses nothing"), and an error sentence from an unrelated lane says nothing about THIS
  dead row. Counted as records, they let a card blocked from planning never get its dead execution row
  repaired: two sweeps each reading the other's badge as "somebody owns this". That is the deadlock, so the
  set of qualifying episodes is closed to the two parks that carry a budget and a named exit.
  */
  it.each([
    ["a planning-admission stall badge", { sourceMetadata: { planAdmissionStall: { code: "plan-admission-throttled", ageMs: 3 * 60 * 60_000 } } }],
    ["a WIP-admission stall badge", { sourceMetadata: { wipAdmissionStall: { stallCode: "wip-admission-throttled", stallCount: 40 } } }],
    ["an unrelated failure sentence", { error: "MERGE_CONFLICT: the branch has conflicts with main" }],
  ])("does NOT read %s as a record of this dead row", (_label, patch) => {
    const decision = evaluateUnclaimedGraphWork(input({
      task: card(patch as Partial<UnclaimedGraphWorkInput["task"]>),
      items: [row({ ...failedStepExecute, nodeInstanceId: null })],
      nodeSeam: "execute",
    }));
    expect(decision.code).toBe("terminal-node-orphan");
  });

  it("leaves a terminalized row that stopped inside the retry ladder to that ladder", () => {
    const decision = evaluateUnclaimedGraphWork(input({ items: [row({ ...failedStepExecute, attempt: 2, nodeInstanceId: null })], nodeSeam: "execute" }));
    expect(decision).toMatchObject({ code: "owned-elsewhere", action: "none", owner: "stranded-continuation-reclaim" });
  });

  it("prefers a live row over a terminal one — a card is not idle while a row is active", () => {
    const decision = evaluateUnclaimedGraphWork(input({
      items: [
        row({ ...failedStepExecute, nodeInstanceId: null }),
        row({ id: "WI-live", state: "runnable", waitReason: "planning" }),
      ],
      nodeSeam: "execute",
      drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: 1_000 },
    }));
    expect(decision.itemId).toBe("WI-live");
    expect(decision.code).toBe("owned-elsewhere");
  });

  it("picks the newest terminal row when a card carries several", () => {
    const older = new Date(NOW - 3 * 60 * 60_000).toISOString();
    const decision = evaluateUnclaimedGraphWork(input({
      items: [
        row({ id: "WI-old", state: "failed", nodeId: "execute", waitReason: null, updatedAt: older }),
        row({ id: "WI-new", state: "failed", nodeId: "execute", waitReason: null, updatedAt: STALE }),
      ],
      nodeSeam: "execute",
    }));
    expect(decision.itemId).toBe("WI-new");
  });

  it("replans a cancelled planning-lane orphan only when a durable specification exists", () => {
    const base = input({ items: [row({ state: "cancelled", nodeId: "plan-review", waitReason: null, nodeInstanceId: null })], nodeSeam: "plan-review" });
    expect(evaluateUnclaimedGraphWork(base)).toMatchObject({ action: "replan" });
    const noSpec = input({
      task: card({ hasDurableSpec: false }),
      items: [row({ state: "cancelled", nodeId: "plan-review", waitReason: null, nodeInstanceId: null })],
      nodeSeam: "plan-review",
    });
    expect(evaluateUnclaimedGraphWork(noSpec)).toMatchObject({ action: "name-terminal", owner: "operator" });
  });
});

describe("evaluateUnclaimedGraphWork — purity and lane vocabulary", () => {
  it("is a pure function of its inputs (byte-identical for two identical calls)", () => {
    const probe = input();
    expect(evaluateUnclaimedGraphWork(probe)).toEqual(evaluateUnclaimedGraphWork(probe));
  });

  it("honours a workflow whose WIP lane has its own id rather than `in-progress`", () => {
    // WF-004-style vocabulary: the seam must read the IR's roles, never a literal column name.
    const decision = evaluateUnclaimedGraphWork(input({
      task: card({ column: "building" }),
      planningColumns: new Set(["backlog"]),
      wipColumns: new Set(["building"]),
      items: [row({ state: "failed", nodeId: "execute", waitReason: null, sourceColumn: "building", nodeInstanceId: "step-execute:1" })],
      nodeSeam: "step-execute",
    }));
    expect(decision).toMatchObject({ code: "terminal-node-orphan", action: "rearm", owner: "execution-rearm" });
  });

  it("carries the FN-8592 verdict through so both owners' answers land in one record", () => {
    const decision = evaluateUnclaimedGraphWork(input({ holdRelease: { candidate: false, reason: "active-continuation" } }));
    expect(decision.holdReleaseReason).toBe("active-continuation");
  });

  it("every code in the closed set is reachable from this suite", () => {
    // Guard for the next edit: add a code, add a case above, or this fails.
    const covered: UnclaimedGraphWorkCode[] = [
      "due-unclaimed", "deferred-repeating", "lease-held", "behind-drain-window", "slot-held",
      "terminal-node-orphan", "terminal-recorded", "not-planning-lane", "lane-vocabulary-unreadable",
      "live-session", "operator-held", "auto-merge-off", "not-aged", "owned-elsewhere",
    ];
    const sources: string[] = [];
    const bodies = [
      evaluateUnclaimedGraphWork(input({ lanesReadable: false })),
      evaluateUnclaimedGraphWork(input({ task: card({ userPaused: true }) })),
      evaluateUnclaimedGraphWork(input({ liveness: "live" })),
      evaluateUnclaimedGraphWork(input({ task: card({ column: "in-review" }) })),
      evaluateUnclaimedGraphWork(input({ task: card({ updatedAt: new Date(NOW).toISOString() }) })),
      evaluateUnclaimedGraphWork(input({ task: card({ autoMerge: false }) })),
      evaluateUnclaimedGraphWork(input()),
      evaluateUnclaimedGraphWork(input({ items: [row({ state: "retrying", retryAfter: new Date(NOW + 45_000).toISOString(), deferredSince: new Date(NOW - UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS - 1).toISOString() })] })),
      evaluateUnclaimedGraphWork(input({ items: [row(), row({ id: "WI-2", state: "running" })] })),
      evaluateUnclaimedGraphWork(input({ items: [row({ leaseOwner: "node-1", leaseExpiresAt: new Date(NOW + 60_000).toISOString() })] })),
      evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: false, drainProgressAgeMs: 1_000 } })),
      evaluateUnclaimedGraphWork(input({ drain: { windowLimit: 20, reachedByDueWindow: true, drainProgressAgeMs: 1_000 } })),
      evaluateUnclaimedGraphWork(input({ task: card({ column: "in-progress" }), items: [row({ ...failedStepExecuteC(), sourceColumn: "in-progress" })], nodeSeam: "step-execute" })),
      evaluateUnclaimedGraphWork(input({ items: [row({ ...failedStepExecuteC(), nodeInstanceId: null })], nodeSeam: "execute", terminalRecordExists: true })),
      evaluateUnclaimedGraphWork(input({ task: card({ status: "failed" }) })),
    ];
    for (const body of bodies) sources.push(body.code);
    for (const code of covered) {
      expect(sources, `code ${code} has no case in this suite`).toContain(code);
    }
    // `unreadable` is the seam's not-yet-reached leg: no caller can produce it until a read fails.
    expect(covered).not.toContain("unreadable");
  });
});

function failedStepExecuteC() {
  return { state: "failed" as const, nodeId: "execute", waitReason: null, nodeInstanceId: "step-execute:1" };
}

/** Kept so a future widening of the staleness floor fails loudly rather than silently re-tuning thresholds. */
describe("unclaimed-graph-work constants", () => {
  it("keeps the redrive budget small enough that a stall cannot loop forever", () => {
    expect(UNCLAIMED_GRAPH_WORK_MAX_REDRIVES).toBeLessThanOrEqual(5);
    expect(UNCLAIMED_GRAPH_WORK_STALENESS_MS).toBeGreaterThan(0);
  });
});
