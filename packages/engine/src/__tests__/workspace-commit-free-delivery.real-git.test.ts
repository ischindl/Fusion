/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-14-04:15 (RUFU-599 Step 6 — the real-git half of the one verdict):
SANE-482 is a workspace card whose every declared repository had already integrated the work, so the land
lane finalised it with no commit at all and recorded `noOpReason` + `workspaceCommitFreeBasis` + the tips it
read. RUFU-599 taught the downstream guards to READ that record, and the acceptance criterion demanded a
real-git case, because every existing test of this pair injects the probe: the writer's ancestry expression
(`merge-base --is-ancestor <tip> <integration branch>`) and the reader's "a `zero-ahead` basis with no
recorded tip is a half-written record" rule had never once been executed against a real repository. A mocked
probe can make any of those shapes look delivered, which is precisely the class of hole this card exists to
close.

What real git is the only witness for, and so what this file pins:

  1. `createTipAncestryProbe` reports `zero-ahead` ONLY for a branch tip git actually contains in that
     repository's own integration branch, and it records the real tip sha — the pair the core guard needs.
  2. A branch that carries a commit the integration branch does not is `unproven`, and a card over it is
     `undelivered`; a recorded basis claiming otherwise is refused by the core guard too, so the writer
     cannot certify what git refused and the reader cannot be talked into accepting it.
  3. An integration branch git cannot resolve is `unproven`, never a vacuous "nothing ahead". A lane that
     points at a branch that is not there gets no delivery from either side of the pair.
  4. The sentence the writer stores is the sentence the reader matches: `decideWorkspaceDelivery`'s output,
     written to `mergeDetails` exactly as `merger-ai.ts` writes it, is accepted by
     `classifyCommitFreeWorkspaceDelivery` / `hasDurableLandingProof` — while `mergeConfirmed` + `noOpMerge`
     on their own (the lane's emptiness claim, with the git evidence stripped) remain NON-proof byte-identically
     to before RUFU-599. That last assertion is the "do not weaken FN-180 / FN-9234" clause of the task.

Injected AI agents and no network: the fixture is the shared real two-repo workspace fixture, and the only
subprocesses are git calls.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCommitFreeWorkspaceDelivery, hasDurableLandingProof } from "@fusion/core";
import {
  COMMIT_FREE_DELIVERY_REASON,
  createTipAncestryProbe,
  decideWorkspaceDelivery,
  probeWorkspaceCommitFree,
  type WorkspaceCommitFreeProbeInput,
} from "../merge/workspace-commit-free-delivery.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const execFileAsync = promisify(execFile);
const describeIfGit = hasGit ? describe : describe.skip;

const TASK_BRANCH = "fusion/sane-482";
const INTEGRATION_BRANCH = "main";
const REPOS = ["repo-a", "repo-b"] as const;

/**
 * The real git runner behind `GitTextRunner`. A rejected run is git saying no — `merge-base --is-ancestor`
 * exits 1 for a tip it does not contain — which is exactly the signal the probe maps to `unproven`.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function probeInputs(fixture: WorkspaceFixture): WorkspaceCommitFreeProbeInput[] {
  return REPOS.map((repo) => ({
    repo,
    repoRootDir: fixture.repoPath(repo),
    branch: TASK_BRANCH,
    integrationBranch: INTEGRATION_BRANCH,
  }));
}

/**
 * Both guards read a structural slice of `MergeDetails`, and every shape this file proves is a shape the
 * writers do NOT produce (that is the point), so the slice is cast once here rather than widened into
 * the product types. The cast names no field: an assertion can only ever pass on the fields the guards
 * actually read.
 */
function asGuardInput(details: unknown): Parameters<typeof hasDurableLandingProof>[0] {
  return details as Parameters<typeof hasDurableLandingProof>[0];
}

/** Mirrors `merger-ai.ts`'s commit-free `mergeDetails` write for a zero-landed workspace finalization. */
function recordFromDelivery(delivery: ReturnType<typeof decideWorkspaceDelivery>) {
  return {
    mergeConfirmed: delivery.mergeConfirmed,
    ...(delivery.kind === "commit-free-delivery"
      ? {
          noOpMerge: true,
          noOpReason: delivery.noOpReason,
          workspaceCommitFreeBasis: delivery.commitFreeBasis,
          ...(delivery.commitFreeBranchTipShas
            ? { workspaceCommitFreeBranchTipShas: delivery.commitFreeBranchTipShas }
            : {}),
        }
      : {}),
  };
}

describeIfGit("workspace commit-free delivery — the recorded proof read against real git", () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  async function integrateEverywhere(): Promise<WorkspaceFixture> {
    const f = await createWorkspaceFixture([...REPOS], INTEGRATION_BRANCH);
    fixture = f;
    for (const repo of REPOS) {
      // The work reached integration by another route, and the card's branch is exactly that content.
      f.git(repo, "git commit --allow-empty -m 'integrated outside the card'");
      f.git(repo, `git branch ${TASK_BRANCH} ${INTEGRATION_BRANCH}`);
    }
    return f;
  }

  it("proves zero-ahead from a real ancestry read and records the tip the guard requires", async () => {
    const f = await integrateEverywhere();
    const evidence = await probeWorkspaceCommitFree(probeInputs(f), createTipAncestryProbe(runGit));

    expect(evidence.map((entry) => `${entry.repo}=${entry.basis}`)).toEqual(["repo-a=zero-ahead", "repo-b=zero-ahead"]);
    for (const entry of evidence) {
      const realTip = await runGit(["rev-parse", "--verify", `refs/heads/${TASK_BRANCH}`], entry.repoRootDir);
      expect(entry.branchTipSha).toBe(realTip);
    }

    const delivery = decideWorkspaceDelivery({ repoCount: REPOS.length, landedCount: 0, evidence });
    expect(delivery.kind).toBe("commit-free-delivery");
    expect(delivery.noOpReason).toBe(COMMIT_FREE_DELIVERY_REASON);

    const mergeDetails = recordFromDelivery(delivery);
    const verdict = hasDurableLandingProof(asGuardInput(mergeDetails));
    expect(verdict).toEqual({ proven: true, kind: "workspace-commit-free", proof: { kind: "workspace-commit-free" } });
    expect(classifyCommitFreeWorkspaceDelivery(mergeDetails)).toEqual({
      zeroAheadRepos: [...REPOS],
      absentRepos: [],
    });
  });

  it("refuses a repository whose branch carries a commit integration does not, on both sides of the pair", async () => {
    const f = await integrateEverywhere();
    // The card did author a commit that never reached integration: the RUFU-262 lost-work shape.
    f.git("repo-b", "git checkout -q " + TASK_BRANCH);
    f.git("repo-b", "git commit --allow-empty -m 'card-only commit that never landed'");
    f.git("repo-b", `git checkout -q ${INTEGRATION_BRANCH}`);

    const evidence = await probeWorkspaceCommitFree(probeInputs(f), createTipAncestryProbe(runGit));
    expect(evidence.map((entry) => `${entry.repo}=${entry.basis}`)).toEqual(["repo-a=zero-ahead", "repo-b=unproven"]);
    const aheadTip = await runGit(["rev-parse", "--verify", `refs/heads/${TASK_BRANCH}`], f.repoPath("repo-b"));
    expect(evidence.find((entry) => entry.repo === "repo-b")?.branchTipSha).toBe(aheadTip);

    const delivery = decideWorkspaceDelivery({ repoCount: REPOS.length, landedCount: 0, evidence });
    expect(delivery.kind).toBe("undelivered");
    expect(delivery.mergeConfirmed).toBe(false);

    // Even a hand-written record cannot make the reader accept a basis git refused, and it cannot make the
    // emptiness flags prove anything on their own.
    const forged = {
      mergeConfirmed: true,
      noOpMerge: true,
      noOpReason: COMMIT_FREE_DELIVERY_REASON,
      workspaceCommitFreeBasis: { "repo-a": "zero-ahead", "repo-b": "unproven" } as const,
      workspaceCommitFreeBranchTipShas: { "repo-a": "a".repeat(40), "repo-b": aheadTip },
    };
    expect(classifyCommitFreeWorkspaceDelivery(asGuardInput(forged))).toBeUndefined();
    expect(hasDurableLandingProof(asGuardInput(forged)).proven).toBe(false);
    expect(hasDurableLandingProof(asGuardInput({ mergeConfirmed: true, noOpMerge: true })).proven).toBe(false);
  });

  it("never reads an unresolvable integration branch as nothing-ahead", async () => {
    const f = await integrateEverywhere();
    const probes = probeInputs(f).map((input) => ({ ...input, integrationBranch: "release/does-not-exist" }));
    const evidence = await probeWorkspaceCommitFree(probes, createTipAncestryProbe(runGit));

    // git could not ask the question, so no repository may be certified. A skipped probe is an absent probe.
    expect(evidence.every((entry) => entry.basis === "unproven")).toBe(true);
    const delivery = decideWorkspaceDelivery({ repoCount: REPOS.length, landedCount: 0, evidence });
    expect(delivery.kind).toBe("undelivered");
    expect(hasDurableLandingProof(asGuardInput(recordFromDelivery(delivery))).proven).toBe(false);
  });

  it("refuses a half-written record whose zero-ahead basis names no tip", async () => {
    const f = await integrateEverywhere();
    const evidence = await probeWorkspaceCommitFree(probeInputs(f), createTipAncestryProbe(runGit));
    const delivery = decideWorkspaceDelivery({ repoCount: REPOS.length, landedCount: 0, evidence });
    const mergeDetails = recordFromDelivery(delivery);

    // Same sentence, same basis, tips dropped: the ancestry claim states an observation that is not recorded.
    const { workspaceCommitFreeBranchTipShas: _dropped, ...halfWritten } = mergeDetails;
    expect(classifyCommitFreeWorkspaceDelivery(asGuardInput(halfWritten))).toBeUndefined();
    expect(hasDurableLandingProof(asGuardInput(halfWritten)).proven).toBe(false);
  });
});
