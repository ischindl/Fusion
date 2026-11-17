/*
FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583, folded from RUFU-243):
EVERY REFUSAL IS ASSERTED BY NAME, ONE CASE PER CLASS, NOT AS A SET DIFFERENCE.

The defect this file keeps dead is a refusal that arrives at the operator as silence. Measured on
RUFU-583: a card held by hand in the review lane rendered no bypass row on either Actions surface and
no sentence on the detail modal, while `POST /tasks/:id/bypass-review` answered `task is paused`. Three
surfaces agreed on nothing, and only the API knew a class had refused. The fix is not a new decision —
`review-bypass-target.test.ts` (50 assertions) pins that the decision tree itself did not move — the fix
is that each of the tree's four `return undefined` exits now carries a name a surface can render.

Two assertions here are load-bearing beyond coverage:
 - the deliberate non-distinctions (`no-refusing-gate` covers the fast lane and the no-gates board;
   `not-in-review-lane` does not claim to know which human-owned lane the card sits in), because an
   invented distinction is a fabricated diagnosis and reads as a real finding; and
 - the exhaustiveness pass, so a sixth reason cannot be added to the union without a case here.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task, WorkflowStepResult } from "../types.js";
import {
  deriveReviewBypassDecision,
  deriveReviewBypassTarget,
  type ReviewBypassDeclineReason,
  type ReviewBypassTaskView,
} from "../merge/review-bypass-target.js";

function step(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "failed",
    completedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function reviewTask(overrides: Partial<Task> = {}): ReviewBypassTaskView {
  return {
    column: "in-review",
    paused: false,
    workflowStepResults: [],
    ...overrides,
  } as ReviewBypassTaskView;
}

const REVIEW = new Set<string>(["in-review"]);
const REQUIRED_CODE_REVIEW = new Set<string>(["code-review"]);

/** The closed refusal vocabulary, asserted against the union rather than a copy kept in this file. */
const ALL_REASONS: ReviewBypassDeclineReason[] = [
  "operator-task-hold",
  "not-in-review-lane",
  "no-refusing-gate",
  "post-merge-review-not-owed",
  "workspace-scope-withheld",
  "workflow-ir-unreadable",
];

function declineOf(task: ReviewBypassTaskView, opts?: {
  required?: ReadonlySet<string>;
  lanes?: ReadonlySet<string>;
  requiredPostMerge?: ReadonlySet<string>;
}): Extract<ReturnType<typeof deriveReviewBypassDecision>, { kind: "declined" }>["decline"] | undefined {
  const decision = deriveReviewBypassDecision(
    task,
    opts?.required ?? new Set<string>(),
    opts?.lanes ?? REVIEW,
    opts?.requiredPostMerge ?? new Set<string>(),
  );
  return decision.kind === "declined" ? decision.decline : undefined;
}

describe("deriveReviewBypassDecision decline classes (RUFU-583)", () => {
  it("names the operator hold, and does not confuse it with an engine park", () => {
    const held = reviewTask({ paused: true, userPaused: true } as Partial<Task>);
    expect(declineOf(held)).toEqual({ reason: "operator-task-hold" });

    // The same card with the engine's own park keeps the offer, so the two states stay separate classes.
    const parked = reviewTask({
      paused: true,
      workflowStepResults: [step()],
    } as Partial<Task>);
    const parkedDecision = deriveReviewBypassDecision(parked, REQUIRED_CODE_REVIEW, REVIEW);
    expect(parkedDecision.kind).toBe("offered");
  });

  it("names the lane the card is standing in as the reason when the bypass is not admitted there", () => {
    const decision = deriveReviewBypassDecision(
      reviewTask({ column: "todo" }),
      REQUIRED_CODE_REVIEW,
      REVIEW,
    );
    expect(decision).toEqual({ kind: "declined", decline: { reason: "not-in-review-lane" } });
  });

  it("names no-refusing-gate when the lane admits the bypass and nothing is refusing", () => {
    const decision = deriveReviewBypassDecision(
      reviewTask({ workflowStepResults: [step({ status: "passed", verdict: "APPROVE" })] }),
      REQUIRED_CODE_REVIEW,
      REVIEW,
    );
    expect(decision).toEqual({ kind: "declined", decline: { reason: "no-refusing-gate" } });
  });

  it("does NOT distinguish the fast lane or the no-gates board from no-refusing-gate", () => {
    /*
    Three operator situations, one class, asserted rather than incidental: a card whose gates all
    passed, a fast-lane card, and a board whose resolved required set is empty all answer
    `no-refusing-gate`. Splitting them would require the derivation to know WHY the set is empty, which
    it cannot from its inputs — and a reason invented here would be rendered to an operator as a fact.
    */
    const allPassed = declineOf(
      reviewTask({ workflowStepResults: [step({ status: "passed", verdict: "APPROVE" })] }),
      { required: REQUIRED_CODE_REVIEW },
    );
    const fastLane = declineOf(reviewTask(), { required: new Set<string>() });
    const noGatesBoard = declineOf(reviewTask(), { required: new Set<string>() });

    expect(allPassed?.reason).toBe("no-refusing-gate");
    expect(fastLane?.reason).toBe("no-refusing-gate");
    expect(noGatesBoard?.reason).toBe("no-refusing-gate");
    expect(allPassed?.workflowStepId).toBeUndefined();
  });

  it("names the post-merge gate whose evidence is not owed yet, and points at that gate", () => {
    const decision = deriveReviewBypassDecision(
      reviewTask({ workflowStepResults: [step({ status: "passed", verdict: "APPROVE" })] }),
      REQUIRED_CODE_REVIEW,
      REVIEW,
      new Set<string>(["post-merge-verification"]),
    );
    expect(decision).toEqual({
      kind: "declined",
      decline: { reason: "post-merge-review-not-owed", workflowStepId: "post-merge-verification" },
    });
  });

  it("names the workspace scope that withholds a verdictless carrier, pointing at the withheld gate", () => {
    const decision = deriveReviewBypassDecision(
      reviewTask({
        workspaceWorktrees: [{ repoPath: "packages/a", branch: "fusion/rufu-583" }],
        workflowStepResults: [step({ status: "skipped", verdict: undefined })],
      } as Partial<Task>),
      REQUIRED_CODE_REVIEW,
      REVIEW,
    );
    expect(decision).toEqual({
      kind: "declined",
      decline: { reason: "workspace-scope-withheld", workflowStepId: "code-review" },
    });
  });

  it("still OFFERS the unrun gate to a workspace card, so the withheld class does not swallow it", () => {
    // One gate owes a verdict (withheld by scope), a different one never ran (still offered).
    const decision = deriveReviewBypassDecision(
      reviewTask({
        workspaceWorktrees: [{ repoPath: "packages/a", branch: "fusion/rufu-583" }],
        workflowStepResults: [step({ workflowStepId: "code-review", status: "skipped", verdict: undefined })],
      } as Partial<Task>),
      new Set<string>(["code-review", "plan-review"]),
      REVIEW,
    );
    expect(decision).toEqual({
      kind: "offered",
      target: { kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" },
    });
  });

  it("never yields a gate to bypass on a declined decision, for any reason", () => {
    const declinedTasks: Array<ReviewBypassTaskView> = [
      reviewTask({ paused: true, userPaused: true } as Partial<Task>),
      reviewTask({ column: "todo" }),
      reviewTask({ workflowStepResults: [step({ status: "passed", verdict: "APPROVE" })] }),
      reviewTask({
        workspaceWorktrees: [{ repoPath: "packages/a", branch: "fusion/rufu-583" }],
        workflowStepResults: [step({ status: "skipped", verdict: undefined })],
      } as Partial<Task>),
    ];
    for (const task of declinedTasks) {
      const decision = deriveReviewBypassDecision(task, REQUIRED_CODE_REVIEW, REVIEW);
      expect(decision.kind).toBe("declined");
      expect((decision as { target?: unknown }).target).toBeUndefined();
      // The projection consumers depend on: a declined decision is the `undefined` they already handle.
      expect(deriveReviewBypassTarget(task, REQUIRED_CODE_REVIEW, REVIEW)).toBeUndefined();
    }
  });

  it("covers the whole union, so a sixth reason cannot ship without a case here", () => {
    const produced: ReviewBypassDeclineReason[] = [];
    const producers: Array<() => void> = [
      () => { const d = declineOf(reviewTask({ paused: true, userPaused: true } as Partial<Task>)); if (d) produced.push(d.reason); },
      () => { const d = declineOf(reviewTask({ column: "todo" }), { required: REQUIRED_CODE_REVIEW }); if (d) produced.push(d.reason); },
      () => { const d = declineOf(reviewTask(), { required: new Set<string>() }); if (d) produced.push(d.reason); },
      () => { const d = declineOf(reviewTask({ workflowStepResults: [step({ status: "passed", verdict: "APPROVE" })] }), { required: REQUIRED_CODE_REVIEW, requiredPostMerge: new Set<string>(["g-post"]) }); if (d) produced.push(d.reason); },
      () => {
        const d = declineOf(
          reviewTask({
            workspaceWorktrees: [{ repoPath: "packages/a", branch: "fusion/rufu-583" }],
            workflowStepResults: [step({ status: "skipped", verdict: undefined })],
          } as Partial<Task>),
          { required: REQUIRED_CODE_REVIEW },
        );
        if (d) produced.push(d.reason);
      },
    ];
    for (const produce of producers) produce();

    // Authored by the hydration seam rather than the pure derivation, which has no IR to fail on.
    produced.push("workflow-ir-unreadable");

    // Every declared reason has a producer, and no producer names a reason the union does not declare.
    expect([...new Set(produced)].sort()).toEqual([...ALL_REASONS].sort());

    // The type-level exhaustiveness pass: a new member makes this callback's switch non-exhaustive.
    const sentenceShape = (reason: ReviewBypassDeclineReason): string => {
      switch (reason) {
        case "operator-task-hold":
        case "not-in-review-lane":
        case "no-refusing-gate":
        case "post-merge-review-not-owed":
        case "workspace-scope-withheld":
        case "workflow-ir-unreadable":
          return "named";
      }
    };
    for (const reason of ALL_REASONS) expect(sentenceShape(reason)).toBe("named");
  });
});

/*
FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583):
`workflow-ir-unreadable` is the one class the pure derivation cannot produce — it has no workflow IR to
fail on, only a caller does. Its producer is `resolveReviewBypassForTask` in `task-store/reads.ts`, whose
`catch` used to answer the SAME `undefined` a fully-approved card answers, laundering "this board cannot
read the workflow" into "nothing is refusing". A code-construct scan is the honest seam here: it asserts
the literal the hydration writes and the diagnostic it writes alongside it, both of which are code, not
prose, and neither of which any behaviour test can reach without a fifth store harness (the same reason
`reads-retry-refusal-hydration.test.ts` scans this file's hydration multiplicity).
*/
describe("the hydration seam authors workflow-ir-unreadable (RUFU-583)", () => {
  const readsSource = readFileSync(resolve(__dirname, "../task-store/reads.ts"), "utf8");
  const helperBody = readsSource.slice(
    readsSource.indexOf("async function resolveReviewBypassForTask"),
    readsSource.indexOf("function applyReviewBypassDecision"),
  );

  it("answers the unreadable-IR arm with its own reason instead of the shared undefined", () => {
    expect(helperBody).toContain('reason: "workflow-ir-unreadable"');
    // Distinguishable from the class it used to hide inside: two different literals in the same helper.
    expect(helperBody).toContain('reason: "not-in-review-lane"');
    expect(helperBody).not.toContain("} catch {\n    return undefined;\n  }");
  });

  it("records the refusal at the hydration seam, ids only", () => {
    expect(helperBody).toMatch(/storeLog\.warn\([\s\S]*taskId: task\.id/);
    // The thrown sentence never enters the record: the catch binds no error to interpolate.
    expect(helperBody).not.toMatch(/catch \(error\)[\s\S]*error\.message/);
  });

  it("ships the decline through one apply seam so no read path can attach half the answer", () => {
    const applySiteCount = (readsSource.match(/applyReviewBypassDecision\(task, /g) ?? []).length;
    expect(applySiteCount).toBeGreaterThanOrEqual(4);
  });
});
