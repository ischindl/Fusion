/*
FNXC:TaskIdAttribution 2026-09-26-21:54:
Defect regression on real git for the saneca workspace acquisition wedge (prefix `SANE`).

Shape reproduced: a card's own worktree directory disappears, its branch survives with real unique
commits, and acquisition re-runs `inspectBareBranchCollision`. Attribution is the ONLY thing that
decides whether Fusion attaches that branch (zero loss) or refuses it as `foreign-unmerged` forever.
The card's commits carry `Fusion-Task-Id: SANE-452` with a bare `SANE-452: …` subject — valid ids
minted from the project's `settings.taskPrefix` — and attribution recognised only `FN-<n>`, so they
read as unattributed and the card could never re-acquire the checkout holding its own work.

Post-fix contract pinned here:
1. `reportBranchAttribution` counts those commits `ownTrailed`, not `unattributed`.
2. `inspectBareBranchCollision` therefore answers `reclaimable` (attach the existing branch) instead
   of `foreign-unmerged`, for a non-`FN` prefix exactly as it always did for `FN`.
3. Widening the prefix did NOT widen ownership: a commit claiming a DIFFERENT card of the same
   prefix is still `foreign`, and the collision still refuses to touch it.
4. A trailer that names nothing matching the canonical id grammar stays `unattributed` — preserved,
   never silently adopted.
*/
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAttributedTaskId,
  inspectBareBranchCollision,
  reportBranchAttribution,
} from "../execution/branch-conflicts.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

interface CollisionFixture {
  rootDir: string;
  worktreePath: string;
  baseSha: string;
  branch: string;
  cleanup: () => void;
}

/*
Builds the production shape for `taskId`: main with one commit, a worktree cut on
`fusion/<taskId lowercased>` carrying `commits`, then the worktree DIRECTORY deleted underneath git —
so the branch is unregistered-but-present and only attribution can tell whose work it is.
*/
function createDeletedWorktreeCollision(
  taskId: string,
  commits: Array<{ subject: string; trailer?: string | null }>,
): CollisionFixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "attrib-prefix-"));
  const rootDir = path.join(base, "repo");
  const worktreesDir = path.join(base, "worktrees");
  const worktreePath = path.join(worktreesDir, taskId.toLowerCase());
  const branch = `fusion/${taskId.toLowerCase()}`;

  mkdirSync(rootDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "card@example.com"');
  git(rootDir, 'git config user.name "Card User"');
  writeFileSync(path.join(rootDir, "tracked.txt"), "base\n", "utf8");
  git(rootDir, "git add tracked.txt");
  git(rootDir, "git commit -m 'chore: base'");
  const baseSha = git(rootDir, "git rev-parse HEAD");

  git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)} main`);
  for (const commit of commits) {
    const file = path.join(worktreePath, `${git(worktreePath, "git rev-parse --short HEAD")}.txt`);
    writeFileSync(file, `${commit.subject}\n`, "utf8");
    git(worktreePath, "git add -A");
    const message = commit.trailer === null
      ? `-m ${JSON.stringify(commit.subject)}`
      : `-m ${JSON.stringify(commit.subject)} -m ${JSON.stringify(commit.trailer ?? `Fusion-Task-Id: ${taskId}`)}`;
    git(worktreePath, `git commit ${message}`);
  }

  // The production failure: the pinned directory is gone, the branch and its work are not.
  rmSync(worktreePath, { recursive: true, force: true });

  return {
    rootDir,
    worktreePath,
    baseSha,
    branch,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describeIfGit("branch attribution for non-FN task id prefixes", () => {
  it("attributes a non-FN card's own trailer-committed work instead of calling it unattributed", async () => {
    const { rootDir, baseSha, branch, cleanup } = createDeletedWorktreeCollision("SANE-452", [
      { subject: "SANE-452: the TaskStore write path is a cold-boot lottery" },
      { subject: "SANE-452: let the harness advance only its own ref" },
    ]);
    try {
      const report = await reportBranchAttribution(rootDir, branch, baseSha, "SANE-452");
      expect(report.ownTrailed).toBe(2);
      expect(report.ownUntrailed).toEqual([]);
      expect(report.foreign).toEqual([]);
      expect(report.unattributed).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("reclaims the card's own unregistered branch instead of refusing it as foreign-unmerged", async () => {
    const { rootDir, worktreePath, branch, cleanup } = createDeletedWorktreeCollision("SANE-452", [
      { subject: "SANE-452: the TaskStore write path is a cold-boot lottery" },
      { subject: "SANE-452: let the harness advance only its own ref" },
    ]);
    try {
      const inspection = await inspectBareBranchCollision({
        repoDir: rootDir,
        branchName: branch,
        conflictingWorktreePath: worktreePath,
        requestingTaskId: "SANE-452",
        startPoint: "main",
      });
      expect(inspection.kind).toBe("reclaimable");
      if (inspection.kind === "reclaimable") {
        expect(inspection.taskAttributedCommitCount).toBe(2);
        expect(inspection.uniqueCommitCount).toBe(2);
      }
    } finally {
      cleanup();
    }
  });

  it("keeps refusing a branch whose commits belong to a different card of the same prefix", async () => {
    const { rootDir, worktreePath, baseSha, branch, cleanup } = createDeletedWorktreeCollision("SANE-452", [
      { subject: "SANE-452: this card's own work" },
      { subject: "SANE-499: work that landed here from another card", trailer: "Fusion-Task-Id: SANE-499" },
    ]);
    try {
      const report = await reportBranchAttribution(rootDir, branch, baseSha, "SANE-452");
      expect(report.foreign).toHaveLength(1);
      expect(report.foreign[0]?.foreignTaskId).toBe("SANE-499");
      expect(report.ownTrailed).toBe(1);

      const inspection = await inspectBareBranchCollision({
        repoDir: rootDir,
        branchName: branch,
        conflictingWorktreePath: worktreePath,
        requestingTaskId: "SANE-452",
        startPoint: "main",
      });
      // Mixed history is never attached wholesale, whatever the prefix — the pre-fix safety property.
      expect(inspection.kind).toBe("foreign-unmerged");
    } finally {
      cleanup();
    }
  });

  it("still attributes an FN-prefixed card exactly as before", async () => {
    const { rootDir, worktreePath, branch, cleanup } = createDeletedWorktreeCollision("FN-1234", [
      { subject: "fix(FN-1234): one" },
      { subject: "fix(FN-1234): two" },
    ]);
    try {
      const inspection = await inspectBareBranchCollision({
        repoDir: rootDir,
        branchName: branch,
        conflictingWorktreePath: worktreePath,
        requestingTaskId: "FN-1234",
        startPoint: "main",
      });
      expect(inspection.kind).toBe("reclaimable");
    } finally {
      cleanup();
    }
  });

  it("extracts any canonical task id and nothing that is not one", () => {
    expect(extractAttributedTaskId("SANE-452: bare subject", "Fusion-Task-Id: SANE-452")).toBe("SANE-452");
    expect(extractAttributedTaskId("fix(sane-452): lowercase scope", "body")).toBe("SANE-452");
    expect(extractAttributedTaskId("chore: none", "Fusion-Task-Id: sane-452\n")).toBe("SANE-452");
    // Trailer wins over the subject scope when they disagree — it is the authoritative stamp.
    expect(extractAttributedTaskId("fix(FN-1): scoped", "Fusion-Task-Id: SANE-9")).toBe("SANE-9");
    // Not a canonical id grammar: preserved as unattributed, never adopted as an owner claim.
    expect(extractAttributedTaskId("chore: none", "Fusion-Task-Id: please-merge")).toBe("");
    expect(extractAttributedTaskId("fix(some-body): scoped", "no trailer")).toBe("");
    expect(extractAttributedTaskId("unrelated subject", "no trailer")).toBe("");
  });
});
