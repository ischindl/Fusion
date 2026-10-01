import { describe, expect, it } from "vitest";
import {
  isWorktreeCapacityHolder,
  type WorktreeCapacityTaskShape,
} from "../agents/worktree-capacity-holder.js";

function task(overrides: Partial<WorktreeCapacityTaskShape> = {}): WorktreeCapacityTaskShape {
  return {
    column: "todo",
    columnTerminalKind: "none",
    ...overrides,
  };
}

describe("isWorktreeCapacityHolder", () => {
  it("does not count a checkout-free planning card", () => {
    expect(isWorktreeCapacityHolder(task({ status: "planning" }))).toBe(false);
  });

  it("counts a live WIP card before acquisition persists a checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "working",
      columnCountsTowardWip: true,
    }))).toBe(true);
  });

  it("counts a live review card with a singular checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "review",
      columnIsReviewOrMerge: true,
      status: "reviewing",
      worktree: "/worktrees/FN-282",
    }))).toBe(true);
  });

  it("counts a live review card with workspace checkouts only", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "review",
      columnIsReviewOrMerge: true,
      status: "reviewing",
      workspaceWorktrees: {
        "packages/core": {
          worktreePath: "/worktrees/FN-282/core",
          branch: "fusion/fn-282-core",
        },
      },
    }))).toBe(true);
  });

  it.each([
    ["singular", { worktree: "/worktrees/FN-282" }],
    ["workspace", {
      workspaceWorktrees: {
        "packages/core": {
          worktreePath: "/worktrees/FN-282/core",
          branch: "fusion/fn-282-core",
        },
      },
    }],
  ])("counts a hold-lane needs-replan card with a retained %s checkout", (_kind, checkout) => {
    expect(isWorktreeCapacityHolder(task({
      column: "hold",
      columnIsIntakeOrHold: true,
      status: "needs-replan",
      ...checkout,
    }))).toBe(true);
  });

  it.each([
    ["paused", { paused: true }],
    ["failed", { status: "failed" as const }],
  ])("does not count a %s WIP card", (_label, state) => {
    expect(isWorktreeCapacityHolder(task({
      column: "working",
      columnCountsTowardWip: true,
      worktree: "/worktrees/FN-282",
      ...state,
    }))).toBe(false);
  });

  it("does not count a terminal card with a retained checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "done",
      columnTerminalKind: "complete",
      worktree: "/worktrees/FN-282",
    }))).toBe(false);
  });

  /*
  FNXC:OverlapScheduling 2026-09-09-00:40 (RUFU-200):
  The capacity half of the phantom-holder fix: RUFU-198 sat in a planning lane with a clean,
  zero-commits-ahead checkout and still consumed one of the operator's `maxWorktrees` slots, so the
  capacity readout reported 3/4 for cards that protected nothing on disk. These tests pin the
  downgrade-only contract of `checkoutProvenEmpty`: ONLY a caller-computed `true` releases the slot —
  an absent field (every legacy caller) and an explicit `false` (occupied OR unknown proof) both keep
  today's counting, because releasing a slot that still hides uncommitted work is the unrecoverable
  error direction.
  */
  it("does not count a hold-lane card whose retained checkout is proven clean-and-behind", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "hold",
      columnIsIntakeOrHold: true,
      status: "needs-replan",
      worktree: "/worktrees/RUFU-198",
      checkoutProvenEmpty: true,
    }))).toBe(false);
  });

  it("still counts the same card when the proof says occupied (explicit false)", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "hold",
      columnIsIntakeOrHold: true,
      status: "needs-replan",
      worktree: "/worktrees/RUFU-198",
      checkoutProvenEmpty: false,
    }))).toBe(true);
  });

  it("still counts the same card when no proof was computed (legacy callers unchanged)", () => {
    /* The pre-RUFU-200 contract, restated as intent rather than accident: a caller whose task shape
       predates the field must NOT silently release capacity — absence means unknown means holder. */
    expect(isWorktreeCapacityHolder(task({
      column: "hold",
      columnIsIntakeOrHold: true,
      status: "needs-replan",
      worktree: "/worktrees/RUFU-198",
    }))).toBe(true);
  });

  it("still counts a live WIP card whose checkout is proven empty (liveness, not checkout, holds the slot)", () => {
    /* A card mid-execution owns its slot through the running-agent clause; the checkout downgrade
       only removes the RETENTION arm, never the live-execution arm. */
    expect(isWorktreeCapacityHolder(task({
      column: "working",
      columnCountsTowardWip: true,
      status: "running",
      worktree: "/worktrees/FN-282",
      checkoutProvenEmpty: true,
    }))).toBe(true);
  });
});
