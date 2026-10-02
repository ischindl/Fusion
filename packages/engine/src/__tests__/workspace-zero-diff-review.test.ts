import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "@fusion/core";
import { classifyWorkspaceZeroAcquire } from "../executor/workspace-zero-acquire.js";
import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

/*
FNXC:WorkspaceCommitFreeReview 2026-10-02-22:40 (RUFU-504):
A workspace card that acquired every declared member repository and legitimately changed nothing used to be
recorded as `NOT_REVIEWED` with an `UNAVAILABLE` aggregate, which the step layer persists as
`status: failed, verdict: None`. That row is a hard merge blocker, the stall classifier parks the card on the
third repeat (`in-review-stall-deadlock`), and nothing retries it: measured on saneca 2026-10-02, 24 cards
carried the failed Code Review row and 16 were parked, one reviewer sentence each.

The invariant, stated once and asserted at every surface that consumes it:
  a proven zero-diff per-repository review is a commit-free DELIVERY, not a review failure.
"Proven" is conjunctive and never the absence of evidence: confirmed scope, an acquired entry for EVERY
declared repository, the task's own commit-free declaration, and a fresh observation that each repository sits
on its merge-base with zero changed files.
*/

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-ZERO",
    title: "workspace zero diff",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "complete", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repositoryScope: { state: "confirmed", repositories: ["alpha", "beta"], revision: 3 },
    noCommitsExpected: true,
    ...overrides,
  } as Task;
}

const worktrees = (paths: Record<string, string>, baseSha?: string) => Object.fromEntries(
  Object.entries(paths).map(([repo, worktreePath]) => [repo, {
    worktreePath,
    branch: "fusion/sane-zero",
    ...(baseSha ? { baseCommitSha: baseSha } : {}),
  }]),
) as Task["workspaceWorktrees"];

describe("classifyWorkspaceZeroAcquire — acquired repositories", () => {
  const acquired = worktrees({ alpha: "/ws/alpha", beta: "/ws/beta" });
  const proven = new Set(["alpha", "beta"]);
  const options = { workspaceMode: true, netZeroAtBaseRepositories: proven };

  it("accepts a commit-free claim only when every declared repository is acquired AND proven at base", () => {
    const verdict = classifyWorkspaceZeroAcquire(task({ workspaceWorktrees: acquired }), options);
    expect(verdict.kind).toBe("commit-free-eligible");
    expect(verdict.kind === "commit-free-eligible" ? verdict.reason : "").toContain("explicit noCommitsExpected=true");
  });

  it.each([
    ["no probe result at all", { workspaceMode: true } as { workspaceMode: boolean; netZeroAtBaseRepositories?: ReadonlySet<string> }],
    ["probe covered only one declared repository", { workspaceMode: true, netZeroAtBaseRepositories: new Set(["alpha"]) }],
    ["probe ran before any repository was acquired", { workspaceMode: true, netZeroAtBaseRepositories: undefined }],
  ])("stays silent for %s", (_label, scopedOptions) => {
    expect(classifyWorkspaceZeroAcquire(task({ workspaceWorktrees: acquired }), scopedOptions)).toEqual({ kind: "not-applicable" });
  });

  it("stays silent when the probe set does not cover a newly declared repository", () => {
    const three = task({
      workspaceWorktrees: worktrees({ alpha: "/ws/alpha", beta: "/ws/beta", gamma: "/ws/gamma" }),
      repositoryScope: { state: "confirmed", repositories: ["alpha", "beta", "gamma"], revision: 3 } as Task["repositoryScope"],
    });
    expect(classifyWorkspaceZeroAcquire(three, options)).toEqual({ kind: "not-applicable" });
  });

  it("stays silent when a declared repository was never acquired", () => {
    expect(classifyWorkspaceZeroAcquire(
      task({ workspaceWorktrees: worktrees({ alpha: "/ws/alpha" }) }),
      options,
    )).toEqual({ kind: "not-applicable" });
  });

  it.each([
    ["unconfirmed scope", task({ workspaceWorktrees: acquired, repositoryScope: { state: "proposed", repositories: ["alpha", "beta"], revision: 1 } as Task["repositoryScope"] })],
    ["duplicate declarations", task({ workspaceWorktrees: acquired, repositoryScope: { state: "confirmed", repositories: ["alpha", "alpha"], revision: 1 } as Task["repositoryScope"] })],
    ["no commit-free declaration", task({ workspaceWorktrees: acquired, noCommitsExpected: undefined })],
  ])("refuses to speak for %s", (_label, scopedTask) => {
    expect(classifyWorkspaceZeroAcquire(scopedTask, options)).toEqual({ kind: "not-applicable" });
  });

  it("never reports 'unproven' for an acquired workspace, because that value hard-refuses fn_task_done", () => {
    // verifyWorkspaceInvariants turns `unproven` into `ok:false reason:"no_commits"`, which would silence the
    // richer prompt-derived evaluation that follows it. Only a proven claim may short-circuit that lane.
    const shapes: Array<Parameters<typeof classifyWorkspaceZeroAcquire>[0]> = [
      task({ workspaceWorktrees: acquired }),
      task({ workspaceWorktrees: acquired, noCommitsExpected: undefined }),
      task({ workspaceWorktrees: worktrees({ alpha: "/ws/alpha" }) }),
      task({ workspaceWorktrees: acquired, repositoryScope: undefined }),
    ];
    for (const shape of shapes) {
      expect(classifyWorkspaceZeroAcquire(shape, options).kind).not.toBe("unproven");
    }
  });
});

/*
FNXC:WorkspaceCommitFreeReview 2026-10-02-22:40 (RUFU-504):
Real git rather than a mocked diff. The producer's approval is authorized by `captureWorkspaceReviewEvidence`,
which reads `rev-list --count base..branch` and `git diff --name-only`; mocking those two commands would let
the test pass on exactly the claim that was wrong in production.
*/
const root = mkdtempSync(join(tmpdir(), "fusion-zero-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function initMember(repository: string): string {
  const dir = join(root, repository);
  execFileSync("git", ["init", "-b", "main", dir], { encoding: "utf-8" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Fusion Test");
  git("commit", "--allow-empty", "-m", "initial");
  git("branch", "fusion/sane-zero");
  return git("rev-parse", "HEAD");
}

const baseShas: Record<string, string> = {};
for (const repository of ["alpha", "beta"]) baseShas[repository] = initMember(repository);
const memberPaths = { alpha: join(root, "alpha"), beta: join(root, "beta") };

// Each entry carries ITS OWN recorded base: the evidence capture resolves `baseCommitSha` inside that
// repository, so a foreign sha would fail to resolve rather than prove anything.
const provenWorktrees = (entries: Record<string, string>) => Object.fromEntries(
  Object.entries(entries).map(([repo, worktreePath]) => [repo, {
    worktreePath,
    branch: "fusion/sane-zero",
    baseCommitSha: baseShas[repo] as string,
  }]),
) as Task["workspaceWorktrees"];

const reviewOptions = { workspaceMode: true, workspaceRootDir: root, workspaceRepos: ["alpha", "beta"], settings: {} };

describe("reviewWorkspacePerRepo — a proven zero-diff workspace", () => {
  it("approves honestly, records each repository as not reviewed, and invents no fingerprint", async () => {
    let reviewerInvocations = 0;
    const result = await reviewWorkspacePerRepo(
      task({ workspaceWorktrees: provenWorktrees(memberPaths) }),
      async () => { reviewerInvocations += 1; return { verdict: "APPROVE", review: "should not run", summary: "should not run" }; },
      reviewOptions,
    );

    expect(result.verdict).toBe("APPROVE");
    expect(result.retryable).not.toBe(true);
    expect(reviewerInvocations).toBe(0); // nothing to inspect: no reviewer session may be spawned
    expect(result.repositoryDiffFingerprints ?? {}).toEqual({});
    expect((result.repositoryReviewOutcomes ?? []).map((outcome) => outcome.status)).toEqual(["NOT_REVIEWED", "NOT_REVIEWED"]);
    expect((result.repositoryReviewOutcomes ?? []).every((outcome) => outcome.verdict === undefined && outcome.fingerprint === undefined)).toBe(true);
    expect(result.summary).toContain("nothing to review");
    // The original symptom must be gone: this card must never again read as a review failure.
    expect(result.summary).not.toMatch(/not reviewed/i);
    expect(result.repositoryScopeRevision).toBe(3);
  });

  it.each([
    ["a task that never declared a commit-free contract",
      (paths: Record<string, string>) => task({ workspaceWorktrees: provenWorktrees(paths), noCommitsExpected: undefined })],
    ["a scope whose second repository was never acquired",
      (paths: Record<string, string>) => task({ workspaceWorktrees: provenWorktrees({ alpha: paths.alpha }) })],
  ])("keeps the existing refusal for %s", async (_label, buildTask) => {
    const result = await reviewWorkspacePerRepo(
      buildTask(memberPaths),
      async () => ({ verdict: "APPROVE", review: "unused", summary: "unused" }),
      reviewOptions,
    );
    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(result.summary).toMatch(/not reviewed/i);
  });

  it("refuses to treat an unprobed tree as an empty one", async () => {
    // The injected capture seam gives file names only; with no `ahead` observation the proof is incomplete,
    // so the lane must fall back to the operator-visible refusal rather than approving.
    const result = await reviewWorkspacePerRepo(
      task({ workspaceWorktrees: provenWorktrees(memberPaths) }),
      async () => ({ verdict: "APPROVE", review: "unused", summary: "unused" }),
      { ...reviewOptions, captureModifiedFiles: async () => [] },
    );
    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.summary).toMatch(/not reviewed/i);
  });

  it("still surfaces content changes as a review it must run", async () => {
    // Control on the other side of the same predicate: a repository with content is reviewed, never waved
    // through by the commit-free arm. The change must be a FILE on the TASK branch - an empty commit on the
    // member's own `main` advances neither `base..fusion/<id>` nor the diff, and would prove nothing.
    execFileSync("git", ["checkout", "fusion/sane-zero"], { cwd: memberPaths.beta, encoding: "utf-8" });
    writeFileSync(join(memberPaths.beta, "shipped.txt"), "content\n");
    execFileSync("git", ["add", "shipped.txt"], { cwd: memberPaths.beta, encoding: "utf-8" });
    execFileSync("git", ["commit", "-m", "one real change"], { cwd: memberPaths.beta, encoding: "utf-8" });

    const reviewedCwds: string[] = [];
    const result = await reviewWorkspacePerRepo(
      task({ workspaceWorktrees: provenWorktrees(memberPaths) }),
      async (cwd) => { reviewedCwds.push(cwd); return { verdict: "APPROVE", review: "ok", summary: "ok" }; },
      reviewOptions,
    );
    expect(reviewedCwds).toEqual([memberPaths.beta]);
    expect(result.verdict).toBe("APPROVE");
    const outcomes = result.repositoryReviewOutcomes ?? [];
    expect(outcomes.find((outcome) => outcome.repository === "beta")?.status).toBe("REVIEWED");
    expect(outcomes.find((outcome) => outcome.repository === "alpha")?.status).toBe("NOT_REVIEWED");
    expect(result.repositoryModifiedFiles).toContain("beta/shipped.txt");
  });
});
