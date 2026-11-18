import { describe, expect, it } from "vitest";
import { overlapPredecessorRelease } from "../tasks/overlap-wait-release.js";
import type { Task, TaskOverlapWait } from "../types.js";

/*
FNXC:OverlapWaitRelease 2026-11-18-01:03 (RUFU-1043):
Acceptance for the `vacant` release face. Measured need on RunFusion 2026-11-17/18: 549 of 595 open overlap
edges were held by blockers with no worktree pointer; 82 cards' last log line named an `active file-scope
lease` for a blocker sitting in `todo` with no checkout; one holder had zero files of its own against `main`
while its own log demanded delivered files from the card waiting on it. The pre-existing `delivered` face
could not release any of them because it requires concrete delivery proof, and a holder that never executed
has none.

Assertions are the invariant across surfaces, not the reported repro: a renamed WIP lane still refuses, the
workspace checkout form still refuses, a review-lane holder still refuses, a holder that owns live graph work
still refuses, unknown lane vocabulary still refuses, and a caller that cannot read liveness never gains the
face by omission.
*/

const episode = { observedAt: "2026-11-17T00:00:00.000Z" } as Pick<TaskOverlapWait, "observedAt" | "observation">;

function holder(over: Partial<Task>): Task {
  return {
    id: "RUFU-1",
    column: "todo",
    status: null,
    branch: null,
    worktree: null,
    workspaceWorktrees: null,
    mergeDetails: null,
    deletedAt: null,
    ...over,
  } as Task;
}

const LANES = { completeColumns: new Set<string>(["done"]), wipColumns: new Set<string>(["in-progress"]) };
/** Everything the reconciliation seam can prove about a holder that rests in a planning lane and owns nothing. */
const VACANT = { hasLiveWorkItem: false, holderLaneCannotDeliver: true };

describe("overlapPredecessorRelease — vacant holder face", () => {
  it("releases a holder that holds nothing: no pointer, no checkout, planning lane, no live work item", () => {
    expect(overlapPredecessorRelease(episode, holder({}), LANES, VACANT)).toBe("vacant");
  });

  it("refuses while the holder stands in a WIP lane, even with no checkout", () => {
    expect(overlapPredecessorRelease(episode, holder({ column: "in-progress" }), LANES, VACANT)).toBeUndefined();
  });

  it("follows the board's DECLARED WIP lane, never the literal id", () => {
    const renamed = { completeColumns: new Set(["shipped"]), wipColumns: new Set(["implementation"]) };
    expect(overlapPredecessorRelease(episode, holder({ column: "implementation" }), renamed, VACANT)).toBeUndefined();
    expect(overlapPredecessorRelease(episode, holder({ column: "backlog" }), renamed, VACANT)).toBe("vacant");
  });

  it("refuses a retained workspace checkout with no singular worktree", () => {
    const workspaceHolder = holder({
      column: "review",
      workspaceWorktrees: { api: { worktreePath: "/tmp/does-not-matter" } },
    });
    expect(overlapPredecessorRelease(episode, workspaceHolder, LANES, VACANT)).toBeUndefined();
  });

  it("refuses a retained singular checkout", () => {
    expect(overlapPredecessorRelease(episode, holder({ worktree: "/tmp/checkout" }), LANES, VACANT)).toBeUndefined();
  });

  it("refuses a holder resting in a review lane, where an unlanded branch is the normal state", () => {
    expect(overlapPredecessorRelease(episode, holder({ column: "in-review" }), LANES,
      { hasLiveWorkItem: false, holderLaneCannotDeliver: false })).toBeUndefined();
  });

  it("refuses when the caller could not resolve the holder's lane vocabulary", () => {
    // Unknown vocabulary must never read as "no delivering lane" (RUFU-341's three-cause rule).
    expect(overlapPredecessorRelease(episode, holder({}), LANES, { hasLiveWorkItem: false })).toBeUndefined();
  });

  it("refuses a holder that still owns live graph work, which is what makes the face safe to state", () => {
    expect(overlapPredecessorRelease(episode, holder({}), LANES,
      { hasLiveWorkItem: true, holderLaneCannotDeliver: true })).toBeUndefined();
  });

  it("never grants the face to a caller that cannot read liveness", () => {
    // No fourth argument at all, and an empty bag: pre-existing callers keep their pre-change answer.
    expect(overlapPredecessorRelease(episode, holder({}), LANES)).toBeUndefined();
    expect(overlapPredecessorRelease(episode, holder({}), LANES, {})).toBeUndefined();
  });

  it("keeps every stronger face winning over vacancy", () => {
    expect(overlapPredecessorRelease(episode, undefined, LANES, VACANT)).toBe("missing");
    expect(overlapPredecessorRelease(episode, holder({ deletedAt: "2026-11-17T00:00:00.000Z" }), LANES, VACANT))
      .toBe("deleted");
    expect(overlapPredecessorRelease(episode, holder({ column: "done" }), LANES, VACANT)).toBe("complete");
    expect(overlapPredecessorRelease({ ...episode, observation: { blockerResetAt: "2026-11-17T00:00:00.000Z" } },
      holder({}), LANES, VACANT)).toBe("reset");
  });
});
