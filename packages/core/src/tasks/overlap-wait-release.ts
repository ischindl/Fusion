import type { Task } from "../types.js";
import type { OverlapWaitDeliverySnapshot, TaskOverlapWait } from "../types/task/task-overlap-wait.js";
import { taskHoldsUnmergedCheckout } from "./file-scope-lease.js";

/*
FNXC:OverlapWaitRelease 2026-09-17-06:29:
A file-scope wait is not a promise that its predecessor will deliver. Reset, deletion and completion
release that scheduling dependency. Preserve concrete landed evidence for checkout synchronization,
but retire an abandoned execution with no delivery instead of waiting forever for files it cannot publish.
Explicit task.dependencies remain operator intent; only stale scheduling indicators are cleared.
*/
export const OVERLAP_DELIVERY_UNAVAILABLE_ERROR = "Delivered file evidence is not yet available for overlap synchronization";
export type OverlapPredecessorRelease = "reset" | "deleted" | "complete" | "missing" | "delivered" | "vacant";

/*
FNXC:OverlapWaitRelease 2026-11-04-09:55 (RUFU-469):
The two lane sets the release decision reasons over, passed as ONE bag so a caller cannot supply the
complete lanes it already had and silently omit the WIP lanes the new face refuses on. Every existing
caller passed `completeColumns` positionally; widening it here is what forces both to resolve the WIP
lanes for the same holder rather than defaulting to an empty set, which would release a live lease.
*/
export interface OverlapReleaseLanes {
  /** Lanes that end the predecessor's obligation outright (the `complete` face). */
  completeColumns: ReadonlySet<string>;
  /** Lanes that treat the predecessor as still executing regardless of its checkout (the `delivered` face). */
  wipColumns: ReadonlySet<string>;
}

/*
FNXC:OverlapWaitRelease 2026-11-04-02:10 (RUFU-373):
Both sentences that mean "this card is waiting on a file-scope predecessor" are recoverable, and they stay
recoverable AFTER the heartbeat acquisition cap has wrapped one of them. SANE-436's live row read
`Worktree acquisition failed after 3 heartbeat attempts for branch "fusion/sane-436": Delivered file evidence
is not yet available for overlap synchronization`; the exact-match version of this predicate could not see
it, so neither the released-overlap-waits sweep nor the heartbeat retry-cap gate could resume a card whose
wait had already composed out — permanently, even after its predecessor landed.

The wrapper is stripped by SHAPE, not by matching the message body, and only a worktree-acquisition wrapper
is stripped: a non-overlap exhaustion message ("fatal: not a git repository") must stay unrecoverable so an
ordinary broken checkout still gets its bounded retries. The inner sentence is then compared exactly, keeping
the predicate's existing no-substring semantics.
*/
const WORKTREE_ACQUISITION_WRAPPER = /^Worktree acquisition failed after \d+ heartbeat attempts for branch "[^"]*":\s*(.+)$/;

export function isRecoverableOverlapWaitFailure(error: string | null | undefined): boolean {
  if (typeof error !== "string") return false;
  const unwrapped = WORKTREE_ACQUISITION_WRAPPER.exec(error)?.[1] ?? error;
  return unwrapped === OVERLAP_DELIVERY_UNAVAILABLE_ERROR
    || /^Overlap synchronization episode [\w-]+ changed before (claim|publication)$/.test(unwrapped);
}

export function overlapDeliverySnapshots(task: Pick<Task, "id" | "lineageId" | "mergeDetails" | "summary">): OverlapWaitDeliverySnapshot[] {
  const details = task.mergeDetails;
  if (!details) return [];
  const repositories = [...new Set([...Object.keys(details.workspaceLandedShas ?? {}), ...Object.keys(details.workspaceLandedFiles ?? {})])];
  if (repositories.length) return repositories.map((repository) => {
    const landedSha = details.workspaceLandedShas?.[repository];
    const files = details.workspaceLandedFiles?.[repository];
    return {
      blockerTaskId: task.id, blockerLineageId: task.lineageId, repository, landedSha,
      target: details.mergeTargetBranch, summary: task.summary,
      paths: files?.map((path) => ({ repository, path, status: "modified" as const })),
      noOp: Array.isArray(files) && files.length === 0 && !landedSha,
      evidence: "workspace-landing" as const,
    };
  });
  return [{
    blockerTaskId: task.id, blockerLineageId: task.lineageId, repository: ".", landedSha: details.commitSha,
    target: details.mergeTargetBranch, summary: task.summary,
    paths: details.landedFiles?.map((path) => ({ repository: ".", path, status: "modified" as const })),
    noOp: details.noOpVerifiedShortCircuit === true || details.noOpMerge === true,
    evidence: details.landedFilesCaptureFallback === "attribution-failed" ? "unavailable" : "merge-details",
  }];
}

export function hasConcreteOverlapDelivery(delivery: OverlapWaitDeliverySnapshot): boolean {
  return Boolean(delivery.landedSha) || Array.isArray(delivery.paths) || delivery.noOp === true;
}

// FNXC:OverlapWaitRelease 2026-09-17-06:38: Partial workspace/no-op metadata must not replace stronger delivery proof already captured for the waiter.
export function mergeOverlapDeliverySnapshots(captured: OverlapWaitDeliverySnapshot[], incoming: OverlapWaitDeliverySnapshot[]): OverlapWaitDeliverySnapshot[] {
  const strength = (delivery: OverlapWaitDeliverySnapshot) => delivery.landedSha ? 3 : delivery.paths?.length ? 2 : hasConcreteOverlapDelivery(delivery) ? 1 : 0;
  const byRepository = new Map(captured.map((delivery) => [delivery.repository, delivery]));
  for (const delivery of incoming) {
    const prior = byRepository.get(delivery.repository);
    if (!prior || strength(delivery) >= strength(prior)) byRepository.set(delivery.repository, delivery);
  }
  return [...byRepository.values()];
}

export function observedOverlapDeliveries(episode: Pick<TaskOverlapWait, "observation">): OverlapWaitDeliverySnapshot[] {
  const deliveries = episode.observation?.deliveries;
  return Array.isArray(deliveries) ? deliveries.filter((value): value is OverlapWaitDeliverySnapshot =>
    value !== null && typeof value === "object" && typeof value.repository === "string") : [];
}

/*
FNXC:OverlapWaitRelease 2026-11-18-01:03 (RUFU-1043):
`hasLiveWorkItem` is the fourth input and it is OPTIONAL ON PURPOSE: every existing caller keeps its
current answer, and a caller that cannot read liveness must never gain the `vacant` face by accident.
The reconciliation seam passes it because that is the only place that can read `workflow_work_items`
inside the same transaction that decides the release; this predicate stays pure.
*/
export interface OverlapReleaseLiveness {
  /** True when the blocker still owns a work item in `running`/`runnable`/`retrying`. */
  hasLiveWorkItem?: boolean;
  /**
   * True ONLY when the caller resolved the holder's own lane vocabulary AND proved the holder rests in a
   * lane that can still deliver work (intake / hold / planning / rebound). Unknown vocabulary must pass
   * `false`: RUFU-341 documents that "no answer" from a lane resolver is never evidence of absence.
   */
  holderLaneCannotDeliver?: boolean;
}

export function overlapPredecessorRelease(
  episode: Pick<TaskOverlapWait, "observedAt" | "observation">,
  blocker: Task | undefined,
  lanes: OverlapReleaseLanes,
  liveness: OverlapReleaseLiveness = {},
): OverlapPredecessorRelease | undefined {
  if (typeof episode.observation?.blockerResetAt === "string") return "reset";
  if (!blocker) return "missing";
  // FNXC:OverlapWaitRelease 2026-09-17-06:29: Pre-fix Reset has no epoch stamp. Its retained lifecycle log is the upgrade proof, never the current planning column alone.
  if ((blocker.log ?? []).some((entry) => Date.parse(entry.timestamp) > Date.parse(episode.observedAt)
    && /^Reset replaced the original description/.test(entry.action))) return "reset";
  if (blocker.deletedAt) return "deleted";
  if (lanes.completeColumns.has(blocker.column)) return "complete";
  /*
  FNXC:OverlapWaitRelease 2026-11-04-10:00 (RUFU-469):
  The wait exists to keep a dependent's files from diverging from work that has not landed yet. Once the
  predecessor's work HAS landed and its checkout is gone, there is nothing left to diverge from, so the
  wait is spent — whichever lane the holder happens to rest in. Measured need: a holder whose work landed
  on `main` on 2026-10-01 but whose post-merge gate held zero result rows kept it parked in a review lane,
  and its 46 waiters stayed `status="queued"` behind a marker naming a lease that no longer existed. They
  were finally released 11.14 days later, at the moment the holder's COLUMN changed, not at the moment its
  work landed — and every release recorded before then came from a surface that requires the waiter to
  already be executing, which a queued card with a retained marker cannot be.

  Three conjuncts, and the lane is the LAST thing read:
    1. Not a WIP lane. `acquireTaskCheckout` moves a card into WIP before its checkout row materializes,
       so a checkout-shaped test alone would release a card mid-acquisition. Admission treats WIP as
       active by column role regardless of checkout; this face keeps that rule.
    2. No retained checkout, single OR workspace form, via the one exported checkout authority
       (`taskHoldsUnmergedCheckout`). The lane test alone was insufficient — RUFU-330 deliberately lets a
       review holder retain its checkout and keep its claim — so dropping the lane gate without this
       conjunct would have released a stronger live claim over a weaker historical one.

  FNXC:OverlapScheduling 2026-11-21-11:44 (RUFU-832):
  The RUFU-330 premise above is half-superseded: a review-trait column now answers `none` at BOTH file-scope
  lease classifiers, so a review holder no longer holds a queue claim at all and an overlapping card is never
  refused admission behind it. This predicate is a different question — whether a RECORDED wait episode is
  still owed — and it stays deliberately lane-blind about review: the conjunct above still does real work for
  the lanes that DO claim (WIP mid-acquisition, hold/dormant with a retained checkout), so it is not relaxed.
  Consequence a reader must not misread: review-lane waits are released by the classifier-driven repairs
  (`freshOverlapBlockerStillBlocks`, `clearStaleBlockedBy`), which now see `none`, and never by this face.
    3. A concrete delivery exists, reusing the existing snapshot authority rather than a second landedness
       reading. `mergeConfirmed` is NOT required as a conjunct: it is a convenience flag (`mergedAt ||
       commitSha`), while the snapshot (a landed sha, landed paths, or a verified no-op) is the same proof
       the rest of this pipeline already consumes, and a workspace card's singular `worktree` is cleared
       by design, which the helper's workspace branch still sees.

  A held checkout therefore answers NOTHING here, exactly like the classifier's dormant branch: the holder
  keeps its claim until it clears the checkout or its work delivers.

  FNXC:OverlapWaitRelease 2026-11-04-09:16 (RUFU-469):
  Dropping `mergeConfirmed` was only safe after auditing every writer of a delivery snapshot for the one
  shape that would break this face — a snapshot recorded BEFORE the content is on the base branch. None
  exists. Each writer of a NON-empty `commitSha` / `landedFiles` / `workspaceLandedShas` derives it from a
  landed SHA read back out of the base repository (`captureSingleCommitLandedMetadata(root, landedSha)`,
  `git diff <mergeBase>..<recordedSha>`) at finalization, i.e. after the land, and the workspace finalize
  writes only once each repository has landed. The writers that run on unlanded content write no concrete
  snapshot at all: recovery/reconcile paths stamp `landedFiles: []` (empty, so `hasConcreteOverlapDelivery`
  refuses it) and the zero-commit hold writer sets `mergeConfirmed: false` with only an `uncommittedWorkHold`
  block. The external-PR writer records the sha of an already-merged upstream commit, so its content is on
  the remote base branch. Stale GENERATIONS are covered by a different mechanism: a re-verification bounce
  sets `mergeDetails: null` wholesale (`cleanupMergeStateForReverification`), so a landed generation's
  snapshot cannot survive into a re-run. Hence no `mergeConfirmed === true` conjunct is required.
  */
  if (!lanes.wipColumns.has(blocker.column)
    && !taskHoldsUnmergedCheckout(blocker)
    && overlapDeliverySnapshots(blocker).some(hasConcreteOverlapDelivery)) return "delivered";
  /*
  FNXC:OverlapWaitRelease 2026-11-18-01:03 (RUFU-1043):
  The `delivered` face above requires concrete delivery proof, so it structurally cannot release the holder
  shape that froze tonight's board: a card that NEVER executed has nothing to deliver, so every waiter's
  `!concrete` branch keeps the obligation forever. Measured on RunFusion 2026-11-17/18: 549 of 595 open
  overlap edges were held by blockers with no worktree pointer, 82 cards carried a last log line naming an
  `active file-scope lease` for a blocker that was in `todo` with no checkout, and RUFU-1044 was refused
  119 times across 31 hours by a `hold-release-sweep` refusal whose own capacity facts read `0 of 21`.
  One of those holders (RUFU-454) had zero files of its own against `main` while 454's own log demanded
  delivered files from the card that was waiting on it — a mutual premise with no edge in both directions,
  so nothing classified it as a cycle either.

  Five conjuncts, ordered fail-closed. The face is deliberately narrower than the symptom: it speaks only
  about a holder resting in a lane that CANNOT deliver, so a holder parked in a review lane with an
  undelivered branch keeps its claim and the `delivered` face stays the only way out of that shape.
    1. Not a WIP lane — mid-acquisition holders keep their claim, exactly as the `delivered` face requires.
    2. `taskHoldsUnmergedCheckout` refuses, so a retained single OR workspace checkout is never vacated.
    3. `holderLaneCannotDeliver === true`, from the caller's resolved lane vocabulary. This is what keeps
       the face out of review lanes, where an unlanded branch is the normal state and releasing a waiter
       would let it collide with work that is genuinely still coming.
    4. `!blocker.worktree` — the pointer itself, not merely the helper's aggregate: this face claims the
       holder holds NOTHING, so it must not rest on a derived read alone.
    5. `hasLiveWorkItem === false`, stated as an equality rather than `!== true`. A holder that is merely
       planning or parked mid-graph still owns work it has not abandoned, and a caller that cannot read
       `workflow_work_items` must not gain the release by omission. A holder whose pointer has DIVERGED
       from git (RUFU-1054's class) is refused by conjunct 3 rather than by a pointer test; RUFU-1054
       stays the owner of the divergence, this face only declines to worsen it.

  Releasing a vacant holder is not forgiving a future collision: the obligation is re-derived the moment
  the holder acquires a checkout again, which is exactly the behaviour that made hand-releasing these rows
  tonight pointless. The face removes a stale premise, not a live lock.
  */
  if (!lanes.wipColumns.has(blocker.column)
    && !taskHoldsUnmergedCheckout(blocker)
    && !blocker.worktree
    && liveness.holderLaneCannotDeliver === true
    && liveness.hasLiveWorkItem === false) return "vacant";
  return undefined;
}
