/**
 * FNXC:MergeSingleFlight 2026-11-21-16:40 (RUFU-1148 Step 5 — AC1):
 * The defect was measured on a shared-PostgreSQL fleet: two daemons, one board, one integration
 * branch, and an already-approved squash lost because the last writer of `refs/heads/main` decided
 * the order. Every guard that existed was in-process memory, so no number of unit tests against one
 * store handle could see it. This file is therefore the AC1 proof specifically: TWO independent
 * `TaskStore` handles — the shape two processes present to one database — contending for one
 * `integration-land:<repoKey>:<branch>` key.
 *
 * It is also the only lane that proves the row is STORABLE. `workspace_coordination_leases` carries a
 * CHECK constraint over its `kind` list; the first revision of this claim named a kind of its own
 * inventing, every double-backed test accepted it, and PostgreSQL refused the INSERT with `23514` at
 * the first real landing. A SKIPPED run here is therefore not a pass: see the `PROVISION` route in
 * `docs/testing.md` before treating this file as evidence.
 *
 * The invariant asserted is the general one, not the reported pair: the claim is a property of the
 * database row, so whichever handle got there first owns the write window, a second handle is
 * refused while it holds, a dead holder's row is taken over after its TTL, and a predecessor whose
 * row was taken over cannot fence-prove its way back into the write.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  assertIntegrationLandClaimHeld,
  integrationLandLeaseKey,
  tryAcquireIntegrationLandClaim,
} from "../merge/integration-land-claim.js";

const pgTest = pgDescribe;

pgTest("integration-landing claim across two store handles (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_integration_land_claim" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const REPO_KEY = "root";
  const BRANCH = "main";

  it("refuses a second process's landing burst while another holds the branch, and names the holder", async () => {
    const holderStore = h.store();
    const waiterStore = h.store();

    const holder = await tryAcquireIntegrationLandClaim(holderStore, {
      taskId: "FN-1148-holder", repoKey: REPO_KEY, integrationBranch: BRANCH,
    });
    expect(holder.outcome).toBe("acquired");
    if (holder.outcome === "unavailable") throw new Error("expected a durable lease seam on PostgreSQL");

    // The second process reaches the SAME row, not a second in-memory belief. This is the exact
    // crossing RUFU-893 / RUFU-702 fell through: two passes, one branch, one approved squash each.
    const waiter = await tryAcquireIntegrationLandClaim(waiterStore, {
      taskId: "FN-1148-waiter", repoKey: REPO_KEY, integrationBranch: BRANCH,
    });
    expect(waiter.outcome).toBe("conflict");
    if (waiter.outcome !== "conflict") return;
    expect(waiter.holderTaskId).toBe("FN-1148-holder");
    expect(waiter.leaseKey).toBe(integrationLandLeaseKey(REPO_KEY, BRANCH));

    /*
    The metadata SHAPE of both events (`{ taskId, holderTaskId, outcome }`, nothing else) is pinned
    exactly by `integration-land-claim.test.ts`; repeating it against a live database would duplicate
    a closed-set check instead of adding the one thing only this file can show — two handles.
    */

    await holder.claim!.release();

    // AC6: release is the fast path — the waiter needs no TTL wait-out once the holder finishes.
    const afterRelease = await tryAcquireIntegrationLandClaim(waiterStore, {
      taskId: "FN-1148-waiter", repoKey: REPO_KEY, integrationBranch: BRANCH,
    });
    expect(["acquired", "reclaimed-expired"]).toContain(afterRelease.outcome);
    if (afterRelease.outcome !== "unavailable") await afterRelease.claim!.release();
  });

  it("takes over a dead holder's row and refuses the dead holder's own fence proof", async () => {
    const deadStore = h.store();
    const liveStore = h.store();

    // leaseMs: 1 models the crash case without waiting a real TTL: the row stays `held`, its TTL lapses.
    const dead = await tryAcquireIntegrationLandClaim(deadStore, {
      taskId: "FN-1148-dead", repoKey: REPO_KEY, integrationBranch: BRANCH, leaseMs: 1,
    });
    expect(dead.outcome).toBe("acquired");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const successor = await tryAcquireIntegrationLandClaim(liveStore, {
      taskId: "FN-1148-successor", repoKey: REPO_KEY, integrationBranch: BRANCH,
    });
    expect(successor.outcome).toBe("reclaimed-expired");

    /*
    The predecessor process is the one that died, so it never released. Its leftover handle must not
    satisfy the pre-advance fence: were it to, two passes would both believe they own one write window
    and the takeover would be worth nothing.
    */
    await expect(assertIntegrationLandClaimHeld(deadStore, dead.claim)).rejects.toThrow();
    await expect(assertIntegrationLandClaimHeld(liveStore, successor.claim)).resolves.toBeUndefined();

    await successor.claim!.release();
  });

  it("keys the claim per integration branch, so two branches never share one window", async () => {
    const storeA = h.store();
    const storeB = h.store();

    const main = await tryAcquireIntegrationLandClaim(storeA, {
      taskId: "FN-1148-main", repoKey: REPO_KEY, integrationBranch: "main",
    });
    const release = await tryAcquireIntegrationLandClaim(storeB, {
      taskId: "FN-1148-release", repoKey: REPO_KEY, integrationBranch: "release/1.2",
    });
    expect(main.outcome).toBe("acquired");
    // A shared branch group lands members onto an intermediate branch; an unrelated branch must not
    // have to wait for `main`, or the claim would serialize the whole board.
    expect(release.outcome).toBe("acquired");

    await main.claim!.release();
    await release.claim!.release();
  });

  it("stores a kind the real table admits, under a key that names the tenancy", async () => {
    const store = h.store();
    const claim = await tryAcquireIntegrationLandClaim(store, {
      taskId: "FN-1148-kind", repoKey: REPO_KEY, integrationBranch: BRANCH, leaseMs: 1,
    });
    expect(claim.outcome).toBe("acquired");
    await new Promise((resolve) => setTimeout(resolve, 20));

    /*
    `workspace_coordination_leases_kind_check` admits exactly `acquire`, `land`, `merge-dispatch`
    (migration `0060_fn_9059_workspace_coordination_leases.sql`). An earlier revision of this claim
    named a kind outside that list: the double-backed suites stored it happily and the real database
    answered `23514` on the first landing that ever tried to take the claim. The tenancy is named by
    its KEY, so a reader that wants only these rows filters `lease_key LIKE 'integration-land:%'`.
    */
    const rows = await store.inspectWorkspaceLeases({ leaseKeys: [integrationLandLeaseKey(REPO_KEY, BRANCH)] });
    const row = rows.find((candidate) => candidate.leaseKey === integrationLandLeaseKey(REPO_KEY, BRANCH));
    expect(row?.kind).toBe("land");
    expect(row?.status).toBe("held");
    expect(row?.owner.taskId).toBe("FN-1148-kind");

    /*
    Sharing `kind` is safe precisely because the keys are disjoint: the workspace per-repo land lease
    owns `repo:<repoRel>` and this one owns `integration-land:<repoKey>:<branch>`. Proven at the real
    table because a shared kind is exactly what would let one family's reclaim sweep eat the other's
    row were the namespaces ever to collide.
    */
    const workspaceLand = await store.acquireWorkspaceLease({
      leaseKey: "repo:packages/engine",
      kind: "land",
      owner: { taskId: "FN-1148-workspace", nodeId: "node-pg", incarnationId: "incarnation-pg" },
      leaseMs: 60_000,
    });
    expect(workspaceLand.outcome).toBe("acquired");
    const heldLand = (await store.inspectWorkspaceLeases())
      .filter((candidate) => candidate.kind === "land" && candidate.status === "held")
      .map((candidate) => candidate.leaseKey)
      .sort();
    expect(heldLand).toEqual(["integration-land:root:main", "repo:packages/engine"].sort());

    if (workspaceLand.outcome === "acquired") await store.releaseWorkspaceLease(workspaceLand.handle);
  });
});
