import type { Task } from "../types.js";

/*
FNXC:MergeSingleFlight 2026-11-21-17:52 (RUFU-1148):
The integration-landing claim (RUFU-1148) is a FOURTH tenancy over this table, and it reuses
`kind: "land"` rather than adding a fifth kind value. The reason is measured, not stylistic: `kind`
is `text` but the table carries `workspace_coordination_leases_kind_check CHECK(kind IN
('acquire','land','merge-dispatch'))` (postgres schema `project.ts`, created by migration
`0060_fn_9059_workspace_coordination_leases.sql`), so a new kind value is a DDL change, and RUFU-1148
declared migrations out of scope. Measured on a provisioned PostgreSQL board: the first insert of
`kind = 'integration-land'` died with `23514 violates check constraint
workspace_coordination_leases_kind_check` — a unit run against a store double cannot see that, which
is why `merge-integration-land.pg.test.ts` exists.

What distinguishes the tenancies is therefore the KEY namespace, not the kind: the workspace sub-repo
land lease owns `repo:<repoRel>` and RUFU-1148's claim owns `integration-land:<repoKey>:<branch>`
(derived in `packages/engine/src/merge/integration-land-claim.ts`). A reader that wants one family
filters on `lease_key LIKE 'integration-land:%'`; a reader that wants every landing claim reads
`kind = 'land'`, which is honest — both are claims on a landing write window. The claim nests INSIDE
`merge-dispatch:<taskId>` and `repo:<repoRel>` — never the reverse.
*/
export type WorkspaceLeaseKind = "acquire" | "land" | "merge-dispatch";
export type WorkspaceLeaseStatus = "held" | "released" | "expired";
export type WorkspaceLeaseOwner = { taskId: string; nodeId: string; incarnationId: string; runId?: string };
export type WorkspaceLeaseHandle = { leaseKey: string; owner: WorkspaceLeaseOwner; fenceToken: bigint; expiresAt: string; fenceRefName?: string; fenceRefSha?: string };
export type WorkspaceLeaseClaimOutcome = "acquired" | "reentrant" | "reclaimed-expired" | "conflict";
export type WorkspaceLeaseFenceOutcome = "valid" | "superseded" | "missing" | "unknown";
export type WorkspaceLandIntentResolution = "landed" | "not-landed";
export type WorkspaceLandIntentResolveOutcome = "resolved" | "lease-live" | "stale-intent" | "superseded" | "missing";
export type WorkspaceLeaseReclaimOutcome = "reclaimed" | "stale-precondition" | "still-live" | "owner-unresolvable" | "missing";
export interface WorkspaceLease extends WorkspaceLeaseHandle { kind: WorkspaceLeaseKind; status: WorkspaceLeaseStatus; acquiredAt: string; renewedAt: string; }
export interface WorkspaceLeaseConflict { leaseKey: string; taskId: string; nodeId: string; incarnationId: string; fenceToken: bigint; expiresAt: string; }
export type AcquireWorkspaceLeaseResult = { outcome: Exclude<WorkspaceLeaseClaimOutcome, "conflict">; handle: WorkspaceLeaseHandle } | { outcome: "conflict"; conflict: WorkspaceLeaseConflict };
export interface WorkspaceLandIntent { taskId: string; repoRelPath: string; remoteUrl: string; integrationRef: string; intendedSha: string; expectedTip: string; fenceRefName: string; fenceRefSha: string; owner: WorkspaceLeaseOwner; fenceToken: bigint; status: "pending" | "recorded" | "abandoned"; resolvedSha?: string; resolution?: WorkspaceLandIntentResolution; createdAt: string; updatedAt: string; resolvedAt?: string; }

/**
 * FNXC:Workspace 2026-08-15-08:23:
 * Store reclaim and workspace self-healing share this deliberately narrow
 * terminal rule so either cannot reclaim a task the other considers live.
 *
 * DELIBERATE-LITERAL — narrow terminal-owner rule (FN-9059). A lease-owner row is
 * read without its workflow context, so resolving the complete lane per-workflow
 * here would let a resolver failure make a live owner read as terminal and allow a
 * competing reclaim. The legacy `done` literal is the intentionally conservative
 * shared floor for both reclaim paths.
 */
export function isTerminalWorkspaceLeaseOwner(row: Pick<Task, "column" | "status"> | null | undefined): boolean {
  return row != null && (row.column === "done" || row.status === "failed");
}
