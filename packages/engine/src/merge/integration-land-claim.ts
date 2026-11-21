/*
FNXC:MergeSingleFlight 2026-11-21-17:40 (RUFU-1148):
Merge single-flight used to be a fact of ONE process. `ProjectEngine.activeMergeTaskId` and the
`mergeQueue` / `mergeActive` sets bound one pass per Node process, and `onMerge` claimed "only one
merge runs at a time per project" — a claim a second daemon on the same shared board cannot see
(that shared-DB fleet is exactly why `store:open` provenance exists, RUFU-344). Measured on main
`e1cfe1961f`: RUFU-893 advanced `main` at 21:22:16 and finalized at 21:22:41 while RUFU-702 sat
inside its own merge pass on the same branch, and RUFU-702 lost an ALREADY-APPROVED squash four
minutes later to its own RUFU-1100 reconciliation. Ancestry stayed consistent, so nothing rewound —
two overlapping write windows, and the last writer of `refs/heads/main` decided the order.

THE INVARIANT this module enforces: every write that moves an integration ref is claimed by exactly
one task ACROSS processes. The claim is a row in the durable `@fusion/core` workspace-lease seam
(holder = `taskId`, fenced by node + incarnation + monotonic `fenceToken`), never a second in-memory
Set, because an in-memory guard is precisely what failed.

SCOPE OF THE CLAIM (operator decision 2026-11-21, NOT a setting): the git-mutating section only —
base selection through the ref advance and its local sync — and NEVER the AI review or the whole
episode. Two reasons, both measured:
  1. an episode-wide lock caps the board at roughly one landing per hour (observed passes ran 51 to
     64 minutes) against ~450 open cards, i.e. it converts latency into throughput loss;
  2. direct commits to `main` made outside the queue (AGENTS.md permits them; inside RUFU-702's own
     window those were `bca1ed6979` at 21:47:07Z and `aa683491eb`) are NOT claimable by anything
     here. RUFU-1100's rebuild tolerance (`assertCurrentEpisodeIdentity`) therefore stays necessary
     and this claim only complements it — it removes the queue-vs-queue race, not the queue-vs-human
     one, and it must not be sold as removing the need to re-prove a candidate before advancing.

NESTING ORDER is fixed and must not invert: `merge-dispatch:<taskId>`
(`merge/workspace-merge-dispatch-lease.ts`), then `repo:<repoRel>` (the workspace per-repo land
lease), then `integration-land:<repoKey>:<branch>` (this claim). The two outer leases are per-task
and per-sub-repo, so neither one orders two different tasks against the SAME branch; inverting the
order would have the shared resource outlive the per-task lease that is supposed to bound it.

A wait is a named wait, never a failure: contention surfaces as `IntegrationLandClaimBusyError`,
which the merge pump routes to its durable re-enqueue ladder. It writes no `status`, no `error`, and
no `mergeRetries`, because "someone else is writing" is not a merge defect.
*/
import {
  resolveEngineIncarnationId,
  resolveEngineNodeId,
  type TaskStore,
  type WorkspaceLeaseHandle,
} from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";

/** One landing claimed the integration ref. Metadata: `{ taskId, holderTaskId, outcome }`. */
export const INTEGRATION_LAND_ACQUIRED_EVENT = "merge:integration-land-acquired";

/** A second pass found the claim held and waited. Metadata: `{ taskId, holderTaskId, outcome }`. */
export const INTEGRATION_LAND_CONTENDED_EVENT = "merge:integration-land-contended";

/**
 * Default claim TTL. A crashed holder costs the next landing at most this long, because
 * `acquireWorkspaceLeaseAsync` lets a successor take an expired row (outcome `reclaimed-expired`)
 * and `reconcileExpiredWorkspaceLeases` plus `releaseStaleWorkspaceLeasesForNode` clear dead rows
 * earlier. Five minutes comfortably exceeds the longest measured git-mutating burst (squash gates +
 * advance + local sync) while staying far below an episode, which is the whole point of the scope
 * decision above.
 */
export const INTEGRATION_LAND_CLAIM_TTL_MS = 5 * 60_000;

/** Renewal cadence, mirroring `workspace-merge-dispatch-lease.ts`. */
const INTEGRATION_LAND_RENEW_MS = 60_000;

/*
FNXC:MergeSingleFlight 2026-11-21-17:13 (RUFU-1148 — the graph merge timeout's relationship to this claim):
`GRAPH_MERGE_TIMEOUT_MS` (`executor/create-authoritative-workflow-primitives.ts`) returns the graph node
after 30 minutes and frees the lane, while the measured merge passes ran 51 to 64 minutes. That
mismatch is one of the ways two passes came to share one window: the node said "done", the queue
admitted the next card, and the first body was still alive. The relationship is now this:

- The timeout never releases a claim. Nothing outside the holder calls `release`; only the holder's own
  `finally` (when the aborted signal unwinds its stack) or the TTL ending its tenancy can do it.
- A pass that honours the abort releases on the way out, so the successor that the freed lane admits
  acquires normally.
- A pass that ignores it — a long agent call or a git call that has not returned — KEEPS its claim,
  because it is still a live writer of that ref. The re-dispatched pass then meets
  `IntegrationLandClaimBusyError` and waits, which is the correct outcome and the one this module exists
  to produce. Raising the timeout is therefore not what protects the branch; the claim is.

The 60 s renewal is what makes "live" and "dead" distinguishable here: a live pass keeps extending the
5-minute TTL without trying to decide anything, and a dead one stops within five minutes.
*/

/**
 * Contention on the integration ref: another card holds the claim for this repository + branch.
 *
 * The fields are deliberately the ONLY things it can carry — a task id, the holder's task id, and
 * the lease key. No path, no ref tip, no error prose: a decision made from prose is the defect class
 * this card removes, and the pump decides by `instanceof`, never by message matching.
 */
export class IntegrationLandClaimBusyError extends Error {
  readonly retryable = true;

  /**
   * Which claim burst met the contention, set by the landing path when it renames the error.
   * Operator-facing only: the pump decides by `instanceof`, never by this field or the message.
   */
  phase?: "recovery" | "base" | "land";

  constructor(
    readonly taskId: string,
    readonly holderTaskId: string,
    readonly leaseKey: string,
  ) {
    super(`integration branch claim for ${leaseKey} is held by ${holderTaskId}`);
    this.name = "IntegrationLandClaimBusyError";
  }
}

/** A claim this pass holds. `handle` is the durable lease handle; `release` is idempotent. */
export type IntegrationLandClaim = {
  leaseKey: string;
  handle: WorkspaceLeaseHandle;
  taskId: string;
  /** Releases the claim, at most once. A lost release is bounded by the TTL, never by a leak. */
  release: () => Promise<void>;
};

export type IntegrationLandAcquireResult =
  /** The claim is ours. `reclaimed-expired` names a dead holder's row we took over. */
  | { outcome: "acquired" | "reentrant" | "reclaimed-expired"; claim: IntegrationLandClaim }
  /** Another card holds it. Waiting is the correct outcome, so this arm carries no error. */
  | { outcome: "conflict"; holderTaskId: string; leaseKey: string }
  /**
   * The durable seam is not reachable on this store (no `AsyncDataLayer` — a local board with one
   * process, or a test double). Fail OPEN: the in-process single-flight is the only guard such a
   * deployment has and it is sufficient for exactly one process. Turning an unavailable seam into a
   * conflict would livelock every landing on a local board, which is why the absent audit row is the
   * signal here rather than a row claiming a wait that never happened.
   */
  | { outcome: "unavailable"; leaseKey: string };

/**
 * The claim key: one per (repository, integration branch). `repoKey` is `root` for a single-repo
 * landing and the repo-relative path for a workspace sub-repo, so a workspace member never shares a
 * key with the entry repository while two processes landing the SAME branch always do.
 */
export function integrationLandLeaseKey(repoKey: string, integrationBranch: string): string {
  return `integration-land:${repoKey || "root"}:${integrationBranch}`;
}

/** True when this store can carry a durable claim across processes at all. */
function hasDurableLeaseSeam(store: Partial<TaskStore>): boolean {
  return typeof store.acquireWorkspaceLease === "function"
    && typeof store.getAsyncLayer === "function"
    && Boolean(store.getAsyncLayer());
}

/**
 * Acquire the integration-landing claim for `taskId`, holding it until the returned `release` runs.
 *
 * Returns rather than throws on contention so a caller can choose between waiting politely (the pump
 * re-enqueue ladder) and refusing a manual resolver; `acquireIntegrationLandClaim` below is the
 * throwing convenience used by the landing path.
 */
export async function tryAcquireIntegrationLandClaim(
  store: TaskStore,
  input: { taskId: string; repoKey: string; integrationBranch: string; leaseMs?: number },
): Promise<IntegrationLandAcquireResult> {
  const leaseKey = integrationLandLeaseKey(input.repoKey, input.integrationBranch);
  const partial = store as Partial<TaskStore>;
  if (!hasDurableLeaseSeam(partial)) return { outcome: "unavailable", leaseKey };

  const owner = {
    taskId: input.taskId,
    // Node + incarnation are what make this cross-process: a second daemon contends for the same
    // key instead of silently sharing it, and a re-dispatch inside the same process is `reentrant`.
    nodeId: resolveEngineNodeId(),
    incarnationId: resolveEngineIncarnationId(),
  };
  const acquire = partial.acquireWorkspaceLease!;
  const claim = await acquire.call(store, {
    leaseKey,
    /*
    FNXC:MergeSingleFlight 2026-11-21-17:52 (RUFU-1148 — why this claim is kind `land`, not a new kind):
    `workspace_coordination_leases` constrains its own taxonomy: `kind IN
    ('acquire','land','merge-dispatch')` (`workspace_coordination_leases_kind_check`, declared in the
    Postgres schema and created by migration `0060_fn_9059_workspace_coordination_leases.sql`). A fifth
    kind value is therefore DDL, and this card's scope forbids a migration — measured on a provisioned
    board, the first `integration-land` insert died with `23514`. The tenancy is named by its KEY
    (`integration-land:<repoKey>:<branch>`) and its kind says honestly what it is: a claim on one
    landing write window, the same thing `repo:<repoRel>` claims for one sub-repo.

    Sharing the kind also inherits the reclaim that kind already has: `reclaimPhantomWorkspaceLandLeases`
    sweeps held `land` rows, and it yanks one only past its age floor, only when the owner is not
    merge-pending, and only when `requireTerminalOwner` proves the owning card is `done`/`failed`. A
    burst in flight is merge-pending, so it cannot be stolen; a burst whose process died with the card
    terminal is released by the sweep instead of waiting out the TTL.
    */
    kind: "land",
    owner,
    leaseMs: input.leaseMs ?? INTEGRATION_LAND_CLAIM_TTL_MS,
  });

  if (claim.outcome === "conflict") {
    // AC4: the wait is measurable, and only through ids and a fixed enum. `holderTaskId` is the row's
    // owner id; the holder is named so "who was writing" is answerable without reading prose.
    await emitIntegrationLandAudit(store, INTEGRATION_LAND_CONTENDED_EVENT, leaseKey, {
      taskId: input.taskId,
      holderTaskId: claim.conflict.taskId,
      outcome: "conflict",
    });
    return { outcome: "conflict", holderTaskId: claim.conflict.taskId, leaseKey };
  }

  let released = false;
  let handleRef = claim.handle;
  const renew = partial.renewWorkspaceLease;
  const timer = typeof renew === "function"
    ? setInterval(() => {
      // A lost renewal is NOT acted on here: the advance re-proves ownership through
      // `assertIntegrationLandClaimHeld` immediately before the only mutating write, so a dropped
      // TTL cannot produce a silent non-ff write, and a mid-burst abort still releases in `finally`.
      void renew.call(store, handleRef, input.leaseMs ?? INTEGRATION_LAND_CLAIM_TTL_MS)
        .then((next) => { if (next) handleRef = next; })
        .catch(() => undefined);
    }, INTEGRATION_LAND_RENEW_MS)
    : undefined;
  timer?.unref?.();

  const heldClaim: IntegrationLandClaim = {
    leaseKey,
    handle: claim.handle,
    taskId: input.taskId,
    release: async () => {
      // Single-shot: the landing path releases on every linear path and a `finally` re-runs it on the
      // unwinding ones. A second release finds no held row and the seam honestly answers `false`.
      // The renewal timer stops with the first release, so a released claim can never be extended.
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      const release = partial.releaseWorkspaceLease;
      if (typeof release !== "function") return;
      await release.call(store, handleRef).catch(() => undefined);
    },
  };

  await emitIntegrationLandAudit(store, INTEGRATION_LAND_ACQUIRED_EVENT, leaseKey, {
    taskId: input.taskId,
    // AC4: null on an uncontended acquire. The row records that THIS card may now write the ref.
    holderTaskId: null,
    outcome: claim.outcome,
  });

  return { outcome: claim.outcome, claim: heldClaim };
}

/**
 * Acquire or throw. The merge pump's contention ladder turns the thrown error into a re-enqueue, so
 * this is the form the landing path uses; a caller that must distinguish "no seam" from "held" uses
 * `tryAcquireIntegrationLandClaim` directly.
 */
export async function acquireIntegrationLandClaim(
  store: TaskStore,
  input: { taskId: string; repoKey: string; integrationBranch: string; leaseMs?: number },
): Promise<IntegrationLandClaim | undefined> {
  const result = await tryAcquireIntegrationLandClaim(store, input);
  if (result.outcome === "conflict") {
    throw new IntegrationLandClaimBusyError(input.taskId, result.holderTaskId, result.leaseKey);
  }
  return result.outcome === "unavailable" ? undefined : result.claim;
}

/**
 * The fence (AC3): prove THIS pass still owns the claim, including its TTL, immediately before a
 * mutating write. Throws on any other verdict — `superseded` (a successor took the row), `missing`
 * (the row is gone), `unknown` (the stored token is behind ours, i.e. the store cannot be trusted to
 * answer), and an unreadable store all refuse rather than wave the write through.
 */
export async function assertIntegrationLandClaimHeld(
  store: TaskStore,
  claim: IntegrationLandClaim | undefined,
): Promise<void> {
  if (!claim) return;
  const validate = (store as Partial<TaskStore>).validateWorkspaceLeaseFence;
  if (typeof validate !== "function") return;
  const verdict = await validate.call(store, {
    leaseKey: claim.leaseKey,
    owner: claim.handle.owner,
    fenceToken: claim.handle.fenceToken,
  });
  if (verdict !== "valid") {
    /*
    FNXC:MergeSingleFlight 2026-11-21-18:45 (RUFU-1148 Step 2):
    Name the CURRENT holder rather than ourselves. `validateWorkspaceLeaseFence` answers a verdict and
    nothing else, and reporting `holderTaskId: <our own id>` would send an operator to interrogate the
    card that just got refused. `inspectWorkspaceLeases` names who actually holds the row; when that
    read is unavailable or itself fails the field says `unknown`, because a fence refusal that invents a
    holder is worse than one that admits it cannot see.
    */
    const holderTaskId = await readCurrentLeaseHolderTaskId(store, claim.leaseKey);
    throw new IntegrationLandClaimBusyError(claim.taskId, holderTaskId, claim.leaseKey);
  }
}

/** Who holds this lease key right now, or `"unknown"` when the store cannot say. */
async function readCurrentLeaseHolderTaskId(store: TaskStore, leaseKey: string): Promise<string> {
  const inspect = (store as Partial<TaskStore>).inspectWorkspaceLeases;
  if (typeof inspect !== "function") return "unknown";
  try {
    const rows = await inspect.call(store, { leaseKeys: [leaseKey] });
    const live = rows.find((row) => row.leaseKey === leaseKey && row.status === "held");
    // `WorkspaceLease extends WorkspaceLeaseHandle`, so the holder is the row's owner triple.
    return live?.owner.taskId ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Bounded emission (FN-9175): the metadata shape is closed at the call site to exactly AC4's three
 * keys, so a path, a ref tip, or an error sentence is unrepresentable in the row by construction. A
 * sink that is absent, throws, rejects, or never settles cannot change acquire, land, or release.
 */
async function emitIntegrationLandAudit(
  store: TaskStore,
  mutationType: typeof INTEGRATION_LAND_ACQUIRED_EVENT | typeof INTEGRATION_LAND_CONTENDED_EVENT,
  target: string,
  metadata: {
    taskId: string;
    holderTaskId: string | null;
    outcome: "acquired" | "reentrant" | "reclaimed-expired" | "conflict";
  },
): Promise<void> {
  await emitBoundedRunAudit(store as RunAuditSinkHost, {
    mutationType,
    domain: "database",
    target,
    metadata,
  }).catch(() => undefined);
}
