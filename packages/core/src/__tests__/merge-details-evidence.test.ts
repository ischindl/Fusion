import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MERGE_DETAIL_EVIDENCE_KEYS,
  MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS,
  classifyMergeDetailKey,
  mergeDetailsCarriesMergeEvidence,
} from "../tasks/merge-details-evidence.js";

/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
Four engine paths asked `Boolean(task.mergeDetails)` and got "a merge happened" from a row that carried only
recovery bookkeeping. The consequence was not cosmetic: the execute-preflight merge reset ran on cards that
never merged, and that reset writes `status: null, error: null`, which is what disarmed the bounded re-arm
park and let RUFU-583 restart its ladder at `attempt 1/4` after already exhausting it (44 grants in under two
hours, 2026-11-14).

So the classification is a closed table with a census. A key that nobody classified must fail this test
rather than silently inherit the ambiguous behavior it was supposed to end.
*/

/** Declared keys of `MergeDetails`, read structurally from the type — not from a hand-maintained copy. */
function declaredMergeDetailKeys(): string[] {
  const url = new URL("../types/task/task-core.ts", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  /*
   * Comments are stripped BEFORE the scan. `FNXC:` blocks sit at the same two-space indent as interface
   * members, so without this the census would count documentation prose as a declared key — a test that
   * tallies prose is testing nothing, and it would fail every honest addition of a comment.
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const start = src.indexOf("export interface MergeDetails");
  if (start === -1) throw new Error("MergeDetails interface not found — the census premise is gone");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    // Top-level members are indented exactly two spaces; nested object members are deeper.
    const match = /^ {2}(\w+)\??:/.exec(line);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}

describe("mergeDetailsCarriesMergeEvidence", () => {
  it("says NO MERGE for every empty shape", () => {
    for (const empty of [undefined, null, {}]) {
      expect(mergeDetailsCarriesMergeEvidence(empty as never)).toBe(false);
    }
  });

  it("says NO MERGE for recovery bookkeeping, which is the case truthiness got wrong", () => {
    const bookkeepingOnly = [
      { pushRecovery: { target: "origin/main", commitSha: "abc", nextAttemptAt: "2026-11-14T00:00:00Z" } },
      { mergeBoundaryRecovery: { signature: "sig", attempt: 2, nextCheckAt: null } },
      { executionRearm: { signature: "sig", attempt: 1, refusal: 0, firstAt: "a", at: "b", heldAt: null } },
      {
        pushRecovery: { target: "origin/main", commitSha: "abc", nextAttemptAt: "2026-11-14T00:00:00Z" },
        mergeBoundaryRecovery: { signature: "sig", attempt: 1, nextCheckAt: null },
        executionRearm: { signature: "sig", attempt: 4, refusal: 0, firstAt: "a", at: "b", heldAt: "c" },
      },
    ];
    for (const row of bookkeepingOnly) expect(mergeDetailsCarriesMergeEvidence(row as never)).toBe(false);
  });

  it("says MERGE for each recorded landing or merge decision", () => {
    const evidenceRows = [
      { commitSha: "abc123" },
      { mergedAt: "2026-11-14T12:00:00Z" },
      { mergeConfirmed: true },
      { landedFiles: ["src/a.ts"] },
      { workspaceLandedShas: { "repo/a": "abc123" } },
      { landedBranchTipSha: "def456" },
      { rebaseBaseSha: "ghi789" },
      { filesChanged: 3 },
      { insertions: 12 },
      { deletions: 2 },
      { noOpMerge: true },
      { noOpVerifiedShortCircuit: true },
      { noOpReason: "already-on-main" },
      { prNumber: 42 },
      { mergeTargetBranch: "main" },
      { mergeCommitMessage: "feat: x" },
      { uncommittedWorkHold: { reason: "dirty" } },
      { integrityWarning: "scope drift" },
      { resolutionStrategy: "ai" },
      { resolutionMethod: "squash" },
      { attemptsMade: 1 },
      { autoResolvedCount: 1 },
      { transientRecoveryCount: 1 },
      { landedFilesCaptureFallback: true },
      { landedFilesAttributionRestricted: true },
      { mergeTargetSource: "remote" },
      { workspaceLandedFiles: { "repo/a": ["src/a.ts"] } },
      { workspaceCommitFreeBasis: "recorded" },
      { workspaceCommitFreeBranchTipShas: { "repo/a": "abc" } },
    ];
    for (const row of evidenceRows) expect(mergeDetailsCarriesMergeEvidence(row as never)).toBe(true);
  });

  it("refuses to let a placeholder value decide, because a recovery path writes zeros too", () => {
    // A merge that landed nothing legitimately records `filesChanged: 0` and `landedFiles: []`; letting such
    // a value answer "a merge happened" would hand the reset trigger back to the writer that must not own it.
    const placeholderRows = [
      { filesChanged: 0 },
      { insertions: 0, deletions: 0 },
      { landedFiles: [] },
      { workspaceLandedShas: {} },
      { mergeConfirmed: false },
      { commitSha: "" },
      { mergeTargetBranch: "   " },
      { prNumber: 0 },
      { noOpMerge: false },
    ];
    for (const row of placeholderRows) expect(mergeDetailsCarriesMergeEvidence(row as never)).toBe(false);
  });

  it("classifies bookkeeping keys out of the evidence bucket", () => {
    for (const key of MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS) {
      expect(classifyMergeDetailKey(key)).toBe("recovery-bookkeeping");
    }
    expect(MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS).toEqual(["pushRecovery", "mergeBoundaryRecovery", "executionRearm"]);
  });

  it("CENSUS: every declared MergeDetails key has exactly one bucket", () => {
    const declared = declaredMergeDetailKeys();
    // The census is only meaningful if the scan found the real shape.
    expect(declared.length).toBeGreaterThanOrEqual(30);
    expect(declared).toContain("commitSha");
    expect(declared).toContain("executionRearm");

    const unclassified = declared.filter(
      (key) => !MERGE_DETAIL_EVIDENCE_KEYS.includes(key) && !MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS.includes(key),
    );
    expect(unclassified, `unclassified MergeDetails keys: ${unclassified.join(", ")}`).toEqual([]);

    const doubleBooked = MERGE_DETAIL_EVIDENCE_KEYS.filter((key) =>
      MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS.includes(key));
    expect(doubleBooked).toEqual([]);

    const stale = MERGE_DETAIL_EVIDENCE_KEYS.filter((key) => !declared.includes(key));
    expect(stale, `evidence keys no longer declared: ${stale.join(", ")}`).toEqual([]);
  });
});
