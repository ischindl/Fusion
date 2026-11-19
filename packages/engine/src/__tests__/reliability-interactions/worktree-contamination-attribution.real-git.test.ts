import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../../executor.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string, taskId?: string): Promise<string> {
  await writeFile(join(cwd, file), content, "utf-8");
  git(cwd, `git add ${JSON.stringify(file)}`);
  if (taskId) {
    git(cwd, `git commit -m ${JSON.stringify(message)} -m ${JSON.stringify(`Fusion-Task-Id: ${taskId}`)}`);
  } else {
    git(cwd, `git commit -m ${JSON.stringify(message)}`);
  }
  return git(cwd, "git rev-parse HEAD");
}

function makeExecutor(rootDir: string): TaskExecutor {
  const stubStore = { on: () => {} } as unknown as TaskStore;
  return new TaskExecutor(stubStore, rootDir);
}

describeIfGit("FN-5039 reliability interaction: worktree contamination attribution", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
  });

  if (!hasGit) {
    // eslint-disable-next-line no-console
    console.warn("Skipping FN-5039 real-git tests: git is not available");
  }

  async function initRepo() {
    const repoDir = await mkdtemp(join(tmpdir(), "fn-5039-ri-"));
    dirs.push(repoDir);
    git(repoDir, "git init -b main");
    git(repoDir, 'git config user.email "test@example.com"');
    git(repoDir, 'git config user.name "Test User"');
    await commitFile(repoDir, "README.md", "base\n", "chore: init", "FN-BASE");
    const baseSha = git(repoDir, "git rev-parse HEAD");
    return { repoDir, baseSha };
  }

  it("filters to own commit files after rebase contamination shape", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-file.ts", "task\n", "feat: own change", taskId);

    git(repoDir, "git checkout main");
    await commitFile(repoDir, "unrelated-a.ts", "a\n", "feat: other 1", "FN-OTHER-1");
    await commitFile(repoDir, "unrelated-b.ts", "b\n", "feat: other 2", "FN-OTHER-2");
    await commitFile(repoDir, "unrelated-c.ts", "c\n", "feat: other 3", "FN-OTHER-3");

    git(repoDir, `git checkout fusion/${taskId.toLowerCase()}`);
    git(repoDir, "git rebase main");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "scope-leak-guard");

    expect(files).toEqual(["task-file.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      target: taskId,
      metadata: expect.objectContaining({
        rawDiffFileCount: 4,
        attributedFileCount: 1,
        foreignCommitCount: 3,
      }),
    }));
  });

  it("returns union for clean own-attributed branch without contamination audit", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-a.ts", "a\n", "feat: own A", taskId);
    await commitFile(repoDir, "task-b.ts", "b\n", "feat: own B", taskId);

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    expect(files).toEqual(["task-a.ts", "task-b.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorktreeAttribution 2026-11-19-02:48 (RUFU-669):
  Re-baselined from "does not auto-attribute untrailered commits", which asserted `foreignCommitCount: 1`
  for a commit that names no card. The row still fires and the file is still hidden — the conservative
  file-set behavior is untouched — but the unlabelled commit is counted in its own bucket, because
  `foreignCommitShas`/`foreignCommitCount` are the operator's answer to "whose work is on this branch".
  */
  it("counts an untrailered commit as unattributed, never as another card's work", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned.ts", "owned\n", "feat: owned", taskId);
    await commitFile(repoDir, "task-untrailered.ts", "no trailer\n", "feat: untrailered");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    expect(files).toEqual(["task-owned.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      metadata: expect.objectContaining({
        rawDiffFileCount: 2,
        attributedFileCount: 1,
        foreignCommitCount: 0,
        nonAttributedCommitCount: 1,
      }),
    }));
  });

  it("falls back without contamination audit when attribution fails", async () => {
    const { repoDir } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned.ts", "owned\n", "feat: owned", taskId);

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(
      repoDir,
      "definitely-not-a-ref",
      taskId,
      audit,
      "post-session",
    );

    expect(files).toEqual([]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  /*
  FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
  The reported symptom, reproduced end to end on real git. A real card's own commits carried their task id
  only in the middle of a conventional-commit subject — `test(ui): gardy legacy tvarov na výstupe mapovania
  (SANE-489 AC1-AC4, krok 6)` — which no attribution source recognised, so every one of the card's OWN
  commits was named in `foreignCommitShas`, the contamination row fired on the card's own work, and the
  auto-widen gate refused the files its own commits had produced.
  The assertion that it is gone: a range holding nothing but the card's own mid-subject commits produces NO
  contamination row at all, and a range that also holds another card's commit names exactly that one sha.
  */
  it("RUFU-669 symptom: a card's own mid-subject commits raise no contamination row", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "SANE-489";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    // The fixture helper writes the file before `git add`, so a nested path needs its directory first.
    await mkdir(join(repoDir, "ui"), { recursive: true });
    await commitFile(
      repoDir,
      "ui/legacy-shapes.spec.ts",
      "test\n",
      "test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)",
    );
    await commitFile(
      repoDir,
      "ui/shared-shapes.spec.ts",
      "test2\n",
      "test(ui): pridaj ďalšie tvary (SANE-489 AC2, krok 4)",
    );

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    expect(files).toEqual(["ui/legacy-shapes.spec.ts", "ui/shared-shapes.spec.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  it("RUFU-669 symptom: a mixed range names only the other card's sha and keeps own files visible", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "SANE-489";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "own.ts", "own\n", "test(ui): gardy legacy tvarov (SANE-489 AC1, krok 6)");
    const foreignSha = await commitFile(repoDir, "other.ts", "other\n", "feat(FN-1000): iná karta", "FN-1000");
    await commitFile(repoDir, "unlabelled.ts", "noise\n", "chore: vendor bump");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    // The card's own file stays attributed, and only the genuinely foreign sha is named.
    expect(files).toEqual(["own.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    const call = audit.database.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(call.metadata).toEqual(
      expect.objectContaining({
        rawDiffFileCount: 3,
        attributedFileCount: 1,
        foreignCommitCount: 1,
        foreignCommitShas: [foreignSha],
        nonAttributedCommitCount: 1,
      }),
    );
  });

  it("RUFU-669 symptom: a re-drive on a member-directory branch already carrying its own commits accuses nothing", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "SANE-489";

    // The previous drive left its own commits on the card's branch, named only mid-subject.
    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "mapping-shapes.ts", "shapes\n", "feat(ui): nove tvary mapovania (SANE-489 AC1, krok 3)");
    await commitFile(repoDir, "mapping-guards.ts", "guards\n", "test(ui): gardy legacy tvarov (SANE-489 AC2, krok 4)");

    // Trunk moves under it, then the re-drive rebases onto the new trunk.
    git(repoDir, "git checkout main");
    await commitFile(repoDir, "trunk.ts", "trunk\n", "chore: trunk pokrok", "FN-TRUNK-1");
    git(repoDir, `git checkout fusion/${taskId.toLowerCase()}`);
    git(repoDir, "git rebase main");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const newBase = git(repoDir, "git merge-base main HEAD");
    const files = await (executor as any).captureModifiedFiles(repoDir, newBase, taskId, audit, "scope-leak-guard");

    expect(files).toEqual(["mapping-guards.ts", "mapping-shapes.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
    // And against the ORIGINAL acquisition base — the range that first produced the false accusation —
    // the card's own shas are still absent from foreignCommitShas.
    const redriveAudit = { database: vi.fn(async () => undefined) };
    await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, redriveAudit, "verification-tool");
    expect(redriveAudit.database).toHaveBeenCalledTimes(1);
    const metadata = redriveAudit.database.mock.calls[0]![0].metadata as { foreignCommitShas: string[] };
    const ownShas = git(repoDir, `git rev-list ${newBase}..fusion/${taskId.toLowerCase()}`).split("\n");
    expect(metadata.foreignCommitShas.some((sha) => ownShas.includes(sha))).toBe(false);
  });
});
