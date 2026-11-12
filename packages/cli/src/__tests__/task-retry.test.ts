/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. `runTaskRetry` resolves its store through the
 * CLI command path (`project-context.resolveProject`), which is independent of
 * the extension store cache the harness injects — so `resolveProject` is
 * redirected to the harness's PG-backed store, and the full retry lifecycle
 * (moveTask / updateTask / getTask / logEntry) runs against real PostgreSQL
 * state instead of the removed SQLite runtime.
 *
 * FNXC:CliTests 2026-07-16-08:45:
 * FN-8102 repairs stale retry scaffolding left after the PG migration: every
 * lifecycle seed and verification read must use the initialized harness store,
 * rather than the removed `createStore()` helper.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

// `runTaskRetry` resolves its store via resolveProject() (commands/task.ts →
// project-context.ts), a separate cache from the extension store the harness
// injects. Redirect resolveProject to the harness PG store so the command path
// and the seeded task share one isolated PostgreSQL database.
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  // FNXC:CliTests 2026-07-16-08:47: FN-8102 keeps command-finally cleanup
  // awaitable while the PG harness retains ownership of the test store lifecycle.
  closeProjectStore: closeProjectStoreMock,
  /*
  FNXC:ProjectRoutingVisibility 2026-09-23-00:12 (RUFU-269): `runTaskRetry` reaches
  `getBoardCommandContext`'s cwd-fallback branch when `resolveProject` has no answer, and that branch now
  wraps its store with the SHARED `project-context.ts` `asLocalProjectContext` (task.ts's private copy is
  gone). A double that omits the export turns the fallback into a call of `undefined`.
  */
  asLocalProjectContext: (store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    resolvedFrom: "cwd-fallback",
    store,
  }),
}));

import { runTaskRetry } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("runTaskRetry", () => {
  const h = createPgExtensionHarness("fn-task-retry");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("retries merge-active missing-worktree session failures by clearing phantom metadata", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "missing worktree merge-active task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: FN-107 requires branchWriteOrigin provenance on every branch write; this engine-simulated fixture predates that guard.
      branchWriteOrigin: "engine" as const,
      sessionFile: "/tmp/fusion-session.json",
      steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }],
      worktreeSessionRetryCount: 3,
      mergeRetries: 3,
    });

    await runTaskRetry(task.id);

    const verificationStore = h.store();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(updated.sessionFile).toBeUndefined();
    expect(updated.worktreeSessionRetryCount).toBe(0);
    expect(updated.mergeRetries).toBe(0);
    expect(updated.steps?.[0]?.status).toBe("done");
  });

  it("rejects unrelated merge-active tasks without the missing-worktree signature", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "ordinary merge", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "ordinary merge still running",
      steps: [{ name: "implemented", status: "done" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state/);
  });

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
  });

  /*
  FNXC:TriageStuckKill 2026-11-11-02:25 (RUFU-562):
  The CLI half of "Retry releases the exhaustion park", measured against the real command path and a real
  PostgreSQL row rather than the patch builder alone. The 21 cards that produced this task sat in the planning
  lane carrying `STUCK_LOOP_EXHAUSTED: ... 6/6 times without planning completion`, and `fn task retry` was
  already accepting them: the park sets `status: "failed"`, so it passed the retry gate and `stuckKillCount`
  went to zero. What survived was `paused: true` with `pausedReason: stuck-loop-exhausted-manual-intervention-required`,
  and triage's `couldBeCandidate` refuses any paused card — so the command reported success and the card never
  planned again. That is the pre-fix behavior this case would have caught, and it is why the assertion covers
  BOTH halves plus the planning-pending status that lets triage pick the card up.

  Deliberately NOT asserted here: `pausedByAgentId`. `buildAutoPauseClearPatch` clears the pause and its reason
  and leaves the "who paused" attribution to `pauseTask(id, false)`, which this branch never calls — the same
  shape the three already-listed park reasons have had, so asserting it here would demand more of the shared
  guard than this change set out to give it.
  */
  it("releases the stuck-loop exhaustion park and zeroes its kill budget", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "planning card killed six times",
      description: "Build the thing",
      column: "todo",
    });
    await store.updateTask(task.id, {
      status: "failed",
      error: "STUCK_LOOP_EXHAUSTED: triage stuck detector killed the task 6/6 times without planning completion",
      paused: true,
      pausedReason: "stuck-loop-exhausted-manual-intervention-required",
      pausedByAgentId: "triage",
      stuckKillCount: 6,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    // Still in a planning lane — the retry must not push a never-planned card into execution.
    expect(["todo", "hold"]).toContain(updated.column);
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.stuckKillCount).toBe(0);
    // A null status is planning-pending: the state triage plans from, not a failure it refuses.
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
  });

  /*
  FNXC:TriageStuckKill 2026-11-11-03:20 (RUFU-562):
  The limit of the widening, at the surface an operator actually types into. An operator who paused the card
  themselves stays authoritative over the engine's automatic park lift.

  Seeded through `pauseTask`, not `updateTask`: the store's field writer cannot write `userPaused` (named in
  `task-column-restart.ts`), so an `updateTask({ userPaused: true })` seed silently produces a row with no
  operator hold at all — measured when this case first ran and the guard correctly lifted the pause it was
  supposed to refuse. `pauseTask` is the seam that owns the flag.
  */
  it("does not lift an explicit operator pause while retrying a stuck-loop card", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "operator-held card",
      description: "Build the thing",
      column: "todo",
    });
    await store.updateTask(task.id, {
      status: "failed",
      error: "STUCK_LOOP_EXHAUSTED: triage stuck detector killed the task 6/6 times",
      stuckKillCount: 6,
    });
    await store.pauseTask(task.id, true, undefined, {
      userPaused: true,
      pausedReason: "stuck-loop-exhausted-manual-intervention-required",
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.userPaused).toBe(true);
    // The kill budget is still zeroed (the operator asked for a retry), but the hold survives it.
    expect(updated.stuckKillCount).toBe(0);
    expect(updated.paused).toBeTruthy();
  });

  /*
  FNXC:StrandedGateRetry 2026-10-13-04:40 (STAS-299 req 4 + Invariant C):
  The STAS-281 card at the CLI. Before this, `fn task retry FN-XXXX` on a card stranded by self-heal's
  FN-8492 orphan flip answered either "not in a retryable state" (the card carries no `failed`
  status — its failure is a step row) or, if the card had been re-stamped `failed`, ran the generic
  fallthrough below the stranded branch: that clears `worktree`, `branch`, `baseBranch` and
  `baseCommitSha`, i.e. it discards the branch and the approved plan to re-run a review session that
  was never asked to be re-planned. These two cases pin both halves: the shape that used to be
  refused is now retryable, and retrying it keeps the work.
  */
  const verdictlessPlanGateRow = {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    phase: "pre-merge" as const,
    source: "optional-group" as const,
    status: "failed" as const,
    reviewKind: "plan" as const,
    startedAt: "2026-09-24T00:16:39.000Z",
    output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
  };

  async function seedStrandedCard(store: ReturnType<typeof h.store>, status: "failed" | null) {
    const task = await store.createTask({
      title: "plan-review stranded in the hold lane",
      description: "test",
      column: "todo",
    });
    await store.updateTask(task.id, {
      status,
      error: status === "failed" ? "1 workflow step result(s) marked failed by self-healing (FN-8492)" : null,
      approvedPlanFingerprint: "7a73aaff",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Await the plan-review verdict", status: "pending" },
      ],
      currentStep: 1,
      worktree: "/tmp/fusion-stranded-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: branch writes need provenance; this fixture simulates an engine-written branch.
      branchWriteOrigin: "engine" as const,
      baseBranch: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workflowStepResults: [verdictlessPlanGateRow],
    });
    return task;
  }

  it("discharges a hold-lane verdict-less plan gate in place, keeping the approved plan and worktree", async () => {
    const store = h.store();
    const task = await seedStrandedCard(store, "failed");

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    // The card is not re-queued anywhere: it already sat in the lane a re-queue would target.
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    // The gate row is discharged, which is what lets Plan Review re-run as a `missing` gate.
    expect(updated.workflowStepResults ?? []).toEqual([]);
    // Invariant C: nothing that constitutes the approved work is touched.
    expect(updated.approvedPlanFingerprint).toBe("7a73aaff");
    expect(updated.steps?.map((step) => step.status)).toEqual(["done", "pending"]);
    expect(updated.currentStep).toBe(1);
    expect(updated.worktree).toBe("/tmp/fusion-stranded-worktree");
    expect(updated.branch).toBe(`fusion/${task.id}`);
    expect(updated.baseBranch).toBe("main");
    expect(updated.baseCommitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    const log = (updated.log ?? []) as Array<{ action?: string }>;
    expect(log.some((entry) => entry.action?.includes("gate row(s) discharged in todo"))).toBe(true);
  });

  it("reaches the stranded cards self-heal parked before the lifecycle fix, which carried no status", async () => {
    const store = h.store();
    /* Every card stranded by this defect BEFORE the fix has this shape: hold lane, approved plan,
       failed gate row, and no card-level failure at all. Those operators had no escape hatch, which
       is what made STAS-281 stall for 2.2 days with nobody owning it. */
    const task = await seedStrandedCard(store, null);

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.workflowStepResults ?? []).toEqual([]);
    expect(updated.approvedPlanFingerprint).toBe("7a73aaff");
    expect(updated.worktree).toBe("/tmp/fusion-stranded-worktree");
  });

  /*
  FNXC:PlanningStrandedRetry 2026-11-10-15:40 (RUFU-575, CLI surface of four):
  The two cards that motivated this task, seeded as found on the saneca board: SANE-282 sat `queued` in
  its planning lane and SANE-524 `needs-replan`, both carrying the spec-run terminal error, and both were
  answered here with "is not in a retryable state (status: ...)". `fn task retry` is the operator's only
  immediate lever, so an exhausted provider episode ended the card's life. Each case states its own data
  state, and the two controls below pin that the admission is a class and not a widening - the card this
  very task logged as capacity-throttled must STILL be refused.
  */
  const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
  const SPEC_BODY = "# Task: Repair the lockfile drift\n\n## Steps\n\n- [ ] Step 0: Preflight\n- [ ] Step 1: Reproduce\n";
  /*
  FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
  The bootstrap seed body a card holds before any planner ran. It is a fixture, not a predicate: the
  residue of a provider timeout is legitimately a missing OR a seed-only PROMPT.md, so admission must
  accept all three states. A gate on seed-ness (`isUnplannedSeedPrompt`) or on the file existing would
  refuse exactly the reported card while every other test stayed green.
  */
  const SEED_ONLY_BODY = "## Original Description\n\nA card whose specification failed with transient provider errors.\n";
  const promptPathOf = (taskId: string) => join(h.rootDir(), ".fusion", "tasks", taskId, "PROMPT.md");

  async function seedPlanningStrandedCard(
    store: ReturnType<typeof h.store>,
    over: { status: "queued" | "needs-replan"; error: string | null; recoveryDisposition?: "escalated-reseed" | "escalated-execution-reseed"; specBody?: string | null },
  ) {
    const task = await store.createTask({
      title: "specification timed out in the planning lane",
      description: "test",
      column: "todo",
    });
    /*
    The specification is the FILE, not a row column — the board's destructive branch removes
    `.fusion/tasks/<id>/PROMPT.md` from disk. So the seed writes a real plan there and the assertion
    below reads it back: "the Retry preserved the specification" is only evidence where the
    specification actually lives.
    */
    const promptPath = join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
    await mkdir(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true });
    /*
    FNXC:PlanningStrandedRetry 2026-11-11-23:16 (RUFU-575, Step 5 against a real PostgreSQL):
    `specBody: null` has to REMOVE the file, not merely skip writing it. `createTask` publishes a
    bootstrap prompt to `.fusion/tasks/<id>/PROMPT.md` as it creates the row (task-creation.ts's
    `buildBootstrapPrompt` + `writePromptFileAtomic`), so a seed that only omitted its own write left a
    seed body on disk and silently turned F4 into F5 - the fixture would have asserted "still absent"
    against a file its own setup had written. Deleting it models the residue a provider timeout actually
    leaves and keeps the assertion measuring the retry instead of the seed.
    */
    if (over.specBody === null) {
      await rm(promptPath, { force: true });
      expect(existsSync(promptPath)).toBe(false);
    } else {
      await writeFile(promptPath, over.specBody ?? SPEC_BODY, "utf-8");
    }
    await store.updateTask(task.id, {
      status: over.status,
      error: over.error,
      recoveryDisposition: over.recoveryDisposition,
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      /* A real `TaskPlanningFailureState` shape (`lifecycleLockTransport` is one of its named markers),
         so the fixture states the intent the patch must clear rather than inventing a key. */
      planningFailure: {
        lifecycleLockTransport: {
          message: "Request timed out.",
          at: new Date(Date.now() - 86_400_000).toISOString(),
          attempt: 3,
        },
      },
      recoveryRetryCount: 3,
      nextRecoveryAt: new Date(Date.now() - 86_400_000).toISOString(),
      mergeRetries: 2,
      worktree: "/tmp/fusion-rufu-575-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: branch writes need provenance; this fixture simulates an engine-written branch.
      branchWriteOrigin: "engine" as const,
      baseBranch: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    return task;
  }

  it.each([
    { label: "SANE-282 (`queued`)", status: "queued" as const, error: SPEC_TIMEOUT_ERROR },
    { label: "SANE-524 (`needs-replan`)", status: "needs-replan" as const, error: SPEC_TIMEOUT_ERROR },
    { label: "post-FN-9512 (`queued`, no error, escalated-reseed)", status: "queued" as const, error: null, recoveryDisposition: "escalated-reseed" as const },
  ])("retries the stranded planning card from $label by re-arming planning in place", async (shape) => {
    const store = h.store();
    const task = await seedPlanningStrandedCard(store, shape);

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    /* The re-arm: `needs-replan` is the request triage's todo rediscovery already honours, so the planner
       runs the specification again. The stale error and the planning bookkeeping that would make the
       next planner turn skip or re-park the card are gone. */
    expect(updated.status).toBe("needs-replan");
    expect(updated.error ?? null).toBeNull();
    expect(updated.planningFailure ?? null).toBeNull();
    expect(updated.recoveryDisposition ?? null).toBeNull();
    expect(updated.recoveryRetryCount ?? null).toBeNull();
    expect(updated.mergeRetries).toBe(0);
    /* Invariant C, the half this task is about: the card did not move and it kept everything that
       constitutes its work. Deleting the specification is what the BOARD used to do to this row. */
    expect(updated.column).toBe("todo");
    expect(await readFile(promptPathOf(task.id), "utf-8")).toBe(SPEC_BODY);
    expect(updated.steps?.map((step) => step.status)).toEqual(["pending"]);
    expect(updated.currentStep).toBe(0);
    expect(updated.worktree).toBe("/tmp/fusion-rufu-575-worktree");
    expect(updated.branch).toBe(`fusion/${task.id}`);
    expect(updated.baseBranch).toBe("main");
    expect(updated.baseCommitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    const log = (updated.log ?? []) as Array<{ action?: string }>;
    expect(log.some((entry) => entry.action?.includes("planning run exhausted in todo"))).toBe(true);
  });

  /*
  FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
  F4 (no `PROMPT.md` at all) and F5 (seed-only body) of `## Symptom Verification`, on the same row the
  operator actually had. The whole point of the row-only classification is that these three bodies buy
  the SAME verdict: a provider timeout usually leaves no usable spec, so a surface that asked the file
  would answer `is not in a retryable state` to exactly the card this task exists to recover. The CLI
  never writes or deletes the spec, so the assertion here is that it never starts to: the byte state of
  the residue is unchanged, absent included.
  */
  it.each([
    { label: "a real plan body (F1-F3's spec state)", specBody: SPEC_BODY as string | null },
    { label: "no PROMPT.md at all (F4, the normal residue of a spec timeout)", specBody: null as string | null },
    { label: "only the bootstrap seed body (F5)", specBody: SEED_ONLY_BODY as string | null },
  ])("re-arms the stranded planning card whose specification state is $label", async ({ specBody }) => {
    const store = h.store();
    const task = await seedPlanningStrandedCard(store, { status: "queued", error: SPEC_TIMEOUT_ERROR, specBody });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.status).toBe("needs-replan");
    expect(updated.error ?? null).toBeNull();
    expect(updated.column).toBe("todo");
    if (specBody === null) {
      // The retry must not invent a specification either: the next planner pass owns that file.
      expect(existsSync(promptPathOf(task.id))).toBe(false);
    } else {
      expect(await readFile(promptPathOf(task.id), "utf-8")).toBe(specBody);
    }
  });

  it("still refuses a legitimately throttled queued card, which carries no planning-exhaustion evidence", async () => {
    const store = h.store();
    /* This task's own card logged exactly this line while waiting for a WIP slot: `queued` with
       maxConcurrent 12/12. It is progressing, the scheduler owns it, and admitting it would be the
       global reclassification of every queued card that this task forbids. */
    const task = await store.createTask({ title: "waiting for a slot", description: "test", column: "todo" });
    await store.updateTask(task.id, {
      status: "queued",
      error: "maxConcurrent capacity exhausted: used=12/12",
      steps: [{ name: "Preflight", status: "pending" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state \(status: queued\)/);

    const updated = await store.getTask(task.id);
    expect(updated.status).toBe("queued");
    expect(updated.error).toBe("maxConcurrent capacity exhausted: used=12/12");
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-15:06 (RUFU-575 code review P0):
  The row an EXECUTION reseed leaves behind, in the same lane and with the same waiting status as the
  accepted post-FN-9512 planning row above. Before the lane split these two rows were byte-identical to
  every field this verb reads, so the verb re-armed a card whose spec, steps and worktree were intact onto
  a fresh planning pass. The refusal must name the real status, and the row must come back untouched.
  */
  it("refuses an execution-reseeded card the scheduler queued, and changes nothing on it", async () => {
    const store = h.store();
    const task = await seedPlanningStrandedCard(store, { status: "queued", error: SPEC_TIMEOUT_ERROR });
    // The executor's exhausted-retry reseed patch, then the scheduler's capacity stamp — the real sequence.
    await store.updateTask(task.id, {
      status: null,
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-execution-reseed",
    });
    await store.updateTask(task.id, { status: "queued" });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state \(status: queued\)/);

    const updated = await store.getTask(task.id);
    expect(updated.status).toBe("queued");
    expect(updated.recoveryDisposition).toBe("escalated-execution-reseed");
    expect(updated.steps?.map((step) => step.status)).toEqual(["pending"]);
    expect(updated.column).toBe("todo");
    expect(await readFile(promptPathOf(task.id), "utf-8")).toBe(SPEC_BODY);
  });

  it("leaves a failed card in the review lane on its existing rebound path rather than re-arming planning", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "implementation failed", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "executor exhausted its retries",
      steps: [{ name: "implemented", status: "done" }, { name: "verify", status: "pending" }],
    });

    await runTaskRetry(task.id);

    /* Review owns its recovery: the class refuses this card on the COLUMN, so the pre-existing
       in-review execution-failure path still runs - rebound to the hold lane with a cleared status,
       NOT stamped `needs-replan`. Sentinelling the value the planning class would have written is the
       point: if the class ever grew a column-blind leg, this card would be sent back to planning. */
    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status ?? null).toBeNull();
    expect(updated.steps?.map((step) => step.status)).toEqual(["done", "pending"]);
  });
});
