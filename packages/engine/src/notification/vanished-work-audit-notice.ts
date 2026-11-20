/*
FNXC:VanishedWorkAuditDedupe 2026-11-20-11:37 (RUFU-523):
The `reconcile-vanished-task-dirs` sweep is explicitly report-only — it repairs nothing, because a
vanished row cannot be reconstructed without inventing lane state — yet its durable record was written
on EVERY maintenance pass although its subject cannot change. Measured against production 2026-10-03
01:30: 939 `task:vanished-approved-work` rows in 7.5 h over 125 distinct tasks, i.e. one re-report of
every stable finding per pass, and 64 rows inside a single 15-minute window. RUFU-283 made the MAILBOX
notice idempotent (`system:vanished-work:<taskId>:<reason>:<bucket>`, 6 h) but left the audit row
unconditional, so `count(*)` over the mutation type reported sweep cadence rather than findings, and the
durable record of a finding that cannot change grew without bound.

That is the damage beyond storage: the audit store is how "what is actually blocking this card" gets
answered after the fact (it is how RUFU-519 was found and how RUFU-504's landing was proven), so a
report-only family that re-emits per pass makes the operators' and agents' first instinct — count the
rows — wrong, and crowds out the events that ARE the evidence trail.

The remedy is NOT suppression. It is the guard this repo already ships twice:
- `executor/run-suspended-notice.ts` (RUFU-442): a STABLE-field signature plus a time window, with an
  injectable `now` and a test-facing reset. Its FNXC note records WHY the first cut failed — the
  signature carried continuation identity, which churns by construction in a re-dispatch loop, and
  `clear()` ran on every non-suspended disposition, so the bound wiped itself.
- `merge/finalization-refusal-notice.ts` (RUFU-431/RUFU-386): the refusal-STATE analogue, keyed on the
  refusal's discriminating metadata.
- The transition-only primitive `util/repeat-suppressed-log.ts` was evaluated first and REJECTED:
  `logOnce` has no time window, so it can only ever report a condition once per process. A vanished
  finding must keep re-asserting per window exactly like its mailbox notice does, and that cadence is
  the whole point of RUFU-283. The other two candidates are lane-owned with different windows and
  different keyspaces (5 min per card for a suspended run; slot-keyed and transition-only for a merge
  refusal), so a speculative shared util across three lanes is a bigger change than this card, and
  taking the RUFU-442 SHAPE here keeps each lane's knob its own.

State is a WeakMap keyed by the TaskStore, not a module-global Map: this sweep runs against whichever
project database its manager owns, and central mode must not let one project's remembered finding
swallow another project's identical finding. A WeakMap also means the memory dies with the store.
Growth is bounded by the vanished-directory inventory, the same accepted bound as RUFU-431/RUFU-442,
and an entry is rewritten only when a row is actually emitted.

In-memory state re-announces once after an engine restart. That is deliberate and documented rather
than engineered around: the sibling guards accept the same bound, run-audit has no store-side once-seam
to hang durability off, and a stale remembered signature can only ever suppress the repeat of a finding
that was already durably recorded — never a first report.
*/

import { WEDGE_RENOTIFY_COOLDOWN_MS, type TaskStore, type VanishedTaskFinding } from "@fusion/core";

/*
FNXC:VanishedWorkAuditDedupe 2026-11-20-11:37 (RUFU-523):
Both this guard and the sweep's mailbox key alias the SAME core constant rather than one importing the
other: `vanished-task-detection.ts` imports this module for the decision, so re-exporting its constant
here would create an import cycle for nothing. Two independent aliases of `WEDGE_RENOTIFY_COOLDOWN_MS`
are provably one number, and `vanished-work-audit-notice.test.ts` pins that equality so a future edit
that gives the row its own clock fails a test instead of silently desynchronising the two surfaces.
*/

/**
 * The window an unchanged finding stays silent for — the same 6 h clock as `VANISHED_WORK_ALERT_COOLDOWN_MS`
 * and therefore as the mailbox notice: a finding re-announces on the mailbox on the same clock it
 * re-enters the audit store, so the two surfaces cannot disagree about how often a standing finding
 * has been reported.
 */
export const VANISHED_WORK_AUDIT_WINDOW_MS = WEDGE_RENOTIFY_COOLDOWN_MS;

type VanishedWorkAuditRecord = { signature: string; recordedAt: number };

/** Last reported finding-signature per card, per project database. */
const lastAuditByKey = new WeakMap<object, Map<string, VanishedWorkAuditRecord>>();

/*
FNXC:VanishedWorkAuditDedupe 2026-11-20-11:37 (RUFU-523):
A WeakMap is not iterable, so a test-facing "forget everything" could not reach the per-store maps
through the lookup path alone. This registry holds ONLY weak references to those maps, so it retains
nothing a store would otherwise have released, and every global reset prunes its dead entries. The
lookup path stays the WeakMap: per-project isolation and die-with-the-store semantics are unchanged.
*/
const knownStoreStates = new Set<WeakRef<Map<string, VanishedWorkAuditRecord>>>();

/**
 * The one signature shape for a vanished-work finding: only fields that are STABLE while the finding
 * stands (RUFU-442's lesson 1 — "a signature may only contain fields that are stable for the duration
 * of the thing being counted").
 *
 * - `reason` and `gateApproved` come from the row/mirror classifier, so they change only when the
 *   evidence about the row changes.
 * - `branchRef` is derived from the task id (`taskBranchRefFor`), so it is constant per card.
 * - `unmergedCommitCount` is the probe result, and it is the ONLY field that can move while the card
 *   is gone — a late branch push, or a branch cleanup that finally removes the ref. Both are facts an
 *   operator reads differently, so the row must be written again.
 *
 * Deliberately EXCLUDED:
 * - `salvageTarget`: it is derived from `reason`/`branchRef` and rides in the row's metadata unchanged,
 *   so it adds no discriminating power while widening the key.
 * - `mirrorColumn`: it is read off the on-disk mirror, and a mirror's own bytes (and its mtime, which is
 *   what RUFU-442's first cut learned to exclude) are whatever the last writer left there. A finding
 *   whose mirror was touched must not look like a new finding on the next pass.
 *
 * `unmergedCommitCount: null` renders as `-`; a task id cannot contain `|`, and `reason` is a closed
 * enum, so the keyspace cannot be forged by a crafted value.
 */
export function vanishedWorkAuditSignature(finding: Pick<
  VanishedTaskFinding,
  "reason" | "branchRef" | "unmergedCommitCount" | "gateApproved"
>): string {
  return [
    finding.reason,
    finding.branchRef,
    finding.unmergedCommitCount === null ? "-" : String(finding.unmergedCommitCount),
    finding.gateApproved ? "approved" : "unapproved",
  ].join("|");
}

/**
 * May this finding be written as a durable run-audit row on this pass?
 *
 * @returns `true` — and records the signature — when the card is unseen, its finding signature differs
 * from the last one reported, or the window elapsed on an unchanged one (the finding is still unresolved
 * and re-asserts, matching the mailbox notice cadence). `false` means this pass restates a finding that
 * is already durably recorded at the same signature: write nothing.
 *
 * Pure in-memory bookkeeping over already-measured inputs: no I/O, no throw path. It must never become
 * a sweep lifecycle dependency, so a caller keeps its per-pass summary independent of this answer.
 */
export function shouldRecordVanishedWorkAudit(
  store: TaskStore,
  taskId: string,
  signature: string,
  now: number = Date.now(),
): boolean {
  let perStore = lastAuditByKey.get(store);
  if (!perStore) {
    perStore = new Map();
    lastAuditByKey.set(store, perStore);
    knownStoreStates.add(new WeakRef(perStore));
  }
  const previous = perStore.get(taskId);
  if (previous
    && previous.signature === signature
    && now - previous.recordedAt < VANISHED_WORK_AUDIT_WINDOW_MS) {
    return false;
  }
  perStore.set(taskId, { signature, recordedAt: now });
  return true;
}

/**
 * Drop remembered finding signatures — for one store, or for every store this process has reported
 * for when none is given (engine stop / tests).
 *
 * The global form exists because a test suite that builds a fresh store per case would otherwise never
 * observe a repeat at all, and a test that reuses one store needs the repeat to start clean.
 */
export function resetVanishedWorkAuditNoticeState(store?: TaskStore): void {
  if (store) {
    lastAuditByKey.get(store)?.clear();
    return;
  }
  for (const ref of knownStoreStates) {
    const state = ref.deref();
    if (!state) {
      knownStoreStates.delete(ref);
      continue;
    }
    state.clear();
  }
}
