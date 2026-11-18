import { describe, expect, it } from "vitest";
import { deriveTaskIdFromFusionBranch } from "../execution/branch-conflicts.js";
import { extractTaskIdFromTempMergeDir, isTaskNotFoundError } from "../healing/self-healing-path-utils.js";

/*
FNXC:TaskIdGrammar 2026-11-18-06:30 (RUFU-730):
RUFU-730 generalized every production parser that reads a task id to OBSERVE it (duplicate closes,
self-defeating dependencies, title drift) and deliberately left these three on the narrow `FN-\d+` grammar
because each one is an input to a DELETION:

- `extractTaskIdFromTempMergeDir` is what lets the temp-merge sweep decide a clean-room's card is gone, and
  that answer is what swaps the reap floor from `STALE_TEMP_MERGE_WORKTREE_MS` (2 h) to
  `DONE_TASK_TEMP_WORKTREE_GRACE_MS` (10 min) before a forced worktree removal.
- `isTaskNotFoundError` is the `catch` arm of that same decision: match it too broadly and any sentence
  shaped like "task X not found" authorises the early deletion.
- `deriveTaskIdFromFusionBranch` gates git deletions in self-healing (fully-subsumed auto-reclaim,
  stale-active-branch reclaim) and `inspectBranchConflict`'s self-owned fallback.

These assertions hold the NARROW language by calling the real functions, so a widening has to edit a named
test rather than flow silently out of a shared-grammar refactor. They assert behavior, never source text:
there is no copy of any pattern here, which is also what keeps this file from becoming the second dictionary
the card forbids. The acquisition-seam half of this guarantee lives in
`worktree-acquisition-pinned.test.ts` ("does NOT destructively reclaim a pinned dir whose foreign branch
carries a non-FN prefix").
*/
describe("destructive-lane task-id grammar stays FN-only", () => {
  describe("extractTaskIdFromTempMergeDir", () => {
    it("still resolves the FN clean-room it always resolved", () => {
      expect(extractTaskIdFromTempMergeDir("fusion-ai-merge-FN-7996-a1b2c3")).toBe("FN-7996");
      expect(extractTaskIdFromTempMergeDir("fusion-ai-merge-fn-7996-a1b2c3")).toBe("FN-7996");
    });

    it("names no card for a non-FN clean-room, so no early reap floor is selected", () => {
      // null here is the safe answer: the sweep keeps the 2 h floor and still reaps on age.
      expect(extractTaskIdFromTempMergeDir("fusion-ai-merge-RUFU-730-a1b2c3")).toBeNull();
      expect(extractTaskIdFromTempMergeDir("fusion-ai-merge-SANE-452-a1b2c3")).toBeNull();
    });

    it("names no card for a directory that is not a merge clean-room at all", () => {
      expect(extractTaskIdFromTempMergeDir("fusion-verify-rufu-730")).toBeNull();
      expect(extractTaskIdFromTempMergeDir("fusion-ai-merge-FN-7996")).toBeNull();
    });
  });

  describe("isTaskNotFoundError", () => {
    it("still matches the FN-shaped lookup miss", () => {
      expect(isTaskNotFoundError(new Error("Task FN-7996 not found"))).toBe(true);
      expect(isTaskNotFoundError(new Error("task fn-7996 NOT FOUND"))).toBe(true);
    });

    it("does not match a non-FN lookup miss, so it cannot release a clean-room early on that sentence", () => {
      expect(isTaskNotFoundError(new Error("Task RUFU-730 not found"))).toBe(false);
      expect(isTaskNotFoundError(new Error("task sane-452 not found"))).toBe(false);
    });

    it("does not match an unrelated failure", () => {
      expect(isTaskNotFoundError(new Error("connection terminated"))).toBe(false);
      expect(isTaskNotFoundError("Task FN-1 not found")).toBe(true);
    });
  });

  describe("deriveTaskIdFromFusionBranch", () => {
    it("still derives the FN branch owner it always derived", () => {
      expect(deriveTaskIdFromFusionBranch("fusion/FN-7996")).toBe("FN-7996");
      expect(deriveTaskIdFromFusionBranch("  fusion/fn-7996  ")).toBe("FN-7996");
    });

    it("derives no owner from a non-FN task branch, withholding reclaim authority", () => {
      // A real RUFU project's branch, and the compound shapes the anchors must also reject.
      expect(deriveTaskIdFromFusionBranch("fusion/RUFU-730")).toBeNull();
      expect(deriveTaskIdFromFusionBranch("fusion/SANE-452")).toBeNull();
      expect(deriveTaskIdFromFusionBranch("fusion/FN-7996-code-review")).toBeNull();
      expect(deriveTaskIdFromFusionBranch("fusion/step-3-build")).toBeNull();
      expect(deriveTaskIdFromFusionBranch("main")).toBeNull();
    });
  });
});
