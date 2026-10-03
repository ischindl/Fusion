import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "@fusion/core";
import {
  captureWorkspaceReviewEvidence,
  WorkspaceMemberEvidenceError,
} from "../worktree/workspace-review-evidence.js";
import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";

/*
FNXC:WorkspaceReviewEvidence 2026-10-03-01:05 (RUFU-519):
The invariant under test is that a member's evidence is measured in the member's own repository.
The production shape is reproduced exactly rather than mocked: a ROOT worktree whose member directory
is an empty leftover of a deleted member worktree. The root repository carries the same `fusion/<id>`
branch name, so the old code could have produced a confident measurement of the wrong repository -
which is why the negative case below asserts that nothing is reported at all.
*/

const root = mkdtempSync(join(tmpdir(), "fusion-member-evidence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(dir: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Fusion Test");
  /*
  The commit must be unique to this fixture repo. Two `commit --allow-empty -m initial` calls in the
  same second produce byte-identical trees and therefore the SAME sha, which would let a base meant to
  be unreachable resolve successfully and silently test nothing.
  */
  git(dir, "commit", "--allow-empty", "-m", `initial ${label}`);
  return git(dir, "rev-parse", "HEAD");
}

function taskWith(entries: Record<string, { worktreePath: string; branch: string; baseCommitSha: string }>): Task {
  return {
    id: "SANE-MEMBER",
    title: "workspace member evidence",
    description: "",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "complete", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repositoryScope: { state: "confirmed", repositories: Object.keys(entries), revision: 1 },
    workspaceWorktrees: entries as Task["workspaceWorktrees"],
  } as Task;
}

let workspaceRoot: string;      // the workspace root repository
let rootTaskWorktree: string;   // .fusion/worktrees/<id> of the root repo
let memberBaseSha: string;      // a real commit of the member repository, unknown to the root repo

beforeAll(() => {
  workspaceRoot = join(root, "workspace");
  initRepo(workspaceRoot, "workspace");
  writeFileSync(join(workspaceRoot, "README.md"), "root\n");
  git(workspaceRoot, "add", "README.md");
  git(workspaceRoot, "commit", "-m", "root content");

  rootTaskWorktree = join(workspaceRoot, ".fusion", "worktrees", "sane-900");
  git(workspaceRoot, "worktree", "add", rootTaskWorktree, "-b", "fusion/sane-900");

  const memberRepo = join(root, "member-source");
  memberBaseSha = initRepo(memberRepo, "member-source");

  // The saneca shape: the member directory inside the task worktree exists but holds nothing,
  // because the member worktree that used to live there was removed. The root repo has the branch.
  mkdirSync(join(rootTaskWorktree, "lager-member"), { recursive: true });
});

describe("captureWorkspaceReviewEvidence — which repository a member is measured in", () => {
  it("refuses to measure a member whose worktree is gone, instead of measuring the enclosing root", async () => {
    // The root repository DOES carry `fusion/sane-900`, so the branch probe would have succeeded and
    // only the member base would fail. Asserting the throw here is what keeps a wrong-repo diff -
    // including a false `netZero` - from ever being reported as evidence.
    expect(git(workspaceRoot, "branch", "--list", "fusion/sane-900")).toContain("fusion/sane-900");

    const task = taskWith({ "lager-member": {
      worktreePath: join(rootTaskWorktree, "lager-member"),
      branch: "fusion/sane-900",
      baseCommitSha: memberBaseSha,
    } });

    await expect(captureWorkspaceReviewEvidence({ task, workspaceRootDir: workspaceRoot, settings: {} }))
      .rejects.toMatchObject({
        name: "WorkspaceMemberEvidenceError",
        repository: "lager-member",
        reasonCode: "member-worktree-missing",
        classification: "workspace-member-worktree-missing:lager-member",
      });
  });

  it("names the member in the merge-content descriptor, not just in the thrown error", async () => {
    // The descriptor reason is the only thing that reaches `getTaskMergeBlocker` and the sweep's
    // `gatesSatisfied`, so it has to carry the same cause the operator sees in the finalize message.
    const task = taskWith({ "lager-member": {
      worktreePath: join(rootTaskWorktree, "lager-member"),
      branch: "fusion/sane-900",
      baseCommitSha: memberBaseSha,
    } });
    const descriptor = await captureMergeContentDescriptor(task, { workspaceRootDir: workspaceRoot, settings: {} });
    expect(descriptor.kind).toBe("workspace");
    expect(descriptor.repositories?.state).toBe("unavailable");
    expect(descriptor.repositories?.reason).toBe("workspace-member-worktree-missing:lager-member");
  });

  it("classifies an unmeasurable base inside a real member worktree as base-unresolvable, not as a missing worktree", async () => {
    // A distinct failure with a distinct remedy: the checkout is fine, the recorded base is not.
    const strangerRepo = join(root, "stranger");
    const strangerSha = initRepo(strangerRepo, "stranger");
    const memberRepo = join(root, "member-own");
    initRepo(memberRepo, "member-own");
    const memberWorktree = join(rootTaskWorktree, "own-member");
    git(memberRepo, "worktree", "add", memberWorktree, "-b", "fusion/sane-900");
    // Make the unresolvability structural, not timestamp-dependent: the base must be unknown here.
    expect(() => git(memberWorktree, "cat-file", "-t", strangerSha)).toThrow();

    const task = taskWith({ "own-member": {
      worktreePath: memberWorktree,
      branch: "fusion/sane-900",
      baseCommitSha: strangerSha,
    } });
    await expect(captureWorkspaceReviewEvidence({ task, workspaceRootDir: workspaceRoot, settings: {} }))
      .rejects.toMatchObject({ name: "WorkspaceMemberEvidenceError", reasonCode: "member-base-unresolvable" });
  });
});

describe("captureWorkspaceReviewEvidence — a healthy member is measured in its own repository", () => {
  it("still accepts a member reached through a symlinked path, so the identity check cannot invent a refusal", async () => {
    /*
    RUFU-519's pre-flight compares the entry path against what git reports as the top level. Git reports
    a resolved path, so a lexical-only comparison would reject every workspace under a symlinked root -
    a worse bug than the one it guards. A symlink to a real member worktree must capture normally.
    */
    const memberRepo = join(root, "linked-member");
    const base = initRepo(memberRepo, "linked-member");
    const worktree = join(rootTaskWorktree, "linked-target");
    git(memberRepo, "worktree", "add", worktree, "-b", "fusion/sane-900");
    const link = join(root, "linked-member-worktree");
    symlinkSync(worktree, link);

    const evidence = await captureWorkspaceReviewEvidence({
      task: taskWith({ linked: { worktreePath: link, branch: "fusion/sane-900", baseCommitSha: base } }),
      workspaceRootDir: workspaceRoot,
      settings: {},
    });
    expect(evidence.repositories).toHaveLength(1);
    expect(evidence.repositories[0].repository).toBe("linked");
  });

  it("reports the member's files, proving the probe ran in the member and not in the root", async () => {
    const memberRepo = join(root, "healthy-member");
    const base = initRepo(memberRepo, "healthy-member");
    const worktree = join(rootTaskWorktree, "healthy");
    git(memberRepo, "worktree", "add", worktree, "-b", "fusion/sane-900");
    writeFileSync(join(worktree, "shipped.txt"), "content\n");
    git(worktree, "add", "shipped.txt");
    git(worktree, "commit", "-m", "member work");

    const evidence = await captureWorkspaceReviewEvidence({
      task: taskWith({ healthy: { worktreePath: worktree, branch: "fusion/sane-900", baseCommitSha: base } }),
      workspaceRootDir: workspaceRoot,
      settings: {},
    });

    expect(evidence.repositories).toHaveLength(1);
    expect(evidence.repositories[0].repository).toBe("healthy");
    expect(evidence.repositories[0].files).toEqual(["shipped.txt"]);
    expect(evidence.repositories[0].qualifiedFiles).toEqual(["healthy/shipped.txt"]);
    expect(evidence.modifiedFiles).toEqual(["healthy/shipped.txt"]);
    expect(evidence.repositories[0].netZero).toBe(false);
  });
});
