/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
A required post-merge gate drawn INSIDE the complete column made graph node entry the mover that
completed the card: `onNodeEntry` writes the node's column under `bypassGuards: true`, so the store's
complete-boundary checks were skipped for every engine-sourced graph move, and the verdict did not
exist yet when the write happened. Measured 2026-09-27 across every `.fusion/tasks` task.json: 14 cards in
`done` carrying a `failed` `post-merge-verification` row (mostly `verdict: REVISE`) plus 7 more in
`done` with the gate enabled and ZERO result rows — 21 of the 23 default-workflow cards that enabled
it. The hole concealed itself: once the card stands in the complete lane the finalizer's evidence
fences short-circuit, and a re-seed cannot reach it because re-dispatch stops short of that lane.

The invariant these tests pin:

1. forward node entry into a complete-trait column is REFUSED — no move is attempted, the boundary's
   own column belief does not advance, and the refusal is auditable with a fixed code;
2. the node still RUNS IN PLACE (`kind: "entered"`), so the gate's verdict goes durable and the
   sanctioned doorkeeper can perform the crossing afterwards — a refusal that stalls the card is a
   second defect, not a fix;
3. `end` is exempt by construction (KTD-1 already forbids it from being a move destination), and
   lateral/backward crossings are NOT this invariant's business, so nothing here widens the refusal
   beyond the one crossing that was illegal;
4. an ordinary forward crossing into a non-complete column still moves and still emits
   `task:column-transition` — the refusal must not become a blanket refusal to move;
5. when the store's gate-evidence guard refuses the node-entry move (the Step 2 arm, which applies
   even under guard bypass), the boundary CONTAINS it. Rethrowing would terminalize the run `failed`
   over an unapproved gate; emitting `task:column-transition` would audit a move that never happened.
*/
import { describe, expect, it, vi } from "vitest";
import {
  CompleteColumnGateEvidenceRejectionError,
  makeTransitionRejection,
  type WorkflowIr,
  type WorkflowIrNode,
} from "@fusion/core";
import {
  COMPLETE_COLUMN_NODE_ENTRY_REFUSAL,
  createWorkflowColumnBoundary,
  isForwardNodeEntryIntoCompleteColumn,
} from "../workflows/workflow-column-boundary.js";

/** wip -> review -> complete, the shape every built-in draws. */
function threeLaneIr(): WorkflowIr {
  return {
    version: "v2",
    name: "complete-lane-probe",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [],
    edges: [],
  } as unknown as WorkflowIr;
}

function node(id: string, column: string, kind: WorkflowIrNode["kind"] = "prompt"): WorkflowIrNode {
  return { id, kind, column, config: {} } as unknown as WorkflowIrNode;
}

function boundary(opts: {
  initialColumn: string;
  moveTask?: ReturnType<typeof vi.fn>;
  audit?: ReturnType<typeof vi.fn>;
}) {
  const audits: unknown[] = [];
  const b = createWorkflowColumnBoundary({
    taskId: "RUFU-349",
    workflowId: "custom:probe",
    ir: threeLaneIr(),
    initialColumn: opts.initialColumn,
    ...(opts.moveTask ? { moveTask: opts.moveTask } : {}),
    emitAudit: async (event) => {
      audits.push(event);
      await opts.audit?.(event);
    },
  });
  return { b, audits };
}

describe("forward node entry may not move a card into the complete lane (RUFU-349)", () => {
  it("refuses the crossing without attempting a move, and records the refusal", async () => {
    const moveTask = vi.fn(async () => {});
    const { b, audits } = boundary({ initialColumn: "in-review", moveTask });

    const result = await b.onNodeEntry(node("post-merge-verification", "done"));

    expect(result).toEqual({ kind: "entered" });
    expect(moveTask).not.toHaveBeenCalled();
    // The boundary's own column belief must stay honest: it never crossed.
    expect(b.currentColumn()).toBe("in-review");

    const refusal = audits.find((event) => (event as { type: string }).type === "task:column-entry-refused-complete-column");
    expect(refusal).toMatchObject({
      taskId: "RUFU-349",
      nodeId: "post-merge-verification",
      fromColumn: "in-review",
      toColumn: "done",
      code: COMPLETE_COLUMN_NODE_ENTRY_REFUSAL,
    });
    // No completed-transition row for a move that never happened.
    expect(audits.some((event) => (event as { type: string }).type === "task:column-transition")).toBe(false);
  });

  it("keeps the node runnable in place so its verdict can still go durable", async () => {
    // `entered` (not `suspended`) is the load-bearing part: a suspended disposition writes a durable
    // continuation and ends the run, which would leave the post-merge gate un-run — the very failure
    // mode being repaired, one step further along.
    const { b } = boundary({ initialColumn: "in-review", moveTask: vi.fn(async () => {}) });
    await expect(b.onNodeEntry(node("post-merge-verification", "done"))).resolves.toEqual({ kind: "entered" });
    // And a second entry re-refuses rather than slipping through on a stale preflight.
    await expect(b.onNodeEntry(node("post-merge-verification", "done"))).resolves.toEqual({ kind: "entered" });
  });

  it("exempts `end`, which names the complete column but is never a move destination (KTD-1)", async () => {
    const moveTask = vi.fn(async () => {});
    const { b, audits } = boundary({ initialColumn: "in-review", moveTask });

    await b.onNodeEntry(node("end", "done", "end"));

    expect(audits.some((event) => (event as { type: string }).type === "task:column-entry-refused-complete-column")).toBe(false);
  });

  it("leaves lateral and backward crossings alone — this invariant is about one crossing only", async () => {
    const moveTask = vi.fn(async () => {});
    const { b, audits } = boundary({ initialColumn: "in-review", moveTask });

    // lateral: review -> review is a no-op before this guard; review -> in-progress is backward and is
    // governed by lifecycle containment, which already has its own in-place clamp.
    await b.onNodeEntry(node("code-review", "in-review"));
    await b.onNodeEntry(node("code-review-remediation", "in-progress"));

    expect(audits.some((event) => (event as { type: string }).type === "task:column-entry-refused-complete-column")).toBe(false);
  });

  it("still performs an ordinary forward crossing into a non-complete column", async () => {
    const moveTask = vi.fn(async () => {});
    const { b, audits } = boundary({ initialColumn: "in-progress", moveTask });

    await b.onNodeEntry(node("do-it", "in-review"));

    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(b.currentColumn()).toBe("in-review");
    expect(audits.some((event) => (event as { type: string }).type === "task:column-transition")).toBe(true);
    expect(audits.some((event) => (event as { type: string }).type === "task:column-entry-refused-complete-column")).toBe(false);
  });

  it("contains the store's gate-evidence refusal instead of terminalizing the run", async () => {
    const refusalError = new CompleteColumnGateEvidenceRejectionError(
      makeTransitionRejection("gate-evidence-not-approved", "transition.rejected.gateEvidenceNotApproved", true),
      "post-merge-verification reported REVISE",
      [],
    );
    const moveTask = vi.fn(async () => {
      throw refusalError;
    });
    const { b, audits } = boundary({ initialColumn: "in-review", moveTask });

    // Pre-fix this call propagated out of the boundary, and the caller terminalized the card `failed`
    // for a gate that merely has not approved.
    await expect(b.onNodeEntry(node("post-merge-verification", "done"))).resolves.toEqual({ kind: "entered" });
    expect(b.currentColumn()).toBe("in-review");
    expect(audits.some((event) => (event as { type: string }).type === "task:column-transition")).toBe(false);
    expect(audits.some((event) => (event as { type: string }).type === "task:column-entry-refused-complete-column")).toBe(true);
  });

  it("still rethrows an unrelated rejection — containment is narrow, not a swallow", async () => {
    const moveTask = vi.fn(async () => {
      throw new Error("invariant violation: some other guard");
    });
    const { b } = boundary({ initialColumn: "in-progress", moveTask });

    // A crossing the structural refusal does not cover, so this really reaches the store call.
    await expect(b.onNodeEntry(node("code-review", "in-review"))).rejects.toThrow(/some other guard/);
    expect(moveTask).toHaveBeenCalledTimes(1);
  });

  it("classifies the crossing purely, so the predicate cannot drift from the branch", () => {
    const refusing = { kind: "optional-group" as const, direction: "forward" as const, targetComplete: true };
    expect(isForwardNodeEntryIntoCompleteColumn(refusing)).toBe(true);
    expect(isForwardNodeEntryIntoCompleteColumn({ ...refusing, kind: "end" })).toBe(false);
    expect(isForwardNodeEntryIntoCompleteColumn({ ...refusing, direction: "lateral" })).toBe(false);
    expect(isForwardNodeEntryIntoCompleteColumn({ ...refusing, direction: "backward" })).toBe(false);
    expect(isForwardNodeEntryIntoCompleteColumn({ ...refusing, direction: "unknown" })).toBe(false);
    expect(isForwardNodeEntryIntoCompleteColumn({ ...refusing, targetComplete: false })).toBe(false);
  });
});
