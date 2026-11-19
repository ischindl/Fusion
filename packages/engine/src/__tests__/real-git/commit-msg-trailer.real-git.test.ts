import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { installTaskWorktreeIdentityGuard } from "../../worktree/worktree-hooks.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

describe("commit-msg trailer hook (real git)", () => {
  it("appends and preserves Fusion-Task-Id trailer in fusion worktrees", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5089-commit-msg-"));
    const worktreeDir = join(rootDir, "wt-kb");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/kb-7 wt-kb HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: worktreeDir,
        taskId: "KB-7",
        taskPrefix: "KB",
        taskAttributionTrailerName: "Fusion-Task-Id",
        projectId: null, // RUFU-394: this lane names no project, so the commit carries no project trailer.
      });

      // FN-5345/FN-5377: pre-commit hook now refuses empty commits in fusion
      // worktrees, so this test stages a real file change for each commit
      // instead of using --allow-empty. The trailer-hook behavior under test
      // is unchanged.
      writeFileSync(join(worktreeDir, "step1.txt"), "first\n");
      git(worktreeDir, "git add step1.txt && git commit -m 'feat(KB-7): first'");
      const firstBody = git(worktreeDir, "git log -1 --format=%B");
      expect(firstBody).toContain("Fusion-Task-Id: KB-7");
      expect((firstBody.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);
      const firstTrailers = git(worktreeDir, "git log -1 --format=%B | git interpret-trailers --parse");
      expect(firstTrailers).toContain("Fusion-Task-Id: KB-7");
      expect(firstTrailers).toContain("Co-authored-by: Fusion <noreply@runfusion.ai>");

      git(worktreeDir, "git commit --amend --no-edit");
      const amendNoEditBody = git(worktreeDir, "git log -1 --format=%B");
      expect((amendNoEditBody.match(/Fusion-Task-Id:\s*KB-7/g) ?? []).length).toBe(1);
      expect((amendNoEditBody.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);

      git(worktreeDir, "git commit --amend -m 'feat(KB-7): rewritten'");
      const rewrittenBody = git(worktreeDir, "git log -1 --format=%B");
      expect(rewrittenBody).toContain("feat(KB-7): rewritten");
      expect((rewrittenBody.match(/Fusion-Task-Id:\s*KB-7/g) ?? []).length).toBe(1);
      expect((rewrittenBody.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);

      writeFileSync(join(worktreeDir, "step-manual.txt"), "manual\n");
      git(worktreeDir, "git add step-manual.txt && git commit -m 'feat(KB-7): manual coauthor' -m 'Co-authored-by: Fusion <noreply@runfusion.ai>'");
      const manualBody = git(worktreeDir, "git log -1 --format=%B");
      expect((manualBody.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);

      const taskFile = git(worktreeDir, "git rev-parse --git-path fusion-task-id");
      writeFileSync(isAbsolute(taskFile) ? taskFile : resolve(worktreeDir, taskFile), "kb-7\n");
      writeFileSync(join(worktreeDir, "step2.txt"), "lowercase\n");
      git(worktreeDir, "git add step2.txt && git commit -m 'feat(KB-7): lowercase metadata'");
      const lowercaseBody = git(worktreeDir, "git log -1 --format=%B");
      expect(lowercaseBody).toContain("Fusion-Task-Id: KB-7");
      expect((lowercaseBody.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);

      writeFileSync(join(rootDir, "outside.txt"), "outside\n");
      git(rootDir, "git add outside.txt && git commit -m 'chore: root commit'");
      const rootBody = git(rootDir, "git log -1 --format=%B");
      expect(rootBody).not.toContain("Fusion-Task-Id:");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses custom co-author settings and honors commitAuthorEnabled false", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7065-commit-author-"));
    const customWorktreeDir = join(rootDir, "wt-custom");
    const disabledWorktreeDir = join(rootDir, "wt-disabled");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-7065-custom wt-custom HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: customWorktreeDir,
        taskId: "FN-7065-CUSTOM",
        commitAuthorName: "Fusion Bot",
        commitAuthorEmail: "bot@example.com",
        projectId: null, // RUFU-394: this lane names no project, so the commit carries no project trailer.
      });
      writeFileSync(join(customWorktreeDir, "custom.txt"), "custom\n");
      git(customWorktreeDir, "git add custom.txt && git commit -m 'feat(FN-7065-CUSTOM): custom author'");
      const customBody = git(customWorktreeDir, "git log -1 --format=%B");
      expect((customBody.match(/Co-authored-by:\s*Fusion Bot <bot@example\.com>/g) ?? []).length).toBe(1);

      git(rootDir, "git worktree add -b fusion/fn-7065-disabled wt-disabled HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: disabledWorktreeDir,
        taskId: "FN-7065-DISABLED",
        commitAuthorEnabled: false,
        projectId: null, // RUFU-394: this lane names no project, so the commit carries no project trailer.
      });
      writeFileSync(join(disabledWorktreeDir, "disabled.txt"), "disabled\n");
      git(disabledWorktreeDir, "git add disabled.txt && git commit -m 'feat(FN-7065-DISABLED): disabled author'");
      const disabledBody = git(disabledWorktreeDir, "git log -1 --format=%B");
      expect(disabledBody).toContain("Fusion-Task-Id: FN-7065-DISABLED");
      expect(disabledBody).not.toContain("Co-authored-by:");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  /*
  FNXC:CommitOwnership 2026-11-19-17:54 (RUFU-394):
  End-to-end proof of the emitting surface, because the string assertions on the generated hook
  cannot show that the shell it writes actually runs, that the project trailer lands in a real
  commit's trailer block, or that the unknown-identity lane writes NOTHING rather than an empty
  key. RUFU-394 exists because a bare task id was treated as delivery evidence across boards, and
  this hook is the only writer for ordinary agent commits — an id that reached `main` without
  project identity stays undetectable at delivery time forever.
  */
  it("writes the project identity trailer into real commits, and writes nothing when identity is unknown", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "rufu-394-project-trailer-"));
    const knownDir = join(rootDir, "wt-known");
    const unknownDir = join(rootDir, "wt-unknown");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/rufu-394-known wt-known HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: knownDir,
        taskId: "RUFU-394-KNOWN",
        taskPrefix: "RUFU",
        projectId: "proj_18b91890789b432f",
      });
      writeFileSync(join(knownDir, "known.txt"), "known\n");
      git(knownDir, "git add known.txt && git commit -m 'fix(RUFU-394-KNOWN): project-scoped identity'");
      const knownTrailers = git(knownDir, "git log -1 --format=%B | git interpret-trailers --parse");
      expect(knownTrailers).toContain("Fusion-Task-Id: RUFU-394-KNOWN");
      expect(knownTrailers).toContain("Fusion-Project-Id: proj_18b91890789b432f");

      // An amend must not stack a second copy: `--if-exists doNothing` guards the project key too.
      git(knownDir, "git commit --amend --no-edit");
      const amendedBody = git(knownDir, "git log -1 --format=%B");
      expect((amendedBody.match(/Fusion-Project-Id:\s*proj_18b91890789b432f/g) ?? []).length).toBe(1);
      expect((amendedBody.match(/Fusion-Task-Id:\s*RUFU-394-KNOWN/g) ?? []).length).toBe(1);

      // A hand-written project trailer survives an amend untouched, same rule as the task id.
      writeFileSync(join(knownDir, "foreign.txt"), "foreign\n");
      git(knownDir, "git add foreign.txt && git commit -m 'fix(RUFU-394-KNOWN): from another board' -m 'Fusion-Project-Id: proj_other'");
      const foreignTrailers = git(knownDir, "git log -1 --format=%B | git interpret-trailers --parse");
      expect((foreignTrailers.match(/Fusion-Project-Id:/g) ?? []).length).toBe(1);
      expect(foreignTrailers).toContain("Fusion-Project-Id: proj_other");

      // The unknown-identity lane must write no key at all: an empty `Fusion-Project-Id:` would
      // later read as "declares no project" and be skipped like an absent one, making the two
      // states indistinguishable — which is the ambiguity this whole change exists to remove.
      git(rootDir, "git worktree add -b fusion/rufu-394-unknown wt-unknown HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: unknownDir,
        taskId: "RUFU-394-UNKNOWN",
        taskPrefix: "RUFU",
        projectId: null,
      });
      writeFileSync(join(unknownDir, "unknown.txt"), "unknown\n");
      git(unknownDir, "git add unknown.txt && git commit -m 'fix(RUFU-394-UNKNOWN): identity unknown'");
      const unknownBody = git(unknownDir, "git log -1 --format=%B");
      expect(unknownBody).toContain("Fusion-Task-Id: RUFU-394-UNKNOWN");
      expect(unknownBody).not.toContain("Fusion-Project-Id");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);
});
