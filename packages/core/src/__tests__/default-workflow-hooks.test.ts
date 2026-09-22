// @vitest-environment node
//
// U4: the default-workflow side effects are resolved THROUGH the trait registry
// (the DI seam, KTD-2/U2). This pins:
//   - registerDefaultWorkflowHooks() wires the impls so resolution finds them
//     (no missing-hook-impl warning on the happy path);
//   - a missing registration degrades to a no-op + audit warning (not a crash);
//   - applyDefaultWorkflowMoveEffects mutates the task per the legacy contract.

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetTraitRegistryForTests,
  getTraitRegistry,
} from "../workflows/trait-registry.js";
import { registerBuiltinTraits } from "../workflows/builtin-traits.js";
import {
  __resetDefaultWorkflowHooksForTests,
  applyDefaultWorkflowMoveEffects,
  registerDefaultWorkflowHooks,
  type DefaultWorkflowMoveContext,
} from "../workflows/default-workflow-hooks.js";
import type { Task } from "../types.js";

function makeCtx(overrides: Partial<DefaultWorkflowMoveContext> = {}): DefaultWorkflowMoveContext {
  const task = {
    id: "FN-1",
    column: "in-progress",
    columnMovedAt: new Date().toISOString(),
    steps: [],
    dependencies: [],
  } as unknown as Task;
  return {
    task,
    fromColumn: "todo",
    toColumn: "in-progress",
    moveSource: "user",
    bypassGuards: false,
    movedAt: new Date().toISOString(),
    settings: undefined,
    options: {},
    resetSteps: () => {},
    ...overrides,
  };
}

describe("default-workflow-hooks registry wiring", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
  });

  it("resolves all default-workflow hooks without a missing-impl warning once registered", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    expect(warnings).toHaveLength(0);
    // timing.onEnter stamped cumulativeActiveMs on entry to in-progress.
    expect(ctx.task.cumulativeActiveMs).toBe(0);
  });

  it("degrades to a no-op + audit warning when a hook impl is not registered", () => {
    // Built-in DEFINITIONS are registered (so the trait declares the hook) but
    // we deliberately do NOT call registerDefaultWorkflowHooks() — no impls.
    const registry = getTraitRegistry();
    // sanity: the trait declares the hook descriptor
    expect(registry.getTrait("timing")?.hooks?.onEnter).toBe(true);
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    // Every declared hook with no impl yields a degraded-no-op warning.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.kind === "missing-hook-impl")).toBe(true);
    // No crash; task unmutated by the (no-op) hooks.
    expect(ctx.task.cumulativeActiveMs).toBeUndefined();
  });

  it("applies userPaused only for user-source reopen to todo", () => {
    registerDefaultWorkflowHooks();
    const userCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "user" });
    applyDefaultWorkflowMoveEffects(userCtx);
    expect(userCtx.task.userPaused).toBe(true);

    const engineCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    applyDefaultWorkflowMoveEffects(engineCtx);
    expect(engineCtx.task.userPaused).toBeUndefined();
  });

  // FN-7851 pause-bounce regression: the executor's pause teardown re-queues a
  // user-paused in-progress task to todo. Without preservePause the reopen
  // block wiped the pause flags, leaving the row dispatchable — the scheduler
  // re-dispatched it seconds after the user paused it.
  it("preservePause keeps the pause park across an engine reopen to todo", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { preservePause: true } });
    ctx.task.paused = true;
    ctx.task.pausedByAgentId = "agent-1";
    ctx.task.pausedReason = "operator pause";
    ctx.task.userPaused = true;
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.paused).toBe(true);
    expect(ctx.task.pausedByAgentId).toBe("agent-1");
    expect(ctx.task.pausedReason).toBe("operator pause");
    expect(ctx.task.userPaused).toBe(true);
  });

  /*
  FNXC:SelfHealing 2026-08-21-16:06:
  FN-9186 writes the no-progress backoff immediately before its engine wip-to-todo
  rebound. Only review-origin moves clear this display mirror, so this pins the
  move-hook contract that keeps the scheduler from immediately redispatching it.
  */
  it("preserves no-progress recovery backoff on an engine wip-to-rebound move", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { recoveryRehome: true } });
    ctx.task.recoveryRetryCount = 1;
    ctx.task.nextRecoveryAt = "2026-08-21T16:07:00.000Z";

    applyDefaultWorkflowMoveEffects(ctx);

    expect(ctx.task.recoveryRetryCount).toBe(1);
    expect(ctx.task.nextRecoveryAt).toBe("2026-08-21T16:07:00.000Z");
  });

  it("preservePause never SETS a pause on an unpaused reopen, and default reopen still clears one", () => {
    registerDefaultWorkflowHooks();
    // preservePause on an unpaused task: nothing appears.
    const unpausedCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { preservePause: true } });
    applyDefaultWorkflowMoveEffects(unpausedCtx);
    expect(unpausedCtx.task.paused).toBeUndefined();
    expect(unpausedCtx.task.userPaused).toBeUndefined();

    // Default (no preservePause) engine reopen still clears an existing pause.
    const defaultCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    defaultCtx.task.paused = true;
    defaultCtx.task.pausedByAgentId = "agent-1";
    defaultCtx.task.pausedReason = "operator pause";
    applyDefaultWorkflowMoveEffects(defaultCtx);
    expect(defaultCtx.task.paused).toBeUndefined();
    expect(defaultCtx.task.pausedByAgentId).toBeUndefined();
    expect(defaultCtx.task.pausedReason).toBeUndefined();
  });

  /*
  FNXC:TaskRetryReleaseIntent 2026-09-22-07:39 (RUFU-261):
  An operator Retry re-queues the card with `moveSource: "user"` (audit attribution is required —
  FNXC:ToolPermissionGates), so the hold-lane park predicate previously could not tell a Retry from
  a drag and parked the card the operator had just asked to RUN — a durable scheduler refusal no
  recovery path ever cleared (11 real cards, 2–14 days). `parkOnHold: false` is the release intent
  every Retry surface carries; the drag gesture sends nothing and must keep parking (pinned by the
  "applies userPaused only for user-source reopen to todo" case above — both gestures live in this
  one file so they can never collapse again).
  */
  it("parkOnHold:false releases the hold-lane park and still runs pause accounting (Retry intent)", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({
      fromColumn: "in-progress",
      toColumn: "todo",
      moveSource: "user",
      options: { preserveProgress: true, parkOnHold: false },
    });
    // An open pause segment must be BANKED by the release move (FN-457), not silently dropped.
    ctx.task.paused = true;
    ctx.task.pausedReason = "in-review-stall-deadlock";
    ctx.task.pausedStartedAt = new Date(Date.parse(ctx.movedAt) - 5_000).toISOString();
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.userPaused).toBeUndefined();
    expect(ctx.task.paused).toBeUndefined();
    expect(ctx.task.pausedReason).toBeUndefined();
    expect(ctx.task.pausedStartedAt).toBeUndefined();
    expect(ctx.task.cumulativePausedMs).toBeGreaterThanOrEqual(5_000);
  });

  it("parkOnHold:false clears a STALE userPaused park on the release move (re-retry of an already-parked card)", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({
      fromColumn: "in-progress",
      toColumn: "todo",
      moveSource: "user",
      options: { preserveProgress: true, parkOnHold: false },
    });
    ctx.task.userPaused = true; // parked by a pre-fix retry or an earlier drag
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.userPaused).toBeUndefined();
  });

  it("parkOnHold:false never overrides preservePause — the park survives (FN-7851 precedence locked)", () => {
    registerDefaultWorkflowHooks();
    // Contradictory by contract (callers must not send this pair); the branch order must still
    // keep the park rather than let the release intent clear it.
    const ctx = makeCtx({
      fromColumn: "in-progress",
      toColumn: "todo",
      moveSource: "user",
      options: { preservePause: true, parkOnHold: false },
    });
    ctx.task.userPaused = true;
    ctx.task.paused = true;
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.userPaused).toBe(true);
    expect(ctx.task.paused).toBe(true);
  });

  it("parkOnHold reads the HOLD ROLE, not the id: a renamed hold lane parks without the flag and releases with it", () => {
    registerDefaultWorkflowHooks();
    const lifecycle: DefaultWorkflowMoveContext["lifecycleColumns"] = {
      intake: "planning",
      hold: "queue",
      wip: "doing",
      review: "reviewing",
      complete: "shipped",
    };
    const drag = makeCtx({
      fromColumn: "doing",
      toColumn: "queue",
      moveSource: "user",
      lifecycleColumns: lifecycle,
    });
    applyDefaultWorkflowMoveEffects(drag);
    expect(drag.task.userPaused).toBe(true);

    const release = makeCtx({
      fromColumn: "doing",
      toColumn: "queue",
      moveSource: "user",
      lifecycleColumns: lifecycle,
      options: { parkOnHold: false },
    });
    applyDefaultWorkflowMoveEffects(release);
    expect(release.task.userPaused).toBeUndefined();
  });

  it("parkOnHold reads the intake-fallback lane shape (hold undefined): intake parks without the flag and releases with it", () => {
    registerDefaultWorkflowHooks();
    const lifecycle: DefaultWorkflowMoveContext["lifecycleColumns"] = {
      intake: "planning",
      hold: undefined,
      wip: "doing",
      review: "reviewing",
      complete: "shipped",
    };
    const drag = makeCtx({
      fromColumn: "doing",
      toColumn: "planning",
      moveSource: "user",
      lifecycleColumns: lifecycle,
    });
    applyDefaultWorkflowMoveEffects(drag);
    expect(drag.task.userPaused).toBe(true);

    const release = makeCtx({
      fromColumn: "doing",
      toColumn: "planning",
      moveSource: "user",
      lifecycleColumns: lifecycle,
      options: { parkOnHold: false },
    });
    applyDefaultWorkflowMoveEffects(release);
    expect(release.task.userPaused).toBeUndefined();
  });

  it("parkOnHold:false on an ENGINE-sourced reopen changes nothing (engine never parks, present-but-unused)", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({
      fromColumn: "in-progress",
      toColumn: "todo",
      moveSource: "engine",
      options: { parkOnHold: false },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.userPaused).toBeUndefined();
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-14:40:
The pre-merge review gates (Code Review, Browser Verification) run with the card in `in-review`, so
the graph's crossing into the paired remediation node is a routine `in-review -> in-progress` move
that lands immediately after the gate wrote its `failed` result. The reopen clear used to wipe
`workflowStepResults` on every such move, destroying the remediation input — and, worse, making
`getTaskMergeBlocker`'s pending/failed branches vacuously false so a card could return to
`in-review` and be mergeable with its gate never re-run.

These cases pin BOTH directions of the gate, because a fix that simply stopped clearing on
`in-progress` would silently change operator-reopen semantics that other recovery paths depend on
(`executor.performWorkflowRerunBounce` documents that `moveTask(in-review -> todo)` clears results
for it). Only a graph-owned in-review -> in-progress crossing is exempt.
*/
describe("applyReopenFieldClears — graph-owned review-gate remediation crossing", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  function withResults(overrides: Partial<DefaultWorkflowMoveContext>): DefaultWorkflowMoveContext {
    const ctx = makeCtx(overrides);
    ctx.task.workflowStepResults = [
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", phase: "pre-merge" },
      { workflowStepId: "browser-verification", workflowStepName: "Browser Verification", status: "passed", phase: "pre-merge" },
    ] as Task["workflowStepResults"];
    return ctx;
  }

  it("RETAINS workflowStepResults on the graph's in-review -> in-progress remediation crossing", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "in-progress",
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      options: { preserveProgress: true },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toHaveLength(2);
    expect(ctx.task.workflowStepResults?.find((r) => r.workflowStepId === "code-review")?.status).toBe("failed");
  });

  it("retains only review evidence for remediation-owned review -> planning bounce", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "todo",
      moveSource: "engine",
      workflowMoveSource: "workflow-remediation",
    });
    ctx.task.branch = "fusion/FN-1";
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toHaveLength(2);
    expect(ctx.task.branch).toBeUndefined();
  });

  it("still CLEARS on an operator reopen in-review -> in-progress (no graph provenance)", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "in-progress",
      moveSource: "user",
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });

  it("still CLEARS on in-review -> todo even when the graph owns the move (bounce invariant)", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "todo",
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      options: { preserveProgress: true },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });

  it("still CLEARS on done -> todo reopen", () => {
    const ctx = withResults({ fromColumn: "done", toColumn: "todo", moveSource: "user" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });
});

/*
FNXC:PlanningFailureClear 2026-09-12-13:45 (RUFU-228):
Stale terminal planning failure (`status:"failed"` + `PLANNING_FAILED_EXHAUSTED`
error) must clear when the card advances FORWARD from a planning lane into the WIP
lane - the fourth member of the transient-failure clear set (reopen->planning,
review entry, Done, forward->WIP). These cases pin the gate from the other side of
the registry: role-resolved (renamed boards), preserveStatus-suppressed, and
retention everywhere the failure may still be live (review entry, mid-retry
WIP moves, non-terminal planning states, terminal->WIP re-entry).
*/
describe("default-workflow-hooks - stale planning-failure clear on forward planning->WIP crossing", () => {
  const STALE_ERROR = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times - last error: fence-unavailable";

  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  function failingCtx(overrides: Partial<DefaultWorkflowMoveContext> = {}): DefaultWorkflowMoveContext {
    const ctx = makeCtx(overrides);
    ctx.task.status = "failed";
    ctx.task.error = STALE_ERROR;
    return ctx;
  }

  it("clears status+error on forward todo -> in-progress (legacy-name basis, v1 IR)", () => {
    const ctx = failingCtx({ fromColumn: "todo", toColumn: "in-progress" });
    ctx.task.blockedBy = "FN-9";
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    expect(warnings).toHaveLength(0);
    expect(ctx.task.status).toBeUndefined();
    expect(ctx.task.error).toBeUndefined();
    // Only the stale failure clears - blockedBy is planning-owned state this
    // effect must not touch (reopen clears it; forward WIP entry leaves it).
    expect(ctx.task.blockedBy).toBe("FN-9");
  });

  it("clears from the intake lane too (triage -> in-progress)", () => {
    const ctx = failingCtx({ fromColumn: "triage", toColumn: "in-progress" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBeUndefined();
    expect(ctx.task.error).toBeUndefined();
  });

  it("preserveStatus suppresses the clear (explicit callers keep exact semantics)", () => {
    const ctx = failingCtx({
      fromColumn: "todo",
      toColumn: "in-progress",
      options: { preserveStatus: true },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBe("failed");
    expect(ctx.task.error).toBe(STALE_ERROR);
  });

  it("retains the failure on planning -> review (review entry owns retention)", () => {
    const ctx = failingCtx({ fromColumn: "todo", toColumn: "in-review" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBe("failed");
    expect(ctx.task.error).toBe(STALE_ERROR);
  });

  it("retains the failure on in-progress -> in-progress (mid-retry error may be live)", () => {
    const ctx = failingCtx({ fromColumn: "in-progress", toColumn: "in-progress" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBe("failed");
    expect(ctx.task.error).toBe(STALE_ERROR);
  });

  it("retains non-terminal planning states across the same crossing", () => {
    const replan = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    replan.task.status = "needs-replan";
    replan.task.error = STALE_ERROR;
    applyDefaultWorkflowMoveEffects(replan);
    expect(replan.task.status).toBe("needs-replan");
    expect(replan.task.error).toBe(STALE_ERROR);

    const errorOnly = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    errorOnly.task.error = STALE_ERROR;
    applyDefaultWorkflowMoveEffects(errorOnly);
    expect(errorOnly.task.status).toBeUndefined();
    expect(errorOnly.task.error).toBe(STALE_ERROR);
  });

  it("retains the failure on terminal -> WIP re-entry (from not in planning - different invariant)", () => {
    const ctx = failingCtx({ fromColumn: "done", toColumn: "in-progress" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBe("failed");
    expect(ctx.task.error).toBe(STALE_ERROR);
  });

  it("clears by ROLE on a renamed board (hold -> WIP, not literal column names)", () => {
    const ctx = failingCtx({
      fromColumn: "backlog",
      toColumn: "doing",
      lifecycleColumns: { intake: "queue", hold: "backlog", wip: "doing", review: "approve", complete: "shipped" },
      lifecycleColumnSets: { wip: ["doing"], complete: ["shipped"], review: ["approve"] },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBeUndefined();
    expect(ctx.task.error).toBeUndefined();
  });

  it("an empty WIP lane set is the answer - no fallback to the legacy literal", () => {
    const ctx = failingCtx({
      fromColumn: "todo",
      toColumn: "in-progress",
      lifecycleColumnSets: { wip: [], complete: [], review: [] },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.status).toBe("failed");
    expect(ctx.task.error).toBe(STALE_ERROR);
  });
});
