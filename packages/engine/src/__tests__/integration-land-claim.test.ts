/*
FNXC:MergeSingleFlight 2026-11-21-17:55 (RUFU-1148 Step 1):
Unit coverage for the durable integration-landing claim against the shared lease store double
(`_integration-land-lease-double.ts`), which models the `@fusion/core` row semantics: one row per key,
a monotonic `fenceToken`, a TTL a successor can take over as `reclaimed-expired`, and owner matching on
taskId + nodeId + incarnationId. The double is a model, not the database —
`merge-integration-land.pg.test.ts` proves the real seam across two store handles. This file proves the
ENGINE side: which outcome the caller sees, what a claim may carry in its audit rows, and that every
exit path hands the claim back.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createLeaseStoreDouble, LEASE_KIND_CHECK } from "./_integration-land-lease-double.js";
import {
  assertIntegrationLandClaimHeld,
  integrationLandLeaseKey,
  INTEGRATION_LAND_ACQUIRED_EVENT,
  INTEGRATION_LAND_CONTENDED_EVENT,
  IntegrationLandClaimBusyError,
  tryAcquireIntegrationLandClaim,
} from "../merge/integration-land-claim.js";

describe("integration landing claim", () => {
  let store: ReturnType<typeof createLeaseStoreDouble>;

  beforeEach(() => {
    vi.restoreAllMocks();
    store = createLeaseStoreDouble();
  });

  it("derives one key per repository and integration branch", () => {
    expect(integrationLandLeaseKey("root", "main")).toBe("integration-land:root:main");
    expect(integrationLandLeaseKey("packages/engine", "main")).toBe("integration-land:packages/engine:main");
    // A workspace sub-repo never shares a key with the entry repository; `root` is the single-repo key.
    expect(integrationLandLeaseKey("", "main")).toBe("integration-land:root:main");
    // The branch is part of the identity: landing `main` must not mute a landing on `release/1`.
    expect(integrationLandLeaseKey("root", "release/1")).not.toBe(integrationLandLeaseKey("root", "main"));
  });

  it("acquires an absent claim and names the acquirer as the row owner", async () => {
    const result = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") throw new Error();
    const row = store.rows.get(integrationLandLeaseKey("root", "main"))!;
    expect(row.ownerTaskId).toBe("RUFU-A");
    /*
    FNXC:MergeSingleFlight 2026-11-21-17:55 (RUFU-1148): the kind must be a value the durable table
    actually admits. `workspace_coordination_leases_kind_check` is a CLOSED list (`acquire`, `land`,
    `merge-dispatch`, migration 0060) and the first revision of this claim named a fifth value of its
    own inventing — every test here stayed green because a permissive fake stores any string, while
    PostgreSQL refused the write with `23514`. So the kind is `land` (this IS a claim on one landing
    write window) and the KEY namespace is what separates it from the workspace `repo:<repoRel>` lease.
    The double now enforces the same list, which turns that database refusal into a unit-lane failure.
    */
    expect(LEASE_KIND_CHECK).toContain(row.kind);
    expect(row.kind).toBe("land");
    // Owner identity carries node + incarnation too, which is what makes a second PROCESS contend.
    expect(row.ownerNodeId).toBeTruthy();
    expect(row.ownerIncarnationId).toBeTruthy();
  });

  it("reports a held claim as a conflict naming the holder, without taking the row", async () => {
    const first = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(first.outcome).toBe("acquired");
    const second = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-B", repoKey: "root", integrationBranch: "main" });
    expect(second).toMatchObject({ outcome: "conflict", holderTaskId: "RUFU-A" });
    // The loser never touches the winner's row: same token, same owner, still held.
    const row = store.rows.get(integrationLandLeaseKey("root", "main"))!;
    expect(row.ownerTaskId).toBe("RUFU-A");
    expect(row.fenceToken).toBe(1n);
    expect(row.status).toBe("held");
  });

  it("is reentrant for the same task inside the same process", async () => {
    const first = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(first.outcome).toBe("acquired");
    // The second burst of the SAME card (the land burst that follows the base burst) must not contend
    // with itself, or every landing would deadlock on its own claim.
    const again = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(again.outcome).toBe("reentrant");
  });

  it("reclaims a crashed holder's expired row and says so", async () => {
    let clock = new Date("2026-11-21T20:00:00.000Z");
    const crashed = createLeaseStoreDouble({ now: () => clock });
    const dead = await tryAcquireIntegrationLandClaim(crashed as TaskStore, {
      taskId: "RUFU-DEAD", repoKey: "root", integrationBranch: "main", leaseMs: 1_000,
    });
    expect(dead.outcome).toBe("acquired");
    // The holder dies: no release runs, the row stays `held`, and the TTL lapses.
    clock = new Date("2026-11-21T20:05:00.000Z");
    const next = await tryAcquireIntegrationLandClaim(crashed as TaskStore, { taskId: "RUFU-NEXT", repoKey: "root", integrationBranch: "main" });
    expect(next.outcome).toBe("reclaimed-expired");
    const row = crashed.rows.get(integrationLandLeaseKey("root", "main"))!;
    expect(row.ownerTaskId).toBe("RUFU-NEXT");
    // A takeover raises the fence, so the dead holder can never write again.
    expect(row.fenceToken).toBe(2n);
  });

  it("hands the claim back when the guarded body throws, so no row is left held", async () => {
    const result = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    if (result.outcome !== "acquired") throw new Error();
    await expect(async () => {
      try {
        throw new Error("body died");
      } finally {
        await result.claim.release();
      }
    }).rejects.toThrow("body died");
    expect(store.rows.get(integrationLandLeaseKey("root", "main"))!.status).toBe("released");
    // A released claim is acquirable by the next card immediately, without waiting out the TTL.
    const next = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-B", repoKey: "root", integrationBranch: "main" });
    expect(next.outcome).toBe("reclaimed-expired");
  });

  it("hands the claim back on an abort too, because abort unwinds through the same finally", async () => {
    const controller = new AbortController();
    const result = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    if (result.outcome !== "acquired") throw new Error();
    await expect(async () => {
      try {
        controller.abort();
        if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      } finally {
        await result.claim.release();
      }
    }).rejects.toThrow("aborted");
    expect(store.rows.get(integrationLandLeaseKey("root", "main"))!.status).toBe("released");
  });

  it("refuses the fence once another token owns the row and once the row is gone", async () => {
    const first = await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    if (first.outcome !== "acquired") throw new Error();
    await expect(assertIntegrationLandClaimHeld(store as TaskStore, first.claim)).resolves.toBeUndefined();

    // A successor takes the row out from under this pass — the crashed-holder shape AC3 must catch.
    const row = store.rows.get(integrationLandLeaseKey("root", "main"))!;
    row.ownerTaskId = "RUFU-C";
    row.fenceToken = row.fenceToken + 1n;
    await expect(assertIntegrationLandClaimHeld(store as TaskStore, first.claim))
      .rejects.toMatchObject({ holderTaskId: "RUFU-C" });

    // A row that vanished also refuses rather than waving the write through: an unprovable fence is
    // never a proof of ownership.
    const vanished = createLeaseStoreDouble();
    const mine = await tryAcquireIntegrationLandClaim(vanished as TaskStore, { taskId: "RUFU-D", repoKey: "root", integrationBranch: "main" });
    if (mine.outcome !== "acquired") throw new Error();
    vanished.rows.delete(mine.claim.leaseKey);
    await expect(assertIntegrationLandClaimHeld(vanished as TaskStore, mine.claim)).rejects.toBeInstanceOf(IntegrationLandClaimBusyError);
  });

  it("carries only ids and a fixed enum in its audit rows", async () => {
    await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    await tryAcquireIntegrationLandClaim(store as TaskStore, { taskId: "RUFU-B", repoKey: "root", integrationBranch: "main" });

    const acquired = store.emits.find((row) => row.mutationType === INTEGRATION_LAND_ACQUIRED_EVENT);
    const contended = store.emits.find((row) => row.mutationType === INTEGRATION_LAND_CONTENDED_EVENT);
    expect(acquired!.metadata).toEqual({ taskId: "RUFU-A", holderTaskId: null, outcome: "acquired" });
    expect(contended!.metadata).toEqual({ taskId: "RUFU-B", holderTaskId: "RUFU-A", outcome: "conflict" });
    for (const row of [acquired!, contended!]) {
      // AC4: the closed three-key set, and nothing else may ever ride along.
      expect(Object.keys(row.metadata).sort()).toEqual(["holderTaskId", "outcome", "taskId"]);
      // `target` names the lease key, so no repository path or ref tip has to be put in metadata.
      expect(row.target).toBe("integration-land:root:main");
      expect(JSON.stringify(row.metadata)).not.toMatch(/home\/|\.\.\.\//);
    }
  });

  /*
  AC4's behavioural half: a hostile sink must not change the claim. Asserted by behaviour — acquire,
  fence, and release all still happen — rather than by reading the emitter's source.
  */
  it.each([
    ["absent sink", () => undefined],
    ["throwing sink", () => { throw new Error("sink exploded"); }],
    ["never-settling sink", () => new Promise(() => undefined)],
  ])("leaves acquire, fence, and release unchanged with a %s", async (_label, sink) => {
    const hostile = createLeaseStoreDouble();
    hostile.setAuditSink(sink as () => unknown);
    const result = await tryAcquireIntegrationLandClaim(hostile as TaskStore, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") throw new Error();
    await expect(assertIntegrationLandClaimHeld(hostile as TaskStore, result.claim)).resolves.toBeUndefined();
    await result.claim.release();
    expect(hostile.rows.get(integrationLandLeaseKey("root", "main"))!.status).toBe("released");

    const contending = await tryAcquireIntegrationLandClaim(hostile as TaskStore, { taskId: "RUFU-B", repoKey: "root", integrationBranch: "main" });
    expect(contending.outcome).toBe("reclaimed-expired");
  });

  it("fails open when the store has no durable lease layer at all", async () => {
    const local = { getAsyncLayer: () => undefined } as Partial<TaskStore> as TaskStore;
    const result = await tryAcquireIntegrationLandClaim(local, { taskId: "RUFU-A", repoKey: "root", integrationBranch: "main" });
    expect(result).toEqual({ outcome: "unavailable", leaseKey: "integration-land:root:main" });
  });
});
