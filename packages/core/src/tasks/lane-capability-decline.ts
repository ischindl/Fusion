import type { Agent, Task } from "../types.js";
import { formatRoleMismatchReason, getAgentAssignmentPolicy, type AgentAssignmentPolicyInput } from "../agents/agent-role-policy.js";

/** The partial-lane shape the policy accepts (`RoleTaggedAgent`, exported as `AgentAssignmentPolicyInput`). */
type LaneInput = AgentAssignmentPolicyInput & Pick<Agent, "id">;
import { buildTaskExternalBlockPatch, formatTaskExternalBlockReason, type TaskExternalBlock } from "./task-external-block.js";

/*
FNXC:LaneCapabilityDecline 2026-09-26-19:40:
RUFU-272: an implementation-class card whose durable owner lane cannot execute it (audit-only roles,
`assignmentPolicy: "none"`, or a renamed board where the legacy column vocabulary no longer matched)
used to re-queue every heartbeat with nothing an operator could read. The named-decline pattern
(RUFU-243/RUFU-248) requires the refusal to be NAMED: on the task row (error text + external block),
in the agent log, and in run-audit. This module is the single contract for that sentence, its
persisted code, its classifier, and the no-eligible-lane freeze patch.

Deliberately modeled on `overlap-wait-release.ts` (the canonical named-decline shape). The freeze
reuses the EXISTING external-block surface with origin `project-configuration` — the mismatch is a
lane-setup defect the operator remedies by editing lane roles/assignmentPolicy or reassigning the
card — so no new origin enum value exists and the dashboard needs no new component.
*/

/** The persisted decline code. Matches the classifier on both the error prefix and the block code. */
export const LANE_CAPABILITY_DECLINE_CODE = "lane-capability-mismatch";

/** The remedy sentence the operator sees next to the reused role-mismatch reason. */
export const LANE_CAPABILITY_DECLINE_REMEDY =
  "Remedy: reassign the card to an executor (or engineer with backlog auto-claim) lane, or set this lane's role tags / assignment policy in its agent settings.";

/**
 * The one sentence every decline surface (task error, agent log, run-audit reason) shares: the
 * reused `formatRoleMismatchReason` verdict sentence (names lane id, roles/policy, task id) plus
 * the operator remedy. Never invent decline prose elsewhere — grep this symbol instead.
 */
export function formatLaneCapabilityDeclineReason(
  agent: LaneInput,
  task: Pick<Task, "id" | "column">,
): string {
  return `${formatRoleMismatchReason(agent, task)} ${LANE_CAPABILITY_DECLINE_REMEDY}`;
}

/** Policy the decline names — surfaced separately so callers dedup on (lane, column, policy). */
export function laneCapabilityDeclinePolicy(agent: AgentAssignmentPolicyInput): string {
  const policy = getAgentAssignmentPolicy(agent);
  const roles = agent.roles?.length ? agent.roles : agent.role ? [agent.role] : [];
  return `${policy}/[${roles.join(",")}]`;
}

/**
 * Build the freeze patch for an eligible-lane-less stranded card. Captures the card's CURRENT
 * column / step / worktree / branch as the resume point (the freeze must return it there, rename
 * included), names the declining owner in the message, and keeps the owner un-cleared — the freeze
 * is the operator decision point, and unowning the card would hide who the decline named.
 */
export function buildLaneCapabilityFreezePatch(
  task: Pick<Task, "id" | "column" | "currentStep" | "worktree" | "branch">,
  decliningAgent: LaneInput,
): Partial<Task> {
  const externalBlock: TaskExternalBlock = {
    origin: "project-configuration",
    code: LANE_CAPABILITY_DECLINE_CODE,
    message: formatLaneCapabilityDeclineReason(decliningAgent, task),
    source: "dependency-readiness",
    blockedAt: new Date().toISOString(),
    resume: {
      column: task.column,
      currentStep: task.currentStep ?? 0,
      worktree: task.worktree,
      branch: task.branch,
    },
  };
  return buildTaskExternalBlockPatch(externalBlock);
}

/**
 * Classifier over the persisted shapes the freeze writes: the `BLOCKED: project-configuration/
 * lane-capability-mismatch: …` error prefix and/or the structured `externalBlock.code`. Matches the
 * exact builder output (round-trip pinned in tests), so a card carrying any OTHER decline or block
 * is never mistaken for this one.
 */
export function isLaneCapabilityDecline(
  task: Pick<Task, "error" | "externalBlock">,
): boolean {
  if (task.externalBlock?.code === LANE_CAPABILITY_DECLINE_CODE) return true;
  const prefix = formatTaskExternalBlockReason({
    origin: "project-configuration",
    code: LANE_CAPABILITY_DECLINE_CODE,
    message: "",
  });
  return typeof task.error === "string" && task.error.startsWith(prefix);
}

/** True when the card already carries THIS decline — the freeze is applied at most once per card. */
export function hasLaneCapabilityFreeze(
  task: Pick<Task, "status" | "error" | "externalBlock" | "paused" | "pausedReason">,
): boolean {
  return task.externalBlock?.code === LANE_CAPABILITY_DECLINE_CODE;
}
