/*
FNXC:ApprovalRefusalCarrier 2026-11-21-14:30 (RUFU-1097):
The sentence `fn task reconcile` prints for a required pre-merge gate refusal, asserted on the pure renderer
`formatApprovalBlockerRefusal` — the same pattern `task-reconcile-commit-free.test.ts` uses for the arms that
command prints, and for the same reason: what the operator reads IS the deliverable, and booting a store, a
repository and a git worktree to read one line of stdout tests everything except the line.

The requirement this pins is RUFU-718's: the bare token `workflow-approval-blocked` named no gate and hid the
row the door had selected, so an operator could not tell "nobody reviewed this" from "the gate reported
`passed` and this lane does not read that as approval" — two opposite remedies behind one word. A test that
asserts only the gate id would pass for every gate-named refusal and prove nothing about that distinction, so
the `passed` case asserts the contradiction clause explicitly.
*/
import { describe, expect, it } from "vitest";
import { formatApprovalBlockerRefusal } from "../commands/task.js";
import type { PreMergeGateApprovalDetail } from "@fusion/engine";

describe("formatApprovalBlockerRefusal", () => {
  it("names the gate and states the contradiction when the gate reported passed", () => {
    const sentence = formatApprovalBlockerRefusal("RUFU-718", {
      gateId: "plan-review",
      gateState: "not-approved",
      gateStatus: "passed",
      gateVerdict: "CLOSE_NO_OP",
    });

    expect(sentence).toContain("'plan-review'");
    expect(sentence).toContain("not-approved");
    expect(sentence).toContain("status passed");
    expect(sentence).toContain("verdict CLOSE_NO_OP");
    // The clause that makes the refusal actionable rather than alarming.
    expect(sentence).toContain("does not accept that answer as approval");
  });

  it("quotes a rejected review plainly, without the contradiction clause", () => {
    const sentence = formatApprovalBlockerRefusal("RUFU-1097", {
      gateId: "code-review",
      gateState: "not-approved",
      gateStatus: "failed",
      gateVerdict: "REVISE",
    });

    expect(sentence).toContain("'code-review'");
    expect(sentence).toContain("status failed, verdict REVISE");
    expect(sentence).not.toContain("does not accept");
  });

  it("says when the gate has no row at all instead of printing empty fields", () => {
    const detail: PreMergeGateApprovalDetail = { gateId: "code-review", gateState: "not-approved" };
    const sentence = formatApprovalBlockerRefusal("RUFU-1097", detail);

    expect(sentence).toContain("'code-review'");
    expect(sentence).toContain("it has no result row at all");
    expect(sentence).not.toContain("status undefined");
    expect(sentence).not.toContain("verdict undefined");
  });

  it("states what reconcile will not do and names both remedies, so the operator is not sent back to the command", () => {
    const sentence = formatApprovalBlockerRefusal("RUFU-718", {
      gateId: "plan-review",
      gateState: "not-approved",
      gateStatus: "passed",
    });

    expect(sentence).toContain("never fabricates a verdict");
    expect(sentence).toContain("never re-runs a gate");
    expect(sentence).toContain("fn task bypass-review RUFU-718");
    expect(sentence).toContain("this task's History");
  });

  it("carries no reviewer prose, because every field it can read is a closed-enum token", () => {
    const sentence = formatApprovalBlockerRefusal("RUFU-718", {
      gateId: "plan-review",
      gateState: "not-approved",
      gateStatus: "passed",
      gateVerdict: "CLOSE_NO_OP",
    });

    // The gate's `notes` (where a no-op close's whole justification lives) is not reachable from the detail.
    for (const forbidden of ["NO-OP:", "notes", "bypassReason"]) {
      expect(sentence).not.toContain(forbidden);
    }
  });
});
