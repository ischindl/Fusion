import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideAutoPrerebase, probeDivergence, runAutoPrerebase } from "../merger-auto-prerebase.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describe("decideAutoPrerebase", () => {
  const settings = {
    prerebaseAutoEnabled: true,
    prerebaseHotFiles: ["AGENTS.md"],
    prerebaseDivergenceThreshold: 50,
  };

  it("short-circuits for worktrunk first", () => {
    expect(decideAutoPrerebase({ settings, baseCommitSha: "abc", commitsBehind: 99, changedFiles: ["AGENTS.md"], worktrunkEnabled: true }).reason).toBe("worktrunk-deferred");
  });

  it("returns disabled when prerebaseAutoEnabled is false", () => {
    expect(decideAutoPrerebase({ settings: { ...settings, prerebaseAutoEnabled: false }, baseCommitSha: "abc", commitsBehind: 99, changedFiles: ["AGENTS.md"], worktrunkEnabled: false }).reason).toBe("disabled");
  });

  it("returns no-base when base commit is missing", () => {
    expect(decideAutoPrerebase({ settings, baseCommitSha: undefined, commitsBehind: 99, changedFiles: ["AGENTS.md"], worktrunkEnabled: false }).reason).toBe("no-base");
  });

  it("prefers hot-file trigger over threshold", () => {
    const decision = decideAutoPrerebase({ settings, baseCommitSha: "abc", commitsBehind: 99, changedFiles: ["AGENTS.md", "other.ts"], worktrunkEnabled: false });
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe("hot-file");
    expect(decision.hotMatches).toEqual(["AGENTS.md"]);
  });

  it("fires on divergence threshold when configured", () => {
    const decision = decideAutoPrerebase({ settings, baseCommitSha: "abc", commitsBehind: 51, changedFiles: ["x.ts"], worktrunkEnabled: false });
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe("divergence-threshold");
  });

  it("returns no-divergence when nothing triggers", () => {
    const decision = decideAutoPrerebase({ settings, baseCommitSha: "abc", commitsBehind: 5, changedFiles: ["x.ts"], worktrunkEnabled: false });
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no-divergence");
  });
});

describeIfGit("merger-auto-prerebase git integration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setupRepo() {
    const repo = mkdtempSync(join(tmpdir(), "fusion-prerebase-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "shared.txt"), "base\n");
    git(repo, "git add a.txt shared.txt && git commit -m 'A'");
    const a = git(repo, "git rev-parse HEAD");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "git add b.txt && git commit -m 'B'");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "git add c.txt && git commit -m 'C'");
    return { repo, a };
  }

  it("probes divergence count and files", async () => {
    const { repo, a } = setupRepo();
    const result = await probeDivergence({ rootDir: repo, baseCommitSha: a });
    expect(result.commitsBehind).toBe(2);
    expect(result.changedFiles).toEqual(["b.txt", "c.txt"]);
  });

  it("runAutoPrerebase succeeds on clean history", async () => {
    const { repo, a } = setupRepo();
    const branch = "fusion/fn-4958-test";
    git(repo, `git checkout -b ${branch} ${a}`);
    writeFileSync(join(repo, "task.txt"), "task\n");
    git(repo, "git add task.txt && git commit -m 'task'");
    const mainHead = git(repo, "git rev-parse main");
    git(repo, `git checkout ${branch}`);

    const logs: string[] = [];
    const result = await runAutoPrerebase({
      rootDir: repo,
      worktreePath: repo,
      branch,
      taskId: "FN-4958",
      mainHead,
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });

    expect(result.ok).toBe(true);
    expect(logs.some((m) => m.includes("succeeded"))).toBe(true);
  });

  it("runAutoPrerebase aborts and returns failure on conflict", async () => {
    const { repo, a } = setupRepo();
    const branch = "fusion/fn-4958-conflict";
    git(repo, `git checkout -b ${branch} ${a}`);
    writeFileSync(join(repo, "shared.txt"), "branch\n");
    git(repo, "git add shared.txt && git commit -m 'branch-change'");
    git(repo, "git checkout main");
    writeFileSync(join(repo, "shared.txt"), "main\n");
    git(repo, "git add shared.txt && git commit -m 'main-change'");

    const mainHead = git(repo, "git rev-parse main");
    git(repo, `git checkout ${branch}`);

    const warn = vi.fn();
    const result = await runAutoPrerebase({
      rootDir: repo,
      worktreePath: repo,
      branch,
      taskId: "FN-4958",
      mainHead,
      logger: { log: vi.fn(), warn },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    expect(git(repo, "git status --porcelain")).toBe("");
  });
});
