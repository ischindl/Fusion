/*
FNXC:MergeSingleFlight 2026-11-21-17:13 (RUFU-1148 Step 5 — AC2/AC4/AC5):
The two-card regression. AC5 asks for the whole sequence in ONE test case, and the reason is specific:
the measured defect (RUFU-702 losing an ALREADY-APPROVED squash to RUFU-893's landing four minutes
after it was approved) is a sequence, not a pair of independently-green behaviours. A suite that tests
"refusal" and "rebuild" as unrelated cases stays green while the sequence itself is broken, because the
defect lives in what the second card sees AFTER the first one lands.

So this file's first case runs card A and card B through real `landOneRepo` calls against one real
repository and asserts the entire chain: A holds the claim while writing -> B defers BY NAME and writes
nothing -> A lands -> B re-runs and rebuilds on A's landing -> both cards are in `main`.

Determinism comes from card A's `setStatus("landing")` hook: it is awaited INSIDE A's land burst, after
the claim and tip are proven and before the one mutating `update-ref`, which is the exact moment a
second card arrives at a branch that is genuinely being written. No timers, no sleeps, no polling.

The card-level pump behaviour that turns the thrown busy error into a re-enqueue consuming no
`mergeRetries` is `project-engine.test.ts`; the same seam across two processes is
`merge-integration-land.pg.test.ts`.
*/
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskStore } from "@fusion/core";
import type { LandRepoContext } from "../merge/merger-ai.js";
import { landOneRepo } from "../merge/merger-ai.js";
import {
  IntegrationLandClaimBusyError,
  INTEGRATION_LAND_ACQUIRED_EVENT,
  INTEGRATION_LAND_CONTENDED_EVENT,
  integrationLandLeaseKey,
} from "../merge/integration-land-claim.js";
import { hasGit } from "./_workspace-fixture.js";
import {
  createLandHarness,
  gitIn,
  makeLandTask,
  prepareCardBranch,
  taskBranch,
  type LandHarness,
  type RecordedWrite,
} from "./_integration-land-repo-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

/** True when `file` exists in the integration branch's tree — read from git, never from a mock. */
function trackedOnMain(repoDir: string, file: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `refs/heads/main:${file}`], {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** The patches AC2 forbids for a card that merely waited: a status, an error, or a consumed retry. */
const FAILURE_KEYS = ["mergeRetries", "status", "error"] as const;
function failureBearing(patches: RecordedWrite[]): Record<string, unknown>[] {
  return patches
    .filter((write) => FAILURE_KEYS.some((key) => key in write.patch))
    .map((write) => write.patch);
}

describeIfGit("two cards, one integration branch", () => {
  let harness: LandHarness;
  beforeEach(() => { harness = createLandHarness(); });
  afterEach(() => { harness.dispose(); });

  const leaseKey = integrationLandLeaseKey("root", "main");

  it("holds the second card at the write window by name, then lands it on the first card's commit", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-AAA", "alpha.txt");
    prepareCardBranch(harness.repoDir, "RUFU-BBB", "beta.txt");
    harness.register(makeLandTask("RUFU-AAA", "alpha.txt"));
    harness.register(makeLandTask("RUFU-BBB", "beta.txt"));
    const baseTip = gitIn(harness.repoDir, "rev-parse", "refs/heads/main");

    /*
    What card B experienced while card A stood inside its land burst. The ref and the worktree list are
    sampled INSIDE the wait, because "B damaged nothing" is a claim about the moment B left, and by the
    time this test body runs again A has already moved `main` on purpose.
    */
    let witness: { deferredTo?: string; writes: RecordedWrite[]; tipDuringWait: string; cleanRoomsDuringWait: string } | undefined;

    /*
    Card A's `setStatus("landing")` is awaited INSIDE the land burst, between the claim/tip proof and
    `landSquash`. Firing B from here is what "A is in its merge section" means in a deterministic test.
    */
    const aSetStatus: LandRepoContext["setStatus"] = async (status) => {
      if (status !== "landing" || witness) return;
      const writesFromHere = harness.store.updateTaskCalls.length;
      let deferredTo: string | undefined;
      try {
        await landOneRepo(harness.repoDir, taskBranch("RUFU-BBB"), "main", harness.landContext("RUFU-BBB"));
        // Reaching here means the claim did NOT order the two passes and B built its candidate on a
        // base A was busy moving. Name that fact instead of letting a later assertion guess at it.
        throw new Error("card B landed while card A held the integration-landing claim");
      } catch (error) {
        if (!(error instanceof IntegrationLandClaimBusyError)) throw error;
        deferredTo = error.holderTaskId;
      }
      witness = {
        deferredTo,
        writes: harness.store.updateTaskCalls.slice(writesFromHere).filter((write) => write.taskId === "RUFU-BBB"),
        tipDuringWait: gitIn(harness.repoDir, "rev-parse", "refs/heads/main"),
        cleanRoomsDuringWait: gitIn(harness.repoDir, "worktree", "list"),
      };
    };

    const aResult = await landOneRepo(
      harness.repoDir,
      taskBranch("RUFU-AAA"),
      "main",
      harness.landContext("RUFU-AAA", { setStatus: aSetStatus }),
    );

    // --- B waited, and said WHO -------------------------------------------------------------
    expect(witness, "card B never met the claim while card A held it").toBeDefined();
    expect(witness!.deferredTo, "the wait must name the card that holds the branch").toBe("RUFU-AAA");
    // AC2: a wait is not a failure. Not one task-row patch named a status, an error, or a retry.
    expect(failureBearing(witness!.writes)).toEqual([]);
    // AC4: the wait is a row of its own, naming the holder, ids and one enum only.
    const contended = harness.store.emits.filter((row) => row.mutationType === INTEGRATION_LAND_CONTENDED_EVENT);
    expect(contended).toHaveLength(1);
    expect(contended[0]!.metadata).toEqual({ taskId: "RUFU-BBB", holderTaskId: "RUFU-AAA", outcome: "conflict" });
    expect(Object.keys(contended[0]!.metadata).sort()).toEqual(["holderTaskId", "outcome", "taskId"]);

    // B refused BEFORE it could damage anything: while it waited the ref still sat at the base both
    // cards started on, and it never built a clean room at all (A's own clean room is present and
    // legitimate, so the assertion is about B's prefix, not about the absence of any clean room).
    expect(witness!.tipDuringWait).toBe(baseTip);
    expect(witness!.cleanRoomsDuringWait).not.toMatch(/fusion-ai-merge-rufu-bbb/);

    // --- A landed ---------------------------------------------------------------------------
    expect(aResult.outcome).toBe("landed");
    if (aResult.outcome !== "landed") throw new Error("unreachable");
    const aSquash = aResult.squashSha;
    expect(gitIn(harness.repoDir, "rev-parse", "refs/heads/main")).toBe(aSquash);
    // AC4's other half: the acquire that opened the episode names nobody but its own holder.
    const acquired = harness.store.emits.filter((row) => row.mutationType === INTEGRATION_LAND_ACQUIRED_EVENT);
    expect(acquired[0]!.metadata).toEqual({ taskId: "RUFU-AAA", holderTaskId: null, outcome: "acquired" });

    // --- B re-runs and rebuilds on A's landing ----------------------------------------------
    // This second call is what the merge pump's re-enqueue does after the wait. It must fix its base
    // at A's commit — the whole point is that B never resumes the stale candidate it built below A.
    const bResult = await landOneRepo(harness.repoDir, taskBranch("RUFU-BBB"), "main", harness.landContext("RUFU-BBB"));
    expect(bResult.outcome).toBe("landed");
    if (bResult.outcome !== "landed") throw new Error("unreachable");
    // B's candidate base IS A's landed squash: the rebuild is proven from the base it recorded, not
    // from a log sentence about rebuilding.
    expect(bResult.tipSha).toBe(aSquash);
    // Both contributions survive in one linear history — no non-ff overwrite of A's work.
    expect(gitIn(harness.repoDir, "merge-base", "--is-ancestor", aSquash, "refs/heads/main")).toBe("");
    expect(trackedOnMain(harness.repoDir, "alpha.txt")).toBe(true);
    expect(gitIn(harness.repoDir, "show", "--name-only", "--format=", "HEAD")).toContain("beta.txt");
    // Exactly one commit per card: A's squash then B's squash on top of it, no third landing commit.
    expect(gitIn(harness.repoDir, "rev-list", "--count", `${baseTip}..refs/heads/main`)).toBe("2");
    // A finished card never leaves its claim standing, so the next pass never waits on a finished one.
    expect(harness.store.rows.get(leaseKey)!.status).toBe("released");
  });

  it("a crashed holder costs the waiting card one pass, not a TTL plus a wedge", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-CCC", "gamma.txt");
    harness.register(makeLandTask("RUFU-CCC", "gamma.txt"));

    // Pass 1: the row a live process owns. CCC is refused by name and records nothing but the wait.
    harness.store.plantHeldLease({
      leaseKey,
      // `kind` mirrors what the claim really writes (see `workspace_coordination_leases_kind_check`);
      // the `integration-land:` lease key above is what identifies the tenancy.
      kind: "land",
      ownerTaskId: "RUFU-DEAD",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const writesFromHere = harness.store.updateTaskCalls.length;
    await expect(
      landOneRepo(harness.repoDir, taskBranch("RUFU-CCC"), "main", harness.landContext("RUFU-CCC")),
    ).rejects.toBeInstanceOf(IntegrationLandClaimBusyError);
    expect(failureBearing(harness.store.updateTaskCalls.slice(writesFromHere))).toEqual([]);
    expect(gitIn(harness.repoDir, "rev-list", "--count", "refs/heads/main")).toBe("1");

    // The holder's process dies without releasing. Nothing announces the death — the row simply ages
    // out — and the next landing must notice that BY ITSELF, on its next pass, not after an extra
    // engine round that a wedged row would force.
    harness.store.rows.get(leaseKey)!.expiresAt = new Date(Date.now() - 1_000).toISOString();

    const result = await landOneRepo(harness.repoDir, taskBranch("RUFU-CCC"), "main", harness.landContext("RUFU-CCC"));
    expect(result.outcome).toBe("landed");
    expect(gitIn(harness.repoDir, "show", "--name-only", "--format=", "HEAD")).toContain("gamma.txt");
    // The takeover is recorded as a takeover, never as a fresh uncontended claim: `holderTaskId` stays
    // null (nobody was waiting on THIS acquire) while `outcome` says a dead holder's row was taken.
    const reclaimed = harness.store.emits.filter((row) => row.mutationType === INTEGRATION_LAND_ACQUIRED_EVENT).at(-1);
    expect(reclaimed?.metadata).toEqual({ taskId: "RUFU-CCC", holderTaskId: null, outcome: "reclaimed-expired" });
  });

  /*
  FNXC:MergeSingleFlight 2026-11-21-17:13 (RUFU-1148 Step 5):
  The two data states a claim test could silently pass on. An ABSENT row and a row owned by a card that
  already reads `done` look the same to a suite that only ever plants a live foreign holder. They are
  not the same: the first must be taken immediately, the second must NOT be — the acquire seam re-derives
  ownership from the ROW and its TTL, never from the owner's task status, because a card that reached
  `done` while its burst ran was still the holder, and only the TTL or the lease reconcile ends that
  tenancy. A claim that "helpfully" took a terminal owner's live row would let two passes write at once.
  */
  it("distinguishes an absent claim from one held by an already-terminal card", async () => {
    prepareCardBranch(harness.repoDir, "RUFU-DDD", "delta.txt");
    harness.register(makeLandTask("RUFU-DDD", "delta.txt"));

    // State 1 — no row at all (the first landing this board ever performs): taken, and named as new.
    const first = await landOneRepo(harness.repoDir, taskBranch("RUFU-DDD"), "main", harness.landContext("RUFU-DDD"));
    expect(first.outcome).toBe("landed");
    expect(harness.store.emits[0]!.metadata).toEqual({ taskId: "RUFU-DDD", holderTaskId: null, outcome: "acquired" });

    // State 2 — a live row whose owner's card already reads `done`: refused, with the holder named.
    harness.register(makeLandTask("RUFU-EEE", "epsilon.txt"));
    await (harness.store as TaskStore).updateTask!("RUFU-EEE", { status: "done" });
    prepareCardBranch(harness.repoDir, "RUFU-FFF", "zeta.txt");
    harness.register(makeLandTask("RUFU-FFF", "zeta.txt"));
    harness.store.plantHeldLease({
      leaseKey,
      kind: "land", // same reason as the other planted rows: the KEY names the tenancy, not the kind
      ownerTaskId: "RUFU-EEE",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const refused = await landOneRepo(
      harness.repoDir,
      taskBranch("RUFU-FFF"),
      "main",
      harness.landContext("RUFU-FFF"),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IntegrationLandClaimBusyError);
    expect((refused as IntegrationLandClaimBusyError).holderTaskId).toBe("RUFU-EEE");
    // Refusing a terminal-looking holder is free; taking it early is not. Nothing moved but DDD's work.
    expect(trackedOnMain(harness.repoDir, "delta.txt")).toBe(true);
    expect(trackedOnMain(harness.repoDir, "zeta.txt")).toBe(false);
  });
});
