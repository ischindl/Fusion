/**
 * FNXC:PlanningStrandedRetry 2026-11-10-22:35 (RUFU-575, extension-tool surface of four):
 * `fn_task_retry` on the pi extension is the ONLY retry an agent can reach, so while it refused this
 * shape there was no actor in the system able to rescue the card. These cases run the real tool against
 * the real PostgreSQL-backed store and assert the observable row, not that a helper was called.
 *
 * The seeds are the two cards this task was filed from, as found on the saneca board: SANE-282 sat
 * `queued` and SANE-524 `needs-replan` in their planning lane, each carrying the spec run's terminal
 * error, and both were answered "is not in a retryable state (status: ...)".
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness, createMockApi, registerExtension, requireTool, type ToolExecuteContext } from "./pg-extension-harness.js";

const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
const SPEC_BODY = "# Task: Repair the lockfile drift\n\n## Steps\n\n- [ ] Step 0: Preflight\n- [ ] Step 1: Reproduce\n";
/*
FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
The bootstrap seed body. A fixture, never a predicate: the residue of a spec timeout is legitimately
absent or seed-only, so all three states must buy the same verdict. Admitting only a body that parses
as a plan would refuse exactly the cards this task was filed from.
*/
const SEED_ONLY_BODY = "## Original Description\n\nA card whose specification failed with transient provider errors.\n";

const pgTest = pgDescribe;

pgTest("fn_task_retry — planning-stranded re-arm", () => {
  const h = createPgExtensionHarness("cli-ext-planning-stranded");
  const api = createMockApi();

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    registerExtension(api);
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const ctx = (): ToolExecuteContext => ({ cwd: h.rootDir() });
  const specPath = (taskId: string) => join(h.rootDir(), ".fusion", "tasks", taskId, "PROMPT.md");

  async function seedStranded(over: { status: "queued" | "needs-replan"; error: string | null; recoveryDisposition?: "escalated-reseed" | "escalated-execution-reseed"; specBody?: string | null }) {
    const store = h.store();
    const task = await store.createTask({
      title: "specification timed out in the planning lane",
      description: "test",
      column: "todo",
    });
    /* The specification is the FILE — the board's destructive branch removes it from disk — so the seed
       writes it there and the assertions read it back from the same place. */
    await mkdir(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true });
    /*
    FNXC:PlanningStrandedRetry 2026-11-11-23:16 (RUFU-575, Step 5 against a real PostgreSQL):
    The specless residue has to be DELETED, not merely unwritten: `store.createTask` publishes a
    bootstrap prompt to `.fusion/tasks/<id>/PROMPT.md` while creating the row, so skipping the write left
    a seed body on disk and made F4 a duplicate of F5 - the "still absent" assertion would have measured
    the seed helper rather than the retry. Removing it is what a spec run that died before publishing
    actually leaves behind.
    */
    if (over.specBody === null) {
      await rm(specPath(task.id), { force: true });
      expect(existsSync(specPath(task.id))).toBe(false);
    } else {
      await writeFile(specPath(task.id), over.specBody ?? SPEC_BODY, "utf-8");
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
      worktree: "/tmp/fusion-rufu-575-ext-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: branch writes need provenance; this fixture simulates an engine-written branch.
      branchWriteOrigin: "engine" as const,
      baseBranch: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    return task;
  }

  it.each([
    { label: "SANE-282 (`queued` + incident marker)", status: "queued" as const, error: SPEC_TIMEOUT_ERROR },
    { label: "SANE-524 (`needs-replan` + incident marker)", status: "needs-replan" as const, error: SPEC_TIMEOUT_ERROR },
    /* FNXC:ReseedLaneDiscriminator 2026-11-12-15:06 (RUFU-575): the disposition-only shape, on the
       surface with the widest audience. The planner authored this diagnostic, so it stays admitted. */
    { label: "post-FN-9512 (`queued`, no error, escalated-reseed)", status: "queued" as const, error: null, recoveryDisposition: "escalated-reseed" as const },
  ])("re-arms the stranded planning card from $label in place, keeping the specification", async (shape) => {
    const store = h.store();
    const task = await seedStranded(shape);

    const result = await requireTool(api, "fn_task_retry").execute(
      "retry-planning-stranded",
      { id: task.id },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.details?.planningStrandedRetried).toBe(true);
    expect(result.details?.column).toBe("todo");

    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe("needs-replan");
    expect(updated?.error ?? null).toBeNull();
    expect(updated?.planningFailure ?? null).toBeNull();
    expect(updated?.recoveryDisposition ?? null).toBeNull();
    expect(updated?.recoveryRetryCount ?? null).toBeNull();
    /* Counters keep one owner: the surface composes the shared reset rather than hand-writing zeros. */
    expect(updated?.mergeRetries).toBe(0);
    /* Nothing was discarded and nothing moved. */
    expect(updated?.column).toBe("todo");
    expect(await readFile(specPath(task.id), "utf-8")).toBe(SPEC_BODY);
    expect(updated?.steps?.map((step) => step.status)).toEqual(["pending"]);
    expect(updated?.worktree).toBe("/tmp/fusion-rufu-575-ext-worktree");
    expect(updated?.branch).toBe(`fusion/${task.id}`);
    expect(updated?.baseBranch).toBe("main");
  });

  /*
  FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
  F4 (no `PROMPT.md`) and F5 (seed-only body) of `## Symptom Verification` on the agent-reachable verb.
  This is the surface with the widest audience - every agent that can call `fn_task_retry` - so the
  "whatever the spec state" claim has to be pinned here too: all three residues of a provider timeout
  take the SAME accepted branch, and the tool leaves the file exactly as it found it, absent included.
  */
  it.each([
    { label: "a real plan body (F1-F3's spec state)", specBody: SPEC_BODY as string | null },
    { label: "no PROMPT.md at all (F4, the normal residue of a spec timeout)", specBody: null as string | null },
    { label: "only the bootstrap seed body (F5)", specBody: SEED_ONLY_BODY as string | null },
  ])("re-arms the stranded card whose specification state is $label and leaves that file alone", async (shape) => {
    const store = h.store();
    const task = await seedStranded({ status: "queued", error: SPEC_TIMEOUT_ERROR, specBody: shape.specBody });

    const result = await requireTool(api, "fn_task_retry").execute(
      "retry-planning-stranded-spec-state",
      { id: task.id },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.details?.planningStrandedRetried).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe("needs-replan");
    expect(updated?.error ?? null).toBeNull();
    expect(updated?.column).toBe("todo");
    if (shape.specBody === null) {
      expect(existsSync(specPath(task.id))).toBe(false);
    } else {
      expect(await readFile(specPath(task.id), "utf-8")).toBe(shape.specBody);
    }
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-15:06 (RUFU-575 code review P0):
  The row the EXECUTOR leaves behind, on the verb every agent can reach. Same lane, same waiting status,
  same cleared error and cadence as the accepted row above — only the author of the reseed diagnostic
  differs — so this is the surface where an ambiguous value cost the most: an agent pressing Retry on a
  card that is merely queueing for a slot would have thrown away a finished specification.
  */
  it("refuses an execution-reseeded card the scheduler queued and leaves its row byte-identical", async () => {
    const store = h.store();
    const task = await seedStranded({ status: "queued", error: SPEC_TIMEOUT_ERROR });
    await store.updateTask(task.id, {
      status: null,
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-execution-reseed",
    });
    await store.updateTask(task.id, { status: "queued" });

    const result = await requireTool(api, "fn_task_retry").execute(
      "retry-execution-reseed-control",
      { id: task.id },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not in a retryable state");
    expect(result.details?.planningStrandedRetried ?? null).toBeNull();
    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.recoveryDisposition).toBe("escalated-execution-reseed");
    expect(updated?.steps?.map((step) => step.status)).toEqual(["pending"]);
    expect(await readFile(specPath(task.id), "utf-8")).toBe(SPEC_BODY);
  });

  it("still refuses a capacity-throttled queued card and leaves its row byte-identical", async () => {
    const store = h.store();
    /* This task's own card logged this exact shape while waiting for a WIP slot. Refusing it is the
       point: admitting every `queued` card would be the global reclassification this task forbids. */
    const task = await store.createTask({ title: "waiting for a slot", description: "test", column: "todo" });
    await store.updateTask(task.id, {
      status: "queued",
      error: "maxConcurrent capacity exhausted: used=12/12",
      steps: [{ name: "Preflight", status: "pending" }],
    });

    const result = await requireTool(api, "fn_task_retry").execute(
      "retry-throttled-control",
      { id: task.id },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not in a retryable state");
    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.error).toBe("maxConcurrent capacity exhausted: used=12/12");
  });
});
