/*
 * RUFU-283: the vanished-work taxonomy.
 *
 * Every case here is a real observed state, not a synthetic branch: RUFU-225 is the
 * `row-missing-branch-unmerged` + approved-gate case, and the tombstone cases are the states
 * FN-6783's `id-exists-anywhere` skip passes over in silence. The classifier is pure, so these
 * assert the taxonomy itself — the engine sweep is covered separately with fake I/O.
 */

import { describe, expect, it } from "vitest";

import {
  buildVanishedTaskNotice,
  buildVanishedTaskNoticeTitle,
  classifyVanishedTaskDir,
  taskBranchRefFor,
  type VanishedTaskDirInput,
  type VanishedTaskGateRow,
} from "../task-store/vanished-task-detection.js";
import type { TaskIdPresence } from "../task-store/task-id-integrity.js";

const LIVE: TaskIdPresence = {
  rowExistsAnywhere: true,
  liveRowExists: true,
  tombstoned: false,
  tombstonedAt: null,
  inArchive: false,
};
const TOMBSTONE: TaskIdPresence = {
  rowExistsAnywhere: true,
  liveRowExists: false,
  tombstoned: true,
  tombstonedAt: "2026-09-17T14:08:16.277Z",
  inArchive: false,
};
const ARCHIVED: TaskIdPresence = {
  rowExistsAnywhere: true,
  liveRowExists: false,
  tombstoned: false,
  tombstonedAt: null,
  inArchive: true,
};

/** RUFU-225's persisted code-review row, copied from its disk mirror. */
const APPROVED_CODE_REVIEW: VanishedTaskGateRow = {
  workflowStepId: "code-review",
  status: "passed",
  reviewKind: "code",
  verdictRequired: true,
  remediationArchivedAt: undefined,
};

function input(overrides: Partial<VanishedTaskDirInput> = {}): VanishedTaskDirInput {
  return {
    taskId: "RUFU-225",
    mirrorMtimeMs: Date.parse("2026-09-17T14:08:16.294Z"),
    row: null,
    unmergedCommitCount: 3,
    mirror: { column: "in-review", status: "failed", workflowStepResults: [APPROVED_CODE_REVIEW] },
    ...overrides,
  };
}

describe("classifyVanishedTaskDir", () => {
  it("reports nothing for a live row — the card is on a lane the query did not show", () => {
    expect(classifyVanishedTaskDir(input({ row: LIVE }))).toBeNull();
  });

  it("reports nothing for an archive-only id — mirror and branch survive archived history by design", () => {
    expect(classifyVanishedTaskDir(input({ row: ARCHIVED, unmergedCommitCount: 7 }))).toBeNull();
  });

  it("classifies RUFU-225's shape: no row, branch holding commits, approved gate on disk", () => {
    const finding = classifyVanishedTaskDir(input());
    expect(finding).not.toBeNull();
    expect(finding!.reason).toBe("row-missing-branch-unmerged");
    expect(finding!.branchRef).toBe("fusion/rufu-225");
    expect(finding!.unmergedCommitCount).toBe(3);
    expect(finding!.gateApproved).toBe(true);
    expect(finding!.mirrorColumn).toBe("in-review");
    // The acceptance contract: the notice names the ref and the command, never asks a re-plan.
    expect(finding!.salvage.salvageTarget).toBe("fusion/rufu-225");
    expect(finding!.salvage.salvageCommand).toBe("git log main..fusion/rufu-225 --oneline");
    expect(finding!.salvage.hint).toContain("APPROVED");
    expect(finding!.salvage.hint).toContain("do not re-plan the work from scratch");
  });

  it("names the lost branch as the salvage target instead of hiding it when the branch is gone too", () => {
    const finding = classifyVanishedTaskDir(input({ unmergedCommitCount: 0 }))!;
    expect(finding.reason).toBe("row-missing-branch-missing");
    expect(finding.salvage.salvageTarget).toBe("fusion/rufu-225");
    expect(finding.salvage.hint).toContain("task.json");
    expect(finding.salvage.hint).toContain("reflog");
  });

  it("classifies a tombstoned row as vanished work while its id stays reserved", () => {
    const finding = classifyVanishedTaskDir(input({ row: TOMBSTONE }))!;
    expect(finding.reason).toBe("row-tombstoned-branch-unmerged");
    expect(finding.salvage.hint).toContain("allowResurrection");
  });

  it("classifies a tombstone whose branch is already gone as mirror-only recovery", () => {
    const finding = classifyVanishedTaskDir(input({ row: TOMBSTONE, unmergedCommitCount: 0 }))!;
    expect(finding.reason).toBe("row-tombstoned-branch-missing");
    expect(finding.salvage.hint).toContain("Only the disk mirror survives");
  });

  it("keeps an unprobeable branch visible as state-unresolved rather than calling it lost", () => {
    // Non-vacuous: a probe failure must not be silently read as "0 unmerged commits".
    const finding = classifyVanishedTaskDir(input({ unmergedCommitCount: null }))!;
    expect(finding.reason).toBe("state-unresolved");
    expect(finding.salvage.hint).toContain("could not be probed");
  });

  describe("approved-gate predicate", () => {
    it("does not credit a verdict that a later remediation archived (FN-295 supersession)", () => {
      const superseded: VanishedTaskGateRow = {
        ...APPROVED_CODE_REVIEW,
        remediationArchivedAt: "2026-09-17T13:00:00.000Z",
      };
      // Same row, one field apart: proves the gate suppression, not an absent affordance.
      expect(classifyVanishedTaskDir(input())!.gateApproved).toBe(true);
      expect(classifyVanishedTaskDir(input({ mirror: { column: "in-review", workflowStepResults: [superseded] } }))!.gateApproved).toBe(false);
    });

    it("does not credit a passing row on a step that never required an authored verdict", () => {
      const noVerdictNeeded: VanishedTaskGateRow = {
        workflowStepId: "verification",
        status: "passed",
        reviewKind: undefined,
        verdictRequired: false,
        remediationArchivedAt: undefined,
      };
      const finding = classifyVanishedTaskDir(
        input({ mirror: { column: "in-review", workflowStepResults: [noVerdictNeeded] } }),
      )!;
      expect(finding.gateApproved).toBe(false);
      expect(finding.salvage.hint).toContain("no approving verdict was recorded");
    });

    it("does not credit a non-passing verdict", () => {
      const failed: VanishedTaskGateRow = { ...APPROVED_CODE_REVIEW, status: "failed" };
      const finding = classifyVanishedTaskDir(
        input({ mirror: { column: "in-review", workflowStepResults: [failed] } }),
      )!;
      expect(finding.gateApproved).toBe(false);
    });

    it("survives an unreadable mirror and still classifies on branch evidence", () => {
      const finding = classifyVanishedTaskDir(input({ mirror: null }))!;
      expect(finding.reason).toBe("row-missing-branch-unmerged");
      expect(finding.gateApproved).toBe(false);
      expect(finding.mirrorColumn).toBeNull();
    });
  });
});

describe("taskBranchRefFor", () => {
  it("lowercases the id into the canonical task branch", () => {
    expect(taskBranchRefFor("RUFU-225")).toBe("fusion/rufu-225");
  });
});

describe("operator notice", () => {
  it("carries the taxonomy code, the ref, the salvage command and the commit count", () => {
    const finding = classifyVanishedTaskDir(input())!;
    const notice = buildVanishedTaskNotice(finding);
    expect(notice).toContain("RUFU-225");
    expect(notice).toContain("row-missing-branch-unmerged");
    expect(notice).toContain("`fusion/rufu-225`");
    expect(notice).toContain("git log main..fusion/rufu-225 --oneline");
    expect(notice).toContain("3 commit(s) not on main");
    expect(buildVanishedTaskNoticeTitle(finding)).toContain("3 unmerged commits");
  });

  it("says the state is unknown instead of reporting a fake count when the probe failed", () => {
    const finding = classifyVanishedTaskDir(input({ unmergedCommitCount: null }))!;
    expect(buildVanishedTaskNotice(finding)).toContain("unprobed");
    expect(buildVanishedTaskNoticeTitle(finding)).toContain("branch state unknown");
  });
});
