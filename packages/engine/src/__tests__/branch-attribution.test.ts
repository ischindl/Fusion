import { describe, expect, it, vi } from "vitest";
import { TASK_ID_TOKEN_PROSE_SOURCE } from "@fusion/core";
import {
  OWN_MENTION_SCAN_SOURCE,
  SilentNoOpAttributionMismatchError,
  BranchAttributionError,
  classifyCommitAttribution,
  collectOwnTaskCommitsForRange,
  filterFilesToOwnTaskCommits,
  type CommitAttributionKind,
  type AttributionSource,
} from "../execution/branch-attribution.js";

describe("FN-5039 branch-attribution", () => {
  it("returns empty attribution for empty range", async () => {
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result).toEqual({
      files: [],
      foreignCommits: [],
      unattributedCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 0,
      commitAttributions: [],
    });
  });

  it("collects files from own-attributed commits only", async () => {
    const log = [
      "sha-own-1\x00own one\x00body\nFusion-Task-Id: FN-5039\n\x1e",
      "sha-own-2\x00own two\x00body\nFusion-Task-Id: FN-5039\n\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\na.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result.files).toEqual(["a.ts", "b.ts"]);
    expect(result.ownCommitCount).toBe(2);
    expect(result.foreignCommits).toEqual([]);
    expect(result.rawDiffFileCount).toBe(2);
  });

  /*
  FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
  This case used to be named "treats foreign and untrailered commits as foreign", and that name WAS the
  defect: an untrailered commit names no card, so it belongs in the third bucket, not in the array the
  operator reads as "another card's work is on my branch". The FILE behavior is deliberately unchanged —
  `task-untrailered` files are still excluded — only the classification and the reported shas moved.
  */
  it("separates a foreign card's commit from a commit that names no card", async () => {
    const log = [
      "sha-own\x00own\x00notes\nFusion-Task-Id: FN-5039\n\x1e",
      "sha-foreign\x00foreign\x00notes\nFusion-Task-Id: FN-1111\n\x1e",
      "sha-none\x00none\x00notes without trailer\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "task.ts\nforeign.ts\nunt.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "task.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result.files).toEqual(["task.ts"]);
    expect(result.foreignCommits).toEqual([
      { sha: "sha-foreign", subject: "foreign", attributedTaskId: "FN-1111" },
    ]);
    expect(result.unattributedCommits).toEqual([{ sha: "sha-none", subject: "none" }]);
    expect(result.commitAttributions.map((entry) => entry.kind)).toEqual(["own", "foreign", "unattributed"]);
    expect(result.commitAttributions.map((entry) => entry.attributed)).toEqual([true, false, false]);
  });

  it("throws BranchAttributionError on malformed git log output", async () => {
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "x.ts\n" })
      .mockResolvedValueOnce({ stdout: "\x00missing sha\x00body\x1e" });

    await expect(
      filterFilesToOwnTaskCommits({
        worktreePath: "/tmp/wt",
        baseRef: "base",
        taskId: "FN-5039",
        execAsyncImpl: execMock as never,
      }),
    ).rejects.toBeInstanceOf(BranchAttributionError);
  });

  it("FN-5083 hotfix: falls back to conventional-commit subject when trailer is missing", async () => {
    // Commit subjects use feat(FN-5039):, fix(FN-5039):, test(FN-5039): with EMPTY trailers —
    // the exact pattern that stranded FN-5060/FN-5083/FN-5053 in production.
    const log = [
      "sha-a\x00feat(FN-5039): step 2\x00body without trailer\x1e",
      "sha-b\x00fix(FN-5039): step 3 fixup\x00body without trailer\x1e",
      "sha-c\x00test(FN-5039): step 4 coverage\x00body without trailer\x1e",
      "sha-d\x00chore(FN-1111): foreign commit\x00body without trailer\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\nc.ts\nd.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\n" })
      .mockResolvedValueOnce({ stdout: "c.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    // Three own commits attributed by subject; one foreign attributed by subject.
    expect(result.ownCommitCount).toBe(3);
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.foreignCommits).toEqual([
      { sha: "sha-d", subject: "chore(FN-1111): foreign commit", attributedTaskId: "FN-1111" },
    ]);
  });

  it("FN-5083 hotfix: accepts bracketed and colon-prefix legacy subject styles", async () => {
    const log = [
      "sha-a\x00[KB-42] legacy bracket style\x00body\x1e",
      "sha-b\x00KB-42: legacy colon style\x00body\x1e",
      "sha-c\x00feat(kb-42): lowercase convention\x00body\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\nc.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\n" })
      .mockResolvedValueOnce({ stdout: "c.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "KB-42",
      execAsyncImpl: execMock as never,
    });

    expect(result.ownCommitCount).toBe(3);
    expect(result.foreignCommits).toEqual([]);
  });

  it("FN-5304: collectOwnTaskCommitsForRange counts only attributable commits", async () => {
    const log = [
      "sha-a\x00fix(FN-5304): one\x00body\x1e",
      "sha-b\x00fix(FN-9999): foreign\x00body\x1e",
      "sha-c\x00chore: none\x00body\x1e",
    ].join("");
    const execMock = vi.fn().mockResolvedValueOnce({ stdout: log });

    const result = await collectOwnTaskCommitsForRange({
      worktreePath: "/tmp/wt",
      rangeRef: "base..fusion/fn-5304",
      taskId: "FN-5304",
      execAsyncImpl: execMock as never,
    });

    expect(result).toEqual({ ownCommitCount: 1, ownCommitShas: ["sha-a"], unattributedCommitCount: 1 });
  });

  it("RUFU-669: collectOwnTaskCommitsForRange counts an own-mention commit as own work", async () => {
    const log = [
      "sha-mention\x00test(ui): gardyske tvary (SANE-489 AC1-AC4, krok 6)\x00body\x1e",
      "sha-b\x00chore: vendor bump\x00body\x1e",
    ].join("");
    const execMock = vi.fn().mockResolvedValueOnce({ stdout: log });

    const result = await collectOwnTaskCommitsForRange({
      worktreePath: "/tmp/wt",
      rangeRef: "base..fusion/sane-489",
      taskId: "SANE-489",
      execAsyncImpl: execMock as never,
    });

    expect(result).toEqual({ ownCommitCount: 1, ownCommitShas: ["sha-mention"], unattributedCommitCount: 1 });
  });

  it("FN-5304: SilentNoOpAttributionMismatchError carries expected metadata", () => {
    const err = new SilentNoOpAttributionMismatchError({
      taskId: "FN-5304",
      recordedSha: "recorded123",
      rebaseMergeBaseSha: "base123",
      sourceBranchRef: "fusion/fn-5304",
      sourceBranchOwnCommitCount: 2,
      sourceBranchOwnCommitShas: ["own1", "own2"],
    });

    expect(err.name).toBe("SilentNoOpAttributionMismatchError");
    expect(err.taskId).toBe("FN-5304");
    expect(err.recordedSha).toBe("recorded123");
    expect(err.rebaseMergeBaseSha).toBe("base123");
    expect(err.sourceBranchRef).toBe("fusion/fn-5304");
    expect(err.sourceBranchOwnCommitCount).toBe(2);
    expect(err.sourceBranchOwnCommitShas).toEqual(["own1", "own2"]);
    expect(err.message).toContain("silent no-op attribution mismatch");
  });

  it("throws BranchAttributionError when git command fails", async () => {
    const execMock = vi.fn().mockRejectedValueOnce(new Error("fatal: bad revision"));

    await expect(
      filterFilesToOwnTaskCommits({
        worktreePath: "/tmp/wt",
        baseRef: "bad",
        taskId: "FN-5039",
        execAsyncImpl: execMock as never,
      }),
    ).rejects.toBeInstanceOf(BranchAttributionError);
  });
});

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
Shared attribution fixture table. The SAME table text lives in
`packages/dashboard/src/__tests__/attribute-done-range-files.test.ts` (over the dashboard route's local
copy of the classifier) and here (over the canonical `classifyCommitAttribution`), so the two
implementations cannot drift apart unnoticed — the dashboard copy stays local by the spawn-economy and
caching design of `attribute-done-range-files.ts`, and its master is
`packages/engine/src/execution/branch-attribution.ts`. Keep both tables byte-identical.

Row 0 is the reported SANE-489 commit verbatim: the operator's card was accused of contamination by a
commit whose own subject named it, three commits deep and none of them on main.
*/
type AttributionFixture = {
  name: string;
  subject: string;
  body: string;
  taskId: string;
  kind: CommitAttributionKind;
  source: AttributionSource;
  attributedTaskId: string | null;
};

const ATTRIBUTION_FIXTURES: AttributionFixture[] = [
  {
    name: "own-mention",
    subject: "test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)",
    body: "",
    taskId: "SANE-489",
    kind: "own",
    source: "own-mention",
    attributedTaskId: "SANE-489",
  },
  {
    name: "own-prefix",
    subject: "feat(SANE-489): x",
    body: "",
    taskId: "SANE-489",
    kind: "own",
    source: "subject-prefix",
    attributedTaskId: "SANE-489",
  },
  {
    name: "unattributed",
    subject: "chore: vendor bump",
    body: "",
    taskId: "SANE-489",
    kind: "unattributed",
    source: "none",
    attributedTaskId: null,
  },
  {
    name: "foreign",
    subject: "feat(OTHER-9): x",
    body: "",
    taskId: "SANE-489",
    kind: "foreign",
    source: "subject-prefix",
    attributedTaskId: "OTHER-9",
  },
  {
    name: "trailer-names-own-card-under-a-foreign-subject",
    subject: "feat(OTHER-9): x",
    body: "Fusion-Task-Id: SANE-489",
    taskId: "SANE-489",
    kind: "own",
    source: "trailer",
    attributedTaskId: "SANE-489",
  },
  {
    name: "trailer-beats-mention",
    subject: "test(ui): zdieľané tvary (SANE-489 AC2, krok 3)",
    body: "Fusion-Task-Id: OTHER-9",
    taskId: "SANE-489",
    kind: "foreign",
    source: "trailer",
    attributedTaskId: "OTHER-9",
  },
  {
    name: "longer-number",
    subject: "chore: bump vendored SANE-4890 shim",
    body: "",
    taskId: "SANE-489",
    kind: "unattributed",
    source: "none",
    attributedTaskId: null,
  },
  {
    name: "merge-subject",
    subject: "Merge branch 'main' into fusion/sane-489",
    body: "",
    taskId: "SANE-489",
    kind: "unattributed",
    source: "none",
    attributedTaskId: null,
  },
];

describe("RUFU-669 canonical commit attribution contract", () => {
  it.each(ATTRIBUTION_FIXTURES)("$name", ({ subject, body, taskId, kind, source, attributedTaskId }) => {
    expect(classifyCommitAttribution({ subject, body, taskId })).toEqual({
      kind,
      source,
      attributedTaskId,
    });
  });

  it("scans free text with the ONE task-id grammar the rest of the product uses", () => {
    // `branch-conflicts.ts` re-exports core's dictionary (identity is pinned by
    // task-id-token-source-single-dictionary.test.ts); composing over the SAME string is what keeps the
    // own-mention tier from inventing its own id alphabet (RUFU-292 / RUFU-352 / RUFU-730).
    expect(OWN_MENTION_SCAN_SOURCE).toBe(`(?<![\\w-])(${TASK_ID_TOKEN_PROSE_SOURCE})`);
  });

  it("never rescues a generated merge subject but still honours a hand-written Merge sentence", () => {
    expect(classifyCommitAttribution({ subject: "Merge remote-tracking branch 'origin/main'", body: "", taskId: "SANE-489" }).kind).toBe("unattributed");
    expect(classifyCommitAttribution({ subject: "Merge the vendor fork (SANE-489, krok 2)", body: "", taskId: "SANE-489" }).kind).toBe("own");
  });

  it("attributes a digit-bearing prefix and a lowercase mention identically", () => {
    expect(classifyCommitAttribution({ subject: "fix(SANE4-42): x", body: "", taskId: "sane4-42" }).source).toBe("subject-prefix");
    expect(classifyCommitAttribution({ subject: "docs: note sane-489 follow-up", body: "", taskId: "SANE-489" }).source).toBe("own-mention");
  });

  it("does not rescue a token embedded in a longer hyphenated compound", () => {
    expect(classifyCommitAttribution({ subject: "chore: rebuild step-3-build cache", body: "", taskId: "STEP-3" }).kind).toBe("unattributed");
    expect(classifyCommitAttribution({ subject: "chore: see x-SANE-489 note", body: "", taskId: "SANE-489" }).kind).toBe("unattributed");
  });
});
