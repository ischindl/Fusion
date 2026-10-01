import { describe, expect, it } from "vitest";
import { fileScopeLeaseBlocksCandidate, type CheckoutEmptinessVerdict, type Task } from "@fusion/core";
import { classifyFileScopeLease, shouldHoldActiveFileScopeLease } from "../scheduler.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("classifyFileScopeLease", () => {
  it("keeps failed, paused, and user-paused review cards active while they own a worktree", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", status: "failed" }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", paused: true }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", userPaused: true }), [])).toMatchObject({ kind: "active" });
  });

  it("releases a review lease after its worktree is gone", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-review" }), [])).toMatchObject({ kind: "none" });
  });

  it("keeps workspace review and dormant leases until every repository checkout is removed", () => {
    const workspaceWorktrees = { "repo-a": { worktreePath: "/wt/fn-1/repo-a" } } as Task["workspaceWorktrees"];
    const review = makeTask({ column: "signoff", workspaceWorktrees });
    const hold = makeTask({ column: "backlog", workspaceWorktrees });

    expect(classifyFileScopeLease(review, [], {
      isWipColumn: false,
      isReviewColumn: true,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(hold, [], {
      isWipColumn: false,
      isReviewColumn: false,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "done", workspaceWorktrees }), [], {
      isTerminalColumn: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "signoff", deletedAt: "2026-01-02T00:00:00.000Z", workspaceWorktrees }), [], {
      isReviewColumn: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "signoff", workspaceWorktrees: {} }), [], {
      isReviewColumn: true,
    })).toMatchObject({ kind: "none" });
  });

  it("keeps WIP work active despite failure and before worktree acquisition", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", worktree: "/wt/a", status: "failed" }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", paused: true }), [])).toMatchObject({ kind: "active" });
  });

  it("waives a WIP lease only for the holder's unmet scheduling dependencies", () => {
    const dependency = makeTask({ id: "FN-DEP", column: "todo" });
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", dependencies: [dependency.id] });
    const unrelated = makeTask({ id: "FN-OTHER", column: "todo" });
    const classification = classifyFileScopeLease(holder, [holder, dependency, unrelated]);

    expect(classification).toMatchObject({ kind: "active", waivedForTaskIds: [dependency.id] });
    expect(fileScopeLeaseBlocksCandidate(holder, dependency, classification)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(holder, unrelated, classification)).toBe(true);
  });

  it("makes preserved worktrees dormant outside WIP and review", () => {
    expect(classifyFileScopeLease(makeTask({ column: "todo", worktree: "/wt/a" }), [])).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "triage", worktree: "/wt/a" }), [])).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "todo" }), [])).toMatchObject({ kind: "none" });
  });

  it("releases terminal and soft-deleted cards before considering their lane", () => {
    expect(classifyFileScopeLease(makeTask({ column: "done", worktree: "/wt/a" }), [])).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", deletedAt: "2026-01-02T00:00:00.000Z" }), [])).toMatchObject({ kind: "none" });
  });

  it("uses resolved terminal and lane traits for renamed boards", () => {
    const complete = makeTask({ column: "shipped", worktree: "/wt/a" });
    const custom = makeTask({ column: "awaiting-merge", worktree: "/wt/a" });

    expect(classifyFileScopeLease(complete, [], { isTerminalColumn: true })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(custom, [], { isWipColumn: false, isReviewColumn: false, isTerminalColumn: false })).toMatchObject({ kind: "dormant" });
  });

  it("keeps the accepted-handoff exception limited to review cards", () => {
    const review = makeTask({ column: "in-review", worktree: "/wt/a" });
    const wip = makeTask({ column: "in-progress", worktree: "/wt/a" });

    expect(classifyFileScopeLease(review, [], {
      mergeRequestContractShadowEnabled: true,
      handoffAccepted: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(review, [], {
      mergeRequestContractShadowEnabled: false,
      handoffAccepted: true,
    })).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(wip, [], {
      mergeRequestContractShadowEnabled: true,
      handoffAccepted: true,
    })).toMatchObject({ kind: "active" });
  });
});

/*
FNXC:OverlapScheduling 2026-09-08-22:25 (RUFU-200):
The dormant lease is the one place the checkout-emptiness proof is allowed to speak, and it is a
 downgrade-only input: it can release a lease, never create one. These cases pin both halves of that
 contract, because each half fails alone:

- A hold-lane card whose checkout is clean and zero-commits-ahead must stop holding files it
  demonstrably does not touch. Measured on the board: this phantom is what blocked RUFU-199 forever
  while its holder sat in planning with an untouched tree.
- Every weaker answer (`occupied`, `unknown`, a proof with no entry for the retained path, an empty
  proof map, or no proof argument at all) must keep the pre-RUFU-200 holder answer verbatim. Releasing
  on an unproven checkout is how a reclaim would destroy uncommitted work.

The release case is non-vacuous by construction: it asserts `kind: "none"` for a task that the
no-proof cases in the block above classify as `dormant`, so a classifier that ignored the proof would
fail it. The `occupied`/`unknown`/missing-entry cases are the paired guard against the opposite error —
a classifier that released on any proof at all.
*/
describe("classifyFileScopeLease with a checkout-emptiness proof (RUFU-200)", () => {
  const holdLane = { isWipColumn: false, isReviewColumn: false, isTerminalColumn: false };
  const singularProof = (verdict: CheckoutEmptinessVerdict) => new Map<string, CheckoutEmptinessVerdict>([["", verdict]]);
  const holder = makeTask({ id: "FN-HOLDER", column: "todo", worktree: "/wt/holder" });
  const peer = makeTask({ id: "FN-PEER", column: "todo" });

  it("releases a dormant lease once every retained checkout is proven empty", () => {
    const classification = classifyFileScopeLease(holder, [holder, peer], {
      ...holdLane,
      checkoutEmptiness: singularProof("empty"),
    });

    expect(classification).toMatchObject({ kind: "none" });
    expect(fileScopeLeaseBlocksCandidate(holder, peer, classification)).toBe(false);
  });

  it.each([["occupied"], ["unknown"]] as const)(
    "keeps the dormant lease on an %s proof — an unproven checkout is never released",
    (verdict) => {
      const classification = classifyFileScopeLease(holder, [holder, peer], {
        ...holdLane,
        checkoutEmptiness: singularProof(verdict),
      });

      expect(classification).toMatchObject({ kind: "dormant" });
      expect(fileScopeLeaseBlocksCandidate(holder, peer, classification)).toBe(true);
    },
  );

  it("keeps the dormant lease when the proof has no entry for the retained path", () => {
    expect(classifyFileScopeLease(holder, [holder, peer], {
      ...holdLane,
      checkoutEmptiness: new Map<string, CheckoutEmptinessVerdict>(),
    })).toMatchObject({ kind: "dormant" });
  });

  it("confines the downgrade to the dormant branch: a proven-empty review checkout stays an active holder", () => {
    const review = makeTask({ id: "FN-REVIEW", column: "in-review", worktree: "/wt/review" });

    expect(classifyFileScopeLease(review, [review, peer], {
      isWipColumn: false,
      isReviewColumn: true,
      isTerminalColumn: false,
      checkoutEmptiness: singularProof("empty"),
    })).toMatchObject({ kind: "active" });
  });

  it("requires EVERY workspace repository to be empty before releasing", () => {
    const workspaceWorktrees = {
      "repo-a": { worktreePath: "/wt/fn-1/repo-a" },
      "repo-b": { worktreePath: "/wt/fn-1/repo-b" },
    } as Task["workspaceWorktrees"];
    const wsHolder = makeTask({ id: "FN-WS", column: "todo", workspaceWorktrees });

    expect(classifyFileScopeLease(wsHolder, [wsHolder, peer], {
      ...holdLane,
      checkoutEmptiness: new Map<string, CheckoutEmptinessVerdict>([
        ["repo-a", "empty"],
        ["repo-b", "occupied"],
      ]),
    })).toMatchObject({ kind: "dormant" });

    expect(classifyFileScopeLease(wsHolder, [wsHolder, peer], {
      ...holdLane,
      checkoutEmptiness: new Map<string, CheckoutEmptinessVerdict>([
        ["repo-a", "empty"],
        ["repo-b", "empty"],
      ]),
    })).toMatchObject({ kind: "none" });
  });

  it("shouldHoldActiveFileScopeLease forwards the proof instead of dropping it", () => {
    const options = { ...holdLane, checkoutEmptiness: singularProof("empty") };

    expect(shouldHoldActiveFileScopeLease(holder, [holder, peer], options)).toBe(false);
    expect(shouldHoldActiveFileScopeLease(holder, [holder, peer], holdLane)).toBe(true);
  });
});
