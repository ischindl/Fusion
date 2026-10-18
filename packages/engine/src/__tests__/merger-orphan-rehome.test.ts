import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  classifyOrphanOurAdvance,
  rehomeOrphanOntoIntegration,
} from "../merge/merger-orphan-rehome.js";

const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const trackedTmpDirs = new Set<string>();

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

afterAll(() => {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
});

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fusion-test-orphan-rehome-"));
  trackedTmpDirs.add(dir);
  git(dir, "git init -b main");
  git(dir, "git config user.name tester");
  git(dir, "git config user.email tester@example.com");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "git add tracked.txt");
  git(dir, "git commit -m init");
  return dir;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-13:20 (batch-engine tail):
`ir` is optional so every existing caller is byte-identical: with no workflow the resolver degrades to
the built-in coding IR, whose complete lane IS `done`, which is what these cases already assert.
*/
function makeFakeStore(tasks: Record<string, { column: string }>, ir?: unknown) {
  return {
    getTask: async (id: string) => tasks[id.toUpperCase()] ?? null,
    ...(ir
      ? {
          getTaskWorkflowSelectionAsync: async () => ({ workflowId: "orphan-lifecycle", stepIds: [] }),
          getTaskWorkflowSelection: () => ({ workflowId: "orphan-lifecycle", stepIds: [] }),
          getWorkflowDefinition: async (id: string) => (id === "orphan-lifecycle" ? { ir } : undefined),
        }
      : {}),
  } as any;
}

function makeFakeAuditor(events: Array<{ type: string; metadata?: any }>) {
  return {
    git: async (event: any) => { events.push(event); },
    database: async () => undefined,
    filesystem: async () => undefined,
    sandbox: async () => undefined,
  } as any;
}

describe("classifyOrphanOurAdvance", () => {
  it("classifies a done-task foreign commit unreachable from integration as orphan", async () => {
    const dir = setupRepo();
    try {
      // Sibling commit attributed to FN-5551, never landed on main.
      git(dir, "git checkout -b sibling-orphan");
      writeFileSync(join(dir, "orphan.txt"), "orphan\n");
      git(dir, "git add orphan.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(true);
      if (result.orphan) {
        expect(result.sourceTaskId).toBe("FN-5551");
        expect(result.orphanSha).toBe(orphanSha);
      }
    } finally {
      removeTmpDirSync(dir);
    }
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:20 (batch-engine tail):
  The case above proves orphan classification for the LEGACY complete id, which is what the guard
  compared against — it passed before this conversion and would pass for a broken one. On a renamed
  complete lane the source read as unfinished, so orphaned commits were never rehomed and stayed
  stranded off the integration branch with no error surfaced.

  REVERT CHECK, measured: with `sourceTask.column !== "done"` restored, this fails with
  `orphan: false, reason: "source-task-not-done"`.
  */
  it("classifies the orphan when the source task sits in a RENAMED complete lane", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling-orphan-renamed");
      writeFileSync(join(dir, "orphan-renamed.txt"), "orphan\n");
      git(dir, "git add orphan-renamed.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore(
          { "FN-5551": { column: RENAMED_VOCAB.complete } },
          lifecycleIr(RENAMED_VOCAB, "orphan-lifecycle"),
        ),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(true);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("still refuses on a RENAMED board when the source task is mid-flight", async () => {
    /*
    Non-vacuous companion: without it, a guard that treated every source as finished would pass the case
    above. Same renamed board, same shape — only the source lane changes.
    */
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling-orphan-wip");
      writeFileSync(join(dir, "orphan-wip.txt"), "orphan\n");
      git(dir, "git add orphan-wip.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore(
          { "FN-5551": { column: RENAMED_VOCAB.wip } },
          lifecycleIr(RENAMED_VOCAB, "orphan-lifecycle"),
        ),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("source-task-not-done");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when source task is not done", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling");
      writeFileSync(join(dir, "x.txt"), "x\n");
      git(dir, "git add x.txt");
      git(dir, `git commit -m "feat(FN-5551): wip" -m "Fusion-Task-Id: FN-5551"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "in-progress" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "feat(FN-5551): wip",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("source-task-not-done");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when the commit is already reachable from integration", async () => {
    const dir = setupRepo();
    try {
      writeFileSync(join(dir, "y.txt"), "y\n");
      git(dir, "git add y.txt");
      git(dir, `git commit -m "feat(FN-5551): landed" -m "Fusion-Task-Id: FN-5551"`);
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "feat(FN-5551): landed",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("reachable-from-integration");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when no Fusion trailer or subject prefix is present", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b stray");
      writeFileSync(join(dir, "z.txt"), "z\n");
      git(dir, "git add z.txt");
      git(dir, `git commit -m "untagged commit"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({}),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "untagged commit",
        commitBody: "",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("no-trailer");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

/*
FNXC:TaskIdAttribution 2026-10-18-13:53 (RUFU-352):
Orphan rehoming is the destructive consumer of task-id attribution: a positive classification makes the
merger advance `refs/heads/<integration>` onto someone else's commit. Before RUFU-352 the classifier
hardcoded `FN-\d+` in BOTH its subject and trailer patterns, so a `fix(RUFU-274): …` commit carrying a
`Fusion-Task-Id: RUFU-274` trailer was read as naming no card at all (`no-trailer`) and its work stayed
stranded off the integration branch forever. RUFU-292 generalized the five branch-conflict attribution
sites; these cases pin the same generalization here, on prefixes the FN-only pattern can never match.

The refusal cases matter more than the positive one: widening attribution must not widen the WRITE.
Each case below re-asserts the ref-unchanged proof from the caller's position (`if (orphan) rehome(...)`),
so a classifier that attributes a non-FN commit but loses its source-done gate is caught red-handed.
*/
describe("classifyOrphanOurAdvance non-FN prefixes", () => {
  it("attributes a foreign commit by a non-FN trailer and subject", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b rufu-orphan");
      writeFileSync(join(dir, "rufu.txt"), "rufu\n");
      git(dir, "git add rufu.txt");
      git(dir, `git commit -m "fix(RUFU-274): orphaned squash" -m "Fusion-Task-Id: RUFU-274"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "RUFU-274": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: orphanSha,
        commitSubject: "fix(RUFU-274): orphaned squash",
        commitBody: "Fusion-Task-Id: RUFU-274\n",
      });

      expect(result.orphan).toBe(true);
      if (result.orphan) {
        expect(result.sourceTaskId).toBe("RUFU-274");
        expect(result.orphanSha).toBe(orphanSha);
      }
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("attributes a non-FN commit from the subject scope alone when the body is empty", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sane-subject-only");
      writeFileSync(join(dir, "sane.txt"), "sane\n");
      git(dir, "git add sane.txt");
      git(dir, `git commit -m "chore(SANE-452): docs refresh"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "SANE-452": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: orphanSha,
        commitSubject: "chore(SANE-452): docs refresh",
        commitBody: "",
      });

      expect(result.orphan).toBe(true);
      if (result.orphan) expect(result.sourceTaskId).toBe("SANE-452");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("normalizes a hand-authored lowercase trailer to the canonical id", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b lowercase-trailer");
      writeFileSync(join(dir, "lc.txt"), "lc\n");
      git(dir, "git add lc.txt");
      git(dir, `git commit -m "fix: orphaned squash" -m "Fusion-Task-Id: rufu-274"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "RUFU-274": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: orphanSha,
        commitSubject: "fix: orphaned squash",
        commitBody: "Fusion-Task-Id: rufu-274\n",
      });

      expect(result.orphan).toBe(true);
      if (result.orphan) expect(result.sourceTaskId).toBe("RUFU-274");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses a non-FN orphan whose source card is mid-flight and never moves the integration ref", async () => {
    /*
    Destructive-path proof. The rehome WRITE is gated solely on `orphan: true`, so this asserts the
    source-done gate survives generalization by mirroring the caller: run the classifier, honour its
    verdict the way run-implementation.ts does, and require refs/heads/main to be untouched.
    */
    const dir = setupRepo();
    try {
      const integrationTipBefore = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b sane-wip");
      writeFileSync(join(dir, "wip.txt"), "wip\n");
      git(dir, "git add wip.txt");
      git(dir, `git commit -m "feat(SANE-452): wip" -m "Fusion-Task-Id: SANE-452"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "SANE-452": { column: "in-progress" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: sha,
        commitSubject: "feat(SANE-452): wip",
        commitBody: "Fusion-Task-Id: SANE-452\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("source-task-not-done");
      // Caller contract: rehome only on a positive verdict, so the ref must not move.
      if (result.orphan) throw new Error("refusing a mid-flight source must not yield an orphan verdict");
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(integrationTipBefore);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses a non-FN commit already reachable from integration", async () => {
    const dir = setupRepo();
    try {
      writeFileSync(join(dir, "landed.txt"), "landed\n");
      git(dir, "git add landed.txt");
      git(dir, `git commit -m "fix(RUFU-274): landed" -m "Fusion-Task-Id: RUFU-274"`);
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "RUFU-274": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: sha,
        commitSubject: "fix(RUFU-274): landed",
        commitBody: "Fusion-Task-Id: RUFU-274\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("reachable-from-integration");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("keeps the self-attribution gate across prefixes", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b self-owned");
      writeFileSync(join(dir, "self.txt"), "self\n");
      git(dir, "git add self.txt");
      git(dir, `git commit -m "fix(RUFU-274): my own work" -m "Fusion-Task-Id: RUFU-274"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        // Same prefix AND same id on both sides: the card merging must not rehome its own commit.
        taskStore: makeFakeStore({ "RUFU-274": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "RUFU-274",
        commitSha: sha,
        commitSubject: "fix(RUFU-274): my own work",
        commitBody: "Fusion-Task-Id: RUFU-274\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("self-attributed");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("still refuses a commit naming no card at all under the generalized grammar", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b stray-grammar");
      writeFileSync(join(dir, "stray.txt"), "stray\n");
      git(dir, "git add stray.txt");
      git(dir, `git commit -m "chore(anything): untagged" -m "Co-authored-by: someone"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({}),
        integrationBranch: "main",
        currentTaskId: "RUFU-290",
        commitSha: sha,
        commitSubject: "chore(anything): untagged",
        commitBody: "Co-authored-by: someone\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("no-trailer");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

describe("rehomeOrphanOntoIntegration", () => {
  it("fast-forwards integration when its tip is an ancestor of the orphan", async () => {
    const dir = setupRepo();
    const events: Array<{ type: string; metadata?: any }> = [];
    try {
      // Orphan extends main by one commit (integration tip IS an ancestor of orphan).
      const integrationTipBefore = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b feature");
      writeFileSync(join(dir, "ff.txt"), "ff\n");
      git(dir, "git add ff.txt");
      git(dir, `git commit -m "feat(FN-5551): ff orphan" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await rehomeOrphanOntoIntegration({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        orphanSha,
        taskId: "FN-5419",
        audit: makeFakeAuditor(events),
      });

      expect(result.rehomed).toBe(true);
      if (result.rehomed) {
        expect(result.mode).toBe("fast-forward");
        expect(result.previousTipSha).toBe(integrationTipBefore);
        expect(result.newTipSha).toBe(orphanSha);
      }
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(orphanSha);
      expect(events.some((e) => e.type === "merger:orphan-rehome-ff")).toBe(true);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses non-FF rehome and emits an actionable cherry-pick hint", async () => {
    const dir = setupRepo();
    const events: Array<{ type: string; metadata?: any }> = [];
    try {
      const baseSha = git(dir, "git rev-parse refs/heads/main");

      // Orphan branch (FN-5551) parented at base.
      git(dir, "git checkout -b orphan-branch");
      writeFileSync(join(dir, "orphan.txt"), "orphan\n");
      git(dir, "git add orphan.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");

      // Advance main to a divergent sibling (FN-5552) — main and orphan
      // now share `baseSha` but neither is an ancestor of the other.
      git(dir, `git checkout ${baseSha}`);
      git(dir, "git checkout -b advancer");
      writeFileSync(join(dir, "advancer.txt"), "advancer\n");
      git(dir, "git add advancer.txt");
      git(dir, `git commit -m "feat(FN-5552): divergent"`);
      const advancerSha = git(dir, "git rev-parse HEAD");
      git(dir, `git update-ref refs/heads/main ${advancerSha} ${baseSha}`);
      git(dir, "git checkout main");

      const result = await rehomeOrphanOntoIntegration({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        orphanSha,
        taskId: "FN-5419",
        audit: makeFakeAuditor(events),
      });

      expect(result.rehomed).toBe(false);
      if (!result.rehomed) {
        expect(result.mode).toBe("refused-non-fast-forward");
        expect(result.cherryPickHint).toContain(`cherry-pick ${orphanSha}`);
      }
      // Integration ref must NOT have moved.
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(advancerSha);
      const refused = events.find((e) => e.type === "merger:orphan-rehome-refused");
      expect(refused).toBeTruthy();
      expect(refused?.metadata?.reason).toBe("non-fast-forward");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});
