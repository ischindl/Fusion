import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeCodeReviewInputFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewDiffFingerprint,
  probeSingularReviewDiffFingerprint,
} from "../worktree/review-diff-fingerprint.js";
import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";

describe("computeCodeReviewInputFingerprint", () => {
  it("distinguishes empty, populated, and unavailable Git evidence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-empty-review-fingerprint-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test User");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", "file.txt");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(repo, "file.txt"), "changed\n");
      git("commit", "-am", "change");

      await expect(computeCodeReviewInputFingerprint(repo, "HEAD"))
        .resolves.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
      await expect(computeCodeReviewInputFingerprint(repo, base))
        .resolves.toMatch(/^[0-9a-f]{64}$/);
      await expect(computeCodeReviewInputFingerprint("/path/that/does/not/exist", "HEAD"))
        .resolves.toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/*
FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521):
Real-git fixtures for the content-proof TARGET rule. The singular proof used to measure the
checkout's mutable HEAD, so a drifted checkout (reclaim-in-place, base probe, detached HEAD) turned
`empty-review-input:v1` into a false "zero delivery" proof on a card whose branch carried real work.

Fixture style follows `review-diff-fingerprint.test.ts`: tmpdir repo + `execFileSync` git, no
polling and no timers (AGENTS.md "Do Not Add Slow Tests" / FN-5048). Each fixture builds the
smallest history that separates HEAD content from branch content.
*/

type Git = (...args: string[]) => string;

function openRepo(prefix: string): { repo: string; git: Git } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git: Git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  return { repo, git };
}

/** One commit on `main` that establishes the shared fork point. */
function seedMain(git: Git, repo: string): string {
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "base");
  return git("rev-parse", "HEAD");
}

/** The card's own commit on its task branch, made while HEAD sits on that branch. */
function commitOnBranch(git: Git, repo: string, branch: string, file: string): string {
  git("checkout", "-B", branch);
  writeFileSync(join(repo, file), "card work\n");
  git("add", file);
  git("commit", "-m", `card work on ${branch}`);
  return git("rev-parse", "HEAD");
}

/** An unrelated integration commit on `main` that the task branch has never seen. */
function advanceMain(git: Git, repo: string, file: string): string {
  git("checkout", "main");
  writeFileSync(join(repo, file), "landed by somebody else\n");
  git("add", file);
  git("commit", "-m", `unrelated integration work ${file}`);
  return git("rev-parse", "HEAD");
}

describe("probeSingularReviewDiffFingerprint target rule (RUFU-521)", () => {
  it("measures the branch when the checkout drifted onto a later integration commit", async () => {
    const { repo, git } = openRepo("fusion-review-proof-drift-");
    try {
      seedMain(git, repo);
      const branchTip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      const driftedMainTip = advanceMain(git, repo, "main-only.txt");
      // The RUFU-290 drift class: the worktree is parked detached on an integration commit.
      git("checkout", "--detach", driftedMainTip);
      expect(git("rev-parse", "HEAD")).toBe(driftedMainTip);
      expect(git("rev-parse", "fusion/T")).toBe(branchTip);

      const drifted = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: undefined,
        branchRef: "fusion/T",
      });

      // Pin the pre-fix computation itself: with the base resolved against HEAD (what the old seam
      // did) the diff is `mainTip..mainTip`, i.e. the false EMPTY proof RUFU-290 was condemned by.
      await expect(probeReviewDiffFingerprint(repo, git("merge-base", "HEAD", "main")))
        .resolves.toEqual({ state: "empty" });

      expect(drifted).toEqual({ state: "fingerprint", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(drifted.state === "fingerprint" ? drifted.fingerprint : undefined)
        .not.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
      // And the fingerprint it reports is the branch's own delivery, byte for byte.
      expect(drifted.state).toBe("fingerprint");
      if (drifted.state === "fingerprint") {
        const forkPoint = git("merge-base", "fusion/T", "main");
        const expected = await probeReviewDiffFingerprint(repo, forkPoint, branchTip);
        expect(expected.state).toBe("fingerprint");
        if (expected.state === "fingerprint") expect(drifted.fingerprint).toBe(expected.fingerprint);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the sentinel only when the branch AND HEAD legs agree there is no delivery", async () => {
    const { repo, git } = openRepo("fusion-review-proof-both-empty-");
    try {
      const base = seedMain(git, repo);
      git("checkout", "-B", "fusion/T");

      const probe = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: base,
        branchRef: "fusion/T",
      });
      expect(probe).toEqual({ state: "empty" });
      // The auto-pass pairing depends on the sentinel string staying the value this lane produces.
      expect(await computeCodeReviewInputFingerprint(repo, base)).toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps HEAD-carried work visible when the branch itself is at the base (overlap-resume)", async () => {
    const { repo, git } = openRepo("fusion-review-proof-head-ahead-");
    try {
      const base = seedMain(git, repo);
      git("checkout", "-B", "fusion/T");
      // The branch has nothing of its own, but the checkout carries a commit (overlap-resume shape).
      git("checkout", "--detach", base);
      writeFileSync(join(repo, "resumed.txt"), "work the resumed tree carries\n");
      git("add", "resumed.txt");
      git("commit", "-m", "resumed work on the tree only");
      const headSha = git("rev-parse", "HEAD");
      expect(git("rev-parse", "fusion/T")).toBe(base);

      const probe = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: base,
        branchRef: "fusion/T",
      });

      expect(probe.state).toBe("fingerprint");
      expect(await probeReviewDiffFingerprint(repo, base, headSha)).toEqual(probe);
      // Work must never be masked as empty just because the named branch is at the base.
      expect(JSON.stringify(probe)).not.toContain(EMPTY_REVIEW_DIFF_FINGERPRINT);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed with a named reason when the branch ref does not resolve", async () => {
    const { repo, git } = openRepo("fusion-review-proof-no-branch-");
    try {
      const base = seedMain(git, repo);
      const probe = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: base,
        branchRef: "fusion/never-created",
      });
      expect(probe).toEqual({ state: "unavailable", reason: "branch-ref-unresolvable" });
      // An unresolvable branch is never reportable as empty content.
      expect(JSON.stringify(probe)).not.toContain("empty");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns today's HEAD path verbatim for a branchless (legacy) caller", async () => {
    const { repo, git } = openRepo("fusion-review-proof-legacy-head-");
    try {
      const base = seedMain(git, repo);
      writeFileSync(join(repo, "head-only.txt"), "uncommitted to any branch\n");
      git("add", "head-only.txt");
      git("commit", "-m", "head commit");

      const [composed, headLeg] = await Promise.all([
        probeSingularReviewDiffFingerprint({ worktreePath: repo, recordedBaseCommitSha: base, branchRef: undefined }),
        probeReviewDiffFingerprint(repo, base),
      ]);
      expect(composed).toEqual(headLeg);
      expect(composed.state).toBe("fingerprint");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a healthy checkout's fingerprint byte-identical to the pre-fix HEAD probe", async () => {
    const { repo, git } = openRepo("fusion-review-proof-stability-");
    try {
      const base = seedMain(git, repo);
      const tip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      git("checkout", "fusion/T");
      expect(git("rev-parse", "HEAD")).toBe(tip);

      // What the pre-fix seam computes: the recorded base verbatim, diffed to HEAD.
      const preFix = await probeReviewDiffFingerprint(repo, base);
      const postFix = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: base,
        branchRef: "fusion/T",
      });
      // The invariant that protects every persisted `reviewInputFingerprint` across this deploy.
      expect(postFix).toEqual(preFix);
      expect(postFix.state).toBe("fingerprint");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a healthy checkout with no recorded base byte-identical too", async () => {
    const { repo, git } = openRepo("fusion-review-proof-stability-unrecorded-");
    try {
      seedMain(git, repo);
      const tip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      git("checkout", "fusion/T");
      expect(git("rev-parse", "HEAD")).toBe(tip);

      // Pre-fix path for a card with no `baseCommitSha`: the HEAD-relative merge base, diffed to HEAD.
      const headRelativeBase = git("merge-base", "HEAD", "main");
      const preFix = await probeReviewDiffFingerprint(repo, headRelativeBase);
      const postFix = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: undefined,
        branchRef: "fusion/T",
      });
      expect(postFix).toEqual(preFix);
      expect(postFix.state).toBe("fingerprint");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recomputes a recorded base that is not an ancestor of the branch tip, never reversing main work", async () => {
    const { repo, git } = openRepo("fusion-review-proof-stale-base-");
    try {
      const forkPoint = seedMain(git, repo);
      const tip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      const tooNewBase = advanceMain(git, repo, "main-only.txt");
      git("checkout", "fusion/T");
      expect(git("rev-parse", "HEAD")).toBe(tip);

      // Prove the hazard the recomputation removes: the too-new base claims the card DELETES
      // somebody else's landed file.
      expect(git("diff", "--name-status", `${tooNewBase}..${tip}`)).toContain("D\tmain-only.txt");

      const corrupted = await probeReviewDiffFingerprint(repo, tooNewBase, tip);
      const probe = await probeSingularReviewDiffFingerprint({
        worktreePath: repo,
        recordedBaseCommitSha: tooNewBase,
        branchRef: "fusion/T",
      });

      expect(probe.state).toBe("fingerprint");
      expect(corrupted.state).toBe("fingerprint");
      if (probe.state === "fingerprint" && corrupted.state === "fingerprint") {
        expect(probe.fingerprint).not.toBe(corrupted.fingerprint);
        const expected = await probeReviewDiffFingerprint(repo, forkPoint, tip);
        expect(expected.state).toBe("fingerprint");
        if (expected.state === "fingerprint") expect(probe.fingerprint).toBe(expected.fingerprint);
      }
      // And the corrected measurement names only the card's own file.
      const measuredRange = `${forkPoint}..${tip}`;
      expect(git("diff", "--name-only", measuredRange)).toBe("card.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/*
FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521):
The merge door compares its own capture against the persisted `reviewInputFingerprint`, so it must
answer the same question the review answered. Measuring the mutable checkout tip instead of the
card's branch is how RUFU-290's card was refused for work it had already delivered. These cases pin
the door itself, not just the shared probe, because the door is what turns a probe state into a
merge blocker.
*/
describe("captureMergeContentDescriptor singular target (RUFU-521)", () => {
  const captureDeps = { workspaceRootDir: process.cwd(), settings: {} };

  it("describes the branch's delivery when the checkout drifted onto a later integration commit", async () => {
    const { repo, git } = openRepo("fusion-merge-door-drift-");
    try {
      const base = seedMain(git, repo);
      const tip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      const driftedMainTip = advanceMain(git, repo, "integration.txt");
      git("checkout", "--detach", driftedMainTip);

      const descriptor = await captureMergeContentDescriptor(
        { id: "RUFU-T", worktree: repo, baseCommitSha: base, branch: "fusion/T" } as never,
        captureDeps,
      );

      expect(descriptor.kind).toBe("singular");
      const branchTruth = await probeReviewDiffFingerprint(repo, base, tip);
      expect(descriptor).toEqual({ kind: "singular", diff: branchTruth });
      // The drifted tree would have described different content entirely; a delivery is never `empty`.
      expect(JSON.stringify(descriptor)).not.toContain(EMPTY_REVIEW_DIFF_FINGERPRINT);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a genuinely empty card as empty at the door, the one state that claim belongs in", async () => {
    const { repo, git } = openRepo("fusion-merge-door-both-empty-");
    try {
      const base = seedMain(git, repo);
      git("checkout", "-B", "fusion/T");

      const descriptor = await captureMergeContentDescriptor(
        { id: "RUFU-T", worktree: repo, baseCommitSha: base, branch: "fusion/T" } as never,
        captureDeps,
      );
      // Both legs sit on the base, so `empty` is a verified statement about this card, not an
      // accident of where the checkout was parked - and it stays a plain `{ state: "empty" }`.
      expect(descriptor).toEqual({ kind: "singular", diff: { state: "empty" } });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports an unresolvable branch as unavailable, never as empty content", async () => {
    const { repo, git } = openRepo("fusion-merge-door-no-branch-");
    try {
      const base = seedMain(git, repo);
      const descriptor = await captureMergeContentDescriptor(
        { id: "RUFU-T", worktree: repo, baseCommitSha: base, branch: "fusion/gone" } as never,
        captureDeps,
      );
      expect(descriptor).toEqual({ kind: "singular", diff: { state: "unavailable", reason: "branch-ref-unresolvable" } });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a branchless task's descriptor byte-identical to the pre-fix HEAD capture", async () => {
    const { repo, git } = openRepo("fusion-merge-door-legacy-");
    try {
      const base = seedMain(git, repo);
      commitOnBranch(git, repo, "fusion/T", "card.txt");

      const descriptor = await captureMergeContentDescriptor(
        { id: "RUFU-T", worktree: repo, baseCommitSha: base } as never,
        captureDeps,
      );
      expect(descriptor).toEqual({ kind: "singular", diff: await probeReviewDiffFingerprint(repo, base) });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("honours the explicit HEAD opt-out for a caller that deliberately captures another tree", async () => {
    const { repo, git } = openRepo("fusion-merge-door-optout-");
    try {
      const base = seedMain(git, repo);
      const tip = commitOnBranch(git, repo, "fusion/T", "card.txt");
      const driftedMainTip = advanceMain(git, repo, "integration.txt");
      git("checkout", "--detach", driftedMainTip);

      const descriptor = await captureMergeContentDescriptor(
        { id: "RUFU-T", worktree: repo, baseCommitSha: base, branch: "fusion/T" } as never,
        captureDeps,
        { branchRef: null },
      );
      // Opted out means the old measurement exactly: the tree, not the branch.
      expect(descriptor).toEqual({ kind: "singular", diff: await probeReviewDiffFingerprint(repo, base, driftedMainTip) });
      expect(JSON.stringify(descriptor)).not.toContain(tip);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
