/**
 * FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
 * The squash-import planner used to prefer `<remote>/<defaultBranch>` as `mainBase`, probing
 * `<remote>/HEAD` and best-effort `git fetch`-ing it first. That made a fresh branch's base a moving
 * remote pointer: a local main that had not caught up to origin produced a branch whose base commits
 * were absent from local main, which is what stranded the RUFU-237 card with zero own commits.
 * `mainBase` is now the SHA of the resolved LOCAL integration branch, with ambient HEAD as the only
 * fallback, and no remote read at all.
 *
 * The second half pins the companion guarantee in `createWorktree`: a default-base card whose start
 * point already IS the integration base must not be routed through the dep squash-import planner at
 * all (that would rewrite the card's own base as an "import" and leave it with zero own commits),
 * while a genuine dependency base still is (FN-2729 behavior preserved).
 */
import { describe, it, expect, vi } from "vitest";
import { planSquashImportFromDep, type SquashImportPlanStore } from "../worktree-squash-import-plan.js";
import { createWorktree, type WorktreeOuterCreateDeps } from "../worktree-create-outer.js";
import type { TaskBaseExecImpl } from "../../worktree/task-base-resolution.js";

const LOCAL_MAIN_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const DEP_SHA = "3333333333333333333333333333333333333333";

type ExecError = Error & { code?: number };

function gitFailure(code = 1): ExecError {
  return Object.assign(new Error(`git exited ${code}`), { code });
}

interface FakeGitShape {
  mainSha?: string | null;
  headSha?: string | null;
  /** Whether `depTip` is modelled as already contained in `mainSha`. */
  depIsAncestorOfMain?: boolean;
}

function fakeGit(shape: FakeGitShape = {}) {
  const mainSha = shape.mainSha === undefined ? LOCAL_MAIN_SHA : shape.mainSha;
  const headSha = shape.headSha === undefined ? HEAD_SHA : shape.headSha;
  const commands: string[] = [];

  const execImpl: TaskBaseExecImpl = async (command) => {
    commands.push(command);

    if (/^git rev-parse --verify 'main\^\{commit\}'$/.test(command)) {
      if (!mainSha) throw gitFailure(1);
      return { stdout: `${mainSha}\n` };
    }
    if (/^git rev-parse HEAD$/.test(command)) {
      if (!headSha) throw gitFailure(128);
      return { stdout: `${headSha}\n` };
    }
    const ancestor = command.match(/^git merge-base --is-ancestor '(\w+)' '(\w+)'$/);
    if (ancestor) {
      if (!shape.depIsAncestorOfMain) throw gitFailure(1);
      return { stdout: "" };
    }
    throw new Error(`unexpected git command: ${command}`);
  };

  return { execImpl, commands };
}

function storeWithSettings(settings: Record<string, unknown>): SquashImportPlanStore {
  return { getSettings: async () => settings as never };
}

describe("planSquashImportFromDep", () => {
  it("anchors mainBase on the local integration SHA and issues no fetch even with a remote configured", async () => {
    const { execImpl, commands } = fakeGit({ depIsAncestorOfMain: false });

    const plan = await planSquashImportFromDep(
      "/repo",
      storeWithSettings({
        integrationBranch: "main",
        worktreeRebaseBeforeMerge: true,
        worktreeRebaseRemote: "origin",
      }),
      "FN-245",
      DEP_SHA,
      "fusion/dep-branch",
      execImpl,
    );

    expect(plan).toEqual({ depTip: DEP_SHA, mainBase: LOCAL_MAIN_SHA, label: "fusion/dep-branch" });
    expect(commands.some((command) => /\bfetch\b|\bpull\b|remote\/HEAD/.test(command))).toBe(false);
  });

  it("falls back to ambient HEAD only when the integration ref itself is unresolvable", async () => {
    const { execImpl, commands } = fakeGit({ mainSha: null, depIsAncestorOfMain: false });

    const plan = await planSquashImportFromDep(
      "/repo",
      storeWithSettings({ integrationBranch: "main" }),
      "FN-245",
      DEP_SHA,
      "fusion/dep-branch",
      execImpl,
    );

    expect(plan?.mainBase).toBe(HEAD_SHA);
    expect(commands).toContain("git rev-parse HEAD");
    expect(commands.some((command) => /\bfetch\b/.test(command))).toBe(false);
  });

  it("returns null when the dep tip already IS local main", async () => {
    const { execImpl } = fakeGit({ depIsAncestorOfMain: true });

    const plan = await planSquashImportFromDep(
      "/repo",
      storeWithSettings({ integrationBranch: "main" }),
      "FN-245",
      LOCAL_MAIN_SHA,
      "main",
      execImpl,
    );

    expect(plan).toBeNull();
  });

  it("keeps the fork-from-main shape when the dep tip is already an ancestor of local main", async () => {
    const { execImpl } = fakeGit({ depIsAncestorOfMain: true });

    const plan = await planSquashImportFromDep(
      "/repo",
      storeWithSettings({ integrationBranch: "main" }),
      "FN-245",
      DEP_SHA,
      "fusion/landed-dep",
      execImpl,
    );

    // Same contract as before this task: branch off main, import nothing.
    expect(plan).toEqual({ depTip: LOCAL_MAIN_SHA, mainBase: LOCAL_MAIN_SHA, label: "fusion/landed-dep" });
  });
});

/*
createWorktree is exercised through its injected deps so the assertion is about WHICH base the
worktree is cut from and whether the dep planner ran — no real git, no real worktree.
*/
function outerDeps(overrides: {
  startPointResolution: string | null;
  execImpl: TaskBaseExecImpl;
  planSquash?: WorktreeOuterCreateDeps["planSquashImportFromDep"];
}): WorktreeOuterCreateDeps {
  return {
    rootDir: "/repo",
    store: {
      updateTask: vi.fn(async () => undefined),
      getSettings: async () => ({ integrationBranch: "main" }) as never,
      logEntry: vi.fn(async () => undefined),
    },
    maxWorktreeRetries: 1,
    worktreeRetryDelaysMs: [0],
    resolveWorktreeStartPoint: async () => overrides.startPointResolution,
    planSquashImportFromDep: overrides.planSquash ?? (vi.fn(async () => null) as never),
    tryCreateWorktree: vi.fn(async (_branch: string, path: string, _taskId: string) => ({
      path,
      branch: "fusion/fn-245",
    })),
    squashImportDepIntoWorktree: vi.fn(async () => undefined),
    rebaseNewWorktreeOntoRemote: vi.fn(async () => undefined),
    execImpl: overrides.execImpl,
  };
}

describe("createWorktree base anchoring", () => {
  it("does not run the dep squash-import planner for a default-base card and cuts from the local integration SHA", async () => {
    const { execImpl } = fakeGit();
    const planSquashImportFromDepSpy = vi.fn(async () => null);
    const deps = outerDeps({
      startPointResolution: LOCAL_MAIN_SHA,
      execImpl,
      planSquash: planSquashImportFromDepSpy as never,
    });

    await createWorktree(deps, "fusion/fn-245", "/wt/fn-245", "FN-245", "main");

    expect(planSquashImportFromDepSpy).not.toHaveBeenCalled();
    const createCall = vi.mocked(deps.tryCreateWorktree).mock.calls[0];
    expect(createCall?.[3]).toBe(LOCAL_MAIN_SHA);
    expect(deps.squashImportDepIntoWorktree).not.toHaveBeenCalled();
  });

  it("still squash-imports for a genuine dependency base distinct from the integration branch", async () => {
    const { execImpl } = fakeGit({ depIsAncestorOfMain: false });
    const planSquashImportFromDepSpy = vi.fn(async () => ({
      depTip: DEP_SHA,
      mainBase: LOCAL_MAIN_SHA,
      label: "fusion/dep-branch",
    }));
    const deps = outerDeps({
      startPointResolution: DEP_SHA,
      execImpl,
      planSquash: planSquashImportFromDepSpy as never,
    });

    await createWorktree(deps, "fusion/fn-245", "/wt/fn-245", "FN-245", "fusion/dep-branch");

    expect(planSquashImportFromDepSpy).toHaveBeenCalledWith("FN-245", DEP_SHA, "fusion/dep-branch");
    const createCall = vi.mocked(deps.tryCreateWorktree).mock.calls[0];
    expect(createCall?.[3]).toBe(LOCAL_MAIN_SHA);
    expect(deps.squashImportDepIntoWorktree).toHaveBeenCalledWith(
      "/wt/fn-245",
      "FN-245",
      DEP_SHA,
      "fusion/dep-branch",
    );
  });
});
