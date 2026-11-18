/*
FNXC:DefaultBranchLandingProof 2026-11-17-21:10 (RUFU-702, code-review P1):
Who says a card is PR-backed — ONE answer, shared by every landing authority.

`pr-backed` existed in the proof vocabulary with no production author: the lane-supplied `prStateOpen` was set
only by a unit test, so an open pull request — the one landing vehicle whose delivery the HOST owes on its
base branch — was measured as an ordinary direct-merge card and could be refused for content that lives on the
forge. Wiring it per lane would have produced two answers (the engine's finalize seams reading one surface,
core's `mergeTaskImpl` door reading another), and a card whose PR-backed status differs by lane is the same
divergence this card exists to remove.

The read spans the two PR surfaces a row can carry, in authority order:

1. the unified `PrEntity` — authoritative, evaluated through the sanctioned `isPrBacked` so the group-member
   carve-out (a shared-group member landing onto its group branch is never PR-backed, or members could never
   land and the group's PR could never advance) cannot drift from the predicate every other PR surface uses;
2. the row-carried `PrInfo.status` — the legacy mirror, consulted when no entity exists or the entity store is
   unreachable. A failed entity read is the ABSENCE of an entity, not evidence that none is open.

When the delivery claim names a PR number, the entity must BE that PR: a card whose earlier PR closed and
whose newest one is open must not inherit an open verdict for a different number. Every failure resolves to
`false`, the conservative direction — an unproven PR vehicle falls through to the default-branch measurement
that already exists rather than being waved through by a read that failed.

The store dependency is a capability, not `TaskStore`: this module must not import the store (which imports
the merge lanes), and a test can satisfy two optional methods without a database.
*/
import type { MergeDetails, PrEntity, Task } from "../types.js";
import { isPrBacked } from "./pr-entity.js";
import { isPrInfoLandingVehicleOpen } from "./default-branch-landing-proof.js";

/** The two PR surfaces this read may consult, as an optional capability so a fake store satisfies it. */
export interface LandingPrVehicleReader {
  getActivePrEntityBySource?: (sourceType: PrEntity["sourceType"], sourceId: string) => Promise<PrEntity | null>;
}

/**
 * Whether the card's landing vehicle is a live pull request, meaning its delivery is owed by the host and not
 * by anything this process can measure on its own clone.
 */
export async function resolveTaskLandingPrVehicleOpen(
  store: LandingPrVehicleReader,
  task: Pick<Task, "id" | "prInfo">,
  mergeTargetSource?: MergeDetails["mergeTargetSource"] | null,
  prNumber?: number | null,
): Promise<boolean> {
  const claimedNumber = typeof prNumber === "number" ? prNumber : null;
  // An entity that records no number cannot contradict a claim that names one; the match is only refused on
  // a proven difference.
  const numberMatches = (entityNumber: number | undefined): boolean =>
    claimedNumber === null || entityNumber === undefined || entityNumber === claimedNumber;

  try {
    const entity = store.getActivePrEntityBySource
      ? await store.getActivePrEntityBySource("task", task.id)
      : null;
    if (entity) return isPrBacked(entity, { mergeTargetSource: mergeTargetSource ?? undefined }) && numberMatches(entity.prNumber);
  } catch {
    // Unreadable entity table: fall through to the row's own mirror instead of inventing an absence.
  }

  if (claimedNumber !== null && task.prInfo?.number !== undefined && task.prInfo.number !== claimedNumber) return false;
  return isPrInfoLandingVehicleOpen(task.prInfo, mergeTargetSource);
}
