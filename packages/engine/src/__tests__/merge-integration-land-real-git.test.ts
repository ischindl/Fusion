/*
FNXC:MergeSingleFlight 2026-11-21-18:50 (RUFU-1148 Step 5 — AC2/AC3/AC6):
Single-card claim mechanics against a REAL git repository. The claim's subject is a git-mutating write
window, so a suite that mocked the landing could assert that a function was called while `main` moved
underneath it. Every assertion here reads `git rev-parse` / `git merge-base` / `git worktree list`
output from disk, so a claim that failed to order two landings could not pass.

What lives HERE is one card's relationship to its own bursts: a refusal that mutates nothing, the
pre-advance tip proof that catches a commit the claim could never exclude, agent latency never sitting
inside a claim, and a claim handed back on every exit. The two-card SEQUENCE AC5 asks for is
`merge-integration-land-two-card.test.ts`; the cross-PROCESS proof (two independent store handles, one
database) is `merge-integration-land.pg.test.ts`; the seam's own outcomes are `integration-land-claim.test.ts`.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import type { LandRepoContext } from "../merge/merger-ai.js";
import { landOneRepo } from "../merge/merger-ai.js";
import {
  IntegrationLandClaimBusyError,
  integrationLandLeaseKey,
  INTEGRATION_LAND_ACQUIRED_EVENT,
  INTEGRATION_LAND_CONTENDED_EVENT,
  tryAcquireIntegrationLandClaim,
} from "../merge/integration-land-claim.js";
import { hasGit } from "./_workspace-fixture.js";
import {
  createLandHarness,
  gitIn,
  makeLandTask,
  prepareCardBranch,
  taskBranch,
  type LandHarness,
} from "./_integration-land-repo-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

describeIfGit("integration-landing claim against a real repository", () => {
  let harness: LandHarness;
  beforeEach(() => { harness = createLandHarness(); });
  afterEach(() => { harness.dispose(); });

  const leaseKey = integrationLandLeaseKey("root", "main");

  it("refuses a second landing burst while another card holds the claim, advancing nothing", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-B", "guest.txt");
    const tipBefore = gitIn(harness.repoDir, "rev-parse", "refs/heads/main");
    harness.register(makeLandTask("RUFU-B", "guest.txt"));

    // Another card owns the claim for this repository + branch — the shape a second daemon produces
    // the moment it starts its own burst, and the shape a crash leaves behind until the TTL lapses.
    harness.store.plantHeldLease({
      leaseKey,
      // The tenancy is named by the KEY above; `kind` stays inside what the real table's CHECK
      // constraint admits (`land`), which is what `integration-land-claim.ts` actually writes.
      kind: "land",
      ownerTaskId: "RUFU-A",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      landOneRepo(harness.repoDir, taskBranch("RUFU-B"), "main", harness.landContext("RUFU-B")),
    ).rejects.toBeInstanceOf(IntegrationLandClaimBusyError);

    // The refusal happened BEFORE any git mutation: the integration ref is byte-identical and no clean
    // room was ever created, so the waiting card left no trace on the shared repository.
    expect(gitIn(harness.repoDir, "rev-parse", "refs/heads/main")).toBe(tipBefore);
    expect(gitIn(harness.repoDir, "worktree", "list")).not.toMatch(/fusion-ai-merge-/);
    // AC4: the wait is recorded, naming the holder, with nothing but ids and the fixed enum.
    const contended = harness.store.emits.find((row) => row.mutationType === INTEGRATION_LAND_CONTENDED_EVENT);
    expect(contended?.metadata).toEqual({ taskId: "RUFU-B", holderTaskId: "RUFU-A", outcome: "conflict" });
  });

  it("re-proves the tip before advancing and rebuilds on a foreign commit instead of clobbering it", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-D", "card.txt");
    harness.register(makeLandTask("RUFU-D", "card.txt"));
    const baseTip = gitIn(harness.repoDir, "rev-parse", "refs/heads/main");

    /*
    A direct advance of `main` lands inside the window this card deliberately spends UNCLAIMED (between
    releasing the base burst and acquiring the land burst) — AGENTS.md permits a direct commit to the
    trunk, which is why the claim alone is not the guarantee and the pre-advance tip proof is. The
    advance is authored as a commit object plus `update-ref` rather than a working-tree commit: the same
    ref movement, with no dependence on a second checkout being clean.
    */
    let foreignSha = "";
    let advanced = false;
    const mergeAgent: LandRepoContext["mergeAgent"] = async (cwd) => {
      execFileSync("git", ["merge", "--squash", taskBranch("RUFU-D")], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      execFileSync("git", ["commit", "-m", "squashed"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      // Once only: the rebuild pass calls the merge agent again, and the foreign advance must be the
      // single event this test is simulating, not something the fixture repeats every pass.
      if (advanced) return;
      advanced = true;
      const tree = gitIn(harness.repoDir, "rev-parse", "refs/heads/main^{tree}");
      const commit = gitIn(harness.repoDir, "commit-tree", tree, "-p", baseTip, "-m", "operator advanced main directly");
      gitIn(harness.repoDir, "update-ref", "refs/heads/main", commit, baseTip);
      foreignSha = gitIn(harness.repoDir, "rev-parse", "refs/heads/main");
      expect(foreignSha).not.toBe(baseTip);
    };

    const result = await landOneRepo(
      harness.repoDir,
      taskBranch("RUFU-D"),
      "main",
      harness.landContext("RUFU-D", { mergeAgent }),
    );

    // AC3: the stale-base candidate was refused and rebuilt on the new tip. The operator's commit
    // survives as an ancestor and the card's work lands on top of it — never a non-ff overwrite.
    expect(result.outcome).toBe("landed");
    expect(gitIn(harness.repoDir, "merge-base", "--is-ancestor", foreignSha, "refs/heads/main")).toBe("");
    expect(gitIn(harness.repoDir, "show", "--name-only", "--format=", "HEAD")).toContain("card.txt");
    // The contract is the rebuild, not the sentence that announces it: the advance inside the unclaimed
    // window is caught either by the reconciliation episode's integration identity or by the pre-advance
    // tip proof below the merge agent. Either way the candidate is rebuilt on the new tip and the
    // foreign commit survives — what is forbidden is a non-ff write that drops it.
    expect(harness.logLines.join("\n")).toMatch(/rebuilding/);
    // The rebuild path is taken from inside the claim, so it is the tip proof — not the claim — that
    // refused this write; the claim itself stayed held by this card throughout.
    expect(harness.store.emits.filter((row) => row.mutationType === INTEGRATION_LAND_CONTENDED_EVENT)).toHaveLength(0);
  });

  it("holds nothing while the merge and review agents run, so agent latency is never claim latency", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-E", "quiet.txt");
    harness.register(makeLandTask("RUFU-E", "quiet.txt"));

    let blockedDuringAgents = true;
    const mergeAgent: LandRepoContext["mergeAgent"] = async (cwd) => {
      // A SECOND card probing the same key mid-merge must get in: this is the throughput property the
      // operator asked for, and an episode-wide lock would fail exactly here.
      const probe = await tryAcquireIntegrationLandClaim(harness.store as unknown as TaskStore, {
        taskId: "RUFU-PROBE", repoKey: "root", integrationBranch: "main",
      });
      blockedDuringAgents = probe.outcome === "conflict";
      if (probe.outcome !== "unavailable" && probe.outcome !== "conflict") await probe.claim.release();
      execFileSync("git", ["merge", "--squash", taskBranch("RUFU-E")], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      execFileSync("git", ["commit", "-m", "squash"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    };

    const result = await landOneRepo(
      harness.repoDir,
      taskBranch("RUFU-E"),
      "main",
      harness.landContext("RUFU-E", { mergeAgent }),
    );
    expect(result.outcome).toBe("landed");
    expect(blockedDuringAgents).toBe(false);
  });

  it("hands every claim back after a landing, so the next card never waits on a finished one", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-F", "release.txt");
    harness.register(makeLandTask("RUFU-F", "release.txt"));

    await landOneRepo(harness.repoDir, taskBranch("RUFU-F"), "main", harness.landContext("RUFU-F"));
    expect(harness.store.rows.get(leaseKey)!.status).toBe("released");

    // The next card on the same branch acquires immediately — no TTL to wait out.
    const next = await tryAcquireIntegrationLandClaim(harness.store as unknown as TaskStore, {
      taskId: "RUFU-G", repoKey: "root", integrationBranch: "main",
    });
    expect(next.outcome).toBe("reclaimed-expired");
    if (next.outcome === "conflict") return;
    expect(next.claim.taskId).toBe("RUFU-G");
    await next.claim.release();
  });
});
