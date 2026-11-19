/*
FNXC:CommitOwnership 2026-11-19-17:38 (RUFU-394):
The shared ownership anchor used to ask one question: "does this commit name the task id?" RUFU-394
measured three commits on `main` that answered yes and were not the cards they claimed: two carried
`Fusion-Task-Id: RUFU-391` 2h46m and 2h47m BEFORE that card's row was created (the allocator had not
reached 391 yet; the row was created at 12:03:28Z, the commits were stamped 09:17:14Z and 09:18:27Z),
and one carried no trailer at all and answered only to a `fix(RUFU-380):` subject naming a different,
live card. Every delivery proof that routed through the anchor - already-merged detection, workspace
landing, self-healing landed classification, the worktree rebind - inherited the same question with
no project and no clock, so RUFU-391 was credited with a delivery it never made and its checkout
lease, file-scope lease and branch were released as though its work had landed.

These tests pin the two refusals the anchor now makes, the bound they are measured against, and just
as importantly the unknowns it must NOT refuse on: a board with no configured project id, a card with
no creation time, and a commit whose committer time cannot be read all keep the legacy behavior,
because the toolchain's own history and every hand-authored commit predate this contract.
*/
import { describe, expect, it } from "vitest";

import { getCommitTaskOwnership } from "../merge/already-merged-detector.js";
import {
  COMMIT_BIRTH_CLOCK_SKEW_MS,
  FUSION_PROJECT_ID_TRAILER_KEY,
  buildFusionCommitTrailers,
  commitDeclaresForeignProject,
  commitPredatesTaskBirth,
  evaluateCommitOwnershipRefusal,
  parseCommitProjectId,
  taskBirthMs,
} from "../merge/commit-trailer-evidence.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The measured gap that a 24 h scan window would have waved through (`36a88363e2` vs `RUFU-391`). */
const MEASURED_INVENTION_GAP_MS = 2 * HOUR + 46 * MINUTE;

describe("commit project identity trailer grammar", () => {
  it("reads a project id only from its own trailer line", () => {
    expect(parseCommitProjectId("body\n\nFusion-Project-Id: proj_18b91890789b432f\n")).toBe("proj_18b91890789b432f");
    expect(parseCommitProjectId("notes\n\nmentions Fusion-Project-Id: proj_x in prose")).toBeNull();
    expect(parseCommitProjectId("")).toBeNull();
    expect(parseCommitProjectId(null)).toBeNull();
    expect(parseCommitProjectId(undefined)).toBeNull();
  });

  it("treats an empty-valued trailer as no identity rather than an empty identity", () => {
    expect(parseCommitProjectId("Fusion-Project-Id:   ")).toBeNull();
    // A blank key carries no more evidence than an absent one: never refuse on it.
    expect(commitDeclaresForeignProject("Fusion-Project-Id: ", "proj_us")).toBe(false);
  });

  it("refuses only a DIFFERENT non-empty project", () => {
    expect(commitDeclaresForeignProject("Fusion-Project-Id: proj_other", "proj_us")).toBe(true);
    expect(commitDeclaresForeignProject("Fusion-Project-Id: proj_us", "proj_us")).toBe(false);
    // Unknown on either side is unknown, not a refusal.
    expect(commitDeclaresForeignProject("Fusion-Project-Id: proj_other", null)).toBe(false);
    expect(commitDeclaresForeignProject("Fusion-Project-Id: proj_other", undefined)).toBe(false);
    expect(commitDeclaresForeignProject("no project trailer", "proj_us")).toBe(false);
  });

  it("builds no project trailer when identity is unknown", () => {
    expect(buildFusionCommitTrailers({ taskId: "FN-1", projectId: "proj_x" }))
      .toEqual(["Fusion-Task-Id: FN-1", "Fusion-Project-Id: proj_x"]);
    expect(buildFusionCommitTrailers({ taskId: "FN-1", projectId: "  " })).toEqual(["Fusion-Task-Id: FN-1"]);
    expect(buildFusionCommitTrailers({ taskId: "FN-1" })).toEqual(["Fusion-Task-Id: FN-1"]);
    expect(buildFusionCommitTrailers({ projectId: "proj_x" })).toEqual(["Fusion-Project-Id: proj_x"]);
    expect(buildFusionCommitTrailers({})).toEqual([]);
    expect(FUSION_PROJECT_ID_TRAILER_KEY).toBe("Fusion-Project-Id");
  });
});

describe("commit birth order against card creation", () => {
  const born = Date.UTC(2026, 9, 10, 12, 0, 0);

  it("refuses the measured invention gap, which a 24 h scan window would have accepted", () => {
    expect(COMMIT_BIRTH_CLOCK_SKEW_MS).toBeLessThan(MEASURED_INVENTION_GAP_MS);
    expect(commitPredatesTaskBirth(born - MEASURED_INVENTION_GAP_MS, born, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(true);
    expect(commitPredatesTaskBirth(born - 2 * DAY, born, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(true);
  });

  it("tolerates a skewed clock, so a slightly-early stamp is never a refusal", () => {
    expect(commitPredatesTaskBirth(born - 10 * MINUTE, born, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(false);
    expect(commitPredatesTaskBirth(born + HOUR, born, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(false);
  });

  it("skips when either clock is unknown", () => {
    expect(commitPredatesTaskBirth(null, born, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(false);
    expect(commitPredatesTaskBirth(born - DAY, null, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(false);
    expect(commitPredatesTaskBirth(born - DAY, Number.NaN, COMMIT_BIRTH_CLOCK_SKEW_MS)).toBe(false);
  });

  it("reads a card's birth without inventing one for a malformed createdAt", () => {
    expect(taskBirthMs({ createdAt: new Date(born).toISOString() })).toBe(born);
    expect(taskBirthMs({ createdAt: "not-a-date" })).toBeNull();
    expect(taskBirthMs({})).toBeNull();
    expect(taskBirthMs(null)).toBeNull();
  });

  it("names the two refusals separately and never refuses on unknowns", () => {
    expect(evaluateCommitOwnershipRefusal(
      { taskId: "RUFU-391", taskCreatedAtMs: null, projectNamespace: "proj_us" },
      { body: "Fusion-Project-Id: proj_other", committerEpochMs: null },
      COMMIT_BIRTH_CLOCK_SKEW_MS,
    )).toBe("foreign-project");
    expect(evaluateCommitOwnershipRefusal(
      { taskId: "RUFU-391", taskCreatedAtMs: born, projectNamespace: "proj_us" },
      { body: "", committerEpochMs: born - MEASURED_INVENTION_GAP_MS },
      COMMIT_BIRTH_CLOCK_SKEW_MS,
    )).toBe("anachronistic");
    // Project is decided before the clock: a commit from another board needs no second reason.
    expect(evaluateCommitOwnershipRefusal(
      { taskId: "RUFU-391", taskCreatedAtMs: born, projectNamespace: "proj_us" },
      { body: "Fusion-Project-Id: proj_other", committerEpochMs: born - 2 * DAY },
      COMMIT_BIRTH_CLOCK_SKEW_MS,
    )).toBe("foreign-project");
    expect(evaluateCommitOwnershipRefusal(
      { taskId: "RUFU-391", taskCreatedAtMs: null, projectNamespace: null },
      { body: "", committerEpochMs: null },
      COMMIT_BIRTH_CLOCK_SKEW_MS,
    )).toBeNull();
  });
});

describe("getCommitTaskOwnership refuses foreign project and anachronism", () => {
  const born = Date.UTC(2026, 9, 10, 12, 0, 0);
  const trailerBody = "Fusion-Task-Id: RUFU-391\n\nbody text";

  it("refuses a commit stamped before its card was created", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", trailerBody, {
      taskCreatedAtMs: born,
      committerEpochMs: born - MEASURED_INVENTION_GAP_MS,
    });
    expect(verdict.owned).toBe(false);
    expect(verdict.rejectionReason).toBe("anachronistic");
    expect(verdict.ownerTaskId).toBe("RUFU-391");
  });

  it("refuses a commit whose declared project is another board", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", [
      trailerBody, "Fusion-Project-Id: proj_other",
    ].join("\n\n"), { taskCreatedAtMs: born, committerEpochMs: born + HOUR, projectNamespace: "proj_us" });
    expect(verdict.owned).toBe(false);
    expect(verdict.rejectionReason).toBe("foreign-project");
  });

  it("refuses a subject-anchored commit the same way an id-bearing one is refused", () => {
    // `8340f30453` carried no task trailer at all; its only identity was the `fix(RUFU-380):` subject.
    const verdict = getCommitTaskOwnership("RUFU-380", undefined, "fix(RUFU-380): an engine stall park", "body", {
      taskCreatedAtMs: born, committerEpochMs: born - MEASURED_INVENTION_GAP_MS,
    });
    expect(verdict.owned).toBe(false);
    expect(verdict.rejectionReason).toBe("anachronistic");
  });

  it("still owns the commit a card legitimately wrote", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", trailerBody, {
      taskCreatedAtMs: born, committerEpochMs: born + 5 * MINUTE, projectNamespace: "proj_us",
    });
    expect(verdict.owned).toBe(true);
    expect(verdict.proof).toBe("task-trailer");
    expect(verdict.rejectionReason).toBeUndefined();
  });

  it("keeps accepting commits and cards that carry no project identity at all", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", trailerBody, {
      taskCreatedAtMs: born, committerEpochMs: born + MINUTE, projectNamespace: null,
    });
    expect(verdict.owned).toBe(true);
  });

  it("keeps accepting a pre-existing commit whose committer time is unreadable", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", trailerBody, {
      taskCreatedAtMs: born, committerEpochMs: null,
    });
    expect(verdict.owned).toBe(true);
  });

  it("keeps accepting a card whose birth is unknown", () => {
    const verdict = getCommitTaskOwnership("RUFU-391", undefined, "fix(RUFU-391): a subject", trailerBody, {
      taskCreatedAtMs: null, committerEpochMs: born - 400 * DAY,
    });
    expect(verdict.owned).toBe(true);
  });

  it("leaves the no-evidence call signature identical to the old contract", () => {
    expect(getCommitTaskOwnership("RUFU-391", undefined, "s", trailerBody).owned).toBe(true);
    expect(getCommitTaskOwnership("RUFU-391", "lin-1", "s", "Fusion-Task-Lineage: lin-1").owned).toBe(true);
    expect(getCommitTaskOwnership("RUFU-391", undefined, "s", "Fusion-Task-Id: RUFU-388").rejectionReason).toBe("foreign-task");
  });
});
