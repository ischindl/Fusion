/**
 * FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
 * Unit coverage for the one probe the self-healing root-git sweeps share. Every case is a real
 * temp directory plus (where the arm is unreachable from a directory) one injected detector, so no
 * timer, poll, or network is involved: the arms that need injection are the ones git itself will
 * never report against a temp path — dubious ownership, a timeout, and an unknown failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { GitRepoDetection } from "../worktree/worktree-pool.js";
import { probeRepoRootIsGitRepository, type RepoRootDetector } from "../self-healing/repo-root-probe.js";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  return String(execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }) ?? "");
}

/** A repository with one commit on `main`, i.e. a root git will answer for. */
function makeRepo(prefix: string): string {
  const root = tempRoot(prefix);
  git(["init"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test User"], root);
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  git(["add", "README.md"], root);
  git(["commit", "-m", "init"], root);
  git(["branch", "-M", "main"], root);
  return root;
}

function injected(verdict: GitRepoDetection): { detector: RepoRootDetector; calls: () => number } {
  const fn = vi.fn(async () => verdict);
  return { detector: fn as RepoRootDetector, calls: () => fn.mock.calls.length };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("probeRepoRootIsGitRepository — data states", () => {
  it("reports an absent path as missing-root and never reaches the shared ENOENT classifier", async () => {
    const missing = join(tempRoot("rufu-804-absent"), "never-created");
    // The injected detector WOULD claim the git binary is missing. The point of checking existence
    // first is that this arm is never reached for a path that does not exist.
    const { detector, calls } = injected({ status: "error", reason: "git-missing", stderr: "spawn git ENOENT" });

    const result = await probeRepoRootIsGitRepository(missing, detector);

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("missing-root");
    expect(result.rootState).toBe("missing");
    expect(result.operatorMessage).toContain("does not exist");
    expect(result.operatorMessage).not.toContain("git-missing");
    expect(calls()).toBe(0);
  });

  it("refuses a plain directory that is not a repository", async () => {
    const root = tempRoot("rufu-804-plain");

    const result = await probeRepoRootIsGitRepository(root);

    expect(result).toMatchObject({ status: "refused", reason: "not-repo", rootState: "present" });
    if (result.status !== "refused") return;
    // The sibling sentence, not the error-arm formatter: it names the consequence a sweep needs.
    expect(result.operatorMessage).toContain("not a Git repository");
    expect(result.operatorMessage).toContain(root);
  });

  it("refuses a workspace root that is not a repository even though a member is (the measured shape)", async () => {
    const workspace = tempRoot("rufu-804-ws");
    const member = join(workspace, "lager-manager");
    mkdirSync(member, { recursive: true });
    git(["init"], member);
    // Control: the member is a repository, so the workspace's refusal is about the ROOT, not about git.
    expect(git(["rev-parse", "--git-dir"], member).trim().length).toBeGreaterThan(0);

    const result = await probeRepoRootIsGitRepository(workspace);

    expect(result).toMatchObject({ status: "refused", reason: "not-repo", rootState: "present" });
  });

  it("proves a healthy single-project repository so the sweep keeps running", async () => {
    const root = makeRepo("rufu-804-repo");

    await expect(probeRepoRootIsGitRepository(root)).resolves.toEqual({ status: "repo" });
  });

  it.each([
    "dubious-ownership",
    "timeout",
    "unknown",
    "git-missing",
  ] as const)("refuses the pass on the injected %s verdict", async (reason) => {
    const root = makeRepo(`rufu-804-${reason}`);
    const { detector } = injected({ status: "error", reason, stderr: `synthetic ${reason} failure` });

    const result = await probeRepoRootIsGitRepository(root, detector);

    expect(result).toMatchObject({ status: "refused", reason, rootState: "present" });
    if (result.status !== "refused") return;
    // The error arm keeps the existing sentence family, so one remedy text stays authoritative.
    expect(result.operatorMessage).toContain("Git repository detection failed for project directory");
    expect(result.operatorMessage).toContain(`synthetic ${reason} failure`);
    if (reason === "dubious-ownership") {
      // The copy-paste-safety rule: the real path is descriptive only, never inside the remedy.
      expect(result.operatorMessage).toContain("safe.directory <project-directory>");
      expect(result.operatorMessage).not.toContain(`safe.directory ${root}`);
    }
  });

  it("re-runs every pass rather than memoising the verdict", async () => {
    const root = makeRepo("rufu-804-nomemo");
    const { detector, calls } = injected({ status: "repo" });

    await probeRepoRootIsGitRepository(root, detector);
    await probeRepoRootIsGitRepository(root, detector);

    // A memo here would keep refusing (or keep allowing) across a repair the manager never re-reads.
    expect(calls()).toBe(2);
  });
});
