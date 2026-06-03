import { describe, expect, it } from "vitest";

import { isBranchGroupComplete, isBranchGroupMemberLanded } from "../branch-group-completion.js";
import type { BranchGroup, Task } from "../types.js";

const GROUP_BRANCH = "fusion/groups/planning-x";

const group = { branchName: GROUP_BRANCH } as Pick<BranchGroup, "branchName">;

function landedMember(): Pick<Task, "mergeDetails"> {
  return {
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: GROUP_BRANCH,
    },
  };
}

describe("isBranchGroupMemberLanded", () => {
  it("returns true when merge is confirmed onto the group branch via integration", () => {
    expect(isBranchGroupMemberLanded(landedMember(), group)).toBe(true);
  });

  it("returns false when mergeTargetBranch does not match the group branch", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: "fusion/fn-sibling",
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when the merge is not confirmed", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: false,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: GROUP_BRANCH,
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when the merge target source is not branch-group-integration", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "project-default",
            mergeTargetBranch: GROUP_BRANCH,
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when there are no merge details", () => {
    expect(isBranchGroupMemberLanded({}, group)).toBe(false);
  });
});

describe("isBranchGroupComplete", () => {
  it("returns true when every member is landed", () => {
    expect(isBranchGroupComplete([landedMember(), landedMember()], group)).toBe(true);
  });

  it("returns false when one member is not landed", () => {
    expect(isBranchGroupComplete([landedMember(), {}], group)).toBe(false);
  });

  it("returns false for an empty membership", () => {
    expect(isBranchGroupComplete([], group)).toBe(false);
  });
});
