import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { BranchGroup, BranchGroupPrState, MergeTargetResolution, Settings, Task, TaskStore } from "@fusion/core";
import { isBranchGroupMemberLanded, resolveEffectiveGroupAutoMerge, resolveTaskMergeTarget } from "@fusion/core";
import { resolveIntegrationBranch } from "./integration-branch.js";

const execAsync = promisify(exec);

export interface BranchGroupMergeRouting {
  branchGroup: BranchGroup;
  mergeTarget: MergeTargetResolution;
}

export interface BranchGroupCompletionStatus {
  complete: boolean;
  totalMembers: number;
  landedMemberIds: string[];
  pendingMemberIds: string[];
}

export interface BranchGroupPromotionResult {
  groupId: string;
  promoted: boolean;
  alreadyFinalized: boolean;
  reason: "promoted" | "incomplete" | "gated" | "already-finalized" | "group-not-found";
  status: BranchGroup["status"];
  prState: BranchGroupPrState;
  prNumber?: number;
  prUrl?: string;
}

export interface BranchGroupPromotionDecision {
  eligible: boolean;
  groupAutoMerge: boolean;
  reason:
    | "group-automerge-disabled"
    | "settings-automerge-disabled"
    | "global-pause"
    | "engine-paused"
    | "eligible";
}

/**
 * Evaluates branch-group completion using the canonical `@fusion/core`
 * `isBranchGroupMemberLanded` predicate so the engine gate can never diverge
 * from the dashboard route gate. A member is landed iff it was merge-confirmed
 * onto THIS group's branch via the branch-group-integration path; the group is
 * complete iff it has at least one member and every member is landed.
 *
 * `group` (its `branchName`) is required: landing is branch-anchored, so a
 * member done against a sibling/mismatched branch must NOT count as landed.
 */
export function evaluateBranchGroupCompletion(input: {
  members: Pick<Task, "id" | "column" | "branchContext" | "mergeDetails">[];
  group: Pick<BranchGroup, "branchName">;
}): BranchGroupCompletionStatus {
  const landedMemberIds: string[] = [];
  const pendingMemberIds: string[] = [];

  for (const member of input.members) {
    if (isBranchGroupMemberLanded(member, input.group)) {
      landedMemberIds.push(member.id);
    } else {
      pendingMemberIds.push(member.id);
    }
  }

  const totalMembers = input.members.length;
  return {
    complete: totalMembers > 0 && pendingMemberIds.length === 0,
    totalMembers,
    landedMemberIds,
    pendingMemberIds,
  };
}

/**
 * Evaluates branch-group → default-branch PROMOTION eligibility only.
 * This does not perform promotion and does not govern member → group-integration
 * routing, which stays on the FN-5782 task-level auto-merge path.
 */
export function evaluateBranchGroupPromotion(input: {
  group: Pick<BranchGroup, "id" | "branchName" | "autoMerge" | "status">;
  settings: Pick<Settings, "autoMerge" | "globalPause" | "enginePaused">;
}): BranchGroupPromotionDecision {
  const groupAutoMerge = resolveEffectiveGroupAutoMerge(input.group, input.settings);
  if (input.settings.globalPause) {
    return { eligible: false, reason: "global-pause", groupAutoMerge };
  }
  if (input.settings.enginePaused) {
    return { eligible: false, reason: "engine-paused", groupAutoMerge };
  }
  if (!groupAutoMerge) {
    if (input.group.autoMerge === false) {
      return { eligible: false, reason: "group-automerge-disabled", groupAutoMerge };
    }
    return { eligible: false, reason: "settings-automerge-disabled", groupAutoMerge };
  }
  if (!input.settings.autoMerge) {
    return { eligible: false, reason: "settings-automerge-disabled", groupAutoMerge };
  }
  return { eligible: true, reason: "eligible", groupAutoMerge };
}

async function ensureGroupBranchExists(rootDir: string, branchName: string, startPoint: string): Promise<void> {
  const quotedBranch = JSON.stringify(`refs/heads/${branchName}`);
  try {
    await execAsync(`git show-ref --verify --quiet ${quotedBranch}`, { cwd: rootDir });
    return;
  } catch {
    await execAsync(`git branch ${JSON.stringify(branchName)} ${JSON.stringify(startPoint)}`, { cwd: rootDir });
  }
}

/**
 * The only entrypoint allowed to perform shared-branch-group → default-branch promotion.
 * Promotion is intentionally idempotent and must never run inline in aiMergeTask.
 */
export async function promoteBranchGroup(input: {
  store: Pick<TaskStore, "getBranchGroup" | "listTasksByBranchGroup" | "updateBranchGroup">;
  rootDir: string;
  groupId: string;
  settings: Pick<Settings, "autoMerge" | "globalPause" | "enginePaused"> & Partial<Pick<Settings, "mergeStrategy" | "integrationBranch" | "baseBranch">>;
  recordAudit?: (event: {
    domain: string;
    mutationType: string;
    target: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
}): Promise<BranchGroupPromotionResult> {
  const group = input.store.getBranchGroup(input.groupId);
  if (!group) {
    return {
      groupId: input.groupId,
      promoted: false,
      alreadyFinalized: false,
      reason: "group-not-found",
      status: "abandoned",
      prState: "none",
    };
  }

  if (group.status === "finalized" || group.prState === "merged") {
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: true,
      reason: "already-finalized",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  if (group.prState === "open") {
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: true,
      reason: "already-finalized",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  const members = await input.store.listTasksByBranchGroup(group.id);
  const completion = evaluateBranchGroupCompletion({ members, group });
  if (!completion.complete) {
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: false,
      reason: "incomplete",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  const eligibility = evaluateBranchGroupPromotion({ group, settings: input.settings });
  if (!eligibility.eligible) {
    await input.recordAudit?.({
      domain: "git",
      mutationType: "merge:branch-group-promotion-gated",
      target: group.id,
      metadata: {
        groupId: group.id,
        branchName: group.branchName,
        groupAutoMerge: eligibility.groupAutoMerge,
        effectiveEligible: false,
        reason: eligibility.reason,
      },
    });
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: false,
      reason: "gated",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  const integrationBranch = await resolveIntegrationBranch(input.rootDir, input.settings);
  await ensureGroupBranchExists(input.rootDir, group.branchName, integrationBranch);
  const currentBranch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: input.rootDir })).stdout.trim();
  try {
    await execAsync(`git checkout ${JSON.stringify(integrationBranch)}`, { cwd: input.rootDir });
    await execAsync(`git merge --no-ff --no-edit ${JSON.stringify(group.branchName)}`, { cwd: input.rootDir });
  } finally {
    await execAsync(`git checkout ${JSON.stringify(currentBranch)}`, { cwd: input.rootDir });
  }

  const isPrMode = input.settings.mergeStrategy === "pull-request";
  const updatedGroup = input.store.updateBranchGroup(group.id, {
    status: "finalized",
    prState: isPrMode ? "open" : "merged",
  });

  await input.recordAudit?.({
    domain: "git",
    mutationType: "merge:branch-group-promoted",
    target: group.id,
    metadata: {
      groupId: group.id,
      branchName: group.branchName,
      integrationBranch,
      memberIds: completion.landedMemberIds,
      ...(updatedGroup.prNumber ? { prNumber: updatedGroup.prNumber } : {}),
      ...(updatedGroup.prUrl ? { prUrl: updatedGroup.prUrl } : {}),
    },
  });

  return {
    groupId: group.id,
    promoted: true,
    alreadyFinalized: false,
    reason: "promoted",
    status: updatedGroup.status,
    prState: updatedGroup.prState,
    prNumber: updatedGroup.prNumber,
    prUrl: updatedGroup.prUrl,
  };
}

export async function resolveBranchGroupMergeRouting(input: {
  task: Pick<Task, "branchContext" | "baseBranch">;
  store: Pick<TaskStore, "getBranchGroup">;
  projectDefaultBranch: string;
  rootDir?: string;
}): Promise<BranchGroupMergeRouting | null> {
  if (input.task.branchContext?.assignmentMode !== "shared") {
    return null;
  }

  const groupId = input.task.branchContext.groupId;
  const branchGroup = input.store.getBranchGroup(groupId);
  if (!branchGroup) {
    return null;
  }

  if (input.rootDir) {
    await ensureGroupBranchExists(input.rootDir, branchGroup.branchName, input.projectDefaultBranch);
  }

  return {
    branchGroup,
    mergeTarget: resolveTaskMergeTarget(
      { ...input.task, baseBranch: undefined },
      {
        projectDefaultBranch: input.projectDefaultBranch,
        branchGroup,
      },
    ),
  };
}
