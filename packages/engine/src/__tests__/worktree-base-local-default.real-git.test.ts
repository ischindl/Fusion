/*
FNXC:TaskBaseResolution 2026-09-16-03:45 (RUFU-245) — symptom-verification fixture:

Reported symptom: a card whose local `main` had diverged from `origin/main` was cut from a base
containing commits absent from local `main` (or refused at merge with zero own commits), because
acquisition preferred the lagging `<remote>/<default>` ref. The fix anchors every fresh task branch
to the LOCAL integration ref and refuses acquisition only when divergence is PROVEN — reconciling a
diverged main is an operator decision.

One bare-remote + clone fixture drives every relation shape end-to-end (real git, no mocks):
- diverged  → acquisition refuses with the `TASK_BASE_DIVERGED:` named reason, creates nothing
  (no branch, no worktree), spends no recovery budget, and emits exactly ONE
  `worktree:workspace-repo-base-branch` audit row with outcome `refused-diverged`;
- aligned   → branch tip equals the local `main` SHA;
- ahead     → branch tip equals the local `main` SHA with zero commits absent from local `main`;
- behind    → fresh branch starts at local `main` and the FN-8839 linear rebase leg (RUFU-245
  Step 4 guard: strictly-behind is NOT divergence) still moves the tip onto `origin/main`.
Assertions are on SHAs, refs, git state, and audit outcomes — never on log prose.
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rebaseNewWorktreeOntoRemote } from "../executor/worktree-create-outer.js";
import { TaskBranchBaseDivergedError } from "../worktree/task-base-resolution.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";

const paths: string[] = [];
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const gitOrNull = (cwd: string, args: string[]): string | null => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

type Shape = "aligned" | "ahead" | "behind" | "diverged";

/** Bare remote + clone where local `main` relates to `origin/main` as `shape` dictates. */
function makeRepo(shape: Shape): { clone: string; mainSha: string; originSha: string } {
  const base = mkdtempSync(join(tmpdir(), "rufu245-base-"));
  paths.push(base);
  const remote = join(base, "remote.git");
  const clone = join(base, "clone");
  git(base, ["init", "--bare", "-b", "main", remote]);

  git(base, ["clone", remote, clone]);
  git(clone, ["config", "user.email", "test@example.com"]);
  git(clone, ["config", "user.name", "Test"]);
  git(clone, ["checkout", "-B", "main"]);
  writeFileSync(join(clone, "shared.ts"), "export const shared = 'C0';\n");
  git(clone, ["add", "shared.ts"]);
  git(clone, ["commit", "-m", "C0"]);
  git(clone, ["push", "-u", "origin", "main"]);

  if (shape === "behind" || shape === "diverged") {
    // Advance the REMOTE only: a second clone contributes commit R.
    const pusher = join(base, "pusher");
    git(base, ["clone", remote, pusher]);
    git(pusher, ["config", "user.email", "pusher@example.com"]);
    git(pusher, ["config", "user.name", "Pusher"]);
    writeFileSync(join(pusher, "remote-only.ts"), "export const remoteOnly = 'R';\n");
    git(pusher, ["add", "remote-only.ts"]);
    git(pusher, ["commit", "-m", "R"]);
    git(pusher, ["push", "origin", "main"]);
    // Update the clone's remote-tracking ref so the relation is VISIBLE without any production-side
    // fetch — the resolver (and the Step 4 rebase probe) only ever read already-available refs.
    git(clone, ["fetch", "origin", "main"]);
  }
  if (shape === "ahead" || shape === "diverged") {
    // Advance LOCAL main only: unpushed commit L.
    writeFileSync(join(clone, "local-only.ts"), "export const localOnly = 'L';\n");
    git(clone, ["add", "local-only.ts"]);
    git(clone, ["commit", "-m", "L"]);
  }

  return { clone, mainSha: git(clone, ["rev-parse", "main"]), originSha: git(clone, ["rev-parse", "origin/main"]) };
}

function makeAcquisition(clone: string) {
  const store = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
  const auditGit = vi.fn(async () => undefined);
  const promise = acquireTaskWorktree({
    task: { id: "FN-ZBASE1", title: "local base anchor", description: "" } as any,
    rootDir: clone,
    store,
    settings: {} as any,
    audit: { git: auditGit },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  return { store, auditGit, promise };
}

const baseBranchRows = (auditGit: ReturnType<typeof vi.fn>) =>
  auditGit.mock.calls
    .map(([input]) => input as { type: string; metadata: Record<string, unknown> })
    .filter((input) => input.type === "worktree:workspace-repo-base-branch");

describe("fresh task branch base anchored to the local default branch (real git)", () => {
  it("proven-diverged local main refuses acquisition, creates nothing, spends no budget, and emits one refused-diverged audit row", async () => {
    const { clone } = makeRepo("diverged");
    const { store, auditGit, promise } = makeAcquisition(clone);

    const err = await promise.then(() => null).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(TaskBranchBaseDivergedError);
    const diverged = err as TaskBranchBaseDivergedError;
    // The operator-visible named reason: literal prefix + both proven counts (1 local-only, 1 remote-only).
    expect(diverged.message.startsWith("TASK_BASE_DIVERGED:")).toBe(true);
    expect(diverged.aheadCount).toBe(1);
    expect(diverged.behindCount).toBe(1);

    // Nothing was created: no task branch, and the clone still has only its main checkout.
    expect(gitOrNull(clone, ["rev-parse", "--verify", "fusion/fn-zbase1"])).toBeNull();
    expect(git(clone, ["worktree", "list"])).not.toContain("fn-zbase1");
    expect(existsSync(join(clone, ".fusion", "worktrees", "fn-zbase1"))).toBe(false);

    // No branch-conflict recovery budget was consumed by acquisition or its gate.
    const budgetWrites = store.updateTask.mock.calls.filter(
      ([, patch]) => patch && typeof patch === "object" && "recoveryRetryCount" in (patch as object),
    );
    expect(budgetWrites).toHaveLength(0);

    // Exactly ONE base-resolution audit row, refused-diverged, ids/outcomes-only metadata.
    const rows = baseBranchRows(auditGit);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      taskId: "FN-ZBASE1",
      stage: "acquire",
      source: "local-integration",
      outcome: "refused-diverged",
    });
    expect(rows[0]!.metadata.repoRelPath).toBeUndefined();
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/main|fusion\//);

    // The refusal sentence reached the operator's task log with the same named prefix.
    const logged = store.logEntry.mock.calls.map(([, message]) => String(message));
    expect(logged.some((message) => message.startsWith("TASK_BASE_DIVERGED:"))).toBe(true);
  });

  it("aligned local main cuts the task branch at the local integration SHA with one resolved audit row", async () => {
    const { clone, mainSha } = makeRepo("aligned");
    const { auditGit, promise } = makeAcquisition(clone);

    const result = await promise;
    expect(result.branch).toBe("fusion/fn-zbase1");
    expect(gitOrNull(clone, ["rev-parse", result.branch])).toBe(mainSha);

    const rows = baseBranchRows(auditGit);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ outcome: "resolved-local-base", stage: "acquire", source: "local-integration" });
  });

  it("ahead-only local main cuts the branch at the local SHA with no commit absent from local main", async () => {
    const { clone, mainSha } = makeRepo("ahead");
    const { promise } = makeAcquisition(clone);

    const result = await promise;
    expect(gitOrNull(clone, ["rev-parse", result.branch])).toBe(mainSha);
    // No upstream/remote lineage slipped in: the branch has zero commits local main lacks.
    expect(git(clone, ["rev-list", "--count", `main..${result.branch}`])).toBe("0");
  });

  it("strictly-behind local main still performs the linear rebase onto origin/main (FN-8839 preserved)", async () => {
    const { clone, mainSha, originSha } = makeRepo("behind");
    const { store, promise } = makeAcquisition(clone);

    const result = await promise;
    // Fresh branch starts at the LOCAL integration SHA (behind remote, linearly).
    expect(gitOrNull(clone, ["rev-parse", result.branch])).toBe(mainSha);
    expect(git(clone, ["merge-base", "--is-ancestor", mainSha, originSha])).toBe("");

    // The post-create rebase leg runs unchanged for a linear-behind remote and lands the tip on the
    // remote integration SHA — divergence skip (Step 4) must not treat this as divergence.
    await rebaseNewWorktreeOntoRemote(clone, store, result.worktreePath, result.branch, "FN-ZBASE1", {
      worktreeRebaseBeforeMerge: true,
    } as any);
    expect(gitOrNull(clone, ["rev-parse", result.branch])).toBe(originSha);
  });
});
