import { describe, expect, it, vi } from "vitest";
import { cleanupMergeStateForReverification } from "../executor/cleanup-merge-state.js";
import { readExecutionRarmMarker } from "../executor/execution-rearm.js";
import { mergeDetailsCarriesMergeEvidence } from "@fusion/core";

/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
The boundary this card had to walk between two guarantees that point in opposite directions.

- RUFU-469's stale-generation guarantee: a re-verification bounce sets `mergeDetails: null` WHOLESALE, so a
  landed generation cannot be observed by a later run. That must stay true, so this cleanup is NOT given a
  key-level carry of anything merge-shaped.
- RUFU-1028's park durability: the re-arm ladder must survive that same cleanup. It does, because RUFU-1027
  moved the ladder to `sourceMetadata.executionRearmEpisode`, a key this update never names.

The distinction the tests below enforce is therefore exact: every delivery snapshot goes, the episode stays
byte-identical, and nothing merge-bookkeeping is written back. A future "improvement" that preserves the whole
`mergeDetails` object would quietly undo RUFU-469, and a future change that moved the ladder back into
`mergeDetails` would re-create RUFU-278's 320-cycle loop. Both are prevented here, on the same fixture.
*/

const PARKED_EPISODE = {
  signature: "rearm:steps#1:step-execute:x:occupied",
  attempt: 5,
  refusal: 0,
  firstAt: "2026-11-14T15:38:41.000Z",
  at: "2026-11-14T15:52:54.000Z",
  heldAt: "2026-11-14T15:52:54.000Z",
  questionStamp: "steps#1:step-execute|plan-review-none|1",
};

function taskWithLadderAndDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-1028-T",
    title: "stuck card",
    description: "",
    column: "in-progress",
    status: "failed",
    error: "EXECUTION_REARM_EXHAUSTED: 4 re-arms produced no step progress",
    paused: false,
    userPaused: false,
    deletedAt: null,
    mergeRetries: 3,
    verificationFailureCount: 2,
    mergeDetails: {
      commitSha: "abc123",
      landedFiles: ["src/a.ts", "src/b.ts"],
      workspaceLandedShas: { "repo/a": "abc123" },
      workspaceLandedFiles: { "repo/a": ["src/a.ts"] },
      mergeConfirmed: true,
      mergedAt: "2026-11-14T14:00:00Z",
      landedBranchTipSha: "def456",
    },
    sourceMetadata: {
      executionRearmEpisode: { ...PARKED_EPISODE },
      // An unrelated provenance key must ride through untouched: the episode write is key-level.
      "duplicate-of": "RUFU-9999",
    },
    steps: [{ id: "0", status: "done" }, { id: "1", status: "in-progress" }],
    workflowStepResults: [
      { workflowStepId: "plan-review", status: "passed", source: "node" },
      { workflowStepId: "steps#1:step-execute", status: "failed", source: "node" },
    ],
    dependencies: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    ...overrides,
  } as any;
}

function storeFor(task: any, options: { logEntryOnce?: ReturnType<typeof vi.fn> } = {}) {
  let current = { ...task };
  const patches: Array<Record<string, unknown>> = [];
  const store: any = {
    getTask: vi.fn(async () => current),
    logEntry: vi.fn(async () => undefined),
    logEntryOnce: options.logEntryOnce ?? vi.fn(async () => true),
    recordRunAuditEvent: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      const { sourceMetadataPatch, ...rest } = patch as any;
      current = {
        ...current,
        ...rest,
        ...(sourceMetadataPatch
          ? { sourceMetadata: { ...(current.sourceMetadata ?? {}), ...sourceMetadataPatch } }
          : {}),
      };
      return current;
    }),
  };
  return { store, patches, get current() { return current; } };
}

const depsFor = (store: any) => ({ store, getRunContextFor: () => undefined }) as any;

describe("cleanupMergeStateForReverification keeps the ladder and drops the delivery", () => {
  it("clears every delivery snapshot and writes no re-arm bookkeeping back into mergeDetails", async () => {
    const task = taskWithLadderAndDelivery();
    const { store, patches } = storeFor(task);

    await cleanupMergeStateForReverification(depsFor(store), task, "stale merge state reset", {
      resetSource: "execute-preflight",
    });

    const written = patches[0];
    // (iii) wholesale, never a partial object — this is what RUFU-469 depends on.
    expect(written.mergeDetails).toBeNull();
    expect(written.mergeDetails).not.toEqual({});
    // The ladder's OLD host must not come back as a key-level carry: the patch text itself is the evidence.
    expect(JSON.stringify(written)).not.toContain("executionRearm");
    // Nothing in the write may restore merge bookkeeping under another name.
    const patchSource = JSON.stringify(written);
    expect(patchSource).not.toContain("commitSha");
    expect(patchSource).not.toContain("landedFiles");
    expect(patchSource).not.toContain("workspaceLanded");
    expect(patchSource).not.toContain("mergeConfirmed");
  });

  it("leaves the re-arm episode byte-identical, because the update never names that key", async () => {
    const task = taskWithLadderAndDelivery();
    const { store } = storeFor(task);

    const after = await cleanupMergeStateForReverification(depsFor(store), task, "stale merge state reset", {
      resetSource: "execute-preflight",
    });

    expect(readExecutionRarmMarker(after)).toEqual(PARKED_EPISODE);
    expect(after.sourceMetadata.duplicateOf ?? after.sourceMetadata["duplicate-of"]).toBe("RUFU-9999");
  });

  it("keeps the reset's other documented effects exactly as before", async () => {
    const task = taskWithLadderAndDelivery();
    const { store, patches } = storeFor(task);

    const after = await cleanupMergeStateForReverification(depsFor(store), task, "stale merge state reset", {
      preserveVerificationFailureCount: true,
      resetSource: "lane-return",
    });

    expect(patches[0]).toMatchObject({ mergeRetries: 0, status: null, error: null });
    expect(after.verificationFailureCount).toBe(2);
    // Pre-execution review evidence survives; post-execution residue does not (FN-7228).
    expect(after.workflowStepResults.map((r: any) => r.workflowStepId)).toEqual(["plan-review"]);

    const withoutPreserve = storeFor(task);
    await cleanupMergeStateForReverification(depsFor(withoutPreserve.store), task, "stale merge state reset", {});
    expect(withoutPreserve.current.verificationFailureCount).toBe(0);
  });

  it("records one disturbance pair for a standing park and nothing for a card that never parked", async () => {
    const parked = taskWithLadderAndDelivery();
    const parkedStore = storeFor(parked);
    await cleanupMergeStateForReverification(depsFor(parkedStore.store), parked, "reset", {
      resetSource: "execute-preflight",
    });

    const audit = parkedStore.store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
    const disturbed = audit.filter((row: any) => row.mutationType === "task:execution-rearm-park-marker-cleared");
    expect(disturbed).toHaveLength(1);
    expect(disturbed[0].metadata).toMatchObject({
      outcome: "marker-cleared",
      observedFrom: "merge-reset",
      resetSource: "execute-preflight",
      parkHeld: true,
      attempt: 5,
      refusal: 0,
    });
    // The metadata is a CLOSED set: no log message, no error sentence, no path, no signature.
    expect(Object.keys(disturbed[0].metadata).sort()).toEqual([
      "attempt", "attemptLimit", "observedFrom", "outcome", "parkHeld", "refusal", "refusalLimit", "resetSource", "taskId",
    ]);

    // A card with no park may write neither row nor History line.
    const unparked = taskWithLadderAndDelivery({
      sourceMetadata: {},
      mergeDetails: { commitSha: "abc123" },
    });
    const cleanStore = storeFor(unparked);
    await cleanupMergeStateForReverification(depsFor(cleanStore.store), unparked, "reset", {});
    const cleanAudit = cleanStore.store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
    expect(cleanAudit.filter((row: any) => row.mutationType === "task:execution-rearm-park-marker-cleared")).toHaveLength(0);
    expect(cleanStore.store.logEntryOnce).not.toHaveBeenCalled();
  });

  it("cannot be turned into a failed reset by a hostile sink", async () => {
    const task = taskWithLadderAndDelivery();
    for (const hostile of [
      vi.fn(async () => { throw new Error("sink exploded"); }),
      vi.fn(() => undefined as any),
      vi.fn(() => new Promise<boolean>(() => {})),
    ]) {
      const store = storeFor(task, { logEntryOnce: hostile }).store;
      const after = await cleanupMergeStateForReverification(depsFor(store), task, "reset", {
        resetSource: "lane-return",
      });
      // The cleanup itself is unaffected either way.
      expect(after.mergeDetails).toBeNull();
      expect(after.status).toBeNull();
    }
  });
});

describe("a bookkeeping-only row is not merge evidence", () => {
  it("denies the execute-preflight trigger the row it used to get from truthiness", () => {
    // RUFU-278 and RUFU-583 were both driven by this arm firing on a row that had never merged anything.
    expect(mergeDetailsCarriesMergeEvidence({
      pushRecovery: { target: "origin/main", commitSha: "abc", nextAttemptAt: "2026-11-14T00:00:00Z" },
      executionRearm: { ...PARKED_EPISODE },
    } as any)).toBe(false);
    expect(mergeDetailsCarriesMergeEvidence({ commitSha: "abc123" } as any)).toBe(true);
  });
});
