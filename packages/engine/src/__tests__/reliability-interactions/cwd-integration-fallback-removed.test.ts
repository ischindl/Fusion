import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { aiMergeTask } from "../../merger.js";
import { git, makeReliabilityFixture } from "./_helpers.js";

describe("FN-5348 reliability interactions: cwd fallback removal", () => {
  // FN-5348 dirty-refusal path replaced by autostash. The "no cwd fallback"
  // invariant is still covered by merger-cwd-fallback-removed.test.ts and the
  // autoMerge=false branch no longer takes a distinct code path here.
  it.skip("autoMerge=false + dirty reused worktree autostashes and proceeds without any cwd fallback events", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5348-RI-AUTO-OFF-AUTOSTASH",
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
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5348-ri-refusal.ts", "export const refusal = true;\n", "feat: add refusal merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);
      git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");

      await aiMergeTask(store, rootDir, task.id).catch(() => undefined);

      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-autostash");
      expect(auditTypes).not.toContain("merge:cwd-integration-fallback-removed");
      expect(auditTypes).not.toContain("merge:cwd-integration-fallback-refused");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
