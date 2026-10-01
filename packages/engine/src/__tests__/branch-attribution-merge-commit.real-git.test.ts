/*
FNXC:BranchAttribution 2026-09-29-21:50:
Defect regression on real git for RUFU-434 — the acquisition refusal that a fully own branch caused
against itself.

Shape reproduced (live on SANE-447, saneca workspace, 2026-09-29): the card's branch carries its own
commits, the card merges something into that branch, and the merge commit's body carries the card's own
`Fusion-Task-Id` trailer. Acquisition then counts unique commits with `git cherry` (merge commits
excluded — 3) and attributes with `git log base..branch` (merge commits included — 4), while the reclaim
decision demands the two counts be equal. `4 === 3` fails forever, `foreign` stays empty, `unattributed`
stays empty, and the card re-refuses `foreign-unmerged` on every pass with an operator-only remedy.

Contract pinned here:
1. Reclaim counts and attributes the SAME unique revision set, so own work plus an own merge commit is
   `reclaimable` — Fusion attaches the branch instead of stranding it.
2. The merge commit is not silently trusted: it is out of the counted set, and any merged commit that
   actually adds content is inside that set. A foreign-trailed commit brought in by a merge is therefore
   still `foreign-unmerged`, with the same operator-only remedy.
3. Whole-range attribution is unchanged for the executor's post-session audit (it still sees the merge),
   which is exactly why the collision path can no longer compare against it.
*/
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectBareBranchCollision,
  reportBranchAttribution,
} from "../execution/branch-conflicts.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

interface MergedBranchFixture {
  rootDir: string;
  worktreePath: string;
  baseSha: string;
  branch: string;
  cleanup: () => void;
}

/**
 * Builds the production shape: main with a base commit, the card's worktree holding two own commits,
 * then a merge into that branch whose commit body carries `trailerForMerge` — the card's own trailer by
 * default, or another card's when the test needs the contaminated shape. The worktree DIRECTORY is then
 * deleted underneath git, so only attribution can decide whose work the branch holds.
 */
function createMergedBranchCollision(
  taskId: string,
  mergedTaskId: string,
): MergedBranchFixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "attrib-merge-"));
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
  for (const subject of [
    `${taskId}: first own commit`,
    `${taskId}: second own commit`,
  ]) {
    const file = path.join(worktreePath, `${git(worktreePath, "git rev-parse --short HEAD")}.txt`);
    writeFileSync(file, `${subject}\n`, "utf8");
    git(worktreePath, "git add -A");
    git(worktreePath, `git commit -m ${JSON.stringify(subject)} -m ${JSON.stringify(`Fusion-Task-Id: ${taskId}`)}`);
  }

  // The card merges a side branch into its own branch: the merge commit is real, and its body carries
  // `mergedTaskId`'s trailer — the card's own in the reclaim case, a foreign card's in the contaminated one.
  git(worktreePath, "git checkout -b side-branch");
  const sideFile = path.join(worktreePath, "side.txt");
  writeFileSync(sideFile, "merged work\n", "utf8");
  git(worktreePath, "git add side.txt");
  git(worktreePath, `git commit -m ${JSON.stringify(`${mergedTaskId}: merged work`)} -m ${JSON.stringify(`Fusion-Task-Id: ${mergedTaskId}`)}`);
  git(worktreePath, `git checkout ${JSON.stringify(branch)}`);
  git(
    worktreePath,
    `git merge --no-ff side-branch -m ${JSON.stringify(`Merge side branch into ${branch}`)} -m ${JSON.stringify(`Fusion-Task-Id: ${taskId}`)}`,
  );

  // The production failure: the pinned directory is gone, the branch and all of its work are not.
  rmSync(worktreePath, { recursive: true, force: true });

  return {
    rootDir,
    worktreePath,
    baseSha,
    branch,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describeIfGit("bare-branch reclaim with an own merge commit on the branch", () => {
  it("reclaims own work plus an own merge commit instead of refusing it as foreign-unmerged", async () => {
    const { rootDir, worktreePath, branch, cleanup } = createMergedBranchCollision("SANE-447", "SANE-447");
    try {
      const inspection = await inspectBareBranchCollision({
        repoDir: rootDir,
        branchName: branch,
        conflictingWorktreePath: worktreePath,
        requestingTaskId: "SANE-447",
        startPoint: "main",
      });
      expect(inspection.kind).toBe("reclaimable");
      if (inspection.kind === "reclaimable") {
        // Two own commits + the merged own commit; the merge commit adds no patch of its own.
        expect(inspection.uniqueCommitCount).toBe(3);
        expect(inspection.taskAttributedCommitCount).toBe(3);
      }
    } finally {
      cleanup();
    }
  });

  it("keeps the whole-range audit honest about the merge while the collision counts only unique work", async () => {
    const { rootDir, baseSha, branch, cleanup } = createMergedBranchCollision("SANE-447", "SANE-447");
    try {
      const rangeReport = await reportBranchAttribution(rootDir, branch, baseSha, "SANE-447");
      // The range still sees the merge commit — this asymmetry is precisely what the reclaim
      // decision must no longer compare against.
      expect(rangeReport.ownTrailed).toBe(4);
      expect(rangeReport.foreign).toEqual([]);

      const uniqueShas = git(rootDir, `git rev-list --no-merges ${baseSha}..${branch}`).split("\n").filter(Boolean);
      const uniqueReport = await reportBranchAttribution(rootDir, branch, baseSha, "SANE-447", uniqueShas);
      expect(uniqueReport.ownTrailed).toBe(uniqueShas.length);
      expect(uniqueReport.foreign).toEqual([]);
      expect(uniqueReport.unattributed).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("still refuses a branch whose merged-in commit belongs to another card", async () => {
    const { rootDir, worktreePath, branch, cleanup } = createMergedBranchCollision("SANE-447", "SANE-422");
    try {
      const inspection = await inspectBareBranchCollision({
        repoDir: rootDir,
        branchName: branch,
        conflictingWorktreePath: worktreePath,
        requestingTaskId: "SANE-447",
        startPoint: "main",
      });
      expect(inspection.kind).toBe("foreign-unmerged");
    } finally {
      cleanup();
    }
  });
});
