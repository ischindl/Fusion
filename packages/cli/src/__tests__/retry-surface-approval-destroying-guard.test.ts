/*
FNXC:ApprovalDestroyingRetry 2026-11-14-01:35 (RUFU-599 reproduction 4, RUFU-472 / RUFU-474) — the Retry-surface structural guard.

RUFU-599's fourth class is a card whose work had landed, whose required review gate still stood APPROVED, and
whose only remaining blocker was something no Retry can re-produce — a post-merge gate that refused to report,
or a review the convergence ladder had already escalated to a human. Every Retry surface offered itself as the
remedy, and each one destroyed the approval on its way: the CLI, the extension tool and the chat tool move the
card back to the hold lane, whose reopen hook wipes `workflowStepResults` whole; the board's stage restart
discards its own column's gate rows. The card then sat with the same blocker and no approval, and review had to
be re-burned — RUFU-284 and RUFU-304 measured that re-burn in hours.

The refusal therefore has to be ONE predicate asked by FOUR transports, in the same shape as the
`buildManualRetryResetPatch` guard beside this file: a surface that re-derives "is this retry safe?" locally is
indistinguishable at the type level from the correct call, and its failure is one card answered four different
ways. Behavioral coverage of the predicate itself lives in
`packages/core/src/__tests__/approval-destroying-retry.test.ts`; the chat surface is pinned behaviorally in
`packages/engine/src/__tests__/agent-tools-task-retry.test.ts`. What only a scan can catch is a transport that
stops asking, so this file names each surface and its own negative half.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// packages/cli/src/__tests__ → the repo root is four levels up; every path below is repo-relative.
const REPO_ROOT = resolve(__dirname, "../../../..");

function sourceOf(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), "utf8");
}

/** Every surface that can perform a destructive Retry on a review-lane card. */
const RETRY_SURFACES: Array<{ label: string; file: string }> = [
  { label: "fn task retry (CLI)", file: "packages/cli/src/commands/task.ts" },
  { label: "agent task retry tool (pi extension)", file: "packages/cli/src/extension.ts" },
  { label: "agent task retry tool (chat lane)", file: "packages/engine/src/agent-tools.ts" },
  { label: "dashboard stage-restart planner", file: "packages/core/src/tasks/task-column-restart.ts" },
];

describe("RUFU-599 — every Retry surface refuses an approval-destroying retry through the one shared predicate", () => {
  for (const surface of RETRY_SURFACES) {
    it(`${surface.label} asks the shared classifier`, () => {
      const source = sourceOf(surface.file);
      expect(source).toMatch(/findApprovalDestroyingRetry\(/);
      /*
      The negative half: a transport that hand-rolls the gate out of the classifier's own ingredients has
      stopped consulting the decision and started re-voting on it. `isGateApprovalVerdict` and
      `isAuditedOperatorBypass` are the predicate's private vocabulary — a surface naming them is a second copy
      of the policy, and the two copies drift the first time one of them grows a case.
      */
      expect(source).not.toMatch(/isGateApprovalVerdict\s*\(/);
      expect(source).not.toMatch(/isAuditedOperatorBypass\s*\(/);
    });
  }

  it("the board's restart route surfaces the refusal instead of falling through to a legacy retry lane", () => {
    /*
    The route has several retry arms after the restart planner. An unhandled `approval-destroying-retry` reason
    that fell through one of them would report a successful retry while the planner had refused to write
    anything — the false-success shape this class keeps producing.
    */
    const route = sourceOf("packages/dashboard/src/routes/register-task-workflow-routes.ts");
    expect(route).toMatch(/approval-destroying-retry/);
  });

  /*
  FNXC:ApprovalDestroyingRetry 2026-11-14-02:10 (RUFU-599 Step 7):
  One refused click gets ONE card-side sentence. The first wiring narrated from both the route's refusal arm and
  `restartTaskStage`, the same function that produced that refusal, so a single dashboard click was on its way to
  two History lines whenever the store lacked the dedupe seam - and a duplicated refusal line is how a card
  starts looking like it was refused twice. The narration therefore has exactly one owner per transport: the
  writer that refuses (`restartTaskStage` for the board), never the caller that reports it.
  */
  it("the refusal is narrated by the writer that refuses it, not also by the surface reporting it", () => {
    const restart = sourceOf("packages/dashboard/src/routes/task-restart-stage.ts");
    expect(restart).toMatch(/recordApprovalDestroyingRetryRefusal\s*\(/);

    const seen: Array<[string, number]> = [
      ["packages/cli/src/commands/task.ts", 1],
      ["packages/cli/src/extension.ts", 1],
      ["packages/engine/src/agent-tools.ts", 1],
      ["packages/dashboard/src/routes/task-restart-stage.ts", 1],
      // The reporting route must stay at zero: its refusal already came from the writer above.
      ["packages/dashboard/src/routes/register-task-workflow-routes.ts", 0],
    ];
    for (const [file, expectedCalls] of seen) {
      // A trailing `(` is what separates a call from an import of the same name; two surfaces reach it through the core namespace object.
      const calls = (sourceOf(file).match(/recordApprovalDestroyingRetryRefusal\s*\(/g) ?? []).length;
      expect(calls, `${file} narrates a refused Retry`).toBe(expectedCalls);
    }
  });

  it("the refusal is answered from the waiver the store already offers, not a second blocker scan", () => {
    /*
    `deriveReviewBypassTarget` is the single authority for "an operator may waive this gate". The refusal is
    the mirror of that offer — offer == accept == refusal == the Retry door — so the classifier must key off it
    rather than re-deriving a waiver from row inspection.
    */
    const classifier = sourceOf("packages/core/src/tasks/approval-destroying-retry.ts");
    expect(classifier).toMatch(/deriveReviewBypassTarget\s*\(/);
  });
});
