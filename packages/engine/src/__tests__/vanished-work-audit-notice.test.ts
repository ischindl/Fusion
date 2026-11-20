/*
 * RUFU-523: the signature + cooldown guard behind `task:vanished-approved-work`.
 *
 * The sweep's finding loop is covered end-to-end in `vanished-task-detection-sweep.test.ts`; this file
 * pins the guard's own decision table in isolation, because the defect RUFU-523 fixes was measured as a
 * ROW COUNT (939 rows / 125 findings in 7.5 h, production 2026-10-03) and the row count is decided here.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { TaskStore, VanishedTaskFinding } from "@fusion/core";

import {
  VANISHED_WORK_AUDIT_WINDOW_MS,
  resetVanishedWorkAuditNoticeState,
  shouldRecordVanishedWorkAudit,
  vanishedWorkAuditSignature,
} from "../notification/vanished-work-audit-notice.js";
import { VANISHED_WORK_ALERT_COOLDOWN_MS } from "../notification/vanished-task-detection.js";

const NOW = Date.parse("2026-10-03T01:30:00.000Z");

function storeStub(): TaskStore {
  return { tasksDir: "/tmp/rufu-523-guard" } as unknown as TaskStore;
}

function finding(over: Partial<VanishedTaskFinding> = {}): VanishedTaskFinding {
  return {
    taskId: "SANE-454",
    reason: "row-tombstoned-branch-missing",
    branchRef: "fusion/sane-454",
    unmergedCommitCount: null,
    gateApproved: false,
    mirrorColumn: "done",
    salvage: { salvageTarget: "fusion/sane-454", salvageCommand: "", hint: "" },
    ...over,
  };
}

beforeEach(() => {
  resetVanishedWorkAuditNoticeState();
});

describe("vanishedWorkAuditSignature", () => {
  it("joins exactly the four stable fields", () => {
    expect(vanishedWorkAuditSignature(finding({
      reason: "row-missing-branch-unmerged",
      branchRef: "fusion/rufu-225",
      unmergedCommitCount: 3,
      gateApproved: true,
    }))).toBe("row-missing-branch-unmerged|fusion/rufu-225|3|approved");
  });

  it("renders an un-probeable branch as a dash instead of the string null", () => {
    expect(vanishedWorkAuditSignature(finding({ unmergedCommitCount: null }))).toContain("|-|");
  });

  it("ignores salvageTarget and mirrorColumn, the two finding fields excluded from the key", () => {
    const base = vanishedWorkAuditSignature(finding({ unmergedCommitCount: 3, gateApproved: true }));
    // Both fields ride in the row or the notice unchanged and are derived from fields already in the
    // key, so widening the key with them would only risk splitting one finding across two signatures.
    // mirrorColumn in particular comes off the on-disk MIRROR, which any writer can touch.
    const other = vanishedWorkAuditSignature(finding({
      unmergedCommitCount: 3,
      gateApproved: true,
      mirrorColumn: "in-review",
      salvage: { salvageTarget: "other-target", salvageCommand: "git cherry-pick abc", hint: "x" },
    }));
    expect(other).toBe(base);
  });
});

describe("shouldRecordVanishedWorkAudit", () => {
  it("reports an unseen finding unconditionally — the first report is never suppressed", () => {
    const store = storeStub();
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", "reason|fusion/sane-454|-|false", NOW)).toBe(true);
  });

  it("stays silent for the identical signature inside the window, which is what bounds the row count", () => {
    const store = storeStub();
    const signature = vanishedWorkAuditSignature(finding());
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW)).toBe(true);
    // Every later maintenance pass in the same window restates the same finding.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + 60_000)).toBe(false);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + 3_600_000)).toBe(false);
  });

  it("re-asserts an unresolved finding exactly at the window, matching the notice cadence", () => {
    const store = storeStub();
    const signature = vanishedWorkAuditSignature(finding());
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW)).toBe(true);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + VANISHED_WORK_AUDIT_WINDOW_MS - 1)).toBe(false);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + VANISHED_WORK_AUDIT_WINDOW_MS)).toBe(true);
  });

  it("reports a changed finding immediately, without waiting for the window", () => {
    const store = storeStub();
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ unmergedCommitCount: 3 })), NOW)).toBe(true);
    // A late branch push changes what is at risk: a different number is a different finding.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ unmergedCommitCount: 4 })), NOW + 1_000)).toBe(true);
    // A different reason class is read differently by the operator, so it is never swallowed.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ reason: "state-unresolved" })), NOW + 2_000)).toBe(true);
    // A gate verdict that appeared (or vanished) is news too.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ gateApproved: true })), NOW + 3_000)).toBe(true);
  });

  it("treats the probe-budget crossing as a new signature, so a null-to-count change stays visible", () => {
    const store = storeStub();
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ unmergedCommitCount: null })), NOW)).toBe(true);
    // Past VANISHED_WORK_MAX_BRANCH_PROBES the count is null; back inside the budget it is a number.
    // That crossing is a changed OBSERVATION and must report, not be mistaken for a restatement.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", vanishedWorkAuditSignature(finding({ unmergedCommitCount: 3 })), NOW + 1_000)).toBe(true);
  });

  it("keeps two cards independent, so one standing finding cannot hide a new one", () => {
    const store = storeStub();
    const signature = vanishedWorkAuditSignature(finding());
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW)).toBe(true);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-457", signature, NOW + 10)).toBe(true);
    // The first card is still suppressed while the second one is fresh.
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + 20)).toBe(false);
  });

  it("keeps two project databases independent, so central mode cannot swallow another project's finding", () => {
    const projectA = storeStub();
    const projectB = storeStub();
    const signature = vanishedWorkAuditSignature(finding());
    expect(shouldRecordVanishedWorkAudit(projectA, "SANE-454", signature, NOW)).toBe(true);
    // Same card id, same signature, different store: the shared database never saw this row.
    expect(shouldRecordVanishedWorkAudit(projectB, "SANE-454", signature, NOW + 10)).toBe(true);
  });

  it("re-arms after the reset, which is the process-boundary and test semantics", () => {
    const store = storeStub();
    const signature = vanishedWorkAuditSignature(finding());
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW)).toBe(true);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + 10)).toBe(false);
    resetVanishedWorkAuditNoticeState(store);
    expect(shouldRecordVanishedWorkAudit(store, "SANE-454", signature, NOW + 20)).toBe(true);
  });

  it("shares one window constant with the mailbox notice, so the two surfaces cannot drift", () => {
    expect(VANISHED_WORK_AUDIT_WINDOW_MS).toBe(VANISHED_WORK_ALERT_COOLDOWN_MS);
  });
});
