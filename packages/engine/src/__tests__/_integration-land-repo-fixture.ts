/*
FNXC:MergeSingleFlight 2026-11-21-17:13 (RUFU-1148 Step 5):
Shared REAL-repository harness for the integration-landing claim suites. The claim's whole subject is a
git-mutating write window, so a suite that mocks `landOneRepo` could assert that a function was called
while `main` moved underneath it. Both consumers therefore drive the real `landOneRepo` against a real
repository and assert on `git rev-parse` / `git merge-base` output read from disk:

- `merge-integration-land-real-git.test.ts` — single-card claim mechanics (refusal before any mutation,
  stale-base rebuild, agent latency never inside a claim, release on every exit).
- `merge-integration-land-two-card.test.ts` — the two-card sequence AC5 asks for, held in ONE test case.

The lease row model lives in `_integration-land-lease-double.ts`; the cross-PROCESS proof against the
real seam is `merge-integration-land.pg.test.ts`. Keep this module dependency-light (node:child_process,
node:fs, the lease double, the workspace fixture's repo initializer, plus a TYPE-only import of
`merger-ai`) so a claim regression never depends on a database.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { RunAuditor } from "../util/run-audit.js";
import type { Settings, Task, TaskStore } from "@fusion/core";
import type { LandRepoContext } from "../merge/merger-ai.js";
import { createLeaseStoreDouble, type LeaseStoreDouble } from "./_integration-land-lease-double.js";
import { initRepoWithCommit } from "./_workspace-fixture.js";

/** Run git in `repoDir`, surfacing git's own stderr — a fixture failure must name git's reason. */
export function gitIn(repoDir: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(`git ${args.join(" ")} failed: ${typeof stderr === "string" ? stderr.trim() : String(error)}`);
  }
}

/** The branch each fixture card works on, derived from its id the way the merger does. */
export const taskBranch = (taskId: string): string => `fusion/${taskId.toLowerCase()}`;

/** Commit one line of work onto the card's own branch, branched off `main`. */
export function prepareCardBranch(repoDir: string, taskId: string, file: string): void {
  const branch = taskBranch(taskId);
  gitIn(repoDir, "checkout", "-b", branch, "main");
  writeFileSync(path.join(repoDir, file), `${taskId} work\n`, "utf-8");
  gitIn(repoDir, "add", file);
  gitIn(repoDir, "commit", "-m", `feat(${taskId}): add ${file}`);
  gitIn(repoDir, "checkout", "main");
}

/** A merge agent that performs the real squash in the clean room (no AI), as the other merger suites do. */
export function squashMergeAgent(
  branch: string,
  onMerged?: () => void,
): LandRepoContext["mergeAgent"] {
  return async (cwd: string) => {
    execFileSync("git", ["merge", "--squash", branch], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("git", ["commit", "-m", `${branch}: squashed`], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    // Runs after the squash exists and before the land burst is acquired — the hook AC3 needs, because
    // it is the only moment a landing path is deliberately outside its own claim.
    onMerged?.();
  };
}

export const approveReviewAgent: LandRepoContext["reviewAgent"] = async () => "REVIEW_VERDICT: approve";

/** A task row with the fields the landing path reads, stating its fixture intent explicitly. */
export function makeLandTask(taskId: string, file: string): Task {
  return {
    id: taskId,
    title: `Land ${taskId}`,
    description: "",
    column: "in-review",
    status: null,
    branch: taskBranch(taskId),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    comments: [],
    steeringComments: [],
    // Merge-mechanics fixture, not a review-gating one: an explicit empty list states the intent
    // instead of inheriting the built-in gate list the door would then refuse.
    enabledWorkflowSteps: [],
    // Declared scope so the squash file-scope invariant sees a declared, matching file.
    modifiedFiles: [file],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

/** One task-row patch the landing path wrote, so a test can prove a wait wrote NOTHING. */
export type RecordedWrite = { taskId: string; patch: Record<string, unknown> };

export type LandHarness = {
  repoDir: string;
  store: LeaseStoreDouble & { updateTaskCalls: RecordedWrite[] };
  audit: RunAuditor;
  auditGit: ReturnType<typeof vi.fn>;
  logLines: string[];
  register: (task: Task) => Task;
  landContext: (
    taskId: string,
    options?: {
      mergeAgent?: LandRepoContext["mergeAgent"];
      setStatus?: LandRepoContext["setStatus"];
    },
  ) => LandRepoContext;
  dispose: () => void;
};

/**
 * A real repo plus the lease/task doubles `landOneRepo` needs, with every task-row write recorded.
 * The recorded patches are what make AC2 assertable: "this pass consumed no merge retry" is a claim
 * about writes that did NOT happen, and only a recording double can show an absence.
 */
export function createLandHarness(): LandHarness {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "fusion-integration-land-"));
  initRepoWithCommit(repoDir, "main");
  const store = createLeaseStoreDouble() as LandHarness["store"];
  const tasks = new Map<string, Task>();
  const updateTaskCalls: RecordedWrite[] = [];
  store.updateTaskCalls = updateTaskCalls;

  store.getTask = vi.fn(async (id: string) => tasks.get(id) ?? null) as never;
  store.updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    updateTaskCalls.push({ taskId: id, patch: patch as Record<string, unknown> });
    const current = tasks.get(id) ?? makeLandTask(id, "unused.txt");
    tasks.set(id, { ...current, ...patch });
    return current;
  }) as never;
  store.getSettings = vi.fn(async () => ({}) as Settings) as never;
  /*
  The reconciliation record is written through the store's atomic CAS seam, not `updateTask`, so a
  double that lacks it fails mid-land with `store.updateTaskAtomic is not a function` — the same
  compatibility note `workspace-merger.test.ts` records for the merge-review episode.
  */
  store.updateTaskAtomic = vi.fn(async (id: string, mutate: (live: Task) => Partial<Task> | undefined) => {
    const current = (await store.getTask!(id)) as Task;
    const patch = mutate(current);
    if (patch) Object.assign(current, patch);
    return current;
  }) as never;
  store.getStaleReviewCallbackWaiverReceipts = vi.fn(async () => []) as never;

  const logLines: string[] = [];
  const auditGit = vi.fn(async () => undefined);
  const audit = {
    git: auditGit,
    task: vi.fn(async () => undefined),
    ai: vi.fn(async () => undefined),
  } as unknown as RunAuditor;

  return {
    repoDir,
    store,
    audit,
    auditGit,
    logLines,
    register: (task: Task) => {
      tasks.set(task.id, task);
      return task;
    },
    landContext: (taskId, options = {}) => ({
      taskId,
      settings: {} as Settings,
      audit,
      log: async (message: string) => { logLines.push(message); },
      setStatus: options.setStatus ?? (async () => undefined),
      maxPasses: 1,
      mergeAgent: options.mergeAgent ?? squashMergeAgent(taskBranch(taskId)),
      reviewAgent: approveReviewAgent,
      stashResolveAgent: async () => undefined,
      includeTaskId: true,
      trailers: [],
      taskTitle: `Land ${taskId}`,
      store: store as TaskStore,
    }) as unknown as LandRepoContext,
    dispose: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}
