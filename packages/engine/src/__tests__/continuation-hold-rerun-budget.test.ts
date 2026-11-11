import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:ContinuationHoldBudget 2026-11-11-09:52 (RUFU-490):
The bounded, re-armable hold ledger for the `active-continuation` arm. Every case here is the shape
RUFU-452's own scope note routed to this card: a refusal the verdictless budget cannot see because
the lane returns it BEFORE reading any verdict. The assertions come in two halves — the cost the
ledger must impose (one line per distinct abandoned holder, then a refusal that skips the write),
and the cost it must never impose (one line per pass on a legitimately-held slot, which is the
steady state that produced 1,822 lines on one card in six hours).
*/

const core = vi.hoisted(() => ({
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  evaluatePreMergeApprovals: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...((await importOriginal() as typeof import("@fusion/core"))),
  ...core,
}));

import {
  classifyContinuationHolderOwnership,
  continuationHoldGateEpisodeResetMarker,
  continuationHoldGatePatienceLogMarker,
  continuationHoldGateRerunLogMarker,
  continuationHoldHolderKey,
  CONTINUATION_HOLD_GATE_PATIENCE_MS,
  filterContinuationHoldLedgerGates,
  MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS,
  openContinuationHoldRerunEpisode,
  readContinuationHoldLedger,
  recordContinuationHoldRefusal,
  resolveContinuationHoldHolder,
  rerouteUnrunPreMergeGateToReview,
  verdictlessGateEpisodeResetMarker,
  verdictlessGateRerunLogMarker,
} from "../merge/pre-merge-gate-reseed.js";
import { rerouteWorkspaceReviewToCodeReview } from "../merge/workspace-review-reroute.js";

const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any;
const required = new Set(["security-review", "code-review"]);
/*
 * Clocks anchor to the REAL clock rather than a fixed instant: the lanes call `Date.now()` themselves,
 * so a fixture anchored to a constant ages past the 30-minute patience floor as the real clock moves
 * and silently flips an "owned" holder into an abandoned one (this test file was green at 10:0x UTC and
 * red an hour later for exactly that reason). `NOW` is the explicit `now` the predicate tests pass, and
 * it shares the anchor, so the ±60 s floor-margin cases stay exact.
 */
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const subject = (overrides: Record<string, unknown> = {}) => ({
  id: "RUFU-478",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  ...overrides,
}) as any;

/**
 * A live continuation holding the seed slot. Default shape is the ABANDONED one the ledger charges:
 * `runnable`, every ownership field null, and a clock older than the patience floor.
 */
function holder(overrides: Record<string, unknown> = {}) {
  return {
    id: "wi-1",
    runId: "run-1",
    nodeId: "step-execute",
    state: "runnable",
    leaseOwner: null,
    leaseExpiresAt: null,
    waitReason: null,
    retryAfter: null,
    deferredSince: null,
    createdAt: iso(-90 * 60_000),
    updatedAt: iso(-60 * 60_000),
    ...overrides,
  } as any;
}

/**
 * The store fake the lanes need. `log` is the DURABLE row's log — `logEntry` appends to the very
 * array `getTask` hands back, so a second pass sees the strikes the first pass wrote. `projection`
 * is the slim board row the lane is called with, whose `log` the ledger must never consult.
 */
function store(options: {
  seeded?: boolean;
  seedReason?: "active-continuation" | "workflow-selection-changed";
  items?: unknown[];
  log?: Array<{ action: string }>;
  getTaskThrows?: boolean;
  selectedStepIds?: string[];
} = {}) {
  const log = options.log ?? [];
  // Mutable so a test can swap the standing holder between passes and watch the lane re-derive it.
  const items = options.items ?? [];
  const storeFake = {
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => (
      options.seeded === false
        ? { seeded: false as const, reason: options.seedReason ?? "active-continuation" as const }
        : { seeded: true as const }
    )),
    getTask: vi.fn(async () => {
      if (options.getTaskThrows) throw new Error("durable row unreadable");
      return { log };
    }),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-1", stepIds: options.selectedStepIds ?? ["code-review"] })),
    logEntry: vi.fn(async (_taskId: string, action: string) => { log.push({ action }); }),
    moveTask: vi.fn(),
  } as any;
  return { store: storeFake, log, items };
}

const holdLines = (log: Array<{ action: string }>) =>
  log.filter((entry) => entry.action.startsWith(continuationHoldGateRerunLogMarker("code-review")));
const patienceLines = (log: Array<{ action: string }>) =>
  log.filter((entry) => entry.action.startsWith(continuationHoldGatePatienceLogMarker("code-review")));

beforeEach(() => {
  // The `missing` target class keeps this lane off the verdictless budget, so `getTask` is called
  // ONLY for a hold ledger the test below asks for — the zero-extra-cost claim, made observable.
  core.evaluatePreMergeApprovals.mockReturnValue([
    { workflowStepId: "security-review", state: "passed" },
    { workflowStepId: "code-review", state: "missing" },
  ]);
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "step-execute", kind: "step-execute", column: "in-progress", config: {} },
      { id: "security-review", kind: "step-review", column: "in-review", config: {} },
      { id: "code-review", kind: "step-review", column: "in-review", config: {} },
    ],
  });
});

describe("continuation-hold ownership predicate", () => {
  it("charges only a runnable/retrying row that no lane is serving", () => {
    // The abandoned shape: due, unleased, no wait reason, no ladder, older than the floor.
    expect(classifyContinuationHolderOwnership(holder(), NOW)).toBe("unowned");
    expect(classifyContinuationHolderOwnership(holder({ state: "retrying" }), NOW)).toBe("unowned");
  });

  it("returns owned for every condition some lane owns", () => {
    // A claimed attempt and a blockedReason-owned hold are both spoken for elsewhere; the sweep's
    // own rule is that the scheduler due-poll selects ONLY runnable/retrying.
    expect(classifyContinuationHolderOwnership(holder({ state: "running" }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ state: "held", blockedReason: "workflow-principal-missing" } as any), NOW)).toBe("owned");
    // Live lease, capacity/admission wait, the ladder's current rung, and the deferral anchor.
    expect(classifyContinuationHolderOwnership(holder({ leaseOwner: "agent-1", leaseExpiresAt: iso(+5 * 60_000) }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ waitReason: "capacity" }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ retryAfter: iso(+30_000) }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ deferredSince: iso(-2 * 60 * 60_000) }), NOW)).toBe("owned");
  });

  it("treats a lease whose expiry has passed as the abandoned shape, not as a claim", () => {
    expect(classifyContinuationHolderOwnership(holder({ leaseOwner: "agent-1", leaseExpiresAt: iso(-60_000) }), NOW)).toBe("unowned");
  });

  it("applies the patience floor on the row's own clock and fails open when no clock is readable", () => {
    expect(classifyContinuationHolderOwnership(holder({ updatedAt: iso(-(CONTINUATION_HOLD_GATE_PATIENCE_MS - 60_000)) }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ updatedAt: iso(-(CONTINUATION_HOLD_GATE_PATIENCE_MS + 60_000)) }), NOW)).toBe("unowned");
    // createdAt is the documented fallback, not a second opinion.
    expect(classifyContinuationHolderOwnership(holder({ updatedAt: "", createdAt: iso(-60_000) }), NOW)).toBe("owned");
    // An absent clock is never read as infinitely stale — that default would sentence on nothing.
    expect(classifyContinuationHolderOwnership(holder({ updatedAt: "", createdAt: "" }), NOW)).toBe("owned");
    expect(classifyContinuationHolderOwnership(holder({ updatedAt: "not-a-date", createdAt: "not-a-date" }), NOW)).toBe("owned");
  });

  it("identifies the holder across nodes, because the seed fence refuses task-wide", async () => {
    // The measured GEDA-1112 shape: the refusal names `code-review`, the only active row is on
    // `step-execute`. A node-restricted holder would be null here and the class would stay unbounded.
    const offNode = holder({ id: "wi-exec" });
    expect(resolveContinuationHoldHolder([offNode], "code-review")?.id).toBe("wi-exec");
    // The target node wins when it has a live row, and ties break on the newest clock.
    const onNode = holder({ id: "wi-review", nodeId: "code-review", updatedAt: iso(-70 * 60_000) });
    expect(resolveContinuationHoldHolder([offNode, onNode], "code-review")?.id).toBe("wi-review");
    expect(resolveContinuationHoldHolder([
      holder({ id: "wi-old", updatedAt: iso(-90 * 60_000) }),
      holder({ id: "wi-new", updatedAt: iso(-45 * 60_000) }),
    ], "code-review")?.id).toBe("wi-new");
    // No active row at all is a pure race, not a holder.
    expect(resolveContinuationHoldHolder([holder({ state: "succeeded" })], "code-review")).toBeNull();
    expect(continuationHoldHolderKey({ id: "", runId: "run-9" })).toBe("run-9");
  });
});

describe("continuation-hold ledger tally", () => {
  it("counts distinct holders, respects its own episode marker, and ignores the verdictless pair", async () => {
    const log = [
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-a' hold 1 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-b' hold 2 of 3` },
      // A marker written for ANOTHER gate resets nothing here.
      { action: `${continuationHoldGateEpisodeResetMarker("security-review")} re-armed` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-b' hold 2 of 3` },
      { action: `${verdictlessGateRerunLogMarker("code-review")} verdict-less failure (rerun 1 of 3)` },
    ];
    const { store: storeFake } = store({ log });
    await expect(readContinuationHoldLedger(storeFake, "RUFU-478", "code-review")).resolves.toEqual({
      struckHolderKeys: ["wi-a", "wi-b"],
      patienceLineCount: 0,
    });

    const reArmed = [
      ...log,
      { action: `${continuationHoldGateEpisodeResetMarker("code-review")} re-armed` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-c' hold 1 of 3` },
      { action: `${continuationHoldGatePatienceLogMarker("code-review")} budget spent` },
    ];
    const reArmStore = store({ log: reArmed });
    await expect(readContinuationHoldLedger(reArmStore.store, "RUFU-478", "code-review")).resolves.toEqual({
      struckHolderKeys: ["wi-c"],
      patienceLineCount: 1,
    });
  });

  it("keeps every marker a distinct prefix so one ledger can never satisfy another's boundary", () => {
    const markers = [
      verdictlessGateRerunLogMarker("code-review"),
      verdictlessGateEpisodeResetMarker("code-review"),
      continuationHoldGateRerunLogMarker("code-review"),
      continuationHoldGatePatienceLogMarker("code-review"),
      continuationHoldGateEpisodeResetMarker("code-review"),
    ];
    for (const a of markers) {
      for (const b of markers) {
        if (a === b) continue;
        expect(a.startsWith(b), `${a} must not start with ${b}`).toBe(false);
      }
    }
  });

  it("re-arms only gates whose ledger holds a line, and writes nothing for an untouched gate", async () => {
    const struck = [
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-a' hold 1 of 3` },
    ];
    const { store: storeFake, log } = store({ log: [...struck] });
    await expect(filterContinuationHoldLedgerGates(storeFake, "RUFU-478", ["code-review", "security-review"]))
      .resolves.toEqual(["code-review"]);
    expect(await openContinuationHoldRerunEpisode(storeFake, "RUFU-478", [])).toEqual([]);
    expect(log).toHaveLength(struck.length);

    const opened = await openContinuationHoldRerunEpisode(storeFake, "RUFU-478", ["code-review"]);
    expect(opened).toEqual(["code-review"]);
    expect(log[log.length - 1]!.action).toContain(continuationHoldGateEpisodeResetMarker("code-review"));
    // The re-arm is an episode boundary, so the same strikes now read as zero charges.
    await expect(readContinuationHoldLedger(storeFake, "RUFU-478", "code-review")).resolves.toEqual({
      struckHolderKeys: [],
      patienceLineCount: 0,
    });
  });

  it("refuses to re-arm on a ledger it could not read", async () => {
    const { store: storeFake } = store({ getTaskThrows: true });
    await expect(filterContinuationHoldLedgerGates(storeFake, "RUFU-478", ["code-review"])).resolves.toEqual([]);
  });
});

describe("recordContinuationHoldRefusal noise discipline", () => {
  const abandoned = holder({ id: "wi-a" });

  it("writes nothing for an owned holder, a holder already struck, or no holder at all", async () => {
    const { store: storeFake, log } = store({});
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", holder({ updatedAt: iso(-60_000) }), { struckHolderKeys: [], patienceLineCount: 0 }, NOW))
      .resolves.toBe("holder-owned");
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", abandoned, { struckHolderKeys: ["wi-a"], patienceLineCount: 0 }, NOW))
      .resolves.toBe("holder-already-struck");
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", null, { struckHolderKeys: [], patienceLineCount: 0 }, NOW))
      .resolves.toBe("no-holder");
    expect(log).toHaveLength(0);
  });

  it("numbers one strike per distinct holder and never repeats it across consecutive rejections", async () => {
    const { store: storeFake, log } = store({});
    const empty = { struckHolderKeys: [], patienceLineCount: 0 };
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", holder({ id: "wi-a" }), empty, NOW))
      .resolves.toBe("struck");
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", holder({ id: "wi-b" }), { struckHolderKeys: ["wi-a"], patienceLineCount: 0 }, NOW))
      .resolves.toBe("struck");
    expect(holdLines(log).map((entry) => entry.action)).toEqual([
      expect.stringContaining("holder 'wi-a' hold 1 of 3"),
      expect.stringContaining("holder 'wi-b' hold 2 of 3"),
    ]);
    expect(holdLines(log)[2]).toBeUndefined();
  });

  it("writes the exhaustion line once, and never a fourth strike", async () => {
    const spent = { struckHolderKeys: ["wi-a", "wi-b", "wi-c"], patienceLineCount: 0 };
    const { store: storeFake, log } = store({});
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", holder({ id: "wi-d" }), spent, NOW))
      .resolves.toBe("exhausted");
    expect(patienceLines(log)).toHaveLength(1);
    expect(holdLines(log)).toHaveLength(0);
    expect(log[0]!.action).toContain("wi-a, wi-b, wi-c");
    // The once-per-episode guard: a second pass on the same spent ledger writes nothing.
    await expect(recordContinuationHoldRefusal(storeFake, subject(), "code-review", holder({ id: "wi-d" }), { ...spent, patienceLineCount: 1 }, NOW))
      .resolves.toBe("exhausted");
    expect(patienceLines(log)).toHaveLength(1);
  });
});

describe("unrun-gate lane continuation-hold budget", () => {
  it("costs nothing when the holder is legitimately held, and reads no durable log to learn it", async () => {
    const { store: storeFake, log } = store({ seeded: false, items: [holder({ updatedAt: iso(-40_000) })] });
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });
    // The seed is still attempted every pass, exactly as before this ledger existed.
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(log).toHaveLength(0);
    expect(storeFake.getTask).not.toHaveBeenCalled();
  });

  it("writes one line for an abandoned holder and stops re-attempting the write while it stands", async () => {
    const { store: storeFake, log } = store({ seeded: false, items: [holder()] });
    for (let pass = 0; pass < 6; pass += 1) {
      await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
        requiredPreMergeStepIds: required, mergeContent: singular,
      })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation" });
    }
    // The filed symptom was one doomed optimistic-concurrency write per pass; the struck holder's
    // second and later passes return the same transient refusal without attempting it again.
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(holdLines(log)).toHaveLength(1);
    expect(holdLines(log)[0]!.action).toContain("holder 'wi-1' hold 1 of 3");
    expect(patienceLines(log)).toHaveLength(0);
  });

  it("re-attempts the write for a replacement holder and charges it separately", async () => {
    const { store: storeFake, log, items } = store({ seeded: false, items: [holder()] });
    for (let pass = 0; pass < 2; pass += 1) {
      await rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
        requiredPreMergeStepIds: required, mergeContent: singular,
      });
    }
    // The abandoned holder is replaced by a different abandoned holder: a new fact, so the write runs
    // again and earns its own strike — this is why the skip is keyed on the holder, not on the gate.
    items.splice(0, items.length, holder({ id: "wi-2" }));
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation" });
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(2);
    expect(holdLines(log).map((line) => line.action.match(/holder '([^']*)'/)?.[1])).toEqual(["wi-1", "wi-2"]);
  });

  it("refuses the fenced write outright once three distinct holders have been abandoned", async () => {
    const log = [
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-a' hold 1 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-b' hold 2 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-c' hold 3 of 3` },
    ];
    const { store: storeFake } = store({ seeded: false, items: [holder({ id: "wi-d" })], log });
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "continuation-hold-budget-exhausted", nodeId: "code-review" });
    // The refusal skips the optimistic-concurrency write it knows will decline.
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(patienceLines(log)).toHaveLength(1);
    expect(log).toHaveLength(4);
  });

  it("carries no lifetime latch: an owned holder, a replacement, or a cleared slot seeds again", async () => {
    const spentLog = [
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-a' hold 1 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-b' hold 2 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-c' hold 3 of 3` },
    ];
    // The holder became a live claim — the exhaustion re-derives and the seed runs again.
    const owned = store({ seeded: true, items: [holder({ state: "running" })], log: [...spentLog] });
    await expect(rerouteUnrunPreMergeGateToReview(owned.store, subject(), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });

    // The slot cleared entirely: no holder, no ledger read, no line.
    const cleared = store({ seeded: true, items: [], log: [...spentLog] });
    await expect(rerouteUnrunPreMergeGateToReview(cleared.store, subject(), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(cleared.log).toHaveLength(spentLog.length);
  });

  it("charges nothing when the seed declines with no active row to name", async () => {
    const { store: storeFake, log } = store({ seeded: false, items: [] });
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation" });
    expect(log).toHaveLength(0);
  });

  it("preserves the workflow-selection refusal ahead of any hold charge", async () => {
    const { store: storeFake, log } = store({ seeded: false, seedReason: "workflow-selection-changed", items: [holder()] });
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject(), {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
      expectedWorkflowSelection: { workflowId: "wf-1", stepIds: ["code-review"] },
    })).resolves.toMatchObject({ rerouted: false, reason: "workflow-selection-changed" });
    expect(log).toHaveLength(0);
  });

  it("stays fail-closed on an unreadable durable row instead of charging on nothing", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "code-review", state: "failed", verdictLessFailed: true },
    ]);
    const { store: storeFake } = store({ seeded: false, items: [holder()], getTaskThrows: true });
    await expect(rerouteUnrunPreMergeGateToReview(storeFake, subject({
      workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }],
    }), { requiredPreMergeStepIds: required, mergeContent: singular })).rejects.toThrow("durable row unreadable");
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });
});

describe("workspace review reroute continuation-hold budget", () => {
  const workspaceSubject = (overrides: Record<string, unknown> = {}) => ({
    id: "RUFU-478",
    column: "in-review",
    autoMerge: true,
    ...overrides,
  }) as any;

  it("refuses the re-entry write once the hold ledger is spent, and says so once", async () => {
    const log = [
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-a' hold 1 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-b' hold 2 of 3` },
      { action: `${continuationHoldGateRerunLogMarker("code-review")} holder 'wi-c' hold 3 of 3` },
    ];
    const { store: storeFake } = store({ seeded: false, items: [holder({ id: "wi-d", nodeId: "code-review" })], log });
    await expect(rerouteWorkspaceReviewToCodeReview(storeFake, workspaceSubject()))
      .resolves.toEqual({ rerouted: false, reason: "continuation-hold-budget-exhausted" });
    expect(storeFake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(patienceLines(log)).toHaveLength(1);
  });

  it("leaves a held workspace slot refusing quietly, one line per abandoned holder", async () => {
    const { store: storeFake, log } = store({ seeded: false, items: [holder({ nodeId: "code-review" })] });
    await expect(rerouteWorkspaceReviewToCodeReview(storeFake, workspaceSubject()))
      .resolves.toEqual({ rerouted: false, reason: "active-continuation" });
    await expect(rerouteWorkspaceReviewToCodeReview(storeFake, workspaceSubject()))
      .resolves.toEqual({ rerouted: false, reason: "active-continuation" });
    expect(holdLines(log)).toHaveLength(1);

    const freshHolder = store({ seeded: false, items: [holder({ updatedAt: iso(-10_000) })] });
    await expect(rerouteWorkspaceReviewToCodeReview(freshHolder.store, workspaceSubject()))
      .resolves.toEqual({ rerouted: false, reason: "active-continuation" });
    expect(freshHolder.log).toHaveLength(0);
  });
});

describe("budget constants", () => {
  it("bounds three distinct holders and waits a patience window before calling a row abandoned", () => {
    expect(MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS).toBe(3);
    expect(CONTINUATION_HOLD_GATE_PATIENCE_MS).toBe(30 * 60_000);
  });
});
