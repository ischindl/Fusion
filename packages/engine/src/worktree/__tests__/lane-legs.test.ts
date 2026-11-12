/*
FNXC:LaneLegGate 2026-11-11-23:05 (RUFU-425):
Real-git fixtures for the lane-leg classifier. The defect these fixtures exist for is measured, not
theoretical: on a sibling board, a lane whose declared member directory was EMPTY still answered
`rev-parse HEAD` with the ENCLOSED repository's commit, so every measurement taken "in the lane"
silently described the wrong repository and a card was reported done with zero commits on any ref.
Five occurrences were recorded before anyone owned the class.

These fixtures reproduce the shape with a REAL submodule and a REAL worktree, because the shape is a
git behavior and no fake can produce it: `git worktree add` of a superproject creates the gitlink
DIRECTORY but never materialises its content, which is exactly how an empty leg is born.

Two rules these fixtures enforce on themselves:
- Every repository is a local path. No fixture reaches a network, and no probe may perform a remote
  update: F7 asserts that from a recording of every command the classifier actually ran.
- F1 asserts BOTH halves of the affordance before it asserts the refusal. Asserting only the refusal
  would let a fixture that simply failed the git call look like a passing test.
*/
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessLaneLegs, isSamePath, type LaneLegProbeOptions } from "../lane-legs.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

/** Fixture git. The classifier gets its own injectable runner so the two never share a seam. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

async function scratch(tag: string): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), `rufu-425-${tag}-`));
  tempRoots.push(base);
  // macOS resolves /var through a symlink; comparing realpath keeps every identity assertion honest.
  return await realpath(base);
}

async function configure(dir: string): Promise<void> {
  await git(["-C", dir, "config", "user.email", "leg@example.com"], dir);
  await git(["-C", dir, "config", "user.name", "Leg Fixture"], dir);
}

async function initRepo(dir: string, fileName = "note.txt"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir], path.dirname(dir));
  await configure(dir);
  await writeFile(path.join(dir, fileName), "base\n", "utf-8");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "chore: base"], dir);
  return await git(["rev-parse", "HEAD"], dir);
}

/**
 * The F1 shape: a superproject that declares a real submodule, checked out as a second worktree.
 * Git creates the submodule's DIRECTORY in the new worktree and fills nothing, and the upstream
 * advances so the leg is also meaningfully behind once materialised.
 */
async function buildSuperprojectWithSubmodule(tag: string): Promise<{ root: string; wt: string; member: string; legPath: string }> {
  const base = await scratch(tag);
  const upstream = path.join(base, "upstream");
  await initRepo(upstream, "u.txt");

  const root = path.join(base, "root");
  await initRepo(root);
  await git(["-c", "protocol.file.allow=always", "-c", "submodule.recurse=false", "submodule", "add", "-q", upstream, "member"], root);
  await git(["commit", "-q", "-m", "chore: declare member leg"], root);

  const wt = path.join(base, "wt");
  await git(["worktree", "add", "-q", wt, "HEAD"], root);
  const legPath = path.join(wt, "member");
  return { root, wt, member: "member", legPath };
}

/**
 * A leg that IS its own repository, with a resolved local trunk ref (the positive shape).
 *
 * The trunk advance is built into the fixture: the upstream carries a second commit, the clone is
 * taken after it, and a leg that must read as BEHIND is put on its own branch at the first commit.
 * No fixture performs a transport operation - the behind-trunk class exists precisely because a leg
 * can already hold the objects and still be a trunk behind, so a fixture that moved data to get
 * there would be teaching the opposite lesson.
 */
async function buildOwnRepositoryLeg(
  tag: string,
  options: { behind?: boolean; detach?: boolean; dropRemoteHeadAlias?: boolean } = {},
): Promise<{ legPath: string; trunkRef: string }> {
  const base = await scratch(tag);
  const upstream = path.join(base, "upstream");
  await initRepo(upstream, "u.txt");
  await writeFile(path.join(upstream, "later.txt"), "landed elsewhere\n", "utf-8");
  await git(["add", "-A"], upstream);
  await git(["commit", "-q", "-m", "feat: trunk advance"], upstream);

  const legPath = path.join(base, "member");
  await git(["clone", "-q", upstream, legPath], base);
  await configure(legPath);
  if (options.dropRemoteHeadAlias) {
    // A clone seeds origin/HEAD on its own, so the alias has to be removed for the premise to hold.
    await git(["-C", legPath, "symbolic-ref", "-d", "refs/remotes/origin/HEAD"], base);
  } else {
    await git(["-C", legPath, "remote", "set-head", "origin", "-a"], base);
  }
  if (options.behind) {
    const firstCommit = await git(["rev-parse", "HEAD~1"], legPath);
    await git(["-C", legPath, "checkout", "-q", "-b", "lane", firstCommit], base);
  }
  if (options.detach) {
    await git(["-C", legPath, "checkout", "-q", "--detach", "HEAD"], base);
  }
  const trunkRef = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], legPath).catch(() => "");
  return { legPath, trunkRef };
}

function taskWithLegs(legs: Record<string, { worktreePath: string; baseBranch?: string }>) {
  return { id: "RUFU-425", workspaceWorktrees: legs } as never;
}

/** Records every git invocation the classifier performs, while delegating to the real git. */
function recordingProbe(recorded: string[]): LaneLegProbeOptions {
  return {
    execImpl: async (args: readonly string[], cwd: string): Promise<string> => {
      recorded.push(args.join(" "));
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
      return stdout;
    },
  };
}

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("lane-leg classifier - the reported shape (F1)", () => {
  it("an empty submodule leg shows the raw affordance AND is refused with lane-leg-empty", async () => {
    const { wt, legPath } = await buildSuperprojectWithSubmodule("f1");

    // Half one: the affordance itself. Zero entries, and yet git answers as if it were a repository.
    const entries = await readdir(legPath);
    expect(entries, "the worktree must create an empty gitlink directory").toHaveLength(0);
    const borrowedHead = await git(["rev-parse", "HEAD"], legPath);
    const superprojectHead = await git(["rev-parse", "HEAD"], wt);
    expect(borrowedHead).toBe(superprojectHead);
    const toplevel = await git(["rev-parse", "--show-toplevel"], legPath);
    expect(toplevel).not.toBe(legPath);

    // Half two: the classifier refuses instead of measuring the borrowed repository.
    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-empty");
    expect(assessment.repository).toBe("member");
    expect(assessment.legs).toEqual([
      expect.objectContaining({
        repository: "member",
        classification: "empty-directory",
        entryCount: 0,
      }),
    ]);
  }, 90_000);
});

describe("lane-leg classifier - one refusal code per shape", () => {
  it("F2 a member directory that does not exist -> lane-leg-missing", async () => {
    const base = await scratch("f2");
    const assessment = await assessLaneLegs(taskWithLegs({ gone: { worktreePath: path.join(base, "never-created") } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-missing");
    expect(assessment.legs[0]?.classification).toBe("missing-directory");
    expect(assessment.legs[0]?.entryCount).toBeNull();
  }, 60_000);

  it("F3 a populated directory whose top-level is an ancestor -> lane-leg-borrowed-toplevel", async () => {
    const base = await scratch("f3");
    const legPath = path.join(base, "root-repo", "packages", "inner");
    await initRepo(path.join(base, "root-repo"));
    await mkdir(legPath, { recursive: true });
    await writeFile(path.join(legPath, "anything.txt"), "content\n", "utf-8");

    const assessment = await assessLaneLegs(taskWithLegs({ "packages/inner": { worktreePath: legPath } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-borrowed-toplevel");
    expect(assessment.legs[0]?.classification).toBe("borrowed-toplevel");
    expect(assessment.legs[0]?.entryCount).toBe(1);
    expect(await isSamePath(assessment.legs[0]?.toplevel ?? "", path.join(base, "root-repo"))).toBe(true);
  }, 60_000);

  it("F4 a member repository with zero own commits -> lane-leg-unborn", async () => {
    const base = await scratch("f4");
    const legPath = path.join(base, "unborn");
    await mkdir(legPath, { recursive: true });
    await git(["init", "-q", "-b", "main", legPath], base);
    await writeFile(path.join(legPath, "work.txt"), "uncommitted\n", "utf-8");

    const assessment = await assessLaneLegs(taskWithLegs({ unborn: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-unborn");
    expect(assessment.legs[0]?.classification).toBe("unborn-repository");
    expect(assessment.legs[0]?.head).toBeNull();
  }, 60_000);

  it("F9 a path that cannot be read as a directory -> lane-leg-unmeasurable, never a silent skip", async () => {
    const base = await scratch("f9");
    const legPath = path.join(base, "a-file-not-a-checkout");
    await writeFile(legPath, "this is a file\n", "utf-8");

    const assessment = await assessLaneLegs(taskWithLegs({ broken: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-unmeasurable");
    expect(assessment.legs[0]?.classification).toBe("unmeasurable");
    expect(assessment.legs[0]?.entryCount).toBeNull();
  }, 60_000);
});

describe("lane-leg classifier - labels an operator acts on are not blockers", () => {
  it("F5 a materialised detached HEAD is classified, never refused", async () => {
    const { legPath } = await buildOwnRepositoryLeg("f5", { detach: true });
    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(false);
    expect(assessment.legs[0]?.classification).toBe("detached-head");
  }, 90_000);

  it("F6 populated but behind the local trunk ref is classified, never refused", async () => {
    const { legPath } = await buildOwnRepositoryLeg("f6", { behind: true });
    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(false);
    expect(assessment.legs[0]?.classification).toBe("behind-trunk");
    expect(assessment.legs[0]?.lag).toBe(1);
  }, 90_000);

  it("F7 no local trunk ref is reported as no-local-trunk-ref and the classifier ran nothing remote", async () => {
    const base = await scratch("f7");
    const legPath = path.join(base, "no-remote");
    await initRepo(legPath);
    const recorded: string[] = [];

    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath } }), recordingProbe(recorded));
    expect(assessment.refused).toBe(false);
    expect(assessment.legs[0]?.classification).toBe("no-local-trunk-ref");
    expect(assessment.legs[0]?.lag).toBeNull();
    // The behavior assertion, not the prose: no command the classifier ran could have moved anything
    // between this repository and a remote.
    const remoteMoving = recorded.filter((command) => /(^|\s)(fetch|pull|push|clone|ls-remote)(\s|$)/.test(command));
    expect(remoteMoving).toEqual([]);
  }, 60_000);

  it("a recorded baseBranch is used as the trunk when the remote HEAD alias is absent", async () => {
    const { legPath } = await buildOwnRepositoryLeg("f7b", { behind: true, dropRemoteHeadAlias: true });

    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath, baseBranch: "origin/main" } }));
    expect(assessment.refused).toBe(false);
    expect(assessment.legs[0]?.classification).toBe("behind-trunk");
    expect(assessment.legs[0]?.lag).toBe(1);
  }, 90_000);
});

describe("lane-leg classifier - the no-legs breakpoint and the precedence contract", () => {
  it("F8 a singular card with no workspace entries produces no legs and refuses nothing", async () => {
    const assessment = await assessLaneLegs({ id: "RUFU-425" } as never);
    expect(assessment).toEqual({ refused: false, legs: [] });
  });

  it("a materialised leg with a current trunk passes", async () => {
    const { legPath } = await buildOwnRepositoryLeg("pass");
    const assessment = await assessLaneLegs(taskWithLegs({ member: { worktreePath: legPath } }));
    expect(assessment.refused).toBe(false);
    expect(assessment.legs[0]?.classification).toBe("materialized");
    expect(assessment.legs[0]?.entryCount).toBeGreaterThan(0);
    expect(assessment.legs[0]?.lag).toBe(0);
  }, 90_000);

  it("the worst class across the legs decides the refusal, not the first leg", async () => {
    const base = await scratch("precedence");
    const empty = path.join(base, "empty-leg");
    await mkdir(empty, { recursive: true });
    const assessment = await assessLaneLegs(taskWithLegs({
      "z-empty": { worktreePath: empty },
      "a-gone": { worktreePath: path.join(base, "not-there") },
    }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    // missing-directory outranks empty-directory, and both legs are still reported for the operator.
    expect(assessment.code).toBe("lane-leg-missing");
    expect(assessment.repository).toBe("a-gone");
    expect(assessment.legs.map((leg) => leg.repository)).toEqual(["z-empty", "a-gone"]);
  }, 60_000);

  it("a tie is broken by repository name so the verdict is deterministic", async () => {
    const base = await scratch("tie");
    for (const name of ["kappa", "alpha"]) {
      await mkdir(path.join(base, name), { recursive: true });
    }
    const assessment = await assessLaneLegs(taskWithLegs({
      kappa: { worktreePath: path.join(base, "kappa") },
      alpha: { worktreePath: path.join(base, "alpha") },
    }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.code).toBe("lane-leg-empty");
    expect(assessment.repository).toBe("alpha");
  }, 60_000);

  it("the legs are enumerated from the task record, so no repository name is ever hardcoded", async () => {
    const base = await scratch("named");
    const legPath = path.join(base, "third-member-directory");
    await mkdir(legPath, { recursive: true });
    const assessment = await assessLaneLegs(taskWithLegs({ "some/third-member": { worktreePath: legPath } }));
    expect(assessment.refused).toBe(true);
    if (!assessment.refused) throw new Error("unreachable");
    expect(assessment.repository).toBe("some/third-member");
  }, 60_000);
});

/*
FNXC:LaneLegGate 2026-11-11-23:05 (RUFU-425, AC5):
The classifier measures a lane and never repairs one. A repair verb here would be the defect wearing
a guard's clothing: the whole reason a green verdict could be produced over an empty directory was
that some code felt entitled to touch the checkout it was measuring. This scan is the structural half
of that promise, and it reads the shipped module source rather than trusting a comment about it.
*/
describe("lane-leg classifier - read-only invariant", () => {
  it("the shipped module source contains no mutating verb", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../lane-legs.ts", import.meta.url), "utf-8");
    for (const forbidden of [
      "worktree add",
      "worktree remove",
      "worktree prune",
      "git clean",
      "reset --hard",
      "submodule update",
      "fetch",
      "push",
    ]) {
      expect(source, `lane-legs.ts must never contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});
