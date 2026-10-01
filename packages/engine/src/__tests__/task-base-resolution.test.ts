/**
 * FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
 * A fresh task branch is anchored to the LOCAL integration ref, and acquisition refuses only on a
 * PROVEN divergence between the local and remote integration refs. These tests pin the resolver's
 * relation verdicts, the refusal's operator-visible message contract, and the
 * no-fetch/no-pull/no-merge constraint that keeps the divergence proof from moving its own target.
 */
import { describe, it, expect } from "vitest";
import {
  TASK_BASE_DIVERGED_PREFIX,
  TaskBranchBaseDivergedError,
  isTaskBranchBaseDivergedError,
  resolveTaskBranchBase,
  type TaskBaseExecImpl,
} from "../worktree/task-base-resolution.js";

const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type ExecError = Error & { code?: number };

function gitFailure(code: number): ExecError {
  return Object.assign(new Error(`git exited ${code}`), { code });
}

interface FakeGit {
  /** Resolved local integration SHA; pass null to model an unresolvable local ref. */
  localSha?: string | null;
  /** Resolved remote-tracking SHA; null models a missing remote-tracking ref. */
  remoteSha?: string | null;
  /** Modelled remote name; null models a repository with no remote at all. */
  remote?: string | null;
  localIsAncestorOfRemote?: boolean;
  remoteIsAncestorOfLocal?: boolean;
  /** Throws (rather than answering) on every ancestry probe. */
  ancestryProbeFails?: boolean;
  aheadCount?: number;
  behindCount?: number;
}

function fakeGit(git: FakeGit = {}) {
  const calls: string[] = [];
  const localSha = git.localSha === undefined ? LOCAL_SHA : git.localSha;
  const remoteSha = git.remoteSha === undefined ? REMOTE_SHA : git.remoteSha;
  const remote = git.remote === undefined ? "origin" : git.remote;

  const execImpl: TaskBaseExecImpl = async (command) => {
    calls.push(command);

    const revParse = command.match(/^git rev-parse --verify '(.+)\^\{commit\}'$/);
    if (revParse) {
      const ref = revParse[1];
      if (ref === "main") {
        if (!localSha) throw gitFailure(1);
        return { stdout: `${localSha}\n` };
      }
      if (ref === "origin/main") {
        if (!remoteSha) throw gitFailure(1);
        return { stdout: `${remoteSha}\n` };
      }
      throw gitFailure(1);
    }

    if (/^git config --get branch\.'main'\.remote$/.test(command)) {
      if (!remote) throw gitFailure(1);
      return { stdout: `${remote}\n` };
    }

    if (command === "git remote") {
      if (!remote) return { stdout: "" };
      return { stdout: `${remote}\n` };
    }

    const ancestor = command.match(/^git merge-base --is-ancestor '(.+)' '(.+)'$/);
    if (ancestor) {
      if (git.ancestryProbeFails) throw gitFailure(128);
      const [, first, second] = ancestor;
      const isLocalFirst = first === localSha && second === remoteSha;
      const isRemoteFirst = first === remoteSha && second === localSha;
      if (!isLocalFirst && !isRemoteFirst) throw gitFailure(128);
      const answer = isLocalFirst
        ? git.localIsAncestorOfRemote !== false
        : git.remoteIsAncestorOfLocal !== false;
      if (!answer) throw gitFailure(1);
      return { stdout: "" };
    }

    const count = command.match(/^git rev-list --count '(.+)\.\.(.+)'$/);
    if (count) {
      const [, exclusive, inclusive] = count;
      const ahead = exclusive === remoteSha && inclusive === localSha;
      const behind = exclusive === localSha && inclusive === remoteSha;
      if (!ahead && !behind) throw gitFailure(128);
      return { stdout: `${(ahead ? git.aheadCount ?? 0 : git.behindCount ?? 0)}\n` };
    }

    throw gitFailure(128);
  };

  return { execImpl, calls };
}

const settings = { integrationBranch: "main" };

describe("resolveTaskBranchBase", () => {
  it("reports an aligned local/remote pair without refusing", async () => {
    const { execImpl, calls } = fakeGit({
      localIsAncestorOfRemote: true,
      remoteIsAncestorOfLocal: true,
    });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("aligned");
    expect(result.reason).toBe("aligned");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("resolved-local-base");
    expect(result.integrationBranch).toBe("main");
    expect(result.remoteRef).toBe("origin/main");
    // The base is always the local integration SHA, never the remote-tracking SHA.
    expect(result.base).toBe(LOCAL_SHA);
    expect(result.base).not.toBe(REMOTE_SHA);
    expect(calls).not.toContainEqual(expect.stringMatching(/^\s*git (fetch|pull|merge)(\s|$)/));
  });

  it("reports a strictly-ahead local default without refusing (unpushed local commits are legal)", async () => {
    const { execImpl } = fakeGit({
      localIsAncestorOfRemote: false,
      remoteIsAncestorOfLocal: true,
    });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("ahead");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("resolved-local-base");
    expect(result.base).toBe(LOCAL_SHA);
  });

  it("reports a strictly-behind local default without refusing, keeping the linear rebase legitimate", async () => {
    const { execImpl } = fakeGit({
      localIsAncestorOfRemote: true,
      remoteIsAncestorOfLocal: false,
    });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    // FN-8839: a linearly-behind remote must still rebase, so this must never refuse.
    expect(result.relation).toBe("behind");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("resolved-local-base");
    expect(result.base).toBe(LOCAL_SHA);
  });

  it("refuses a proven divergence and names both refs and both counts in the message", async () => {
    const { execImpl } = fakeGit({
      localIsAncestorOfRemote: false,
      remoteIsAncestorOfLocal: false,
      aheadCount: 101,
      behindCount: 2,
    });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("diverged");
    expect(result.refusal).toBe("base-diverged-from-remote");
    expect(result.outcome).toBe("refused-diverged");
    expect(result.aheadCount).toBe(101);
    expect(result.behindCount).toBe(2);
    // Even on refusal the offered base stays local: nothing may fall back to origin/main.
    expect(result.base).toBe(LOCAL_SHA);

    const error = new TaskBranchBaseDivergedError({
      localRef: result.integrationBranch,
      remoteRef: result.remoteRef!,
      aheadCount: result.aheadCount!,
      behindCount: result.behindCount!,
    });

    expect(error.message.startsWith(`${TASK_BASE_DIVERGED_PREFIX} `)).toBe(true);
    expect(error.message).toContain("'main'");
    expect(error.message).toContain("'origin/main'");
    expect(error.message).toContain("101");
    expect(error.message).toContain("2");
    expect(error.message).toMatch(/push(ing| and).*pull|pull(ing| or).*push/i);
    expect(isTaskBranchBaseDivergedError(error)).toBe(true);
  });

  it("names the offending workspace sub-repository in the refusal message", () => {
    const error = new TaskBranchBaseDivergedError({
      localRef: "main",
      remoteRef: "origin/main",
      aheadCount: 3,
      behindCount: 1,
      repoRelPath: "services/api",
    });

    expect(error.message.startsWith(TASK_BASE_DIVERGED_PREFIX)).toBe(true);
    expect(error.message).toContain("services/api");
    expect(error.repoRelPath).toBe("services/api");
  });

  it("does not refuse when the remote-tracking ref is missing (no remote/HEAD configured)", async () => {
    const { execImpl, calls } = fakeGit({ remoteSha: null });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("remote-unresolvable");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("skipped-remote-unresolvable");
    expect(result.fallbackReason).toBe("remote-ref-unresolvable");
    expect(result.base).toBe(LOCAL_SHA);
    expect(calls.some((call) => call.includes("merge-base"))).toBe(false);
  });

  it("does not refuse when the repository has no remote at all", async () => {
    const { execImpl } = fakeGit({ remote: null });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("remote-unresolvable");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("skipped-remote-unresolvable");
  });

  it("fails open when an ancestry probe errors, so a git read cannot block work", async () => {
    const { execImpl } = fakeGit({ ancestryProbeFails: true });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("remote-unresolvable");
    expect(result.refusal).toBeNull();
    expect(result.reason).toBe("remote-ancestry-unreadable");
    expect(result.outcome).toBe("skipped-remote-unresolvable");
    expect(result.base).toBe(LOCAL_SHA);
  });

  it("offers a local base even when the local integration ref is unresolvable", async () => {
    const { execImpl, calls } = fakeGit({ localSha: null });

    const result = await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });

    expect(result.relation).toBe("local-unresolvable");
    expect(result.refusal).toBeNull();
    expect(result.base).toBe("main");
    expect(calls.some((call) => call.includes("merge-base"))).toBe(false);
  });

  it("skips the divergence comparison entirely when rebase-before-merge is disabled", async () => {
    const { execImpl, calls } = fakeGit({
      localIsAncestorOfRemote: false,
      remoteIsAncestorOfLocal: false,
    });

    const result = await resolveTaskBranchBase({
      rootDir: "/repo",
      settings: { ...settings, worktreeRebaseBeforeMerge: false },
      execImpl,
    });

    expect(result.relation).toBe("remote-unresolvable");
    expect(result.reason).toBe("remote-rebase-disabled");
    expect(result.refusal).toBeNull();
    expect(result.outcome).toBe("skipped-remote-rebase-disabled");
    expect(result.fallbackReason).toBe("remote-rebase-disabled");
    // No remote participates in base selection at all: only the local SHA probe runs.
    expect(calls).toEqual([`git rev-parse --verify 'main^{commit}'`]);
    expect(result.base).toBe(LOCAL_SHA);
  });

  it("never issues a fetch, pull, or merge while proving divergence", async () => {
    const seen: string[][] = [];
    const scenarios: FakeGit[] = [
      { localIsAncestorOfRemote: true, remoteIsAncestorOfLocal: true },
      { localIsAncestorOfRemote: false, remoteIsAncestorOfLocal: true },
      { localIsAncestorOfRemote: true, remoteIsAncestorOfLocal: false },
      { localIsAncestorOfRemote: false, remoteIsAncestorOfLocal: false, aheadCount: 1, behindCount: 1 },
      { remoteSha: null },
      { localSha: null },
      { ancestryProbeFails: true },
    ];

    for (const scenario of scenarios) {
      const { execImpl, calls } = fakeGit(scenario);
      await resolveTaskBranchBase({ rootDir: "/repo", settings, execImpl });
      seen.push(calls);
    }

    for (const calls of seen) {
      for (const command of calls) {
        // `git merge-base` is an ancestry read, not a merge: match the verb position only.
        expect(command).not.toMatch(/^\s*git (fetch|pull|merge)(\s|$)/);
        expect(command).not.toMatch(/\bgit (fetch|pull)\b/);
      }
    }
  });
});
