import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY, WIP_ADMISSION_STALL_REFRESH_FLOOR_MS } from "@fusion/core";
import {
  WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS,
  WIP_ADMISSION_SWEEP_NODE,
  clearWipAdmissionPark,
  holdReleaseKind,
  isHumanOrEventRelease,
  publishWipAdmissionHold,
  recordWipAdmissionPark,
  wipAdmissionGateHasInLaneRemedy,
  wipAdmissionParkCodeForHeldReason,
  wipAdmissionHoldHasNoCheapRecheck,
  wipAdmissionReleaseAttemptIsCooling,
  wipAdmissionSignatureFrom,
} from "../wip-admission-park.js";

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The recorder is the single place a withheld hold->WIP crossing becomes durable, so these tests pin the
three things that make it a bound instead of a second counter: one accepted write per changed condition
(everything else writes nothing), a marker write that is a KEY-PRESERVING patch (a whole-field
`sourceMetadata` wipe would orphan `duplicateOf`, `handoffFrom` and the RUFU-273 planning episode), and a
store failure that degrades to "no audit row" rather than throwing into the graph. The History-mirror
tests exist because the first draft called `logEntry` with an object where the store takes a positional
string — a shape bug that crashed an unrelated sweep test with `entry.message.includes is not a function`.
*/

const T0 = Date.parse("2026-11-01T00:00:00.000Z");

function card(sourceMetadata: Record<string, unknown> = {}): Pick<Task, "id" | "sourceMetadata"> {
  return { id: "RUFU-393", sourceMetadata };
}

function makeStore(overrides: Partial<TaskStore> = {}) {
  const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: "RUFU-393", patch }));
  const logEntryOnce = vi.fn(async () => true);
  const logEntry = vi.fn(async () => undefined);
  const store = { updateTask, logEntryOnce, logEntry, ...overrides } as unknown as TaskStore;
  return { store, updateTask, logEntryOnce, logEntry };
}

const seamContext = {
  code: "scheduler-seam" as const,
  nodeId: "parse",
  fromColumn: "todo",
  toColumn: "in-progress",
};

describe("recordWipAdmissionPark", () => {
  it("records a changed condition once and warrants exactly one audit row", async () => {
    const { store, updateTask } = makeStore();
    const first = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(first.accepted).toBe(true);
    expect(first.auditRowWarranted).toBe(true);
    expect(updateTask).toHaveBeenCalledTimes(1);

    // The same refusal 15 seconds later must write nothing: the storm was one row per dispatch.
    const again = await recordWipAdmissionPark(store, card(first.episode ? { [WIP_ADMISSION_STALL_METADATA_KEY]: first.episode } : {}), seamContext, T0 + 15_000);
    expect(again.accepted).toBe(false);
    expect(again.auditRowWarranted).toBe(false);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("writes through a key-preserving patch, never a whole sourceMetadata replacement", async () => {
    const { store, updateTask } = makeStore();
    await recordWipAdmissionPark(store, card({ duplicateOf: "RUFU-000" }), seamContext, T0);
    const patch = updateTask.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["sourceMetadataPatch"]);
    expect(Object.keys(patch.sourceMetadataPatch as Record<string, unknown>)).toEqual([WIP_ADMISSION_STALL_METADATA_KEY]);
    expect(patch).not.toHaveProperty("sourceMetadata");
  });

  it("refreshes past the floor with the age preserved and one further audit row", async () => {
    const { store } = makeStore();
    const first = await recordWipAdmissionPark(store, card(), seamContext, T0);
    const refreshed = await recordWipAdmissionPark(
      store,
      card({ [WIP_ADMISSION_STALL_METADATA_KEY]: first.episode }),
      seamContext,
      T0 + 20 * 60_000,
    );
    expect(refreshed.accepted).toBe(true);
    expect(refreshed.episode?.firstAt).toBe(first.episode?.firstAt);
    expect(refreshed.episode?.stallCount).toBe(2);
  });

  it("degrades a store failure to no-marker and no-audit-row instead of throwing", async () => {
    const { store } = makeStore({ updateTask: vi.fn(async () => { throw new Error("store down"); }) } as unknown as Partial<TaskStore>);
    const result = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(result).toEqual({ accepted: false, auditRowWarranted: false });
  });
});

describe("recordWipAdmissionPark History mirror", () => {
  it("announces through the durable once-seam keyed by the episode signature", async () => {
    const { store, logEntryOnce } = makeStore();
    await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(logEntryOnce).toHaveBeenCalledTimes(1);
    const [taskId, input] = logEntryOnce.mock.calls[0] as unknown as [string, { action: string; dedupeKey: string; windowMs: number }];
    expect(taskId).toBe("RUFU-393");
    expect(input.dedupeKey).toBe(`wip-admission-park:${wipAdmissionSignatureFrom(seamContext)}`);
    expect(input.windowMs).toBe(WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS);
    expect(input.action).toContain("scheduler-seam");
  });

  it("falls back to logEntry with a positional string, matching the store signature", async () => {
    const { store, logEntry } = makeStore({ logEntryOnce: undefined } as unknown as Partial<TaskStore>);
    await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(logEntry).toHaveBeenCalledTimes(1);
    const [taskId, action] = logEntry.mock.calls[0] as unknown as [string, unknown];
    expect(taskId).toBe("RUFU-393");
    // The pre-fix draft passed an object here, which stored a non-string `message` and blew up a sweep test.
    expect(typeof action).toBe("string");
  });

  it("keeps the marker for a readiness gate but stays out of History", async () => {
    const { store, updateTask, logEntryOnce } = makeStore();
    await recordWipAdmissionPark(store, card(), { ...seamContext, code: "awaiting-planning" }, T0);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(logEntryOnce).not.toHaveBeenCalled();
  });

  it("swallows a History failure so telemetry cannot fail the marker", async () => {
    const { store } = makeStore({ logEntryOnce: vi.fn(async () => { throw new Error("log sink down"); }) } as unknown as Partial<TaskStore>);
    const result = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(result.accepted).toBe(true);
  });
});

describe("publishWipAdmissionHold", () => {
  it("publishes a measured sweep verdict under the graph's node when one already parked the card", async () => {
    const { store, updateTask } = makeStore();
    const parkedByGraph = {
      code: "scheduler-seam",
      signature: wipAdmissionSignatureFrom(seamContext),
      nodeId: "parse",
      fromColumn: "todo",
      toColumn: "in-progress",
      lastAt: new Date(T0 - 20 * 60_000).toISOString(),
      firstAt: new Date(T0 - 20 * 60_000).toISOString(),
      stallCount: 1,
    };
    await publishWipAdmissionHold(
      store,
      card({ [WIP_ADMISSION_STALL_METADATA_KEY]: parkedByGraph }),
      { fromColumn: "todo", toColumn: "in-progress", heldReason: "downstream-full", poolId: "column:in-progress", occupants: 4, limit: 4 },
      T0,
    );
    const patch = (updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, never> }).sourceMetadataPatch;
    const episode = patch[WIP_ADMISSION_STALL_METADATA_KEY] as { nodeId: string; code: string; firstAt: string; occupants?: number };
    // One episode, one counter: the sweep sharpens the gate but inherits the graph's node and clock.
    expect(episode.nodeId).toBe("parse");
    expect(episode.code).toBe("downstream-full");
    expect(episode.occupants).toBe(4);
    expect(episode.firstAt).toBe(parkedByGraph.firstAt);
  });

  it("names itself as the author when no graph episode exists to inherit", async () => {
    const { store, updateTask } = makeStore();
    await publishWipAdmissionHold(
      store,
      card(),
      { fromColumn: "todo", toColumn: "in-progress", heldReason: "downstream-full", poolId: "column:in-progress", occupants: 2, limit: 2 },
      T0,
    );
    const patch = (updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, never> }).sourceMetadataPatch;
    expect((patch[WIP_ADMISSION_STALL_METADATA_KEY] as { nodeId: string }).nodeId).toBe(WIP_ADMISSION_SWEEP_NODE);
  });

  it("publishes nothing for an arm outside the closed gate vocabulary", async () => {
    const { store, updateTask } = makeStore();
    await publishWipAdmissionHold(store, card(), { fromColumn: "todo", toColumn: "in-progress", heldReason: "timer-not-elapsed" }, T0);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("sweep-arm and release-kind eligibility", () => {
  /*
  FNXC:WipAdmissionPark 2026-11-20-23:38 (RUFU-758):
  The sweep now publishes the refusal its release primitive returned, so the release-refusal codes are held
  reasons too and belong in the same arm-to-gate table as the measured capacity arms. `move-rejected-or-no-slot`
  is asserted as the identity for a CODELESS refusal only -- a premise refusal must never land on it, because
  that gate means a slot was found and the move was refused, which the premise door contradicts (it refuses
  before any slot is requested). The premise family collapses to ONE gate on purpose: the distinguishing detail
  lives in the card's History line and the sweep's held reason, not in nine badge sentences.
  */
  it("maps each measured sweep arm onto a gate and refuses to invent one", () => {
    expect(wipAdmissionParkCodeForHeldReason("downstream-full")).toBe("downstream-full");
    expect(wipAdmissionParkCodeForHeldReason("no-downstream-capacity-column")).toBe("no-downstream-capacity-column");
    expect(wipAdmissionParkCodeForHeldReason("move-rejected-or-no-slot")).toBe("move-rejected-or-no-slot");
    expect(wipAdmissionParkCodeForHeldReason("awaiting-approval")).toBe("awaiting-approval");
    // The readiness probe is parameterized; the gate is one thing.
    expect(wipAdmissionParkCodeForHeldReason("awaiting-planning:seed-prompt")).toBe("awaiting-planning");
    // Released refusals that carry a code reach the same table (RUFU-758), each under its own gate.
    expect(wipAdmissionParkCodeForHeldReason("plan-premise-unavailable")).toBe("plan-premise-unmet");
    expect(wipAdmissionParkCodeForHeldReason("plan-premise-invalid")).toBe("plan-premise-unmet");
    expect(wipAdmissionParkCodeForHeldReason("unplanned-for-execution")).toBe("awaiting-planning");
    expect(wipAdmissionParkCodeForHeldReason("capacity-exhausted-or-no-slot")).toBe("move-rejected-or-no-slot");
    expect(wipAdmissionParkCodeForHeldReason("timer-not-elapsed")).toBeUndefined();
    expect(wipAdmissionParkCodeForHeldReason("manual-only")).toBeUndefined();
    expect(wipAdmissionParkCodeForHeldReason("reason-someone-adds-tomorrow")).toBeUndefined();
  });

  it("reads the hold release kind from the IR and treats only manual/event releases as human-owned", () => {
    const ir = (release: string) => ({
      version: "v2",
      columns: [{ id: "todo", traits: [{ trait: "hold", config: { release } }] }],
    }) as unknown as WorkflowIr;
    expect(holdReleaseKind(ir("capacity"), "todo")).toBe("capacity");
    expect(holdReleaseKind(ir("manual"), "todo")).toBe("manual");
    expect(holdReleaseKind(undefined, "todo")).toBeUndefined();
    expect(holdReleaseKind(ir("manual"), "review")).toBeUndefined();

    expect(isHumanOrEventRelease("manual")).toBe(true);
    expect(isHumanOrEventRelease("external-event")).toBe(true);
    expect(isHumanOrEventRelease("capacity")).toBe(false);
    expect(isHumanOrEventRelease("timer")).toBe(false);
    expect(isHumanOrEventRelease(undefined)).toBe(false);
  });

  it("derives one signature for one crossing no matter which writer measured what", () => {
    // The graph never sees a pool; the sweep always does. Both must name the same wait.
    const fromGraph = wipAdmissionSignatureFrom({ code: "scheduler-seam", nodeId: "parse", fromColumn: "todo", toColumn: "in-progress" });
    const fromSweep = wipAdmissionSignatureFrom({
      code: "downstream-full", nodeId: WIP_ADMISSION_SWEEP_NODE, fromColumn: "todo", toColumn: "in-progress",
      poolId: "column:in-progress", occupants: 4, limit: 4,
    });
    expect(fromSweep).toBe(fromGraph);
    // A different destination is a different wait.
    expect(wipAdmissionSignatureFrom({ code: "scheduler-seam", nodeId: "parse", fromColumn: "todo", toColumn: "review" })).not.toBe(fromGraph);
  });
});

/*
FNXC:WipAdmissionParkCooldown 2026-11-19-21:15 (RUFU-558):
The release-sweep cadence rule, pinned at the predicate level so the ONE-wide allowlist cannot widen by
accident. The integration file (`hold-release-capacity-cooldown.test.ts`) proves the loop is bounded; this
matrix proves WHICH held reasons may be paced, and every row below is a card that must still be evaluated the
same pass. The rows that matter most are `downstream-full` (its lane sample is free and live, so pacing it
would delay a release that is ready now by a full refresh floor) and the readiness gates, whose freeze was the
RUFU-393 code-review P0.

FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
The predicate takes BOTH axes on purpose, and the matrix is the proof that neither can be dropped. The reason
axis decides the class; the row's own episode decides the moment. The `awaiting-planning:*` rows are written in
the FORM the sweep actually reports them (suffixed with the readiness reason), because that suffix is what an
exact-match allowlist tests against - a row spelling only the bare code would pass while the real reason
string slipped past.
*/
describe("wipAdmissionReleaseAttemptIsCooling", () => {
  /** One floor of rest, in the same units the episode's instants are stored in. */
  const FLOOR = WIP_ADMISSION_STALL_REFRESH_FLOOR_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  const episode = (over: Record<string, unknown> = {}) => ({
    code: "move-rejected-or-no-slot",
    signature: "capacity|todo->in-progress",
    nodeId: WIP_ADMISSION_SWEEP_NODE,
    fromColumn: "todo",
    toColumn: "in-progress",
    firstAt: iso(T0),
    lastAt: iso(T0),
    stallCount: 2,
    poolId: "column:in-progress",
    occupants: 0,
    limit: 4,
    ...over,
  });
  /** The row the sweep already listed: cadence must cost no extra read, so the marker rides the row. */
  const row = (over: Record<string, unknown> = {}, column = "todo") => ({
    id: "RUFU-558",
    column,
    sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode(over) },
  });
  const cooling = (
    task: { id: string; column: string; sourceMetadata: Record<string, unknown> },
    reason: string | undefined,
    now: number,
  ) => wipAdmissionReleaseAttemptIsCooling(task, reason, now);

  it("paces the refusal the sweep itself authored, for exactly one floor", () => {
    expect(cooling(row(), "move-rejected-or-no-slot", T0 + 15_000)).toBe(true);
    expect(cooling(row(), "move-rejected-or-no-slot", T0 + FLOOR - 1)).toBe(true);
    // At the floor the refusal is stale and the expensive leg runs again: a bound, never a lock.
    expect(cooling(row(), "move-rejected-or-no-slot", T0 + FLOOR)).toBe(false);
    expect(cooling(row(), "move-rejected-or-no-slot", T0 + FLOOR * 4)).toBe(false);
  });

  it("engages on a card whose episode label was sharpened upward, which a code-keyed bound never could", () => {
    // `moreSpecificWipAdmissionGate` keeps this label forever. Keying the bound on it answers "not cooling"
    // for these cards permanently - the inertness this correction removes - so both rank-4 labels must pace.
    for (const code of ["downstream-full", "column-capacity"]) {
      expect(cooling(row({ code }), "move-rejected-or-no-slot", T0 + 15_000)).toBe(true);
    }
  });

  it("never paces a refusal that has a cheap live re-check, however fresh the marker", () => {
    for (const reason of [
      "downstream-full",
      "column-capacity",
      "scheduler-seam",
      "capacity-rejection-without-facts",
      "no-downstream-capacity-column",
      "no-release-target",
      "deps-unsatisfied",
      "timer-not-elapsed",
    ]) {
      expect(cooling(row(), reason, T0 + 1_000)).toBe(false);
    }
  });

  it("never paces a readiness park, in the shape the sweep really reports it (RUFU-393 P0)", () => {
    // A card whose remaining work is in the refused column must keep being evaluated, or it is never planned.
    for (const reason of [
      "awaiting-approval",
      "awaiting-planning",
      "awaiting-planning:seed-prompt",
      "awaiting-planning:plan-review-pending",
      "awaiting-planning:needs-replan",
    ]) {
      expect(cooling(row(), reason, T0 + 1_000)).toBe(false);
      expect(cooling(row(), reason, T0 + FLOOR * 8)).toBe(false);
    }
    // Rule 2 reaches the label too: an episode naming an in-lane-remedy gate is never paced, whatever the
    // sweep's current reason says. That is the guard a future widening of the allowlist cannot step over.
    for (const code of ["awaiting-planning", "awaiting-approval"] as const) {
      expect(wipAdmissionGateHasInLaneRemedy(code)).toBe(true);
      expect(cooling(row({ code }), "move-rejected-or-no-slot", T0 + 1_000)).toBe(false);
    }
  });

  it("treats an unknown or newly added held reason as NOT paceable (positive list, not a negation)", () => {
    expect(cooling(row(), "plan-premise-unmet", T0 + 1_000)).toBe(false);
    expect(cooling(row(), "some-future-refusal", T0 + 1_000)).toBe(false);
    expect(cooling(row(), "", T0 + 1_000)).toBe(false);
  });

  it("paces nothing it cannot read: no reason, no marker, another column, or an unusable instant", () => {
    // A fresh card, or the first pass after an engine restart: the reason map is process-local.
    expect(cooling(row(), undefined, T0 + 15_000)).toBe(false);
    // No marker at all - e.g. cleared at the move seam by `clearWipAdmissionStallPatch`.
    expect(cooling({ id: "RUFU-558", column: "todo", sourceMetadata: {} }, "move-rejected-or-no-slot", T0 + 15_000)).toBe(false);
    // The marker names the column the card was refused IN; this card moved on.
    expect(cooling(row({}, "in-progress"), "move-rejected-or-no-slot", T0 + 15_000)).toBe(false);
    // A legacy or hand-edited marker with no instants is not a marker, and an unparsable stamp is not a clock.
    expect(cooling(row({ lastAt: undefined }), "move-rejected-or-no-slot", T0 + 15_000)).toBe(false);
    expect(cooling(row({ lastAt: "not-a-date" }), "move-rejected-or-no-slot", T0 + 15_000)).toBe(false);
  });

  it("classifies a held reason as paceable only when it genuinely has no cheap re-check", () => {
    expect(wipAdmissionHoldHasNoCheapRecheck("move-rejected-or-no-slot")).toBe(true);
    expect(wipAdmissionHoldHasNoCheapRecheck("downstream-full")).toBe(false);
    expect(wipAdmissionHoldHasNoCheapRecheck("awaiting-planning:seed-prompt")).toBe(false);
  });
});


describe("clearWipAdmissionPark", () => {
  it("clears the marker key only, and never names a column", async () => {
    const { store, updateTask } = makeStore();
    await clearWipAdmissionPark(store, "RUFU-393");
    const patch = updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, unknown> };
    expect(patch.sourceMetadataPatch).toEqual({ [WIP_ADMISSION_STALL_METADATA_KEY]: null });
  });

  it("swallows a clear failure so a marker that outlives its meaning cannot fail the move", async () => {
    const { store } = makeStore({ updateTask: vi.fn(async () => { throw new Error("store down"); }) } as unknown as Partial<TaskStore>);
    
    await expect(clearWipAdmissionPark(store, "RUFU-393")).resolves.toBeUndefined();
  });
});
