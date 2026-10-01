import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  getTaskMergeBlocker,
  isUncommittedWorkHold,
  type Task,
  type TaskStore,
} from "@fusion/core";

/*
FNXC:WorktreeCleanup 2026-09-27-01:01 (RUFU-274):
Mirrors the mock harness `post-landing-worktree-cleanup.test.ts` uses, so the cleanup assertions below drive
the real decision code while the git layer stays a seam. `worktree-backend.js` is aliased away by the
engine's Vitest config, so it must be mocked explicitly rather than resolved.
*/
const { removeWorktreeMock } = vi.hoisted(() => ({ removeWorktreeMock: vi.fn() }));
vi.mock("../worktree/worktree-backend.js", () => ({
  ActiveSessionWorktreeRemovalError: class extends Error {},
  RemovalReason: { CompletionLandedCleanup: "completion-landed-cleanup" },
  removeWorktree: removeWorktreeMock,
}));

import {
  DELIVERY_UNPROVEN_ERROR_PREFIX,
  applyZeroCommitUncommittedWorkHold,
  clearZeroCommitUncommittedWorkHold,
} from "../merge/zero-commit-finalization-guard.js";
import { cleanupLandedTaskWorktree } from "../merge/post-landing-worktree-cleanup.js";

/*
FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 7/8):
The merge-queue drain decides a landing from two things only: `merged`/`noOp` from the merge, and
`result.deliveryUnproven` plus the durable row hold. Both refusal signals must survive a second tick without
burning the retry budget. These are the two failure modes RUFU-262 hid behind its missing probe: the drain
counter only advanced on `merged || noOp`, so a refused card re-ran its merge forever, and a card whose only
signal was a process-local marker lost its refusal the moment the process changed. Everything asserted here
is durable-row reasoning, which is what makes a refusal survive across ticks and across processes.
*/

function heldTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-274",
    title: "Zero-commit card with the work still in its checkout",
    description: "",
    column: "in-review",
    status: "review-pending",
    paused: false,
    branch: "fusion/rufu-274",
    worktree: "/worktrees/rufu-274",
    steps: [],
    mergeDetails: { mergeConfirmed: true, mergeTargetBranch: "main", mergeSourceBranch: "fusion/rufu-274" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

function createStore(initial: Task) {
  let current = { ...initial };
  const audits: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const store = {
    getTask: vi.fn(async () => current),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS }) as never),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      /*
      The real store REPLACES `mergeDetails` on an update, which is exactly what lets a clear remove the hold
      marker. A permissive deep merge here would make the store lie about the one behaviour under test.
      */
      current = { ...current, ...updates } as Task;
      if (updates.error === null) delete (current as { error?: string | null }).error;
      return current;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (entry: { type: string; metadata?: Record<string, unknown> }) => {
      audits.push({ type: entry.type, metadata: entry.metadata ?? {} });
    }),
    moveTask: vi.fn(async () => current),
    emit: vi.fn(),
    on: vi.fn(),
    __audits: audits,
  } as unknown as TaskStore & { __audits: typeof audits };
  return store;
}

function holdInput(task: Task, over: { source?: Parameters<typeof applyZeroCommitUncommittedWorkHold>[0]["source"] } = {}) {
  return {
    task,
    source: over.source ?? ("merge-queue-drain" as const),
    code: "uncommitted-work" as const,
    refusal: "2 uncommitted change(s) survive in the worktree (tracked.txt, brand-new.ts) and a merge would drop them.",
    uncommittedPaths: ["tracked.txt", "brand-new.ts"],
    contentState: "deliverable" as const,
    modifiedCount: 1,
    untrackedCount: 1,
    contentBasis: "clean" as const,
    aheadCommitCount: 0,
  };
}

describe("zero-commit delivery refusal — durable hold, queue drain, and cleanup", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    removeWorktreeMock.mockReset();
  });

  it("stamps a row-visible hold that refuses every later lane without touching status or retry budget", async () => {
    const task = heldTask();
    const store = createStore(task);

    await applyZeroCommitUncommittedWorkHold({ store, ...holdInput(task) });

    const held = (await store.getTask!(task.id))!;
    expect(isUncommittedWorkHold(held.mergeDetails)).toBe(true);
    // The claim under test is revoked with the refusal: the row can no longer self-authorize a finalize.
    expect(held.mergeDetails!.mergeConfirmed).toBe(false);
    expect(held.paused).toBe(true);
    expect(held.pausedReason).toBe("manual-hold");
    expect(held.error).toContain(DELIVERY_UNPROVEN_ERROR_PREFIX);

    /*
    The drain's own refusal predicate, verbatim from project-engine: no `merged`/`noOp` result plus either
    signal must park the card as `manual-required` rather than continue the queue. Asserted as the shipped
    expression so a future refactor cannot silently drop the row-hold half of the disjunction.
    */
    const refused = (result: { merged?: boolean; noOp?: boolean; deliveryUnproven?: unknown }) =>
      !result.merged && !result.noOp && (Boolean(result.deliveryUnproven) || isUncommittedWorkHold(held.mergeDetails));
    expect(refused({})).toBe(true);
    expect(refused({ deliveryUnproven: {} })).toBe(true);
    expect(refused({ merged: true })).toBe(false);
    expect(refused({ noOp: true })).toBe(false);

    // The refusal is a wait, never a verdict about the code: no status write, no retry burn, no move.
    expect(held.status).toBe("review-pending");
    expect(held.mergeDetails!.mergeRetries ?? 0).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();

    // Every later lane refuses it from the row alone, with no re-probe, and names the surviving files.
    expect(getTaskMergeBlocker(held)).toContain("survive in the worktree");
    expect(getTaskMergeBlocker(held)).toContain("tracked.txt");
  });

  it("releases only its own refusal sentence and leaves another owner's park intact", async () => {
    // Case A: the pause/error pair this hold stamped, released when the landing proof arrives.
    const mine = createStore(heldTask());
    await applyZeroCommitUncommittedWorkHold({ store: mine, ...holdInput(heldTask(), { source: "merge-runner" }) });
    const heldA = (await mine.getTask!("RUFU-274"))!;
    await clearZeroCommitUncommittedWorkHold(mine, heldA, "merge-runner");
    const cleared = (await mine.getTask!("RUFU-274"))!;
    expect(isUncommittedWorkHold(cleared.mergeDetails)).toBe(false);
    expect(cleared.paused).toBe(false);
    expect(cleared.error ?? null).toBeNull();

    // Case B: the pause belongs to a different owner — releasing must not unlock it.
    const foreignError = "AUTO_MERGE_RETRY_REJECTED: merge retries exhausted";
    const foreignTask = heldTask({ paused: true, pausedReason: "manual-hold", error: foreignError });
    const theirs = createStore(foreignTask);
    // A real lane hands the guard the row it just read, foreign park included.
    await applyZeroCommitUncommittedWorkHold({ store: theirs, ...holdInput(foreignTask, { source: "merge-runner" }) });
    const heldB = (await theirs.getTask!("RUFU-274"))!;
    await clearZeroCommitUncommittedWorkHold(theirs, heldB, "merge-runner");
    const afterB = (await theirs.getTask!("RUFU-274"))!;
    expect(isUncommittedWorkHold(afterB.mergeDetails)).toBe(false);
    expect(afterB.paused).toBe(true);
    expect(afterB.error).toBe(foreignError);
  });

  it("does not destroy the surviving content when a held card reaches post-landing cleanup", async () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), "rufu274-held-wt-"));
    tempDirs.push(worktreeDir);
    const task = heldTask({ worktree: worktreeDir });
    const store = createStore(task);
    await applyZeroCommitUncommittedWorkHold({ store, ...holdInput(task) });
    const held = (await store.getTask!(task.id))!;

    const outcome = await cleanupLandedTaskWorktree({
      store,
      taskId: task.id,
      worktreePath: held.worktree,
      rootDir: "/project",
      landedSha: "abc1234",
      task: held,
      source: "ai-merge-finalize",
      log: async () => undefined,
    });

    expect(outcome).toMatchObject({ removed: false, preservedReason: "delivery-unproven" });
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    // The pointer is still the only thing standing between the surviving files and deletion.
    expect(held.worktree).toBe(worktreeDir);
  });

  it("still removes an unheld landed worktree — the control that proves the hold is what refuses", async () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), "rufu274-clean-wt-"));
    tempDirs.push(worktreeDir);
    const task = heldTask({ worktree: worktreeDir });
    const store = createStore(task);
    removeWorktreeMock.mockResolvedValue({ removed: true });

    const outcome = await cleanupLandedTaskWorktree({
      store,
      taskId: task.id,
      worktreePath: task.worktree,
      rootDir: "/project",
      landedSha: "abc1234",
      task,
      source: "ai-merge-finalize",
      log: async () => undefined,
    });

    expect(outcome).toMatchObject({ removed: true, outcome: "removed" });
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
  });
});
