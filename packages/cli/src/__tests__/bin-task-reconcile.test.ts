// @vitest-environment node

/*
FNXC:LandedTruthReopen 2026-11-06-10:50 (RUFU-702):
`fn task reconcile --reopen` is the only door through which a card sitting in a terminal lane can be put
back on a path, and the reason it needs pinning at the CLI is that the CLI is where the authority lives:
the automatic census may only REPORT (lifecycle containment, FN-207/FN-217, forbids an automatic move
backward out of a terminal lane), so an operator's explicit instruction is the sole thing that may move
one. These cases pin three separate promises, all of which were free before this flag existed and any of
which could silently regress:

1. the flag reaches the reopen seam and ONLY the reopen seam — one named card, no reconcile pass, no sweep;
2. without the flag the command still only reconciles, and a card the repository refuses is never reported
   as complete (`reconcileLandedReviewTask` would otherwise answer `already-complete` for it);
3. the arms that must NOT move a card — a proven delivery, an unreadable repository — say so and exit
   nonzero or zero as the fact deserves, never as a move.

Only the fence is stubbed, at its construction, so the CLI's own outcome-to-sentence mapping is the subject;
the measurement itself is pinned against real git in
`packages/engine/src/__tests__/landed-truth-census.real-git.test.ts`.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTaskReconcileArgs, runTaskReconcile } from "../commands/task.js";

const reconcileLandedReviewTask = vi.hoisted(() => vi.fn());
const describeLandedTruth = vi.hoisted(() => vi.fn());
const reopenUnprovenLandedTask = vi.hoisted(() => vi.fn());
const reconcileManagerCtor = vi.hoisted(() => vi.fn());
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@fusion/engine", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/engine")>();
  return {
    ...actual,
    SelfHealingManager: reconcileManagerCtor,
  };
});

vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  closeProjectStore: closeProjectStoreMock,
  createLocalStore: vi.fn(async () => ({})),
  asLocalProjectContext: vi.fn(() => ({
    projectId: "project-1",
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store: {},
  })),
}));

const EXIT_SENTINEL = "process-exit";

let logLines: string[];
let errorLines: string[];

beforeEach(() => {
  logLines = [];
  errorLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code });
  }) as typeof process.exit);
  resolveProjectMock.mockResolvedValue({
    projectId: "project-1",
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store: { close: vi.fn(async () => undefined) },
  });
  reconcileManagerCtor.mockImplementation(function (this: Record<string, unknown>) {
    this.reconcileLandedReviewTask = reconcileLandedReviewTask;
    this.describeLandedTruth = describeLandedTruth;
    this.reopenUnprovenLandedTask = reopenUnprovenLandedTask;
  });
  // The neutral answer: a review-lane card, which neither arm acts on.
  describeLandedTruth.mockResolvedValue({ state: "not-in-complete-lane", column: "in-review" });
});

afterEach(() => {
  vi.restoreAllMocks();
  reconcileLandedReviewTask.mockReset();
  describeLandedTruth.mockReset();
  reopenUnprovenLandedTask.mockReset();
});

async function run(args: { id: string; reopen?: boolean }): Promise<{ exitCode?: number }> {
  try {
    await runTaskReconcile(args.id, "current-project", { reopen: args.reopen === true });
    return {};
  } catch (error) {
    const err = error as Error & { exitCode?: number };
    if (err?.message === EXIT_SENTINEL) return { exitCode: err.exitCode };
    throw error;
  }
}

const REFUSED_VERDICT = {
  state: "refused",
  sentence: "RUFU-294 is marked landed on `main`, but `62804b43` is not reachable from it, its recorded content is not on it, and merging it today would conflict (238 conflicts).",
  integrationBranch: "main",
  recordedSha: "62804b4340a3ac40e7d1e94216782e1d75b168d3",
  branchRef: "fusion/rufu-294",
  refusalCode: "commit-not-on-integration-branch",
  conflictCount: 238,
};

describe("fn task reconcile argument parsing", () => {
  it("reads --reopen as an operator instruction attached to exactly one named card", () => {
    expect(parseTaskReconcileArgs(["RUFU-294", "--reopen"])).toEqual({ id: "RUFU-294", reopen: true });
    expect(parseTaskReconcileArgs(["RUFU-294"])).toEqual({ id: "RUFU-294", reopen: false });
    // A flag with no card is not a card with a flag: the usage refusal, never a sweep-wide reopen.
    expect(parseTaskReconcileArgs([]).id).toBeNull();
    expect(parseTaskReconcileArgs(["   "]).id).toBeNull();
  });
});

describe("fn task reconcile --reopen", () => {
  it("reopens exactly the named card through the reopen seam and never the reconcile fence", async () => {
    reopenUnprovenLandedTask.mockResolvedValue({
      outcome: "reopened",
      fromColumn: "done",
      toColumn: "todo",
      integrationBranch: "main",
      recordedSha: REFUSED_VERDICT.recordedSha,
      branchRef: "fusion/rufu-294",
      refusalCode: "commit-not-on-integration-branch",
      conflictCount: 238,
    });

    const { exitCode } = await run({ id: "RUFU-294", reopen: true });

    expect(reopenUnprovenLandedTask).toHaveBeenCalledTimes(1);
    expect(reopenUnprovenLandedTask).toHaveBeenCalledWith("RUFU-294");
    expect(reconcileLandedReviewTask).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    const printed = logLines.join("\n");
    expect(printed).toContain("Reopened RUFU-294: done → todo");
    expect(printed).toContain("commit-not-on-integration-branch");
    // The work's whereabouts are named, because the reopen clears the false claim and the branch is all
    // that is left of the delivery: an operator must be able to see what survives the move.
    expect(printed).toContain("fusion/rufu-294");
    expect(errorLines).toEqual([]);
  });

  it("refuses to reopen a card whose delivery IS proven, and says the board is right", async () => {
    reopenUnprovenLandedTask.mockResolvedValue({ outcome: "proven", integrationBranch: "main", proofKind: "squash-commit-recorded" });

    const { exitCode } = await run({ id: "RUFU-294", reopen: true });

    expect(exitCode).toBe(0);
    const printed = logLines.join("\n");
    expect(printed).toContain("stays closed");
    expect(printed).toContain("squash-commit-recorded");
    expect(errorLines).toEqual([]);
    expect(reconcileLandedReviewTask).not.toHaveBeenCalled();
  });

  it("treats an unreadable repository as no evidence at all, so nothing moves", async () => {
    reopenUnprovenLandedTask.mockResolvedValue({ outcome: "deferred", reason: "integration-ref-unreadable" });

    const { exitCode } = await run({ id: "RUFU-294", reopen: true });

    expect(exitCode).toBe(1);
    const printed = errorLines.join("\n");
    expect(printed).toContain("could not be measured");
    expect(printed).toContain("not evidence of a false landing");
    expect(logLines.join("\n")).not.toContain("Reopened");
  });

  it("names the fence that stopped the move instead of printing a bare reason code", async () => {
    reopenUnprovenLandedTask.mockResolvedValue({ outcome: "refused", reason: "no-reopen-target" });

    const { exitCode } = await run({ id: "RUFU-294", reopen: true });

    expect(exitCode).toBe(1);
    expect(errorLines.join("\n")).toContain("no planning lane");
  });
});

describe("fn task reconcile without --reopen still only reconciles", () => {
  it("never touches the reopen seam", async () => {
    reconcileLandedReviewTask.mockResolvedValue({
      outcome: "reconciled",
      sha: "abcdef1234567890",
      strategy: "squash",
      baseBranch: "main",
    });

    const { exitCode } = await run({ id: "RUFU-294" });

    expect(reopenUnprovenLandedTask).not.toHaveBeenCalled();
    expect(reconcileLandedReviewTask).toHaveBeenCalledTimes(1);
    expect(exitCode).toBeUndefined();
    expect(logLines.join("\n")).toContain("Reconciled RUFU-294");
  });

  it("prints the landing refusal for a card in a terminal lane rather than calling it complete", async () => {
    // The disagreement this card exists to close: `reconcileLandedReviewTask` answers `already-complete`
    // for a done card, which is precisely the sentence RUFU-294 wore for three weeks.
    describeLandedTruth.mockResolvedValue(REFUSED_VERDICT);
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "already-complete" });

    const { exitCode } = await run({ id: "RUFU-294" });

    expect(reconcileLandedReviewTask).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    const printed = errorLines.join("\n");
    expect(printed).toContain("238 conflicts");
    expect(printed).toContain("fn task reconcile RUFU-294 --reopen");
    expect(logLines.join("\n")).not.toContain("already complete");
  });

  it("changes nothing when the truth cannot be measured", async () => {
    // A deferred verdict must not alter the command's behavior — an unreadable repository may not
    // manufacture a delivery failure at the operator's terminal any more than in the merge lane.
    describeLandedTruth.mockResolvedValue({ state: "deferred", reason: "integration-ref-unreadable" });
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "already-complete" });

    const { exitCode } = await run({ id: "RUFU-294" });

    expect(reconcileLandedReviewTask).toHaveBeenCalledTimes(1);
    expect(exitCode).toBeUndefined();
    expect(logLines.join("\n")).toContain("already complete");
  });
});
