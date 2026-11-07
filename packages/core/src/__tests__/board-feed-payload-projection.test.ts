import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  BOARD_DESCRIPTION_PREVIEW_CHARS,
  BOARD_SOURCE_METADATA_KEYS,
  compactBoardFeedRow,
  resolveBoardFeedCostVisibility,
} from "../task-store/reads.js";

/*
FNXC:BoardPayloadBudget 2026-11-07-13:55 (RUFU-871):
The board feed must stop shipping bodies no card renders (83 % of the measured 2.2 MB first
download) while keeping exactly what the card face and its memo comparator reason about. These
tests are the two-direction contract: the junk is gone, and every carried field survives.
*/

function boardTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-871",
    title: "Board row",
    description: "",
    column: "in-progress",
    steps: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

const FULL_SPEC = `${"spec body ".repeat(800)}`;

describe("board feed row projection (RUFU-871)", () => {
  it("caps the description at the named preview bound and flags it", () => {
    const task = boardTask({ description: FULL_SPEC });
    compactBoardFeedRow(task, { includeTokenUsage: false });

    expect(task.description.length).toBeLessThanOrEqual(BOARD_DESCRIPTION_PREVIEW_CHARS);
    expect(task.description).toBe(FULL_SPEC.slice(0, BOARD_DESCRIPTION_PREVIEW_CHARS));
    expect(task.descriptionTruncated).toBe(true);
  });

  it("leaves an in-bounds description byte-identical and unflagged", () => {
    const short = "a short spec";
    const task = boardTask({ description: short });
    compactBoardFeedRow(task, { includeTokenUsage: false });

    expect(task.description).toBe(short);
    expect(task.descriptionTruncated).toBeUndefined();
  });

  it("drops the comment, steering, step-report and recommendation bodies", () => {
    const task = boardTask({
      comments: [{ id: "c1", body: "x".repeat(5000) } as never],
      steeringComments: [{ id: "s1", body: "y".repeat(5000) } as never],
      stepReports: [{ stepName: "implement", report: "z".repeat(5000) } as never],
      recommendations: [{ id: "r1", summary: "w".repeat(5000) } as never],
      summary: "the whole completion summary",
    });
    compactBoardFeedRow(task, { includeTokenUsage: false });

    expect(task.comments).toBeUndefined();
    expect(task.steeringComments).toBeUndefined();
    expect(task.stepReports).toBeUndefined();
    expect(task.recommendations).toBeUndefined();
    expect(task.summary).toBeUndefined();
  });

  it("keeps only the retry total the board badge renders", () => {
    const task = boardTask({
      retrySummary: {
        total: 7,
        stuckKill: 1,
        recovery: 2,
        taskDone: 1,
        worktreeSession: 0,
        workflowStep: 1,
        verification: 0,
        postReviewFix: 1,
        mergeConflict: 0,
        branchConflict: 1,
        reviewerContext: 0,
        reviewerFallback: 0,
      },
    });
    compactBoardFeedRow(task, { includeTokenUsage: false });

    expect(task.retrySummary).toEqual({ total: 7 });
  });

  it("omits tokenUsage when the project spend chip is off and keeps it byte-identical when on", () => {
    const tokenUsage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5 } as NonNullable<Task["tokenUsage"]>;
    const off = boardTask({ tokenUsage: { ...tokenUsage } });
    compactBoardFeedRow(off, { includeTokenUsage: false });
    expect(off.tokenUsage).toBeUndefined();

    const on = boardTask({ tokenUsage: { ...tokenUsage } });
    compactBoardFeedRow(on, { includeTokenUsage: true });
    expect(on.tokenUsage).toEqual(tokenUsage);
  });

  it("drops a foreign sourceMetadata blob and carries every allowlisted key", () => {
    const carried = Object.fromEntries(BOARD_SOURCE_METADATA_KEYS.map((key, index) => [key, `v${index}`]));
    const task = boardTask({
      sourceMetadata: {
        ...carried,
        planAdmissionStall: { signature: "sweep:x", firstAt: "2026-11-01T00:00:00.000Z" },
        branchConflictRecoveryEpisode: { refusalCount: 3 },
        wipAdmissionStallBlob: "not the allowlisted key",
      },
    });
    compactBoardFeedRow(task, { includeTokenUsage: false });

    expect(task.sourceMetadata).toEqual(carried);
    expect(task.sourceMetadata).not.toHaveProperty("planAdmissionStall");
    expect(task.sourceMetadata).not.toHaveProperty("branchConflictRecoveryEpisode");
    expect(task.sourceMetadata).toHaveProperty("fusionBranchContext");
  });

  it("resolves the spend-chip decision from the resolved project setting", async () => {
    const off = { getSettingsFast: async () => ({ showCostBadgeOnCards: false }) } as never;
    const on = { getSettingsFast: async () => ({ showCostBadgeOnCards: true }) } as never;
    const hostile = { getSettingsFast: async () => { throw new Error("store unavailable"); } } as never;

    await expect(resolveBoardFeedCostVisibility(off)).resolves.toBe(false);
    await expect(resolveBoardFeedCostVisibility(on)).resolves.toBe(true);
    await expect(resolveBoardFeedCostVisibility(hostile)).resolves.toBe(true);
  });
});
