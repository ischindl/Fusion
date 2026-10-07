import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC: "Plan approved but spec lock unavailable:",
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  evaluatePreMergeApprovals: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
}));
/*
FNXC:LifecycleContainment 2026-09-02-22:41:
RUFU-178: the re-seed now clamps its targetColumn through the SHARED core helper, so the module
mock keeps the real `clampReviewGateEntry` — a hand-cloned fake would let the seed and the column
boundary drift while the suite stayed green, which is the whole failure mode the extraction removed.
*/
vi.mock("@fusion/core", async (importOriginal) => ({
  ...((await importOriginal() as typeof import("@fusion/core"))),
  ...core,
}));

import {
  MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS,
  rerouteFailedNoVerdictPreMergeGateToReview,
  rerouteUnrunPreMergeGateToReview,
  verdictlessGateRerunLogMarker,
} from "../merge/pre-merge-gate-reseed.js";
// Real core class (the module mock spreads importOriginal), so the throw below is the production error.
import { TaskNotFoundError } from "@fusion/core";

const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any;
const subject = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9243",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  ...overrides,
}) as any;

/*
FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-449, RUFU-452):
The re-seed lanes count their durable rerun budget from task-log markers, so the shared fake must expose
both halves of that seam: `getTask` for the DURABLE row the counter reads, and `logEntry` for the marker
written after a seed lands. RUFU-452 moved the source of truth: `log` on the task is a board PROJECTION
and is never consulted, so a budget test states its strikes through `storeWithDurableLog(...)` and keeps
the projection slim (`log: []`) the way `listTasks({ slim: true })` hands it over. A fixture that puts
strikes only on the projection now asserts the opposite claim.
*/
function store(seeded = true) {
  return {
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
    getTask: vi.fn(async () => null),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(),
  } as any;
}

const required = new Set(["security-review", "code-review"]);

beforeEach(() => {
  core.evaluatePreMergeApprovals.mockReturnValue([
    { workflowStepId: "security-review", state: "missing" },
    { workflowStepId: "code-review", state: "missing" },
  ]);
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "optional-group", column: "in-progress", config: {} },
      { id: "code-review", kind: "step-review", column: "in-review", config: {} },
    ],
  });
});

describe("unrun pre-merge gate reseed", () => {
  it.each(["output", "notes"])("does not redispatch deterministic plan-lock failures carried in %s", async (field) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{
      workflowStepId: "security-review", reviewKind: "plan", status: "failed",
      [field]: "Plan approved but spec lock unavailable: mission-missing (mission).",
    }] });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required, mergeContent: singular,
      })).rerouted).toBe(false);
    }
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it.each([rerouteUnrunPreMergeGateToReview, rerouteFailedNoVerdictPreMergeGateToReview])("never seeds pre-merge work after landing", async (reroute) => {
    const fake = store();
    const task = subject({ mergeDetails: { mergeConfirmed: true }, workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }] });
    expect((await reroute(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("bounds consecutive failed no-verdict attempts without discarding evidence", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", phase: "pre-merge", status: "failed" };
    const task = subject({ workflowStepResults: [{ ...failure, priorAttempts: [failure, failure, failure] }] });
    const before = structuredClone(task);
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("allows recovery for new review input despite old failure history", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", status: "failed", reviewInputFingerprint: "old" };
    const task = subject({ workflowStepResults: [{ ...failure, reviewInputFingerprint: "new", priorAttempts: [failure, failure, failure] }] });
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(true);
  });

  it("seeds the earliest missing gate without mutating review evidence or moving the card", async () => {
    const task = subject();
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "security-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-progress",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it.each([
    ["undefined results", subject({ workflowStepResults: undefined }), required, singular, "seeded"],
    ["empty results", subject({ workflowStepResults: [] }), required, singular, "seeded"],
    ["all reported", subject(), required, singular, "no-unrun-gate"],
    ["no enabled gates", subject(), new Set<string>(), singular, "no-unrun-gate"],
    ["workspace content", subject(), required, { kind: "workspace" }, "not-singular"],
    ["workspace task", subject({ workspaceWorktrees: {} }), required, singular, "not-singular"],
    ["operator hold", subject({ paused: true }), required, singular, "operator-held"],
  ] as const)("declines %s without writes", async (_label, task, requiredIds, content, reason) => {
    if (reason === "no-unrun-gate" && requiredIds.size > 0) core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
    const before = structuredClone(task);
    const fake = store();
    const result = await rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: requiredIds, mergeContent: content as any });
    expect(result.reason).toBe(reason);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("preserves last-result semantics and marks a raced seed as an active continuation", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "missing" },
    ]);
    const task = subject({ workflowStepResults: [{ workflowStepId: "security-review", status: "failed" }, { workflowStepId: "security-review", status: "passed", verdict: "APPROVE" }] });
    const before = structuredClone(task);
    const fake = store(false);
    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("declines a missing gate absent from the workflow route", async () => {
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "no-review-route" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:LifecycleContainment 2026-09-02-22:41:
  RUFU-178 (the RUFU-172 wedge): the gate the re-seed picks can be authored in a LATER lane the card
  has already passed. The continuation must never name that column — the boundary enters backward
  review-gate moves in place, so the seed names the card's current column instead.
  */
  it("clamps a planning-lane plan-review gate to the review lane the card stands in", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([{ workflowStepId: "plan-review", state: "missing" }]);
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({
      name: "Coding",
      columns: [
        { id: "todo", name: "Ready", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
      ],
      nodes: [{ id: "plan-review", kind: "optional-group", column: "todo", config: {} }],
    });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: new Set(["plan-review"]), mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "plan-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "plan-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-review",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
  });

  it("keeps the node column for a forward review-gate entry", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([{ workflowStepId: "code-review", state: "missing" }]);
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({
      name: "Coding",
      columns: [
        { id: "in-progress", name: "WIP", traits: [{ trait: "wip", config: {} }] },
        { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
      ],
      nodes: [{ id: "code-review", kind: "step-review", column: "in-review", config: {} }],
    });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject({ column: "in-progress" }), { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "code-review", sourceColumn: "in-progress", targetColumn: "in-review",
    }));
  });

  it("re-seeds exactly a failed no-verdict code review while retaining its finding evidence", async () => {
    const task = subject({
      steps: [{ name: "Documentation & Delivery", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      nodeId: "code-review",
      runId: expect.stringContaining("failed-no-verdict-pre-merge-gate-reseed"),
    }));
    expect(task).toEqual(before);
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]).toMatchObject({ status: "done" });
  });

  it.each([
    ["a real REVISE", { status: "failed", verdict: "REVISE" }],
    ["a pending result", { status: "pending" }],
    ["a bypassed result", { status: "skipped", bypassedBy: "operator" }],
    ["a post-merge result", { status: "failed", phase: "post-merge" }],
  ])("does not re-run %s", async (_label, result) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", ...result }] });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-09-30-14:34 (RUFU-449):
  Invariant, not repro: a required gate that dies the same way is re-run a bounded number of times, and
  every re-run is visible on the card. The budget is shared with the unrun-gate lane on purpose, so
  `missing`/`verdictless`/`failed-no-verdict` passes through one gate consume ONE 3-strike budget.
  */
  function rerunMarkers(gateId: string, count: number): Array<{ action: string }> {
    return Array.from({ length: count }, (_unused, index) => ({
      action: `[verdictless-gate-rerun] gate '${gateId}' verdict-less failure, re-seeded in place for a fresh run`
        + ` (rerun ${index + 1} of 3)`,
    }));
  }

  /**
   * The durable row the counter reads, kept separate from the caller's projection — RUFU-452's
   * source-of-truth seam. Pair with a `log: []` projection to reproduce a slim board read.
   */
  function storeWithDurableLog(log: Array<{ action: string }>) {
    const fake = store();
    fake.getTask = vi.fn(async () => ({ log }));
    return fake;
  }

  const failedNoVerdictResult = { workflowStepId: "code-review", phase: "pre-merge", status: "failed" };

  it("logs the rerun marker on the card for each bounded re-seed of a verdict-less gate", async () => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult] });
    const fake = store();

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });

    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining(
      "[verdictless-gate-rerun] gate 'code-review'",
    ));
    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("rerun 1 of 3"));
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-02:45 (RUFU-452):
  Fresh-card semantics stay decision-neutral for every shape of an absent durable log: no row at all
  (`getTask` → `null`, the default every other test here already relies on), a row with no `log` field,
  and a row whose `log` is `undefined` are all zero strikes, so a first re-run still seeds and labels
  itself honestly. Only a REJECTED read is fail-closed — see the pair further below.
  */
  it.each([
    ["no durable row", null],
    ["a durable row with no log field", {}],
    ["a durable row whose log is undefined", { log: undefined }],
  ])("counts zero strikes for %s and seeds the first re-run", async (_shape, durable) => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => durable);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("rerun 1 of 3"));
  });

  it.each([1, 2])("re-seeds a verdict-less gate up to the cap (durable markers so far: %i)", async (existing) => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = storeWithDurableLog(rerunMarkers("code-review", existing));

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining(`rerun ${existing + 1} of 3`));
  });

  it("stops re-seeding once the shared per-gate budget is spent and says why", async () => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const before = structuredClone(task);
    const fake = storeWithDurableLog(rerunMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS));

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({
      rerouted: false, reason: "rerun-budget-exhausted", nodeId: "code-review", workflowStepId: "code-review",
    });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("counts a marker written by the unrun-gate lane against the same per-gate budget", async () => {
    // A verdict-less failed row: the class the unrun lane counts against the shared budget.
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "code-review", state: "approved", verdictLessFailed: true },
    ]);
    const task = subject({ workflowStepResults: [], log: [] });
    const fake = storeWithDurableLog(rerunMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS));

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-452):
  The mirror-image control for the pair below: strikes that live only on the caller's projection must
  NOT spend a strike — pre-fix this card was refused with `rerun-budget-exhausted` while its durable
  log held nothing at all. The same trusted projection that under-counted on a slim read over-counted
  here, which is the whole argument for one source of truth.
  */
  it("counts a marker-bearing projection as zero strikes when the durable row holds none", async () => {
    const task = subject({
      workflowStepResults: [failedNoVerdictResult],
      log: rerunMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS),
    });
    const fake = storeWithDurableLog([]);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(fake.getTask).toHaveBeenCalledWith(task.id);
    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("rerun 1 of 3"));
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-452):
  A board read is a PROJECTION, not an absence. `listTasks({ slim: true })` answers `log: []` for a card
  whose durable log carries every strike, so the old `Array.isArray(task.log) ? task.log : hydrate`
  arm never hydrated on a production read and the per-(task, gate) budget read zero strikes forever —
  measured 2026-09-30 as 11 strikes on RUFU-281 all claiming `rerun 1 of 3`. These two cases are the
  shape the engine actually hands the counter (an empty projection plus a marker-bearing durable row)
  through BOTH lanes that consume the shared budget; the `log: []` on the projection is what makes the
  case reachable at all, which is why the pre-fix suite — whose only hydration case deleted `log`
  outright — could never have caught it.
  */
  it("refuses the sixth re-run when the durable row holds the strikes the empty projection hid (no-verdict lane)", async () => {
    const durable = { log: rerunMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) };
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => durable);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted", workflowStepId: "code-review" });
    expect(fake.getTask).toHaveBeenCalledWith(task.id);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
  });

  it("refuses the sixth re-run when the durable row holds the strikes the empty projection hid (unrun-gate lane)", async () => {
    // A verdict-less failed row classified through the unrun lane: same shared budget, other call site.
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "code-review", state: "approved", verdictLessFailed: true },
    ]);
    const durable = { log: rerunMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) };
    const task = subject({ workflowStepResults: [], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => durable);

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted", workflowStepId: "code-review" });
    expect(fake.getTask).toHaveBeenCalledWith(task.id);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-01:52 (RUFU-452):
  The budget is per (task, GATE), and now that the count comes from the durable log the scoping rule
  is load-bearing: a card whose `plan-review` gate burned its three strikes must still get its three
  honest `code-review` re-runs. Matching stays on the quoted gate id inside the marker prefix, so
  another gate's strikes are inert here.
  */
  it("does not let another gate's durable markers spend this gate's budget", async () => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = storeWithDurableLog(rerunMarkers("plan-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS));

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(fake.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("rerun 1 of 3"));
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-01:52 (RUFU-452):
  Fail-closed on an unreadable durable row. Swallowing the read error would count zero strikes, i.e.
  exactly the false "budget is fresh" evidence RUFU-452 exists to remove — a flaky sink must cost a
  skipped card, not an unlimited re-seed of a gate that keeps dying without a verdict. Every caller
  contains the rejection (`.catch` in project-engine/self-healing, try/catch in handle-graph-failure
  and the no-verdict sweep), which is why propagating is safe rather than a new crash surface.
  */
  it("seeds nothing when the durable read is rejected (no-verdict lane)", async () => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => { throw new Error("durable read unavailable"); });

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).rejects.toThrow("durable read unavailable");
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
  });

  it("seeds nothing when the durable read is rejected (unrun-gate lane)", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "code-review", state: "approved", verdictLessFailed: true },
    ]);
    const task = subject({ workflowStepResults: [], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => { throw new Error("durable read unavailable"); });

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).rejects.toThrow("durable read unavailable");
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-02-09:10 (RUFU-452):
  The counter filters markers out of the WHOLE retained durable log, so ordinary churn between strikes
  (comments, status writes, other lanes' entries) must not hide a spent budget. This is the reach for
  the retention bound stated on the counter: `logEntryImpl` keeps only the newest
  `DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT` (1,000) entries, so churn is guaranteed while strikes are
  young — a counter that only inspected consecutive rows, or that read the newest N entries, would
  lose the budget here. It also pins that the read passes no `activityLogLimit`.
  */
  it("counts strikes separated by unrelated durable log churn", async () => {
    const churn = (index: number) => ({ action: `Heartbeat move to in-review (${index})` });
    const strike = (n: number) => ({
      action: `${verdictlessGateRerunLogMarker("code-review")} verdict-less failure, re-seeded in place` +
        ` for a fresh run (rerun ${n} of 3)`,
    });
    const durable = {
      log: [
        strike(1),
        ...Array.from({ length: 5 }, (_unused, index) => churn(index)),
        strike(2),
        ...Array.from({ length: 40 }, (_unused, index) => churn(index + 5)),
        strike(3),
        churn(99),
      ],
    };
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => durable);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted", workflowStepId: "code-review" });
    expect(fake.getTask).toHaveBeenCalledWith(task.id);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-02-09:10 (RUFU-452):
  The production shape of a missing durable row is a THROW, not a `null`: the real `getTask` raises
  `TaskNotFoundError` for an absent id and `TaskDeletedError` for a soft-deleted card. So "the card is
  gone" travels the same fail-closed path as "the row is unreadable" and seeds nothing — seeding a
  soft-deleted card would strand a continuation on a row no read path can show. This pins that the
  engine lane does not special-case the 404 into a fresh budget, which is the distinction the
  decision-neutral `null` arm (fake/legacy stores) must keep.
  */
  it("seeds nothing when the durable read throws TaskNotFoundError (the real store's missing row)", async () => {
    const task = subject({ workflowStepResults: [failedNoVerdictResult], log: [] });
    const fake = store();
    fake.getTask = vi.fn(async () => { throw new TaskNotFoundError(task.id); });

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).rejects.toThrow(new TaskNotFoundError(task.id));
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
  });

  it("refuses duplicate dispatch, manual hold, and selection change", async () => {
    const retryTask = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }] });
    const duplicate = store(false);
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(duplicate, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });

    for (const [task, content, expected] of [
      [subject({ paused: true, workflowStepResults: retryTask.workflowStepResults }), singular, "operator-held"],
    ] as const) {
      const fake = store();
      await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required,
        mergeContent: content as any,
      })).resolves.toMatchObject({ rerouted: false, reason: expected });
      expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    }

    /*
    FNXC:NoVerdictWorkspaceSeed 2026-09-28-09:15 (RUFU-391): this lane used to answer a workspace card
    with "not-singular". The idle seed reads no merge content at all, so that guard never protected
    anything — it only kept workspace cards from the review re-run they were owed, and on a board of
    workspace cards that meant the verdict-less gate was never re-run. Non-singular content now seeds;
    the unrun-gate lane keeps its own content guard untouched.
    */
    const workspaceFake = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(workspaceFake, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "workspace" } as any,
    })).resolves.toMatchObject({ rerouted: true, nodeId: "code-review" });
    expect(workspaceFake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);

    const changed = store(false);
    changed.seedWorkspaceCodeReviewContinuationIfIdle.mockResolvedValueOnce({ seeded: false, reason: "workflow-selection-changed" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(changed, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: ["code-review"] },
    })).resolves.toMatchObject({ rerouted: false, reason: "workflow-selection-changed" });
  });
});
