import type { Task } from "../types.js";
import { compareTasksByPriorityThenAgeAndId } from "./task-priority.js";

export type FileScopeLeaseKind = "none" | "active" | "dormant";

/*
FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
The lease classifier needs to distinguish "this card retained a checkout" from "this card retains a
checkout that still has something to preserve". Path presence alone was never proof of unmerged work:
a task branch cut from the base that never committed anything is byte-identical to the base, so the
checkout it retains protects nothing while it serializes every overlapping peer forever (RUFU-198
deadlocked RUFU-199 exactly this way while sitting `todo` and dependency-blocked, and no dispatch-time
recovery could ever reach it).
The verdict is computed OUTSIDE core (git I/O) and arrives as a downgrade-only input. `empty` means
clean worktree AND zero commits ahead of the resolved base, per repository. `occupied` is positive
evidence of work to preserve. `unknown` means the proof could not be obtained — a failed or timed-out
git call, an unresolvable base ref, a missing map entry — and MUST behave exactly like `occupied`,
because the failure mode of guessing wrong is destroying someone's uncommitted work. Absent the whole
argument the predicate is byte-for-byte its pre-RUFU-200 self, which is what keeps every legacy
caller and fixture on today's behavior.
*/
export type CheckoutEmptinessVerdict = "empty" | "occupied" | "unknown";

/**
 * Proof map keyed by repository entry: `""` is the singular {@link Task.worktree} checkout, every
 * other key is a `task.workspaceWorktrees` repository key. A key that is simply absent from the map
 * is classified as `unknown` — fail-closed, never as `empty`.
 */
export type CheckoutEmptinessProofMap = ReadonlyMap<string, CheckoutEmptinessVerdict>;

export interface FileScopeLeaseClassification {
  kind: FileScopeLeaseKind;
  waivedForTaskIds: readonly string[];
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace tasks deliberately clear the singular `task.worktree` through
`normalizeWorkspaceTaskWorktreeMetadata({ clearSingularWorktree: true })`, so overlap lifetime must also
recognize their per-repository checkouts. A retained entry is the unfinished-work proof; executor and archive
cleanup delete those entries when the checkout is removed, preserving checkout clearing as the early-release hatch.

FNXC:OverlapScheduling 2026-09-01-14:49:
A planning-only card owns neither checkout form and therefore owns no file-scope lease; planning never
serializes planning. A hold-lane card retaining a real checkout after execution still owns unmerged work
and deliberately keeps its dormant lease. Checkout evidence, not a column exception, decides the outcome.
*/
export function taskHoldsUnmergedCheckout(
  task: Pick<Task, "worktree" | "workspaceWorktrees">,
  checkoutEmptiness?: CheckoutEmptinessProofMap,
): boolean {
  const retainedKeys: string[] = [];
  if (typeof task.worktree === "string" && task.worktree.trim()) retainedKeys.push("");
  for (const [repoKey, entry] of Object.entries(task.workspaceWorktrees ?? {})) {
    if (typeof entry?.worktreePath === "string" && entry.worktreePath.trim().length > 0) {
      retainedKeys.push(repoKey);
    }
  }
  if (retainedKeys.length === 0) return false;
  if (!checkoutEmptiness) return true;

  /*
  FNXC:WorkspaceFileOverlap 2026-09-08-19:50 (RUFU-200):
  The emptiness test is per repository, never all-or-nothing: a workspace card whose `packages/cli`
  checkout is clean-and-behind but whose `packages/engine` checkout is one commit ahead still owns
  unmerged work and keeps its lease. Downgrade requires EVERY retained entry to be proven `empty`.
  */
  return retainedKeys.some((key) => checkoutEmptiness.get(key) !== "empty");
}

function normalizeWorkspaceScopePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace repository scope treats an unprefixed declaration as applying inside every configured repository,
matching `resolveRepoDeclaredScope`'s `unprefixed-fallback` behavior. Expand overlap scope in the safe direction:
more serialization is acceptable, while missing a qualified peer would admit conflicting edits. Explicit repository
paths remain untouched, and tasks without repository checkouts retain the exact single-repository scope behavior.
*/
export function normalizeOverlapScopeForTask(
  task: Pick<Task, "workspaceWorktrees">,
  scope: readonly string[],
): string[] {
  const repoKeys = [...new Set(
    Object.keys(task.workspaceWorktrees ?? {})
      .map(normalizeWorkspaceScopePath)
      .filter(Boolean),
  )].sort();
  if (repoKeys.length === 0) return [...scope];

  const normalizedScope = new Set<string>();
  for (const rawEntry of scope) {
    const entry = normalizeWorkspaceScopePath(rawEntry);
    if (!entry) continue;
    normalizedScope.add(entry);
    if (repoKeys.some((repoKey) => entry === repoKey || entry.startsWith(`${repoKey}/`))) continue;
    for (const repoKey of repoKeys) normalizedScope.add(`${repoKey}/${entry}`);
  }
  return [...normalizedScope].sort();
}

/*
FNXC:OverlapScheduling 2026-08-29-05:47:
A file-scope claim lasts until the blocking task's work has landed rather than only while it occupies a
particular board column. Active claims always serialize overlapping work; dormant claims use priority,
age, then task id so two waiting holders choose one deterministic winner instead of freezing each other.
*/
export function fileScopeLeaseBlocksCandidate(
  blocker: Pick<Task, "id" | "priority" | "createdAt">,
  candidate: Pick<Task, "id" | "priority" | "createdAt">,
  classification: FileScopeLeaseClassification,
): boolean {
  if (blocker.id === candidate.id) return false;
  if (classification.waivedForTaskIds.includes(candidate.id)) return false;
  if (classification.kind === "active") return true;
  if (classification.kind === "dormant") {
    return compareTasksByPriorityThenAgeAndId(blocker, candidate) < 0;
  }
  return false;
}
