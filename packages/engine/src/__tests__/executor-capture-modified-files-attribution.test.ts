import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";
import * as attributionModule from "../execution/branch-attribution.js";

/*
FNXC:WorktreeAttribution 2026-11-19-02:48 (RUFU-669):
These cases pin the contamination row's three buckets. `foreignCommitShas` is the operator's answer to
"whose work is on this branch", so a commit that names no card rides in `nonAttributedCommitCount`
instead, and a card's own commit is named by NEITHER bucket. Measured on SANE-489
(saneca workspace, proj_e70af3a5554a4f03, 2026-10-14): the row fired five times naming the card's own
commit `d2447193ebf…` (`test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)`).
*/
describe("RUFU-5039/RUFU-669 captureModifiedFiles contamination audit metadata", () => {
  const makeExecutor = () => new TaskExecutor({ on: () => {} } as never, "/repo");

  it("emits no contamination row when raw and attributed file counts match", async () => {
    const executor = makeExecutor();
    const filterMock = vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["own.ts"],
      foreignCommits: [],
      unattributedCommits: [],
      ownCommitCount: 1,
      rawDiffFileCount: 1,
      commitAttributions: [],
    });

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", { database: vi.fn() }, "post-session");

    expect(files).toEqual(["own.ts"]);
    expect(filterMock).toHaveBeenCalledTimes(1);
    filterMock.mockRestore();
  });

  /*
  FNXC:WorktreeAttribution 2026-11-19-02:48 (RUFU-669): The mixed fixture: one own commit, one commit
  positively attributed to another card, one commit naming nothing. Exactly one sha may appear in
  `foreignCommitShas`, and the unlabelled commit must be visible as its own count.
  */
  it("reports the foreign sha and the unattributed count as separate buckets", async () => {
    const executor = makeExecutor();
    const filterMock = vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["own.ts"],
      foreignCommits: [{ sha: "abc", subject: "feat(FN-1000): foreign", attributedTaskId: "FN-1000" }],
      unattributedCommits: [{ sha: "def", subject: "chore: vendor bump" }],
      ownCommitCount: 1,
      rawDiffFileCount: 3,
      commitAttributions: [],
    });
    const audit = { database: vi.fn(async () => undefined) };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", audit, "scope-leak-guard");

    expect(files).toEqual(["own.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      target: "FN-5039",
      metadata: expect.objectContaining({
        rawDiffFileCount: 3,
        attributedFileCount: 1,
        foreignCommitCount: 1,
        foreignCommitShas: ["abc"],
        nonAttributedCommitCount: 1,
        source: "scope-leak-guard",
      }),
    }));
    filterMock.mockRestore();
  });

  /*
  FNXC:WorktreeAttribution 2026-11-19-02:48 (RUFU-669): The reported SANE-489 shape end to end at this
  seam: a card whose only commits name itself mid-subject owns every raw-diff file, so the divergence
  that triggered the row disappears entirely — no row, and the files stay visible.
  */
  it("emits no contamination row when every commit names the executing card mid-subject", async () => {
    const executor = makeExecutor();
    const filterMock = vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["ui/guards.spec.ts", "ui/legacy-shapes.spec.ts"],
      foreignCommits: [],
      unattributedCommits: [],
      ownCommitCount: 1,
      ownCommitShas: ["d2447193ebf00000000000000000000000000000"],
      rawDiffFileCount: 2,
      commitAttributions: [
        {
          sha: "d2447193ebf000000000000000000000000000000",
          subject: "test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)",
          kind: "own",
          source: "own-mention",
          attributed: true,
          attributedTaskId: "SANE-489",
        },
      ],
    });
    const audit = { database: vi.fn(async () => undefined) };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "SANE-489", audit, "post-session");

    expect(files).toEqual(["ui/guards.spec.ts", "ui/legacy-shapes.spec.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
    filterMock.mockRestore();
  });

  /*
  FNXC:WorktreeAttribution 2026-11-19-02:48 (RUFU-669): A file-set gap caused only by unlabelled work is
  still a real gap, so the row must still fire — with zero foreign shas. Silencing it would hide the
  divergence; the honest difference is which bucket the count lands in.
  */
  it("still reports the row for an unattributed-only gap, naming no foreign sha", async () => {
    const executor = makeExecutor();
    const filterMock = vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["own.ts"],
      foreignCommits: [],
      unattributedCommits: [{ sha: "def", subject: "chore: vendor bump" }],
      ownCommitCount: 1,
      rawDiffFileCount: 2,
      commitAttributions: [],
    });
    const audit = { database: vi.fn(async () => undefined) };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", audit, "post-session");

    expect(files).toEqual(["own.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        foreignCommitCount: 0,
        nonAttributedCommitCount: 1,
      }),
    }));
    const metadata = audit.database.mock.calls[0][0].metadata;
    expect(metadata.foreignCommitShas).toEqual([]);
    filterMock.mockRestore();
  });
});
