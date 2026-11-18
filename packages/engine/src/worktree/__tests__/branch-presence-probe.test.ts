/**
 * FNXC:PlanningLaneWorktreeIdentity 2026-11-18-20:05 (RUFU-893, Step 4):
 * CHARACTERIZATION FOR THE TRI-STATE BRANCH READS IN THIS MODULE, against a real repository. Before this
 * card the file had no test of its own — the presence read was exercised only through
 * `self-healing-workspace*.test.ts` with the `execBranchProbe` seam stubbed — so the containment read
 * landed beside an uncharacterized neighbour. That matters because this module's whole contract is a
 * THREE-state answer: every consumer that decides whether to null a task's only path or branch pointer
 * reads what these functions return. A reader that folds `unknown` into `absent` is the exact unsoundness
 * `isCommitReachableFromBranch` (`SelfHealingGitEvidence`) and `isAncestor` (`execution/branch-conflicts.ts`)
 * carry — both `catch { return false }` — and this task forbids importing that shape into a decision whose
 * failure answer would destroy a branch.
 *
 * The ratchet this file holds:
 * - `contained` requires git to report a count of zero, never a failed lookup.
 * - `divergent` carries the outstanding-commit count, because that number is what the refusal sentence
 *   tells an operator and it must be measured rather than asserted.
 * - An absent branch is NEVER `contained`. It answers `unknown` from this read, and the reason is a fact
 *   about git, not a shortcut: `rev-list --count <integration>..<ref>` fails with the SAME exit-128
 *   `ambiguous argument … unknown revision` message for a bad ref on either side of the range, so this
 *   command cannot tell "your branch does not exist" from "your integration branch does not exist".
 *   Answering `not-applicable` would be a guess about which side failed. `unknown` is the refusal
 *   direction, which satisfies the ratchet's actual requirement (never `contained`), and the sweep proves
 *   absence with `probeBranchPresence` — whose `show-ref --verify` DOES distinguish the two cases — and
 *   only asks about containment for a ref it has already proven present.
 * - A malformed ref, a non-repository, an unresolvable integration branch, a tag, and a non-branch rev all
 *   answer `unknown`.
 *
 * Placement note: the module lives under `merge/`, but this file sits in `worktree/__tests__/` because the
 * reads exist for the worktree/branch identity lane and `merge/` owns no test directory of its own.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyBranchProbeError,
  probeBranchContainment,
  probeBranchPresence,
} from "../../merge/branch-presence-probe.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const openFixtures: Array<() => void> = [];

function createRepo(label: string): string {
  const base = mkdtempSync(join(tmpdir(), `bpp-${label}-`));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "git init -b main");
  git(repo, 'git config user.email "probe@example.com"');
  git(repo, 'git config user.name "Probe User"');
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  git(repo, "git add tracked.txt");
  git(repo, "git commit -m 'chore: base'");
  openFixtures.push(() => rmSync(base, { recursive: true, force: true }));
  return repo;
}

function commitsOnBranch(repo: string, branch: string, files: string[]): void {
  git(repo, `git checkout -b ${branch} main`);
  for (const file of files) {
    writeFileSync(join(repo, file), `${file}\n`, "utf8");
    git(repo, `git add ${file}`);
    git(repo, `git commit -m 'feat: ${file}'`);
  }
  git(repo, "git checkout main");
}

function createNonRepository(label: string): string {
  const base = mkdtempSync(join(tmpdir(), `bpp-${label}-`));
  openFixtures.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

describeIfGit("branch-presence-probe: tri-state reads against real git", () => {
  afterAll(() => {
    while (openFixtures.length > 0) openFixtures.pop()!();
  });

  describe("probeBranchContainment", () => {
    it("answers contained only when the integration branch already holds the tip", async () => {
      const repo = createRepo("contained");
      commitsOnBranch(repo, "fusion/probe-merged", ["landed.txt"]);
      git(repo, "git merge --ff-only fusion/probe-merged");

      expect(await probeBranchContainment(repo, "fusion/probe-merged", "main")).toEqual({
        verdict: "contained",
        uniqueCommitCount: 0,
      });
    });

    it("answers divergent with the number of commits that were never delivered", async () => {
      const repo = createRepo("divergent");
      commitsOnBranch(repo, "fusion/probe-diverged", ["one.txt", "two.txt"]);

      const verdict = await probeBranchContainment(repo, "fusion/probe-diverged", "main");
      expect(verdict.verdict).toBe("divergent");
      /* The count is the figure the refusal sentence names, so it is measured, not implied. */
      expect(verdict.uniqueCommitCount).toBe(2);
      expect(git(repo, "git rev-list --count main..refs/heads/fusion/probe-diverged")).toBe("2");
    });

    it("never answers contained for a branch that does not exist", async () => {
      const repo = createRepo("absent");
      const verdict = await probeBranchContainment(repo, "fusion/probe-never-existed", "main");

      /*
      The head of this branch is unknown rather than `not-applicable` because git fails a bad ref on either
      side of the range with one identical message, so naming which side failed would be a guess. See the
      file header: the sweep proves absence with the presence read and asks this question only afterwards.
      */
      expect(verdict.verdict).toBe("unknown");
      expect(verdict.verdict).not.toBe("contained");
    });

    it("answers unknown for a malformed ref rather than guessing either direction", async () => {
      const repo = createRepo("malformed");
      commitsOnBranch(repo, "fusion/probe-real", ["work.txt"]);

      for (const branch of ["HEAD ../elsewhere", "-x", "refs/heads/../../etc", "not a ref ;", "  ", ""]) {
        expect(await probeBranchContainment(repo, branch, "main"), branch).toEqual({ verdict: "unknown" });
      }
    });

    it("answers unknown when the integration branch itself cannot be resolved", async () => {
      const repo = createRepo("bad-integration");
      commitsOnBranch(repo, "fusion/probe-real", ["work.txt"]);

      expect(await probeBranchContainment(repo, "fusion/probe-real", "main-nope")).toEqual({ verdict: "unknown" });
      /* A `null` integration branch is not a question that can be asked, so it is not a `contained` either. */
      expect(await probeBranchContainment(repo, "fusion/probe-real", null)).toEqual({ verdict: "unknown" });
    });

    it("answers unknown at a root that is not a repository, instead of reading silence as absence", async () => {
      /*
      This is the read that keeps a workspace ENTRY directory — which is not itself a repository — from
      handing out absence proofs about member-repository branches. Measured before the change, an
      unconditional clear at exactly such a root nulled live member pointers.
      */
      const base = createNonRepository("notarepo");

      expect(await probeBranchContainment(base, "fusion/probe-x", "main")).toEqual({ verdict: "unknown" });
      expect(await probeBranchContainment(join(base, "does-not-exist"), "fusion/probe-x", "main"))
        .toEqual({ verdict: "unknown" });
    });

    it("does not mistake a tag or a detached rev for a branch", async () => {
      /*
      The revision range qualifies the branch as `refs/heads/<branch>` precisely so a tag or an object id
      cannot yield `contained` for a branch that does not exist — the same qualification
      `isBranchMergedToBranch` documents for its own `show-ref --glob refs/heads/` guard.
      */
      const repo = createRepo("tag-not-branch");
      git(repo, "git tag v1.0.0");
      commitsOnBranch(repo, "fusion/probe-real", ["work.txt"]);

      for (const notABranch of ["v1.0.0", "HEAD"]) {
        const verdict = await probeBranchContainment(repo, notABranch, "main");
        expect(verdict.verdict, notABranch).toBe("unknown");
        expect(verdict.verdict, notABranch).not.toBe("contained");
      }

      /*
      A card whose `branch` field names the trunk is the one degenerate value the qualification lets
      resolve, and the honest answer is a vacuous `contained`: `main..refs/heads/main` counts nothing.
      That is harmless in the consuming decision, because a pointer naming the trunk carries no work the
      trunk lacks, so clearing it strands nothing and can never
      produce a false `divergent` claim of lost work. Pinned so a later reader does not mistake the
      emptiness for a leak, and so a tightening that special-cases the value has a witness to update.
      */
      for (const degenerate of ["main"]) {
        expect(await probeBranchContainment(repo, degenerate, "main"), degenerate).toEqual({
          verdict: "contained",
          uniqueCommitCount: 0,
        });
      }
    });
  });

  describe("probeBranchPresence keeps its own three answers honest", () => {
    it("proves presence and absence from real refs", async () => {
      const repo = createRepo("presence");
      commitsOnBranch(repo, "fusion/probe-present", ["a.txt"]);

      expect(await probeBranchPresence(repo, "fusion/probe-present")).toBe("present");
      /* `absent` here is a SUCCESSFUL `show-ref --verify` that answered 1, which is what makes it usable
      as a clear basis — the property the containment read above deliberately does not claim. */
      expect(await probeBranchPresence(repo, "fusion/probe-absent")).toBe("absent");
    });

    it("refuses to call a non-repository absent", async () => {
      const base = createNonRepository("presence-notarepo");
      expect(await probeBranchPresence(base, "fusion/probe-present")).toBe("unknown");
    });

    it("classifies only a clean exit-1 as absence", () => {
      expect(classifyBranchProbeError(Object.assign(new Error("no such ref"), { code: 1, signal: null })))
        .toBe("absent");
      /* 128 is what `show-ref` answers for "not a repository" as well as for "no such ref"; the shared
      code is why the two must never collapse into one answer. */
      expect(classifyBranchProbeError(Object.assign(new Error("not a repo"), { code: 128, signal: null })))
        .toBe("unknown");
      expect(classifyBranchProbeError(Object.assign(new Error("killed"), { code: null, killed: true })))
        .toBe("unknown");
      expect(classifyBranchProbeError(new Error("spawn failed"))).toBe("unknown");
    });
  });
});
