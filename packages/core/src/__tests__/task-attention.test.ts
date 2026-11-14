import { describe, expect, it } from "vitest";
/*
FNXC:BoardOrdering 2026-11-13-09:30:
RUFU-526 - the attention ladder's own semantics. The board's default order must rank cards that need
attention above idle/backlog, and this is the single place that decides what "needs attention" means;
`task-attention-parity.test.ts` checks the two halves agree, and `task-queue-attention.test.ts` checks
the ladder actually reorders a lane. This file checks the LADDER ITSELF: every tier reachable,
first-match-wins between adjacent tiers, the absent/empty/whitespace text states, `humanPlanApproval`
armed versus decided, and that a leftover `priority` value cannot move a tier.
*/
import {
  ATTENTION_TIER_IDLE,
  resolveAttentionTier,
  type AttentionTask,
} from "../tasks/task-attention.js";
import { ATTENTION_FIXTURE_A } from "./task-attention-fixtures.js";

const clientTiers = (reviewScope: boolean) =>
  ATTENTION_FIXTURE_A.map((row) => resolveAttentionTier(row.task, { reviewScope }));

describe("resolveAttentionTier - every tier of the ladder is reachable", () => {
  it("assigns each Fixture A row the tier the ladder table declares, gate off and gate on", () => {
    // Row-by-row rather than one array compare: a failure must name the shape, not an index.
    for (const row of ATTENTION_FIXTURE_A) {
      expect(resolveAttentionTier(row.task, { reviewScope: false }), `${row.name} (gate off)`).toBe(row.withoutGate);
      expect(resolveAttentionTier(row.task, { reviewScope: true }), `${row.name} (gate on)`).toBe(row.withGate);
    }
  });

  it("covers all seven tiers on both sides of the review-scope gate", () => {
    const observed = (reviewScope: boolean) =>
      new Set(ATTENTION_FIXTURE_A.map((row) => resolveAttentionTier(row.task, { reviewScope })));
    // With the gate on, the whole ladder is exercised...
    expect([...observed(true)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // ...and with it off, tiers 1 and 3 are unreachable by construction - the cost bound and the
    // derived-signal rule in one assertion.
    expect(observed(false)).toEqual(new Set([0, 2, 4, 5, 6]));
  });

  it("floors at idle rather than inventing urgency for an empty row", () => {
    expect(resolveAttentionTier({})).toBe(ATTENTION_TIER_IDLE);
    expect(ATTENTION_TIER_IDLE).toBe(6);
  });
});

describe("resolveAttentionTier - first match wins, lowest tier ranks highest", () => {
  /*
  Adjacent pairs only, because a non-adjacent skip is implied by the adjacent ones and a table that
  repeats it hides which edge actually broke. The pairs run down the ladder: 0>1, 1>2, 2>3, 3>4, 4>5.
  */
  const precedencePairs: ReadonlyArray<{ label: string; winner: AttentionTask; loser: AttentionTask; expected: number }> = [
    {
      label: "tier 0 outranks tier 1",
      winner: { status: "failed" },
      loser: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [] },
      expected: 0,
    },
    {
      label: "tier 1 outranks tier 2",
      winner: { enabledWorkflowSteps: ["code-review"], workflowStepResults: [], awaitingApprovalReason: "human-plan-approval" },
      loser: { awaitingApprovalReason: "human-plan-approval" },
      expected: 1,
    },
    {
      label: "tier 2 outranks tier 3",
      winner: { awaitingApprovalReason: "merge-blocked-by-policy", stallReason: { code: "merge-blocker" } },
      loser: { stallReason: { code: "merge-blocker" } },
      expected: 2,
    },
    {
      label: "tier 3 outranks tier 4",
      winner: { stallReason: { code: "merge-blocker" }, pausedReason: "in-review-stall-deadlock" },
      loser: { pausedReason: "in-review-stall-deadlock" },
      expected: 3,
    },
    {
      label: "tier 4 outranks tier 5",
      winner: { pausedReason: "branch-conflict-unrecoverable", dependencies: ["FN-001"] },
      loser: { dependencies: ["FN-001"] },
      expected: 4,
    },
    {
      label: "tier 5 outranks tier 6",
      winner: { blockedBy: "FN-001" },
      loser: {},
      expected: 5,
    },
  ];

  for (const pair of precedencePairs) {
    it(`${pair.label} even when the lower tier also matches`, () => {
      expect(resolveAttentionTier(pair.winner, { reviewScope: true })).toBe(pair.expected);
    });
  }

  it("stacks every signal at once and still reports tier 0", () => {
    expect(
      resolveAttentionTier(
        {
          error: "boom",
          status: "failed",
          enabledWorkflowSteps: ["code-review"],
          workflowStepResults: [],
          awaitingApprovalReason: "human-plan-approval",
          stallReason: { code: "merge-blocker" },
          pausedReason: "in-review-stall-deadlock",
          dependencies: ["FN-001"],
        },
        { reviewScope: true },
      ),
    ).toBe(0);
  });
});

describe("resolveAttentionTier - absent, empty, null and whitespace-only text all stay idle", () => {
  /*
  The shape that makes this worth a suite: `error: ""` and `pausedReason: "  "` are persisted values
  that mean nothing, and a ladder that treats them as signals would float 200 idle cards to the top
  on a board whose writer defaults them to empty strings. Each field is checked in all four states.
  */
  const textFields = ["error", "awaitingApprovalReason", "pausedReason", "blockedBy", "overlapBlockedBy"] as const;

  for (const field of textFields) {
    it(`${field}: absent, null, empty and whitespace all match nothing`, () => {
      for (const value of [undefined, null, "", "   ", "\t\n"] as const) {
        expect(resolveAttentionTier({ [field]: value } as AttentionTask, { reviewScope: true }), `${field}=${JSON.stringify(value)}`).toBe(
          ATTENTION_TIER_IDLE,
        );
      }
    });

    it(`${field}: one real character is a signal`, () => {
      expect(resolveAttentionTier({ [field]: "x" } as AttentionTask, { reviewScope: true })).toBeLessThan(ATTENTION_TIER_IDLE);
    });
  }
});

describe("resolveAttentionTier - human approval counts only while armed and undecided", () => {
  it("ranks an armed plan lock with no decision at tier 2", () => {
    expect(resolveAttentionTier({ humanPlanApproval: { enabled: true, generation: 3 } } as AttentionTask)).toBe(2);
  });

  it("stops ranking a plan lock the operator already answered", () => {
    expect(
      resolveAttentionTier({
        humanPlanApproval: {
          enabled: true,
          generation: 3,
          decision: { decidedBy: "operator", decidedAt: "2026-11-13T00:00:00.000Z" },
        },
      } as AttentionTask),
    ).toBe(ATTENTION_TIER_IDLE);
  });

  it("ignores a plan lock that was never armed", () => {
    expect(resolveAttentionTier({ humanPlanApproval: { enabled: false, generation: 1 } } as AttentionTask)).toBe(ATTENTION_TIER_IDLE);
    expect(resolveAttentionTier({ humanPlanApproval: {} } as AttentionTask)).toBe(ATTENTION_TIER_IDLE);
  });

  it("treats an armed merge lock the same way, armed or answered", () => {
    expect(resolveAttentionTier({ humanMergeApproval: { enabled: true, generation: 1 } } as AttentionTask)).toBe(2);
    expect(
      resolveAttentionTier({ humanMergeApproval: { enabled: true, generation: 1, decision: { decidedBy: "operator" } } } as AttentionTask),
    ).toBe(ATTENTION_TIER_IDLE);
  });
});

describe("resolveAttentionTier - priority is not an input", () => {
  /*
  FN-509 deleted `priority` from the model, so this asserts the DELETION rather than a rule: a row
  that still carries a leftover `priority` value (an old feed, a stale mirror) must tier exactly like
  the same row without it. If a future change reintroduces priority as a ranking input, this breaks.
  */
  const BASE: AttentionTask = { status: "queued" };

  it("leaves an idle row idle no matter what priority claims", () => {
    for (const priority of [-10, 0, 1, 5, 99]) {
      expect(resolveAttentionTier({ ...BASE, priority } as AttentionTask, { reviewScope: true })).toBe(ATTENTION_TIER_IDLE);
    }
  });

  it("does not let priority outrank a real signal", () => {
    const failing = { status: "failed" } as AttentionTask;
    expect(resolveAttentionTier({ ...failing, priority: 0 } as AttentionTask)).toBe(0);
    expect(resolveAttentionTier({ ...failing, priority: 99 } as AttentionTask)).toBe(0);
  });
});

describe("resolveAttentionTier - the review-scope gate removes tier 1 and tier 3 only", () => {
  it("drops the step-array arm and the derived stall signals when the gate is off", () => {
    const gated: AttentionTask = {
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [],
      stallReason: { code: "merge-blocker" },
      inReviewStall: { code: "merge-blocker", reason: "Merge blocked", observedAt: "2026-11-13T00:00:00.000Z" },
    };
    expect(resolveAttentionTier(gated, { reviewScope: true })).toBe(1);
    expect(resolveAttentionTier(gated, { reviewScope: false })).toBe(ATTENTION_TIER_IDLE);
  });

  it("defaults to OFF so a caller that forgets the option cannot pay the step-array cost", () => {
    const gateOnly: AttentionTask = { enabledWorkflowSteps: ["code-review"], workflowStepResults: [] };
    expect(resolveAttentionTier(gateOnly)).toBe(ATTENTION_TIER_IDLE);
  });

  it("keeps every durable tier identical across the gate", () => {
    for (const durableOnly of [
      { error: "boom" },
      { awaitingApprovalReason: "human-plan-approval" },
      { pausedReason: "branch-conflict-unrecoverable" },
      { dependencies: ["FN-001"] },
      {},
    ] satisfies AttentionTask[]) {
      expect(resolveAttentionTier(durableOnly, { reviewScope: true })).toBe(resolveAttentionTier(durableOnly, { reviewScope: false }));
    }
  });
});
