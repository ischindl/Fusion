import { describe, expect, it } from "vitest";
import type { Task, WorkflowStepResult } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import {
  deriveReviewBypassTarget,
  isOperatorPausedForReviewBypass,
  resolveReviewBypassLanes,
  type ReviewBypassTaskView,
} from "../merge/review-bypass-target.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";

/*
FNXC:ReviewLaneBypass 2026-09-03-10:07 (RUFU-179):
Direct unit coverage for the ONE answer shared by `store.bypassFailedPreMergeReviewStep` and the
read-path hydration that feeds the dashboard's bypass affordance. Every branch of the semantics
list is asserted as a direct call on the production function — no store, no mocks — because the
whole point of the seam is that it is pure.

The reported bug (SANE-387) is the `kind:"absent"` row: the client predicate that used to gate the
menu asked only `status === "failed"`, so this fixture rendered no affordance while the store
accepted the bypass. The `kind:"failed"`-only regression case below is the shape of the deleted
predicate, pinned so a future edit cannot quietly narrow the affordance back to it.
*/

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
const NO_REQUIRED = new Set<string>();

describe("deriveReviewBypassTarget", () => {
  it("names an enabled required gate that never produced a result as the absent target", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({ workflowStepResults: [] }),
      new Set<string>(["plan-review"]),
      REVIEW,
    );
    expect(target).toEqual({ kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" });
  });

  it("survives a task with no workflowStepResults array at all (zero-result card)", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({ workflowStepResults: undefined }),
      new Set<string>(["plan-review"]),
      REVIEW,
    );
    expect(target?.kind).toBe("absent");
    expect(target?.workflowStepId).toBe("plan-review");
  });

  it("still answers absent for a card whose other gates all terminated", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({
        workflowStepResults: [
          step({ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed" }),
        ],
      }),
      new Set<string>(["plan-review", "code-review"]),
      REVIEW,
    );
    expect(target).toEqual({ kind: "absent", workflowStepId: "code-review", workflowStepName: "code-review" });
  });

  it("reports the latest failed pre-merge result as the failed target (the deleted client predicate's only case)", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({
        workflowStepResults: [
          step({ completedAt: "2026-09-01T00:00:00.000Z" }),
          step({ workflowStepId: "browser-verification", workflowStepName: "Browser Verification", completedAt: "2026-09-03T00:00:00.000Z" }),
        ],
      }),
      NO_REQUIRED,
      REVIEW,
    );
    expect(target).toEqual({ kind: "failed", workflowStepId: "browser-verification", workflowStepName: "Browser Verification" });
  });

  it("lets a failed result WIN over an unrun gate, so one bypass never consumes two decisions", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({
        workflowStepResults: [step({ status: "failed" })],
        enabledWorkflowSteps: ["plan-review"],
      }),
      new Set<string>(["plan-review"]),
      REVIEW,
    );
    expect(target).toEqual({ kind: "failed", workflowStepId: "code-review", workflowStepName: "Code Review" });
  });

  it("treats a pending result as PRESENT, so a gate that is running is never offered for skipping", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({
        workflowStepResults: [step({ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending" })],
      }),
      new Set<string>(["plan-review"]),
      REVIEW,
    );
    expect(target).toBeUndefined();
  });

  it("answers nothing when no gate is required (fast lane / no enabled gates)", () => {
    expect(deriveReviewBypassTarget(reviewTask(), NO_REQUIRED, REVIEW)).toBeUndefined();
  });

  it("answers nothing once every required gate has a terminal result (already recovered)", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({ workflowStepResults: [step({ workflowStepId: "plan-review", status: "passed", workflowStepName: "Plan Review" })] }),
      new Set<string>(["plan-review"]),
      REVIEW,
    );
    expect(target).toBeUndefined();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  THE PAUSE MATRIX, TABLE-DRIVEN. Only an operator hold — `paused` AND `userPaused` — removes the
  capability; an engine-originated park keeps it. Table-driving BOTH target kinds is the point: the
  park this task was filed for carries an unrun gate (`absent`), and an `absent`-only matrix would
  leave a future edit free to re-add a bare-`paused` early return above the failed-target branch and
  still pass — the exact shape the pre-fix code had.

  The stale assertion this replaced read "answers nothing for a paused card, mirroring the store's
  paused refusal" and pinned `{ paused: true }` alone to suppression. That was the defect, not the
  contract: `pauseTask(id, true)` — the route the engine's stall-deadlock, retry-exhausted, and
  merge-fix parks all use — writes exactly that shape, so the assertion was enforcing the very
  confiscation of the operator's lever that made a wedged card unrecoverable from the GUI.
  */
  const PAUSE_SHAPES = [
    {
      name: "operator hold (paused + userPaused)",
      task: { paused: true, userPaused: true },
      withheld: true,
    },
    { name: "engine park (paused, userPaused unset)", task: { paused: true }, withheld: false },
    { name: "engine park (paused, userPaused false)", task: { paused: true, userPaused: false }, withheld: false },
    /* `userPaused` is typed `boolean | undefined`, but the predicate compares against `true` so a
       raw-row `null` that bypassed serialization is still not a hold. Pinned, not assumed. */
    { name: "engine park (paused, userPaused null)", task: { paused: true, userPaused: null }, withheld: false },
    /*
    WHY EVERY ENGINE PARK REASON IS ENUMERATED HERE. `pausedReason` is deliberately NOT consulted,
    and an allowlist keyed on it would re-create the defect for whichever sink was left off the list:
    the stall router's `in-review-stall-deadlock` (the live RUFU-204 card), the merge-fix park's
    `merge-deadlock-detected`, the contamination sweep's `branch-conflict-unrecoverable`, and
    triage's `duplicate-decision-required` all park WITHOUT `userPaused`, and the graph-failure and
    mission-autopilot sinks park BARE with no reason at all (covered by the unset row above). A
    reason-keyed gate would hide the hatch from exactly the cards the hatch exists for.

    The honest-blocked exit's `external-block` freeze is enumerated as the second NAMED park class so it
    is ASSERTED rather than silently defaulted by the predicate: `buildTaskExternalBlockPatch`
    (`tasks/task-external-block.ts`) parks `paused: true` + `pausedReason: "external-block"` +
    `status: "blocked"` with no `userPaused`, and its own FNXC note rules the freeze "operator-recoverable
    lifecycle state rather than an operator-authored pause" — so offering the hatch there is that note's
    answer, not an accident. Safety is not conceded: `status: "blocked"` is NOT a `BLOCKING_TASK_STATUSES`
    member, so the freeze holds the merge door through the same `paused` condition every other engine park
    uses, and that condition survives the bypass — the card stays parked and unmerged until the operator
    clears the block or retries it.
    */
    {
      name: "engine park with a stall-deadlock reason",
      task: { paused: true, pausedReason: "in-review-stall-deadlock" },
      withheld: false,
    },
    {
      name: "engine park with a merge-deadlock reason",
      task: { paused: true, pausedReason: "merge-deadlock-detected" },
      withheld: false,
    },
    {
      name: "engine park with an unrecoverable-branch-conflict reason",
      task: { paused: true, pausedReason: "branch-conflict-unrecoverable" },
      withheld: false,
    },
    {
      name: "engine park with a duplicate-decision reason",
      task: { paused: true, pausedReason: "duplicate-decision-required" },
      withheld: false,
    },
    {
      name: "outside-worktree external-block freeze (paused + status blocked, no userPaused)",
      task: { paused: true, pausedReason: "external-block" },
      withheld: false,
    },
  ];

  /** A card whose ONLY wedge is an unrun required gate → the `absent` target. */
  const unrunCard = (pause: Record<string, unknown>) =>
    reviewTask({ paused: false, workflowStepResults: [], ...pause } as Partial<Task>);
  /** A card whose wedge is a failed Code Review (no required gate needed) → the `failed` target. */
  const failedCard = (pause: Record<string, unknown>) =>
    reviewTask({ paused: false, workflowStepResults: [step({ status: "failed" })], ...pause } as Partial<Task>);
  const UNRUN_REQUIRED = new Set<string>(["plan-review"]);

  for (const shape of PAUSE_SHAPES) {
    it(`${shape.withheld ? "withholds" : "offers"} BOTH bypass kinds on ${shape.name}`, () => {
      for (const [kind, task, required] of [
        ["absent", unrunCard(shape.task), UNRUN_REQUIRED],
        ["failed", failedCard(shape.task), NO_REQUIRED],
      ] as const) {
        const target = deriveReviewBypassTarget(task, required, REVIEW);
        if (shape.withheld) {
          expect(target, `${kind} target on ${shape.name}`).toBeUndefined();
        } else {
          expect(target?.kind, `${kind} target on ${shape.name}`).toBe(kind);
        }
      }
    });
  }

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  The predicate's own truth table, asserted directly so a caller-level green run cannot hide a
  widened test (e.g. `paused || userPaused`, which would refuse an operator-unpaused-but-stale-flag
  card the store would happily accept) behind four passing derivation cases.
  */
  it("isOperatorPausedForReviewBypass is true only for the operator hold", () => {
    expect(isOperatorPausedForReviewBypass({ paused: true, userPaused: true })).toBe(true);
    expect(isOperatorPausedForReviewBypass({ paused: true, userPaused: false })).toBe(false);
    expect(isOperatorPausedForReviewBypass({ paused: true })).toBe(false);
    expect(isOperatorPausedForReviewBypass({ paused: false, userPaused: true })).toBe(false);
    expect(isOperatorPausedForReviewBypass({ paused: false })).toBe(false);
    expect(isOperatorPausedForReviewBypass({})).toBe(false);
    /* A reason never turns a park into a hold, and never turns a hold into a park. */
    expect(isOperatorPausedForReviewBypass({ paused: true, pausedReason: "in-review-stall-deadlock" })).toBe(false);
    expect(
      isOperatorPausedForReviewBypass({ paused: true, userPaused: true, pausedReason: "merge-deadlock-detected" }),
    ).toBe(true);
  });

  it("answers nothing for an unpaused card whose paused flag is merely absent", () => {
    const task = { column: "in-review", workflowStepResults: [] } as ReviewBypassTaskView;
    expect(deriveReviewBypassTarget(task, new Set<string>(["plan-review"]), REVIEW)?.kind).toBe("absent");
  });

  it("answers nothing outside the review lanes, including the merge queue and a done card", () => {
    for (const column of ["todo", "in-progress", "done", "archived"]) {
      expect(deriveReviewBypassTarget(reviewTask({ column }), new Set<string>(["plan-review"]), REVIEW)).toBeUndefined();
    }
  });

  it("honours a renamed review lane when the caller resolves that lane set", () => {
    const lanes = new Set<string>(["signoff"]);
    const target = deriveReviewBypassTarget(
      reviewTask({ column: "signoff", workflowStepResults: [] }),
      new Set<string>(["plan-review"]),
      lanes,
    );
    expect(target?.kind).toBe("absent");
    // …and the legacy id is NOT bypassable on such a board, which is why the store's exact set is
    // threaded instead of the diagnostic's broader always-unioned-with-in-review answer.
    expect(deriveReviewBypassTarget(reviewTask({ column: "in-review" }), new Set<string>(["plan-review"]), lanes)).toBeUndefined();
  });

  it("ignores failed POST-merge steps — they do not block merge and are not bypassable", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({ workflowStepResults: [step({ phase: "post-merge" })] }),
      NO_REQUIRED,
      REVIEW,
    );
    expect(target).toBeUndefined();
  });

  it("picks the first required gate in resolution order when several never ran", () => {
    const target = deriveReviewBypassTarget(
      reviewTask({ workflowStepResults: [] }),
      new Set<string>(["plan-review", "code-review", "browser-verification"]),
      REVIEW,
    );
    expect(target?.workflowStepId).toBe("plan-review");
  });

  it("is deterministic: repeated calls on the same row produce the identical target", () => {
    const task = reviewTask({ workflowStepResults: [] });
    const required = new Set<string>(["plan-review"]);
    expect(deriveReviewBypassTarget(task, required, REVIEW)).toEqual(deriveReviewBypassTarget(task, required, REVIEW));
  });
});

describe("resolveReviewBypassLanes", () => {
  function irWithColumns(columns: WorkflowIr["columns"]): WorkflowIr {
    return {
      version: "v2",
      name: "lane-probe",
      columns,
      nodes: [
        { id: "start", kind: "start", column: columns[0]!.id },
        { id: "end", kind: "end", column: columns[columns.length - 1]!.id },
      ],
      edges: [{ from: "start", to: "end" }],
    } as unknown as WorkflowIr;
  }

  const lifecycleColumns = [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ];

  it("falls back to the legacy in-review id when no IR is resolvable", () => {
    expect(resolveReviewBypassLanes(undefined)).toEqual(["in-review"]);
  });

  /*
  The v1-upgrade shape `synthesizeDefaultColumns` emits: every default column with an EMPTY traits
  array. Such a board resolves cleanly and answers empty for every role while its `in-review` column
  plainly exists, so `declaresAnyLifecycleTrait` is what keeps the legacy vocabulary instead of
  concluding the role is absent.
  */
  it("falls back to the legacy in-review id for a trait-less board (the v1-upgrade shape)", () => {
    expect(resolveReviewBypassLanes(irWithColumns([
      { id: "todo", name: "Todo", traits: [] },
      { id: "in-review", name: "Review", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ]) as WorkflowIr)).toEqual(["in-review"]);
  });

  it("names the board's own review lane for a lifecycle board, WITHOUT unioning the legacy id in", () => {
    expect(resolveReviewBypassLanes(irWithColumns(lifecycleColumns))).toEqual(["signoff"]);
  });

  it("admits every review role's lane on a board that splits them", () => {
    expect(resolveReviewBypassLanes(irWithColumns([
      ...lifecycleColumns.slice(0, 2),
      { id: "merging", name: "Merging", traits: [{ trait: "merge" }] },
      { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ]) as WorkflowIr).sort()).toEqual(["merging", "signoff"]);
  });
});

describe("required-gate resolution feeds the same derivation", () => {
  /*
  Guards the composition rather than the resolver: the derivation's absent case is only as correct
  as the required set the caller resolved. A fast-lane card resolves an EMPTY required set, so the
  derivation must answer nothing — otherwise the menu would offer to skip a gate Fast deliberately
  never dispatches.
  */
  const ir = {
    version: "v2",
    name: "gate-probe",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "Review", traits: [{ trait: "human-review" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "backlog" },
      { id: "plan", kind: "prompt", column: "backlog", config: { seam: "planning" } },
      { id: "execute", kind: "prompt", column: "building", config: { seam: "execute" } },
      { id: "code-review", kind: "optional-group", column: "in-review", config: { name: "Code Review", defaultOn: true } },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "execute" },
      { from: "execute", to: "code-review" },
      { from: "code-review", to: "end" },
    ],
  } as unknown as WorkflowIr;

  it("produces no target for a fast-lane card whose required set resolved empty", () => {
    const fastTask = {
      column: "in-review",
      paused: false,
      workflowStepResults: [],
      executionMode: "fast",
    } as unknown as Task;
    const required = resolveRequiredPreMergeStepIds(ir, undefined, fastTask);
    expect(required.size).toBe(0);
    expect(deriveReviewBypassTarget(fastTask, required, new Set(["in-review"]))).toBeUndefined();

    /*
    Non-vacuous control: the SAME IR on a standard card must resolve a non-empty required set and
    answer `absent`. Without this line the assertion above would pass for an IR that simply declares
    no gates, and would stop guarding the fast-lane route the moment the fixture drifted.
    */
    const standardTask = { ...fastTask, executionMode: undefined } as unknown as Task;
    const standardRequired = resolveRequiredPreMergeStepIds(ir, undefined, standardTask);
    expect([...standardRequired]).toEqual(["code-review"]);
    expect(deriveReviewBypassTarget(standardTask, standardRequired, new Set(["in-review"]))?.kind).toBe("absent");
  });
});
