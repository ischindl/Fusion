import {
  isWorkspaceTask,
  resolveRequiredPostMergeGateIds,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import {
  isTerminalPostMergeReseedRefusal,
  resolvePostMergeEvidenceContract,
  resumeMissingPostMergeGate,
  type PostMergeGateReseedReason,
} from "@fusion/engine";

/*
FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
The operator's Retry on an ALREADY-LANDED card is answered here, in a module of its own, rather than as a
branch inside `task-restart-stage.ts`. That is a ruling, not a file-size preference, and three separate
facts force it:

1. `post-merge-seam-fork-decision.test.ts` item 3a (RUFU-557) forbids the symbols `resumeMissingPostMergeGate`
   and `manualRetry` in `task-restart-stage.ts`, and its `codeOf()` strips comments, so a comment cannot
   smuggle them past it. The stage restart is the DESTRUCTIVE authority — it discards the column's gate rows —
   and the asymmetry it protects is intended: the automatic lanes, self-healing, `fn task reconcile` and now
   the operator's Retry may reach the recovery seam; the stage restart may not. A landed card must be
   structurally incapable of entering that authority, not merely refused once inside it.
2. `scripts/line-count-baseline.json` pins `register-task-workflow-routes.ts` over its ceiling: an over-cap
   file may shrink but never grow, so the dispatcher can only afford a call, not an implementation.
3. A card whose landing proof is durable has no stage left to discard, so the destructive restart is the
   wrong OPERATION for it — measured on main it answered 200 while rewriting `mergeDetails: null` and
   deleting the approving `code-review` row, and answered 500 in the shapes the landed tests encode.

The three decisions below are the ones a reader cannot re-derive from the surrounding code, so each is
recorded at its call site: why the fence updater returns `null`, and why landing proof is proven on the
fenced snapshot instead of on the row the dispatcher handed in.
*/

/** The one History prefix this authority writes, and the only one it ever writes. */
const REFUSAL_LOG_PREFIX = "Retry refused (post-merge-recheck):";

/**
 * Per-reason remedy copy. The reason CODE is always present — it is the name an operator can grep, the key
 * the audit row and the automatic lanes' own notices carry, and (RUFU-370) the whole point of the seam's
 * taxonomy is that every withheld arm names its own condition. The sentence around it is dashboard-only
 * copy: what to do next, in the operator's terms.
 *
 * Deliberately NOT a re-derivation of terminality: `isTerminalPostMergeReseedRefusal` is asked, so this map
 * can never disagree with the seam about whether a further Retry can ever help.
 */
const REFUSAL_REMEDIES: Record<PostMergeGateReseedReason, string> = {
  seeded: "the verification was re-driven.",
  "no-merge-proof": "no durable landing proof is recorded on this card, so nothing has landed to verify.",
  "no-missing-gate": "no required post-merge gate is owed right now.",
  "no-post-merge-node": "the card's workflow declares no post-merge gate this Retry could run.",
  workspace: "workspace cards are not re-driven through this seam; the workspace land lane owns them.",
  "operator-held": "the card is paused or held. Unpause it, then Retry.",
  "engine-paused": "the engine or the whole board is paused. Unpause it, then Retry.",
  "auto-merge-off": "this project runs with auto-merge Off, so the lane is human-owned end to end. Run the verification by hand, or turn auto-merge back on.",
  "manual-pr-open": "a manual pull request covers this landing, so a human owns its closeout. Land or close that PR first.",
  "finalize-blocked": "the card is in a status that blocks finalization, likely an active merge. Wait for it to settle, then Retry.",
  "checkout-lease": "another lane holds a live checkout on this card. Wait for it to finish, then Retry.",
  "execution-live": "a session is still running on this card. Wait for it to settle, then Retry.",
  "gate-not-resumable": "the gate's existing report is authoritative (an approval, a `pending` run, or a scheduled recheck that is not due yet), so re-seeding it would overwrite a real verdict. A pending run finishes on its own.",
  "selection-drift": "the card's workflow selection moved while Retry was deciding. Retry again against the current row.",
  "rerun-budget-exhausted": "the bounded re-seed budget for this gate is spent. Only an operator waiver of the gate, or evidence that satisfies it, clears this card.",
  "active-continuation": "a continuation for this gate is already queued or running, so the verification is already re-driven.",
  "task-state-changed": "the card changed while Retry was deciding. Retry again against the current row.",
  "unsupported-store": "this storage backend cannot seed a post-merge continuation.",
  "durable-read-unavailable": "the card's durable state could not be read, so nothing was re-seeded. Retry once the store answers.",
};

export type LandedPostMergeRedriveResult =
  /** Nothing owed, or not this authority's shape — the dispatcher continues byte-for-byte as before. */
  | { kind: "not-applicable" }
  /** The seam installed the idle continuation; the card keeps its row, history and landing proof. */
  | { kind: "seeded"; workflowStepId?: string }
  /** The seam withheld the seed: 409 copy naming the reason code and its remedy. */
  | { kind: "refused"; reason: PostMergeGateReseedReason; message: string; workflowStepId?: string };

/** A durable result that means "this gate still owes a report" — everything else is authoritative. */
function isRedrivableGateResult(result: WorkflowStepResult): boolean {
  return result.status === "failed" || result.status === "pending";
}

function refusal(
  reason: PostMergeGateReseedReason,
  gateId: string | undefined,
  taskId: string,
): { kind: "refused"; reason: PostMergeGateReseedReason; message: string; workflowStepId?: string } {
  const gateClause = gateId ? ` for gate '${gateId}'` : "";
  const terminalClause = isTerminalPostMergeReseedRefusal(reason)
    ? " Another Retry cannot produce this evidence."
    : " A later Retry may succeed once that condition clears.";
  return {
    kind: "refused",
    reason,
    workflowStepId: gateId,
    message: `Retry cannot re-drive post-merge verification${gateClause} on ${taskId}`
      + ` (${reason}): ${REFUSAL_REMEDIES[reason]}${terminalClause}`
      + " Nothing was changed on this card — its landing proof and review history are intact.",
  };
}

/**
 * Ask the fenced post-merge recovery seam for one re-driven verification of a card that has already landed.
 *
 * Three properties bound what this can cost and what it can touch:
 * - A card that does not owe a re-drive sees ONLY its own in-memory row: no `getTask`, no `getSettings`, no
 *   `git remote`, no extra `updateTaskAtomic`. That is not an optimization — the route harness counts reads
 *   (`moveOnSecondRead` fails on one extra `getTask`) and counts fenced writes (`mergeOnFence` pins
 *   `updateTaskAtomic` at exactly 2 for a card with no step results), so an arm that read eagerly would
 *   change the race every one of those cases models.
 * - The card row is never patched. The only write is the seam's own continuation seed.
 * - Nothing here throws: a refusal always carries a reason, and the two hostile-store shapes (an
 *   unreadable row, an absent `logEntry`) still produce a `refused` result rather than a 500.
 */
export async function redriveLandedPostMergeGate(params: {
  store: TaskStore;
  task: Task;
  ir: WorkflowIr;
}): Promise<LandedPostMergeRedriveResult> {
  const { store, task, ir } = params;

  // ── Cheap precondition. Everything below this line is work only an owed card pays for. ──
  // A workspace card is refused by the seam by construction (RUFU-429: its requirement resolves
  // `not-applicable` in core, and seeding a reviewer onto cleaned repos caused the SANE-507 loop), so it is
  // excluded HERE rather than paying an atomic write to be told no. RUFU-408 owns workspace reachability.
  if (isWorkspaceTask(task)) return { kind: "not-applicable" };
  const gateIds = resolveRequiredPostMergeGateIds(task, ir);
  if (gateIds.length === 0) return { kind: "not-applicable" };
  // Only a durable `failed` or `pending` row is a re-drive candidate. No row at all belongs to the finalizer,
  // self-healing and `fn task reconcile` (they own the zero-durable-result arm); `skipped` with a
  // `notRunReason`, a bypass, or a remediation archive is RUFU-599's operator-waiver class, and stealing it
  // would replace the waiver's own refusal narrative with ours. A `passed` row is an approval.
  const owedGate = task.workflowStepResults?.find(
    (result) => gateIds.includes(result.workflowStepId) && isRedrivableGateResult(result),
  );
  if (!owedGate) return { kind: "not-applicable" };
  const gateId = owedGate.workflowStepId;

  /*
  FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
  Re-observe the row atomically WITHOUT writing it. The updater returns `null` unconditionally — in this
  store a `null` patch means "no mutation", which is why this call is legal on a card this authority may
  not touch. The reason it exists at all is the window the frozen case names
  (`preserves landing proof that arrives between Retry validation and its publication fence`): the row the
  dispatcher loaded can gain or lose its landing proof while the request is in flight, and the answer must
  be about the card as it is at the decision point, not as it was when the button was pressed. It is also
  the whole cost of this arm — the seam takes its own `createMergeWriteFence` internally and this performs
  no destructive write, so the arm deliberately does NOT take the per-task planning lock (that advisory
  lock is non-reentrant and `restartTaskStage` acquires it internally; wrapping here would deadlock the
  very cards that fall through).
  */
  let snapshot: Task | undefined;
  try {
    if (typeof store.updateTaskAtomic === "function") {
      const returned = await store.updateTaskAtomic(task.id, async (live) => {
        snapshot = live;
        return null;
      });
      snapshot = snapshot ?? returned ?? undefined;
    } else {
      // A store that cannot re-observe is decided on the row in hand rather than refused: the seam still
      // fences its own seed on `expectedTaskUpdatedAt`, so the write stays protected either way.
      snapshot = task;
    }
  } catch {
    return refusal("durable-read-unavailable", gateId, task.id);
  }

  /*
  FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
  Landing proof is proven on the FENCED snapshot, never on the entry row. Stated as a deliberate decision
  because the opposite looks like a bug and will otherwise be "fixed": a card whose post-merge row was
  rejected but which holds no durable landing proof is NOT landed, so it keeps exactly today's behavior
  (the stage restart, with its own refusals) instead of gaining a new 409 that names `no-merge-proof` for
  work that never merged. Proving it on the entry row would also lose the mirror case — proof published
  between validation and this decision — which is the race the frozen route test pins.
  */
  if (!snapshot?.mergeDetails?.mergeConfirmed) return { kind: "not-applicable" };

  // Resolved only now, because resolving it reads the project's git remote and workflow files (and caches
  // per root): a card that owes nothing must never pay a shellout. The resolver never throws.
  const contract = await resolvePostMergeEvidenceContract(store);
  /*
  FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
  One seam, one arm. `source: "manual-reconcile"` is the label the reconcile surface already uses for an
  explicit operator request, and `manualRetry: true` is the ONLY authority FN-9502's schedule override
  recognises as explicit operator intent — the seam derives it as `manualRetry === true && blocked/failed`,
  so it overrides the 15/30/60-then-hourly recheck schedule and nothing else: every other guard inside the
  seam still refuses. No `fence` is passed, so the seam builds its own; no `producerSurface` is passed
  either, because a dashboard request has no resolved delivery-surface observation to hand, and reading
  without one fails closed to a real demand rather than exempting the gate (RUFU-430's direction of error).
  The seam itself never throws — an unreadable budget is the named refusal `durable-read-unavailable`
  (RUFU-502) — which is what makes "no 5xx" reachable at all from this arm.
  */
  const resumed = await resumeMissingPostMergeGate(store, snapshot, {
    source: "manual-reconcile",
    contract,
    manualRetry: true,
  });

  if (resumed.outcome === "seeded") {
    /*
    FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556) one-narrator doctrine:
    The seed is already narrated on the card by the seam itself ("Resuming missing verification at …" /
    "Rechecking rejected evidence at …"), which is the sentence the reseed budget counts. A second line here
    would give one operator click two candidate authors for the same event and desynchronise the marker from
    its own count, so the seeded path writes no History of its own.
    */
    return { kind: "seeded", workflowStepId: resumed.workflowStepId ?? gateId };
  }

  const result = refusal(resumed.reason, resumed.workflowStepId ?? gateId, task.id);
  /*
  FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
  A refused Retry must leave a trace on the CARD, not only in the HTTP response — the RUFU-599 lesson: a 409
  that never reaches the card leaves the next reader pressing the same button. Exactly one line, guarded by
  a `typeof` check so a store double with no `logEntry` still answers 409 instead of 500, and never through
  `recordApprovalDestroyingRetryRefusal`: that helper's call counts are pinned at zero for this registrar by
  `retry-surface-approval-destroying-guard.test.ts`, and this arm destroys nothing, so it has no claim on the
  approval-destroying narrative.
  */
  try {
    if (typeof store.logEntry === "function") {
      await store.logEntry(task.id, `${REFUSAL_LOG_PREFIX} ${resumed.reason}`
        + `${gateId ? ` at '${gateId}'` : ""}: ${REFUSAL_REMEDIES[resumed.reason]}`);
    }
  } catch {
    // A card whose History cannot be written still gets its honest 409.
  }
  return result;
}
