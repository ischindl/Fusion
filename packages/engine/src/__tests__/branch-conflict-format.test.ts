import { describe, expect, it } from "vitest";
import {
  BranchConflictError,
  classifyBranchConflictRefusalFamily,
  desiredPathFor,
  liveCheckoutPathFor,
} from "../execution/branch-conflicts.js";
import {
  formatBranchConflictAgentLog,
  formatBranchConflictLifecycleLog,
} from "../executor/branch-conflict-format.js";

/*
FNXC:BranchPhantomEcho 2026-10-19 (RUFU-376):
The two formatters are what a human actually reads — the card's History line and the agent-log line an
executor session pastes into its own reasoning — and both used to print the acquire's requested path in
the worktree slot. A `foreign-unmerged` refusal has no checkout, so the honest rendering states the
absence: the lifecycle line says the branch is refused and not checked out anywhere, and the key=value
line reads `worktree=none`, the same vocabulary the same function already uses for `stranded=none`.
Appending the desired path with a qualifier was rejected on purpose: in the worktree position of either
line a path is a checkout claim regardless of the words beside it.
*/

const DESIRED = "/repo/.worktrees/fn-500";
const LIVE = "/repo/.worktrees/foreign-fn-500";

function conflict(overrides: Partial<BranchConflictError> = {}) {
  return new BranchConflictError({
    branchName: "fusion/fn-500",
    conflictingWorktreePath: LIVE,
    existingTipSha: "abc123def4567890",
    strandedCommits: [{ sha: "ffee00001111222233334444", subject: "feat: stranded work" }],
    startPoint: "main",
    recommendedAction: "Inspect or reclaim the conflicting checkout before retrying.",
    ...overrides,
  } as BranchConflictError);
}

const noCheckout = () => conflict({ conflictingWorktreePath: "", desiredWorktreePath: DESIRED, collisionKind: "foreign-unmerged" });
const liveCheckout = () => conflict({ desiredWorktreePath: DESIRED, collisionKind: undefined });

describe("branch-conflict log formatters", () => {
  it("states the absence instead of printing the requested path when nothing is checked out", () => {
    const error = noCheckout();
    const lifecycle = formatBranchConflictLifecycleLog("FN-500", error);
    const agent = formatBranchConflictAgentLog("FN-500", error);

    expect(lifecycle).toContain("fusion/fn-500 is refused — it is not checked out in any live worktree");
    expect(agent).toContain("worktree=none");
    expect(lifecycle).not.toContain(DESIRED);
    expect(agent).not.toContain(DESIRED);
    // The rest of the report stays intact — the truthful shape loses the path, not the diagnosis.
    expect(lifecycle).toContain("abc123def456");
    expect(lifecycle).toContain("feat: stranded work");
    expect(agent).toContain("stranded=ffee00001111 feat: stranded work");
  });

  it("keeps naming the checkout it can prove for a live conflict", () => {
    const error = liveCheckout();

    expect(formatBranchConflictLifecycleLog("FN-500", error)).toContain(`is already checked out at ${LIVE}`);
    expect(formatBranchConflictAgentLog("FN-500", error)).toContain(`worktree=${LIVE}`);
    // The requested path is still not a second checkout to advertise.
    expect(formatBranchConflictLifecycleLog("FN-500", error)).not.toContain(DESIRED);
    expect(formatBranchConflictAgentLog("FN-500", error)).not.toContain(DESIRED);
  });

  it("agrees with the refusal sentence about whether a checkout exists", () => {
    /*
    FNXC:BranchPhantomEcho 2026-10-19: the operator used to read a location in the message and an
    absence in the log (or the reverse), because the two rendered from different fields. Both now read
    through `liveCheckoutPathFor`, so the two surfaces cannot disagree and no surface has to re-parse.
    */
    const phantom = noCheckout();
    expect(phantom.message).not.toContain(DESIRED);
    expect(phantom.message).not.toContain(LIVE);
    expect(formatBranchConflictLifecycleLog("FN-500", phantom)).not.toContain(DESIRED);
    expect(formatBranchConflictAgentLog("FN-500", phantom)).not.toContain(DESIRED);

    const live = liveCheckout();
    expect(live.message).toContain(LIVE);
    expect(formatBranchConflictLifecycleLog("FN-500", live)).toContain(LIVE);
    expect(formatBranchConflictAgentLog("FN-500", live)).toContain(LIVE);
  });

  it("classifies both refusal families and nothing else", () => {
    expect(classifyBranchConflictRefusalFamily(noCheckout().message)).toBe("branch-conflict");
    expect(classifyBranchConflictRefusalFamily(liveCheckout().message)).toBe("branch-conflict");
    expect(classifyBranchConflictRefusalFamily(liveCheckout().message.toUpperCase())).toBe("branch-conflict");
    // A persisted sentence recovers the family only — it is not a path source, so unrelated text is null.
    expect(classifyBranchConflictRefusalFamily(`Branch ${DESIRED} was created from main`)).toBeNull();
    expect(classifyBranchConflictRefusalFamily("Worktree removed successfully")).toBeNull();
    expect(classifyBranchConflictRefusalFamily("")).toBeNull();
  });

  it("separates the checkout read from the requested-path read", () => {
    const phantom = noCheckout();
    expect(liveCheckoutPathFor(phantom)).toBe("");
    expect(desiredPathFor(phantom)).toBe(DESIRED);

    const live = liveCheckout();
    expect(liveCheckoutPathFor(live)).toBe(LIVE);
    expect(desiredPathFor(live)).toBe(DESIRED);

    // A refusal constructed with no desired path at all reports no requested path either.
    const bare = conflict({});
    expect(desiredPathFor(bare)).toBe("");
    expect(liveCheckoutPathFor(bare)).toBe(LIVE);
  });
});
