import type { StallAgent } from "./stallReason";

/*
FNXC:StallReason 2026-09-02-22:35 (RUFU-177):
One mapper from a board/API agent record to the `StallContext.agent` shape, used by every surface that
calls `resolveStallReason` (card / list rows / cards / detail banner). Pure and browser-safe: no `node:*`
and no `@fusion/core` runtime import (the dashboard resolver stays browser-safe;
`scripts/check-no-node-only-core-imports-in-dashboard.mjs` must stay green).

The owner guard is load-bearing: surfaces resolve the agent through a shared project-wide agents map
(`useAgentsMapCache`), so a stale map entry or a reassignment race could hand the resolver an agent that
no longer owns the card. An approval wait on agent B must never stall agent A's card, so an agent whose
`id` disagrees with the task's `assignedAgentId` maps to `undefined` -- the classifier then behaves
exactly as if no agent were wired.
*/

/** The only task fields the mapper needs; keeps it usable with card-shaped tasks, list rows, and full tasks. */
export interface StallAgentTaskRef {
  assignedAgentId?: string | null;
}

/**
 * The structural minimum of a board/API agent record (`Agent` widens these with richer literal types,
 * which remain assignable). Deliberately not importing the `Agent` type so the mapper stays testable
 * with plain fixtures.
 */
export interface StallAgentRecord {
  id?: string;
  state?: string;
  pauseReason?: string | null;
  lastError?: string | null;
  pendingApprovalCount?: number | null;
}

/**
 * Map the owning agent onto the resolver's `StallAgent`, or `undefined` when there is no (or no owning)
 * agent. Field-for-field pass-through with null→undefined normalization so the resolver's `?? 0` /
 * truthiness checks see exactly the values its `StallAgent` contract promises.
 */
export function toStallAgent(
  task: StallAgentTaskRef,
  agent: StallAgentRecord | null | undefined,
): StallAgent | undefined {
  if (!agent) return undefined;
  if (task.assignedAgentId && agent.id && agent.id !== task.assignedAgentId) return undefined;
  return {
    state: agent.state,
    pauseReason: agent.pauseReason ?? undefined,
    lastError: agent.lastError ?? undefined,
    pendingApprovalCount: agent.pendingApprovalCount ?? undefined,
  };
}
