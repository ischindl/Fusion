import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(task: Task, settings: Partial<Settings> = {}, events: unknown[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "direct",
    directMergeCommitStrategy: "auto",
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    mergeIntegrationWorktree: "cwd-main" as const,
    ...settings,
  } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    getTask: vi.fn(async () => task),
    /*
    FNXC:StaleReviewCallbackWaiver 2026-11-08-20:10 (RUFU-540):
    `aiMergeTask` reads the merge door (`store.getStaleReviewCallbackWaiverReceipts(task.id)` plus `store.getProjectId()`) before it captures merge content, so every store this fixture hands the merger must answer both reads or the call dies with `store.getStaleReviewCallbackWaiverReceipts is not a function` long before the no-op gate under test runs. The door was added 2026-10-01 (FNXC:StaleReviewCallbackWaiver 2026-10-01-04:24 in `merger.ts`); this real-git fixture predates it and went stale the same way `non-executor-run-audit-sink-health.test.ts` did. Empty receipts is the intended stance: no stale-callback waiver exists in these scenarios, so the door must not be able to grant one.
    */
    getStaleReviewCallbackWaiverReceipts: vi.fn(async () => []),
    getProjectId: vi.fn(() => "test-project"),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column ? [task].filter((t) => t.column === column) : [task])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => mergedSettings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: unknown) => {
      events.push(event);
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
    /*
    FNXC:WorkflowPassCacheFixture 2026-11-08-20:10 (RUFU-540):
    `SelfHealingManager` builds one epoch-guarded IR cache per pass from `store.workflowDefinitionEpoch()` (RUFU-584, `self-healing.ts:1588`), so a fixture store handed to it must answer that read or the whole pass aborts inside its own catch and emits none of the audit rows the assertions look for. The real store answers with a plain counter (`core/src/store.ts:767`); a frozen `0` is the correct fake here because these scenarios never sync a workflow definition mid-pass.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
  }) as unknown as TaskStore & EventEmitter;
}

describe("foreign start-point no-owned-commit interactions (real git)", () => {
  it("merger no-op gate blocks completion and contains the task in review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4656-ri-merge-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");

      git(dir, "git checkout -b fusion/fn-a");
      writeFileSync(join(dir, "foreign.txt"), "from fn-a\n");
      git(dir, "git add foreign.txt");
      git(dir, "git commit -m 'feat(FN-A): foreign' -m 'Fusion-Task-Id: FN-A'");
      const foreignBaseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout main");
      git(dir, "git checkout -b fusion/fn-b");
      git(dir, "git checkout main");

      const task = {
        id: "FN-B",
        title: "t",
        description: "d",
        column: "in-review",
        branch: "fusion/fn-b",
        baseBranch: "main",
        baseCommitSha: foreignBaseSha,
        modifiedFiles: ["foreign.txt"],
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const events: unknown[] = [];
      const store = makeStore(task, {}, events);

      const result = await aiMergeTask(store, dir, task.id);

      expect(result.merged).toBe(false);
      expect(task.column).toBe("in-review");
      expect(events.some((event: any) => event?.mutationType === "task:finalize-unproven-blocked")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("self-healing no-op pass requeues unproven candidates to todo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4656-ri-heal-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git checkout -b fusion/fn-a");
      writeFileSync(join(dir, "foreign.txt"), "from fn-a\n");
      git(dir, "git add foreign.txt");
      git(dir, "git commit -m 'feat(FN-A): foreign' -m 'Fusion-Task-Id: FN-A'");
      const foreignBaseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout main");
      git(dir, "git checkout -b fusion/fn-b");
      git(dir, "git checkout main");

      const task = {
        id: "FN-B2",
        title: "t",
        description: "d",
        column: "in-review",
        branch: "fusion/fn-b",
        baseBranch: "main",
        baseCommitSha: foreignBaseSha,
        modifiedFiles: ["foreign.txt"],
        paused: false,
        status: undefined,
        worktree: `${dir}/.worktrees/fn-b2`,
        mergeDetails: undefined,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      const events: unknown[] = [];
      const store = makeStore(task, {}, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      const recovered = await manager.finalizeNoOpReviewTasks();

      expect(recovered).toBe(0);
      expect(task.column).toBe("in-review");
      expect(events.some((event: any) => event?.mutationType === "task:finalize-no-op-review-no-action")).toBe(true);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
