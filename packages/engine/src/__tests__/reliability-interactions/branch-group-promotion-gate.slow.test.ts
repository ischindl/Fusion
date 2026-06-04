import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type TaskStore } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

async function stageMergeBranch(store: TaskStore, rootDir: string, taskId: string, fileName: string): Promise<void> {
  const task = await store.getTask(taskId);
  const branch = `fusion/${taskId.toLowerCase()}`;
  const worktreePath = join(`${rootDir}-worktrees`, taskId.toLowerCase());
  await store.updateTask(taskId, {
    baseBranch: "",
    branch,
    column: "in-review",
    worktree: worktreePath,
    steps: (task?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    currentStep: (task?.steps ?? []).length ?? 0,
  } as any);

  git(rootDir, `git checkout -b ${branch}`);
  await mkdir(join(rootDir, "packages/engine/src"), { recursive: true });
  git(rootDir, `sh -c 'printf ${JSON.stringify(`export const ${fileName} = true;\n`)} > ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}'`);
  git(rootDir, `git add ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}`);
  git(rootDir, `git commit -m ${JSON.stringify(`feat: add ${fileName}`)}`);
  git(rootDir, "git checkout main");
  store.enqueueMergeQueue(taskId);
}

type Scenario = {
  name: string;
  groupAutoMerge?: boolean;
  settings: Record<string, unknown>;
  expected: { effectiveEligible: boolean; reason: string; groupAutoMerge: boolean };
};

function findPromotionGateEvent(store: TaskStore, groupId: string) {
  const events = store.getRunAuditEvents();
  return events.find((event) => event.mutationType === "merge:branch-group-promotion-gated" && (event.metadata as any)?.groupId === groupId);
}

describe("FN-5788 reliability interactions: branch group promotion gate", () => {
  const scenarios: Scenario[] = [
    {
      name: "eligible gate emits without promoting default branch",
      groupAutoMerge: true,
      settings: { autoMerge: true },
      expected: { effectiveEligible: true, reason: "eligible", groupAutoMerge: true },
    },
    {
      name: "group-automerge-disabled when group autoMerge is false",
      groupAutoMerge: false,
      settings: { autoMerge: true },
      expected: { effectiveEligible: false, reason: "group-automerge-disabled", groupAutoMerge: false },
    },
    {
      name: "global-pause override",
      groupAutoMerge: true,
      settings: { autoMerge: true, globalPause: true },
      expected: { effectiveEligible: false, reason: "global-pause", groupAutoMerge: true },
    },
    {
      name: "engine-paused override",
      groupAutoMerge: true,
      settings: { autoMerge: true, enginePaused: true },
      expected: { effectiveEligible: false, reason: "engine-paused", groupAutoMerge: true },
    },
    {
      name: "settings-automerge-disabled override",
      groupAutoMerge: true,
      settings: { autoMerge: false, globalPause: false, enginePaused: false },
      expected: { effectiveEligible: false, reason: "settings-automerge-disabled", groupAutoMerge: true },
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    it.skipIf(!hasGit)(scenario.name, async () => {
      const fixture = await makeReliabilityFixture({ settings: { ...scenario.settings, testMode: true } as any });
      try {
        const { rootDir, store, task } = fixture;
        const fileName = `fn5788Gate${index}`;
        await stageMergeBranch(store, rootDir, task.id, fileName);
        const group = store.createBranchGroup({
          sourceType: "planning",
          sourceId: `PS-FN5788-${index}`,
          branchName: `fusion/groups/fn-5788-gate-${index}`,
          autoMerge: scenario.groupAutoMerge,
        });
        await store.setTaskBranchGroup(task.id, group.id);
        await store.updateTask(task.id, {
          branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" },
        } as any);

        const auditSpy = vi.spyOn(store as any, "recordRunAuditEvent");
        const result = await aiMergeTask(store, rootDir, task.id);
        expect(result.merged).toBe(true);

        expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/${fileName}.ts`)).toContain(fileName);
        expect(() => git(rootDir, `git show main:packages/engine/src/${fileName}.ts`)).toThrow();

        expect(store.getBranchGroup(group.id)?.status).toBe("open");

        expect(findPromotionGateEvent(store, group.id)?.metadata).toEqual(expect.objectContaining({
          groupId: group.id,
          branchName: group.branchName,
          groupAutoMerge: scenario.expected.groupAutoMerge,
          effectiveEligible: scenario.expected.effectiveEligible,
          reason: scenario.expected.reason,
        }));

        expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
          domain: "git",
          mutationType: "merge:branch-group-promotion-gated",
          target: task.id,
          metadata: expect.objectContaining({
            groupId: group.id,
            branchName: group.branchName,
            groupAutoMerge: scenario.expected.groupAutoMerge,
            effectiveEligible: scenario.expected.effectiveEligible,
            reason: scenario.expected.reason,
          }),
        }));
      } finally {
        await fixture.cleanup();
      }
    }, 45_000);
  }
});
