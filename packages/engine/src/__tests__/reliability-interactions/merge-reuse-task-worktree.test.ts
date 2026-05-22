import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../pi.js", () => ({
  createFnAgent: vi.fn(async () => ({
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  })),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<unknown> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  compactSessionContext: vi.fn(),
}));

import { activeSessionRegistry, executingTaskLock } from "../../active-session-registry.js";
import { aiMergeTask } from "../../merger.js";
import { createFnAgent } from "../../pi.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

describe("FN-5279 reliability interactions: merge reuse task worktree", () => {
  it.skipIf(!hasGit)("happy path merges from a reused task worktree and applies the squash to the project root's integration branch", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-HAPPY",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        worktreeRebaseRemote: "origin",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-happy.ts", "export const value = 1;\n", "feat: add reuse merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      const rootHeadBefore = git(rootDir, "git rev-parse HEAD");
      const rootTrackedStatusBefore = git(rootDir, "git status --porcelain --untracked-files=no");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);

      const mergedTask = await store.getTask(task.id);
      expect(mergedTask?.column).toBe("done");

      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
      const acquired = audits.find((event) => event.mutationType === "merge:reuse-handoff-acquired");
      expect(acquired?.metadata).toMatchObject({ integrationRemote: "origin", integrationBranch: "master" });

      // Step 5c (FN-5279 reuse mode) advances the project root's integration
      // branch to the new squash commit so changes actually land on master.
      expect(auditTypes).toContain("merge:integration-ref-advance");
      const advanced = audits.find(
        (event) => event.mutationType === "merge:integration-ref-advance",
      );
      expect(advanced?.metadata).toMatchObject({ advanceMode: "update-ref", succeeded: true });
      expect(git(rootDir, "git rev-parse HEAD")).not.toBe(rootHeadBefore);
      const rootTrackedStatusAfter = git(rootDir, "git status --porcelain --untracked-files=no");
      expect(rootTrackedStatusAfter).not.toBe(rootTrackedStatusBefore);
      expect(rootTrackedStatusAfter).toContain("fn-5279-ri-happy.ts");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("dirty reused worktree is autostashed so the merge can proceed", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-DIRTY",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-dirty.ts", "export const dirty = true;\n", "feat: add dirty merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);
      git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");

      await aiMergeTask(store, rootDir, task.id).catch(() => undefined);
      const autostash = store.getRunAuditEvents({ taskId: task.id })
        .find((event) => event.mutationType === "merge:reuse-handoff-autostash");
      expect(autostash?.metadata).toMatchObject({ worktreePath });
      expect(typeof autostash?.metadata?.stashSha).toBe("string");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("active session binding refuses handoff until the worktree is released", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-ACTIVE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-active.ts", "export const active = true;\n", "feat: add active merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);
      activeSessionRegistry.registerPath(worktreePath, { taskId: task.id, kind: "executor", ownerKey: task.id });
      executingTaskLock.tryClaim(task.id);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "active-session-binding",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "active-session-binding" });
    } finally {
      activeSessionRegistry.clear();
      executingTaskLock._clearForTest();
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("branch/worktree mapping mismatches refuse handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-MISMATCH",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch: "fusion/fn-other",
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-mismatch.ts", "export const mismatch = true;\n", "feat: add mismatch merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath } as any);
      store.enqueueMergeQueue(task.id);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "branch-worktree-mapping",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "branch-worktree-mapping" });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("missing merge queue lease refuses handoff with target-not-queued diagnostics", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-NO-LEASE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-no-lease.ts", "export const noLease = true;\n", "feat: add no-lease merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id, { now: "2026-05-19T00:00:00.000Z" });
      store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
        "worker-other",
        "2026-05-19T00:01:00.000Z",
        "2099-05-19T00:10:00.000Z",
        task.id,
      );

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: aiMergeTask succeeds without pre-enqueue by self-enqueueing before handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5353-RI-SELF-ENQUEUE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, { baseBranch: "master", branch, steps: completedSteps, currentStep: completedSteps.length } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5353-ri-self-enqueue.ts", "export const selfEnqueue = true;\n", "feat: add self enqueue merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: cross-task queue entries remain untouched when aiMergeTask self-enqueues target", async () => {
    const fixtureA = await makeReliabilityFixture({
      taskId: "FN-5353-RI-TARGET-A",
      settings: { baseBranch: "master", mergeIntegrationWorktree: "reuse-task-worktree" } as any,
    });

    try {
      const { rootDir, store, task } = fixtureA;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      const other = await store.createTask({ description: "queue head other", priority: "normal" });
      await store.moveTask(other.id, "todo");
      await store.moveTask(other.id, "in-progress");
      await store.handoffToReview(other.id, {
        ownerAgentId: "agent-1",
        evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      });
      store.enqueueMergeQueue(other.id, { now: "2026-05-19T00:00:00.000Z" });

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, { baseBranch: "master", branch, steps: completedSteps, currentStep: completedSteps.length } as any);
      await fixtureA.createBranch(branch);
      await fixtureA.writeAndCommit("packages/engine/src/fn-5353-ri-target-not-queued.ts", "export const targetNotQueued = true;\n", "feat: add target not queued reproduction");
      await fixtureA.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");

      const otherRow = store.getDatabase().prepare("SELECT taskId, leasedBy FROM mergeQueue WHERE taskId = ?").get(other.id) as {
        taskId: string;
        leasedBy: string | null;
      };
      expect(otherRow.taskId).toBe(other.id);
      expect(otherRow.leasedBy).toBeNull();
    } finally {
      await fixtureA.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: reuse handoff rejects project-root worktree misconfiguration", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5353-RI-PROJECT-ROOT-WORKTREE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        worktree: rootDir,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5353-ri-project-root.ts", "export const projectRootReuse = true;\n", "feat: add project root misconfiguration content");
      await fixture.checkout("master");
      store.enqueueMergeQueue(task.id);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "reuse-misconfigured",
        reason: "worktree-equals-project-root",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: missing task.worktree reacquires a reusable worktree before handoff gates", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5353-RI-MISSING-WORKTREE-HANDOFF",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      git(rootDir, "git branch -m main master");

      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        worktree: null,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5353-ri-missing-worktree-handoff.ts", "export const missingHandoff = true;\n", "feat: add missing worktree handoff content");
      await fixture.checkout("master");
      store.enqueueMergeQueue(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-fallback-new-worktree");
      expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
      const refused = audits.find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect((refused?.metadata as { reason?: string } | undefined)?.reason).not.toBe("worktree-equals-project-root");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5363: queue-head pollution by non-in-review tasks does not block target reuse handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5363-RI-POLLUTED",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        worktreeRebaseRemote: "origin",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, { baseBranch: "master", branch, steps: completedSteps, currentStep: completedSteps.length } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5363-ri-polluted.ts", "export const polluted = true;\n", "feat: add polluted queue merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id, { now: "2026-05-19T00:00:02.000Z" });

      const todoTask = await store.createTask({ description: "polluter todo", priority: "normal" });
      await store.moveTask(todoTask.id, "todo");
      const inProgressTask = await store.createTask({ description: "polluter progress", priority: "normal" });
      await store.moveTask(inProgressTask.id, "todo");
      await store.moveTask(inProgressTask.id, "in-progress");

      store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(todoTask.id, "2026-05-19T00:00:00.000Z", "normal");
      store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(inProgressTask.id, "2026-05-19T00:00:01.000Z", "normal");
      store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
        "merger-reuse-handoff",
        "2026-05-19T00:10:00.000Z",
        "2099-05-19T00:20:00.000Z",
        todoTask.id,
      );

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      expect(store.getDatabase().prepare("SELECT leasedBy FROM mergeQueue WHERE taskId = ?").get(task.id)).toBeUndefined();
      expect(store.getDatabase().prepare("SELECT taskId FROM mergeQueue WHERE taskId IN (?, ?)").all(todoTask.id, inProgressTask.id)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5363: target row leased by another worker refuses with target-not-queued diagnostics", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5363-RI-NO-LEASE-TARGET",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, { baseBranch: "master", branch, steps: completedSteps, currentStep: completedSteps.length } as any);
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.handoffToReview(task.id, {
        ownerAgentId: "agent-1",
        evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      });
      await store.updateTask(task.id, {
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5363-ri-no-lease-target.ts", "export const noLeaseTarget = true;\n", "feat: add leased target merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
        "worker-other",
        "2026-05-19T00:01:00.000Z",
        "2099-05-19T00:10:00.000Z",
        task.id,
      );

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ reason: "target-not-queued" });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("already-landed branch auto-finalizes from the reused worktree path", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-ALREADY-LANDED",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-already-landed.ts", "export const landed = true;\n", "feat: add already-landed merge content");
      await fixture.checkout("master");
      git(rootDir, `git merge --ff-only ${JSON.stringify(branch)}`);
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect(result.mergeConfirmed).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("Layer 3 conflict resolution sessions run from the reused worktree", async () => {
    mockedCreateFnAgent.mockClear();
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-LAYER3",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        mergeConflictStrategy: "smart-prefer-main",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
        prompt: "## File Scope\n- packages/engine/src/**\n",
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-layer3.ts", "export const value = 'branch';\n", "feat: branch conflict content");
      await fixture.checkout("master");
      git(rootDir, "mkdir -p packages/engine/src");
      git(rootDir, "sh -c \"printf \\\"export const value = 'main';\\n\\\" > packages/engine/src/fn-5279-ri-layer3.ts\"");
      git(rootDir, "git add packages/engine/src/fn-5279-ri-layer3.ts");
      git(rootDir, "git commit -m 'feat: main conflict content'");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      await aiMergeTask(store, rootDir, task.id);
      expect(
        mockedCreateFnAgent.mock.calls.some(([input]) => (input as any)?.cwd === worktreePath),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("reacquires a fresh task worktree when reuse is requested without a task worktree", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5353-RI-MISSING-WORKTREE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        worktree: null,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5353-ri-missing-worktree.ts", "export const fallback = true;\n", "feat: add fallback merge content");
      await fixture.checkout("master");
      store.enqueueMergeQueue(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-fallback-new-worktree");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).not.toContain("merge:reuse-fallback-cwd-main");
      expect(auditTypes).not.toContain("merge:reuse-fallback-cwd-integration-branch");
      expect(auditTypes).not.toContain("merge:cwd-integration-fallback-removed");
      const fallback = audits.find((event) => event.mutationType === "merge:reuse-fallback-new-worktree");
      expect(fallback?.metadata).toMatchObject({
        reason: "missing-task-worktree",
        source: "fresh",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("cwd-main legacy alias is normalized to cwd-integration-branch and stays on the opt-in path with no reuse handoff events", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-CWD-MAIN",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "cwd-main" as const,
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-cwd-main.ts", "export const legacy = true;\n", "feat: add cwd-main merge content");
      await fixture.checkout("master");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("worktrunk-enabled reuse mode still acquires reuse handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-WORKTRUNK",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        worktrunk: { enabled: true } as any,
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-worktrunk.ts", "export const deferred = true;\n", "feat: add worktrunk merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-deferred-to-worktrunk");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("autoMerge off remains inert and emits no reuse handoff events", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-AUTO-OFF",
      settings: {
        autoMerge: false,
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());
      git(rootDir, "git branch -m main master");
      await fixture.createBranch(branch);
      await fixture.checkout("master");
      await store.updateTask(task.id, { baseBranch: "master", worktree: worktreePath, branch } as any);
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);

      const latest = await store.getTask(task.id);
      expect(latest?.column).toBe("in-review");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  // FN-5345/FN-5377 regression backstop.
  //
  // A verification-only task that committed `--allow-empty` produced a branch
  // with own-commit-count >= 1 but zero net tree change vs merge-base. Combined
  // with drifted worktree<->branch mapping, the reuse-handoff gate would refuse
  // with `registered-branch-mismatch` and the task would escalate to
  // `merge-deadlock-detected: verified content not on main` after FN-4999
  // completion-handoff-limbo recovery exhausts. The early empty-own-diff
  // fast-path must finalize this BEFORE any reuse-handoff acquisition runs.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff branch auto-finalizes via early fast-path without acquiring reuse handoff",
    async () => {
      const fixture = await makeReliabilityFixture({
        taskId: "FN-5279-RI-EMPTY-OWN-DIFF",
        settings: {
          baseBranch: "master",
          mergeIntegrationWorktree: "reuse-task-worktree",
        } as any,
      });

      try {
        const { rootDir, store, task } = fixture;
        const actualTask = await store.getTask(task.id);
        const branch = `fusion/${actualTask!.id.toLowerCase()}`;
        const worktreeRoot = `${rootDir}-worktrees`;
        const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

        git(rootDir, "git branch -m main master");
        const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
        await store.updateTask(task.id, {
          baseBranch: "master",
          branch,
          steps: completedSteps,
          currentStep: completedSteps.length,
        } as any);
        await fixture.createBranch(branch);
        // Produce an empty handoff commit on the branch: own_commit_count == 1
        // but `git diff --quiet mergeBase..branch` exits 0 (no net change).
        git(rootDir, `git commit --allow-empty -m 'test(${actualTask!.id}): verification-only handoff'`);
        await fixture.checkout("master");

        // Set up the worktree mapping in a way that would normally wedge the
        // reuse-handoff gate (FN-5345 scenario): worktree mapped to a
        // not-yet-created path so classifyTaskWorktree would report `missing`,
        // forcing reacquire-fallback into FN-5083-class branch-registration drift.
        await store.updateTask(task.id, {
          worktree: join(worktreeRoot, "drifted-missing-path"),
          branch,
        } as any);
        store.enqueueMergeQueue(task.id);

        const result = await aiMergeTask(store, rootDir, task.id);

        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        expect(result.mergeConfirmed).toBe(true);
        expect((await store.getTask(task.id))?.column).toBe("done");

        const audits = store.getRunAuditEvents({ taskId: task.id });
        const auditTypes = audits.map((event) => event.mutationType);

        // Early fast-path must short-circuit BEFORE any reuse-handoff event.
        expect(auditTypes).not.toContain("merge:reuse-handoff-acquired");
        expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
        expect(auditTypes).not.toContain("merge:reuse-fallback-new-worktree");

        // Records the auto-finalize audit with the empty-own-diff reason.
        const finalize = audits.find(
          (event) =>
            event.mutationType === "task:auto-recover-finalize-already-on-main"
            && (event.metadata as any)?.reason === "empty-own-diff-early-fast-path",
        );
        expect(finalize).toBeDefined();
        expect((finalize?.metadata as any)?.aheadCount).toBeGreaterThanOrEqual(1);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 backstop variant: reproduce the actual production wedge
  // geometry where `fusion/<id>` is registered to TWO worktrees simultaneously
  // (e.g. faint-creek + hazy-quail in the FN-5345 incident). The early
  // fast-path runs against projectRootDir and is immune to the worktree drift,
  // so it must still finalize without acquiring any reuse handoff.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path fires even when branch is registered to two worktrees",
    async () => {
      const fixture = await makeReliabilityFixture({
        taskId: "FN-5279-RI-DOUBLE-REG",
        settings: {
          baseBranch: "master",
          mergeIntegrationWorktree: "reuse-task-worktree",
        } as any,
      });

      try {
        const { rootDir, store, task } = fixture;
        const actualTask = await store.getTask(task.id);
        const branch = `fusion/${actualTask!.id.toLowerCase()}`;
        const worktreeRoot = `${rootDir}-worktrees`;
        const pathA = join(worktreeRoot, `${actualTask!.id.toLowerCase()}-a`);
        const pathB = join(worktreeRoot, `${actualTask!.id.toLowerCase()}-b`);

        git(rootDir, "git branch -m main master");
        const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
        await store.updateTask(task.id, {
          baseBranch: "master",
          branch,
          steps: completedSteps,
          currentStep: completedSteps.length,
        } as any);
        await fixture.createBranch(branch);
        git(rootDir, `git commit --allow-empty -m 'test(${actualTask!.id}): verification-only handoff'`);
        await fixture.checkout("master");

        // Register branch at pathA, then force-register at pathB — reproduces
        // FN-5345's two-worktree-one-branch state.
        await mkdir(worktreeRoot, { recursive: true });
        git(rootDir, `git worktree add ${JSON.stringify(pathA)} ${JSON.stringify(branch)}`);
        git(rootDir, `git worktree add -f ${JSON.stringify(pathB)} ${JSON.stringify(branch)}`);

        // task.worktree points at one of them — doesn't matter which; the
        // fast-path operates against projectRootDir.
        await store.updateTask(task.id, { worktree: pathA, branch } as any);
        store.enqueueMergeQueue(task.id);

        const result = await aiMergeTask(store, rootDir, task.id);

        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        expect(result.mergeConfirmed).toBe(true);
        expect((await store.getTask(task.id))?.column).toBe("done");

        const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
        // No reuse-handoff lifecycle event should have fired — the fast-path
        // ran first against projectRootDir.
        expect(auditTypes).not.toContain("merge:reuse-handoff-acquired");
        expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
        expect(auditTypes).toContain("task:auto-recover-finalize-already-on-main");
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 cleanup-safety backstop: the fast-path's worktree removal
  // MUST preserve a worktree that has uncommitted tracked changes. We run
  // `git status --porcelain --untracked-files=no` and skip the removal when
  // tracked dirt is present. Untracked junk does not count (operator noise
  // like .DS_Store should not block cleanup).
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path preserves worktrees with uncommitted tracked changes",
    async () => {
      const fixture = await makeReliabilityFixture({
        taskId: "FN-5279-RI-DIRTY-PRESERVE",
        settings: {
          baseBranch: "master",
          mergeIntegrationWorktree: "reuse-task-worktree",
        } as any,
      });

      try {
        const { rootDir, store, task } = fixture;
        const actualTask = await store.getTask(task.id);
        const branch = `fusion/${actualTask!.id.toLowerCase()}`;
        const worktreeRoot = `${rootDir}-worktrees`;
        const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

        git(rootDir, "git branch -m main master");
        const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
        await store.updateTask(task.id, {
          baseBranch: "master",
          branch,
          steps: completedSteps,
          currentStep: completedSteps.length,
        } as any);
        await fixture.createBranch(branch);
        // Empty-own-diff handoff commit on the branch.
        git(rootDir, `git commit --allow-empty -m 'test(${actualTask!.id}): verification-only handoff'`);
        await fixture.checkout("master");

        // Create the worktree at branch tip, then introduce a tracked
        // modification (not committed) to simulate agent scratch.
        await mkdir(worktreeRoot, { recursive: true });
        git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
        // README.md is created by the fixture as a tracked file. Modify it to
        // produce tracked-dirty status.
        await writeFile(join(worktreePath, "README.md"), "agent scratch: uncommitted edits\n");
        await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
        store.enqueueMergeQueue(task.id);

        const result = await aiMergeTask(store, rootDir, task.id);
        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);

        // Critical: the worktree must NOT be removed because it has tracked
        // uncommitted changes. result.worktreeRemoved reflects that.
        expect(result.worktreeRemoved).toBe(false);
        expect(existsSync(worktreePath)).toBe(true);
        expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 cleanup-noise backstop: untracked junk (e.g. .DS_Store,
  // editor swap files, build artifacts that are not gitignored at the task
  // worktree level) must NOT block fast-path cleanup. Only tracked dirt does.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path cleans up worktrees with only untracked noise",
    async () => {
      const fixture = await makeReliabilityFixture({
        taskId: "FN-5279-RI-UNTRACKED-OK",
        settings: {
          baseBranch: "master",
          mergeIntegrationWorktree: "reuse-task-worktree",
        } as any,
      });

      try {
        const { rootDir, store, task } = fixture;
        const actualTask = await store.getTask(task.id);
        const branch = `fusion/${actualTask!.id.toLowerCase()}`;
        const worktreeRoot = `${rootDir}-worktrees`;
        const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

        git(rootDir, "git branch -m main master");
        const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
        await store.updateTask(task.id, {
          baseBranch: "master",
          branch,
          steps: completedSteps,
          currentStep: completedSteps.length,
        } as any);
        await fixture.createBranch(branch);
        git(rootDir, `git commit --allow-empty -m 'test(${actualTask!.id}): verification-only handoff'`);
        await fixture.checkout("master");

        await mkdir(worktreeRoot, { recursive: true });
        git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
        // Sprinkle untracked-only noise into the worktree.
        await writeFile(join(worktreePath, ".DS_Store"), "binary junk\n");
        await writeFile(join(worktreePath, "editor.swp"), "swap file\n");
        await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
        store.enqueueMergeQueue(task.id);

        const result = await aiMergeTask(store, rootDir, task.id);
        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        // Untracked-only is treated as clean — cleanup proceeds.
        expect(result.worktreeRemoved).toBe(true);
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );
});
