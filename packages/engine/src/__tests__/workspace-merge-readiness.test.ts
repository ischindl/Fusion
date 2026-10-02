import { describe, expect, it } from "vitest";
import { resolveWorkspaceMergeReadiness } from "../merge/workspace-merge-readiness.js";

const task = {
  id: "FN-106",
  repositoryScope: { state: "confirmed" as const, repositories: ["Merge-Auth"] },
  workspaceWorktrees: {
    "Merge-Auth": { worktreePath: "/workspace/Merge-Auth/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
  },
  modifiedFiles: ["Merge-Auth/src/auth.ts"],
};

describe("workspace merge readiness", () => {
  it("keeps an already-landed confirmed repository as the second-pass obligation", () => {
    expect(resolveWorkspaceMergeReadiness(task, new Set(), new Set())).toEqual({
      kind: "ready",
      repositories: ["Merge-Auth"],
      preservedFiles: ["Merge-Auth/src/auth.ts"],
    });
  });

  it("fails closed instead of deriving all-landed from unexplained emptiness", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, workspaceWorktrees: { "Merge-Auth": { ...task.workspaceWorktrees["Merge-Auth"], landedSha: undefined } } }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
  });

  it("rejects malformed persisted duplicate declarations and worktree paths", () => {
    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge-Auth", "Merge-Auth"] },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate") });

    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge", "Merge-Auth"] },
      workspaceWorktrees: {
        Merge: { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106" },
        "Merge-Auth": { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
      },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate worktree") });
  });

  it("permits only an explicit commit-free task to take the no-op path", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, repositoryScope: { state: "confirmed", repositories: [] }, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "no-op" });
  });

  /*
  FNXC:WorkspaceFinalization 2026-10-02-19:51 (RUFU-504):
  The reported shape. A commit-free workspace whose member branches sit exactly on their merge-base has
  zero files (so no fresh obligation), zero commits ahead (so `netZero` is false, because
  `workspace-review-evidence.ts` computes `ahead` as a boolean), and no `landedSha`. Readiness used to
  refuse it as unexplained emptiness, and the card repeated one blocker sentence until the stall
  classifier parked it. Reproduce the original failure: the same fixture must no longer reach the
  "no evidenced landing obligations" sentence.
  */
  describe("commit-free workspace with acquired repositories", () => {
    const zeroDiffTask = {
      id: "SANE-463",
      noCommitsExpected: true,
      repositoryScope: { state: "confirmed" as const, repositories: ["lager-manager", "lager-2026"] },
      workspaceWorktrees: {
        "lager-manager": { worktreePath: "/saneca/.fusion/worktrees/sane-463/lager-manager", branch: "fusion/sane-463", baseCommitSha: "b".repeat(40) },
        "lager-2026": { worktreePath: "/saneca/.fusion/worktrees/sane-463/lager-2026", branch: "fusion/sane-463", baseCommitSha: "b".repeat(40) },
      },
      modifiedFiles: [] as string[],
    };

    it("lands each acquired repository as an obligation instead of refusing the whole workspace", () => {
      const result = resolveWorkspaceMergeReadiness(zeroDiffTask, new Set(), new Set());
      expect(result).toEqual({
        kind: "ready",
        repositories: ["lager-2026", "lager-manager"],
        preservedFiles: [],
      });
      expect(result.kind === "blocked" ? result.reason : "").not.toContain("no evidenced landing obligations");
    });

    it("refuses a commit-free workspace that declared two repositories and acquired only one", () => {
      const partial = {
        ...zeroDiffTask,
        workspaceWorktrees: { "lager-manager": zeroDiffTask.workspaceWorktrees["lager-manager"] },
      };
      const result = resolveWorkspaceMergeReadiness(partial, new Set(), new Set());
      /*
      The invariant a partial acquisition must hold is that it is never admitted as a delivery, not which
      refusal sentence names it: with one of two declared repositories present, `knownEntries` is non-empty,
      so the generic landing-obligation refusal is the honest owner. Pinning the sentence would make this
      test a copy of the message rather than a guard on the door.
      */
      expect(result.kind).not.toBe("ready");
      expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("SANE-463") });
    });

    it("keeps refusing an unexplained empty workspace that never declared a commit-free contract", () => {
      const { noCommitsExpected: _omitted, ...undeclared } = zeroDiffTask;
      expect(resolveWorkspaceMergeReadiness(undeclared, new Set(), new Set())).toMatchObject({
        kind: "blocked",
        reason: expect.stringContaining("no evidenced landing obligations"),
      });
    });

    it("leaves a fresh-diff obligation on the ready path it already had", () => {
      expect(resolveWorkspaceMergeReadiness(zeroDiffTask, new Set(["lager-manager"]), new Set())).toMatchObject({
        kind: "ready",
        repositories: ["lager-manager"],
      });
    });
  });
});
