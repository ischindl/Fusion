/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-20:17 (RUFU-531):
 * The heartbeat reviewer lane could complete a real review and publish nothing. `fn_review_step` was
 * deleted by U10/R9 with no replacement, so the wake recorded `completed`, left zero `code-review`
 * rows, and the card sat in `in-review` refused by `no recorded code review verdict` while
 * `reviewerRunCount` climbed one per wake. This module is the lane's ONLY verdict write surface: it
 * turns one reviewed heartbeat pass into exactly one pre-merge `code-review` row, then closes the
 * reviewer-run row that made the wake — which is what stops the re-wake.
 *
 * Four constraints shape the whole file:
 *
 * 1. CANDIDACY IS DECIDED FROM THE LIVE ROW, never from the caller's copy. The row that owns the
 *    merge door is the last non-superseded pre-merge `code-review` result, so every predicate reads a
 *    freshly read task row. A row carrying `reviewInputFingerprint` already proves its content, and a
 *    row carrying `remediationArchivedAt` is FN-295's evidence carrier — appending over either is the
 *    class of bug RUFU-288 was escalated over, so both are refusals. FN-8141's laundering shape (a
 *    completed card with no verdict row) stays unreachable: a verdict never defaults.
 *
 * 2. THE FINGERPRINT IS THE MERGE DOOR'S OWN MEASUREMENT, computed by the composition
 *    `captureMergeContentDescriptor` uses for a singular card (`resolveDiffBaseRef` +
 *    `probeSingularReviewDiffFingerprint` with `branchRef`). RUFU-521 moved that authority to the
 *    branch tip precisely because measuring mutable HEAD made a card with real commits read as
 *    `empty-review-input:v1` and raised a false `stale_content` (RUFU-290). A verdict recorded off any
 *    other measurement is dead on arrival at the door, so parity is not a nicety: the fingerprint a
 *    heartbeat APPROVE carries must equal the door's `diff.fingerprint` byte for byte. The paired test
 *    drives the real door over the same fixture, so drift on either side fails loudly.
 *
 * 3. PERSISTENCE IS THE FENCED WRITE (`persistWorkflowStepResultWithOutcome`), never a raw
 *    `upsertWorkflowStepResult`. `aborted` / `fence-refused` / `no-writer` are dispositions, never
 *    successes.
 *
 * 4. THE LEDGER CLOSES AFTER THE ROW IS DURABLE. Closing the reviewer-run row before the verdict is
 *    durable would strand the card with no verdict row AND no reviewer-run row — strictly worse than
 *    the bug being fixed — so a refused write leaves the ledger row live for the next wake.
 *
 * Workspace cards are refused honestly: a workspace review gate is a per-repository
 * `repositoryReviewOutcomes` rollup that no single fingerprint can satisfy. A genuine workspace
 * verdict surface is separate work.
 */
import {
  CODE_REVIEW_GROUP_ID,
  applyReviewSeverityGate,
  completeReviewerRunForTask,
  describeMergeContentShape,
  type RunMutationContext,
  findLiveReviewerRunForTask,
  isVerdictLessFailedGateRow,
  type ReviewerRunRow,
  type Task,
  type TaskStore,
  type WorkflowReviewFinding,
  type WorkflowStepResult,
} from "@fusion/core";
import { persistWorkflowStepResultWithOutcome } from "../executor/execute-workflow-graph.js";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import {
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewChangesSinceCommit,
  probeSingularReviewDiffFingerprint,
  type ReviewDiffFingerprintProbe,
} from "../worktree/review-diff-fingerprint.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { executorLog as log } from "../logger.js";

/** The verdicts the heartbeat reviewer lane may author. `RETHINK` stays graph-lane only. */
export const HEARTBEAT_REVIEW_VERDICTS = ["APPROVE", "APPROVE_WITH_NOTES", "REVISE"] as const;
export type HeartbeatReviewVerdict = (typeof HEARTBEAT_REVIEW_VERDICTS)[number];

export interface RecordReviewVerdictInput {
  verdict: HeartbeatReviewVerdict;
  /** One-line outcome. Recorded as the row's `output` and `notes`; never a run-audit payload. */
  summary: string;
  findings?: WorkflowReviewFinding[];
}

/**
 * How the review-input proof resolved. `absent-revise` is the one state that persists no fingerprint:
 * a REVISE blocks the door regardless of proof, and stamping a fabricated value would be a false
 * content claim. Probe-unavailable never appears here because it is a refusal, not a record.
 */
export type ReviewVerdictFingerprintState = "fingerprint" | "empty" | "absent-revise";

/** Fixed refusal vocabulary. Every guard arm names exactly one of these. */
export type ReviewVerdictRefusalCode =
  /** FN-295's archived carrier — restore it through the FN-7720 operator bypass, never append over it. */
  | "archived-carrier"
  /** The live row's reviewed commit is no longer the checkout tip; a NEW review at a NEW fingerprint is owed. */
  | "content-drift"
  /** The live row already carries content proof (`reviewInputFingerprint`); this seam appends nothing. */
  | "already-proven"
  /** An already-proven row whose verdict differs from the caller's — zero writes, no ledger close. */
  | "verdict-contradiction"
  /** The probe could not measure, and an approving verdict without proof is unfusable at the door. */
  | "fingerprint-unavailable"
  /** The tip probe could not answer, so the live row's proof can be neither confirmed nor dismissed. */
  | "tip-state-unavailable"
  /** A workspace gate needs per-repository outcomes this seam cannot build. */
  | "workspace-unsupported"
  /** No acquired checkout; measuring the engine's process cwd would record a review of the wrong repo. */
  | "worktree-missing"
  /** No live pre-merge `code-review` row to record against. */
  | "no-live-gate"
  /** The live gate row already carries an authored verdict — a row with an opinion stands. */
  | "gate-not-pending"
  /** REVISE with no open actionable finding and no hard-blocker sentence in the summary. */
  | "revise-without-finding"
  /** A live reviewer-run row belongs to another agent, so this caller is not the dispatched reviewer. */
  | "task-not-owned"
  /** The persistence writer seam is absent. */
  | "no-writer"
  /** The fence refused (including a cancellation observed mid-write). */
  | "fence-refused"
  /** The caller's abort signal was already raised before the write. */
  | "aborted"
  /** A superseded repository scope owned the write. */
  | "scope-superseded"
  /** The persistence seam threw. */
  | "persist-error";

/** Ledger observation shared by every outcome arm; `true` only for a transition this call caused. */
export interface RecordReviewVerdictLedgerState {
  ledgerClosed: boolean;
  /** True when the live reviewer-run row belonged to another agent, so this call closed nothing. */
  ledgerSkippedForeign: boolean;
  /** True when the close returned false because the row had already settled — success, not an error. */
  ledgerAlreadySettled: boolean;
}

const NO_LEDGER: RecordReviewVerdictLedgerState = {
  ledgerClosed: false,
  ledgerSkippedForeign: false,
  ledgerAlreadySettled: false,
};

export type RecordReviewVerdictResult =
  | {
      outcome: "recorded";
      verdict: HeartbeatReviewVerdict;
      fingerprintState: ReviewVerdictFingerprintState;
      /** Present only when a fingerprint was bound; `absent-revise` persists none. */
      reviewInputFingerprint?: string;
    } & RecordReviewVerdictLedgerState
  | ({
      outcome: "refused";
      code: ReviewVerdictRefusalCode;
      message: string;
      /** Set for the `already-proven` class: the verdict already on disk, which the caller must learn. */
      recordedVerdict?: WorkflowStepResult["verdict"];
    } & RecordReviewVerdictLedgerState);

export interface RecordReviewVerdictDeps {
  store: TaskStore;
  /** Run context for the fenced write and the audit row, so both name this wake. */
  getRunContextFor?: (taskId: string) => RunMutationContext | undefined;
  /**
   * The reviewer-run ledger, injectable so a fake store with no pg async layer stays testable.
   * Production binds the shipped single-slot ledger helpers — the only sanctioned writers.
   */
  ledger?: {
    findLiveRun: (store: TaskStore, taskId: string) => Promise<ReviewerRunRow | null>;
    completeRun: (
      store: TaskStore,
      input: { taskId: string; id: string; status: "approve" | "revise"; at: string; summary?: string | null },
    ) => Promise<boolean>;
  };
  /** Injectable for tests; production always uses the real-time clock. */
  now?: () => number;
}

const DEFAULT_LEDGER: NonNullable<RecordReviewVerdictDeps["ledger"]> = {
  findLiveRun: (store, taskId) => findLiveReviewerRunForTask(store, taskId),
  completeRun: (store, input) => completeReviewerRunForTask(store, input),
};

/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-21:10 (RUFU-531):
 * The wake-side question: would a verdict recorded by THIS agent against THIS card right now have any
 * chance of being written? It is the conjunction of the seam's own structural candidacy rules - a
 * non-workspace card, a live non-superseded pre-merge `code-review` row, no `remediationArchivedAt`, no
 * `reviewInputFingerprint`, and a status that still owes the verdict (`pending`, or FN-8492's
 * verdict-less `failed`) - evaluated over the SAME shipped primitives the write path uses
 * (`describeMergeContentShape`, `liveCodeReviewRow`, `isVerdictLessFailedGateRow`), not a re-spelling.
 *
 * It exists so the heartbeat lane can withhold the tool instead of offering a surface that can only answer
 * `no-live-gate`, which burns a turn and invites a hallucinated success. This is NOT a second authority:
 * the write path never consults it, and it deliberately answers nothing about the parts that need the
 * caller, the store, or git - reviewer ownership, tip movement, and the content probe. Those stay
 * refusals inside {@link recordHeartbeatReviewVerdict}, which remains the only place a verdict is decided.
 * `false` therefore means "offering this tool would be a lie", never "this card's review is finished".
 */
export function heartbeatReviewVerdictGateOpens(task: Task): boolean {
  if (describeMergeContentShape(task) === "workspace") return false;
  const row = liveCodeReviewRow(task);
  if (!row) return false;
  if (row.remediationArchivedAt != null) return false;
  if (row.reviewInputFingerprint !== undefined) return false;
  return row.status === "pending" || isVerdictLessFailedGateRow(row);
}

/** The live row that owns the merge door: the LAST pre-merge `code-review` result that is not superseded. */
function liveCodeReviewRow(task: Task): WorkflowStepResult | undefined {
  const rows = (task.workflowStepResults ?? []).filter(
    (row) => row.workflowStepId === CODE_REVIEW_GROUP_ID && (row.phase ?? "pre-merge") === "pre-merge",
  );
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!rows[index].supersededAt) return rows[index];
  }
  return undefined;
}

/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-20:17 (RUFU-531):
 * The review-input proof, computed the way the merge door computes it for a singular card:
 * `resolveDiffBaseRef(worktree, baseCommitSha)` then the branch-targeted probe. That composition is
 * RUFU-521's authority (mutable-HEAD measurement produced false empty-proofs and false stale-content)
 * and is CONSUMED here, never modified: this seam owns none of that rule.
 */
async function probeDoorReviewInput(task: Task): Promise<ReviewDiffFingerprintProbe> {
  const worktreePath = task.worktree ?? "";
  const recordedBaseCommitSha = await resolveDiffBaseRef(worktreePath, task.baseCommitSha);
  return await probeSingularReviewDiffFingerprint({
    worktreePath,
    recordedBaseCommitSha,
    branchRef: task.branch ?? undefined,
  });
}

/**
 * The one REVISE that needs no finding: the card cannot be reviewed at all (missing credential,
 * unreproducible environment). Deliberately a fixed phrase list rather than a keyword net, so a lazy
 * REVISE still has to name a concrete objection.
 */
const HARD_BLOCKER_MARKERS = [
  "hard blocker",
  "cannot be reviewed",
  "cannot review",
  "unreproducible",
  "missing credential",
  "no reproducible",
] as const;

function claimsHardBlocker(summary: string): boolean {
  const lowered = summary.toLowerCase();
  return HARD_BLOCKER_MARKERS.some((marker) => lowered.includes(marker));
}

export async function recordHeartbeatReviewVerdict(
  deps: RecordReviewVerdictDeps,
  args: { task: Pick<Task, "id">; callingAgentId: string; input: RecordReviewVerdictInput; signal?: AbortSignal },
): Promise<RecordReviewVerdictResult> {
  const store = deps.store;
  const ledger = deps.ledger ?? DEFAULT_LEDGER;
  const now = deps.now?.() ?? Date.now();
  const stamp = new Date(now).toISOString();
  const { input, callingAgentId } = args;

  const refuse = (code: ReviewVerdictRefusalCode, message: string): RecordReviewVerdictResult => ({
    outcome: "refused",
    code,
    message,
    ...NO_LEDGER,
  });

  // ---- Live-row candidacy gate -------------------------------------------------------------
  const live = await store.getTask(args.task.id);
  if (!live) return refuse("no-live-gate", `Task ${args.task.id} no longer exists; nothing was recorded.`);

  if (describeMergeContentShape(live) === "workspace") {
    return refuse(
      "workspace-unsupported",
      `Task ${live.id} is a workspace card: its code-review gate is a per-repository rollup that one review-input fingerprint cannot prove. The workspace verdict surface is unbuilt, so this lane records nothing and the card stays with the workspace review lane. Nothing was recorded.`,
    );
  }

  const row = liveCodeReviewRow(live);
  if (!row) {
    return refuse(
      "no-live-gate",
      `Task ${live.id} has no live pre-merge code-review gate row to record against. Nothing was recorded.`,
    );
  }

  if (row.remediationArchivedAt != null) {
    /*
    This refusal is not negotiable. AGENTS records `remediationArchivedAt` WITHOUT `bypassedBy` as an
    UNCONDITIONAL merge veto (FN-7720), and FN-295 assigns its remedy to the restore lane that returns the
    gate to its pre-archive terminal status - explicitly not a verdict fill-in. A verdict written over it
    would erase that veto with zero new content review, which is authority this seam must not mint; the
    archived row is also the evidence the next pass reads to know what to fix. So: no result row, the live
    reviewer-run attempt stays open (the sweep's failed-only close remains the non-delivery fallback), and
    one History line names the class and its restore lane. No card comment (comments reach agents as
    instructions) and no run-audit row. The narrative writes no column, no status, no pause, and releases
    no lease - FN-295's restore, the FN-7720 audited bypass, and the remediation owner stay the only movers.
    */
    try {
      await store.logEntry?.(
        live.id,
        "Heartbeat review verdict refused — the live code-review row is an archived remediation carrier (FN-295). Restore it through the operator bypass; nothing was recorded.",
      );
    } catch {
      // A History write must never turn a refusal into a failure.
    }
    return refuse(
      "archived-carrier",
      "The live code-review row is an FN-295 remediation archive (it carries `remediationArchivedAt`), which is the evidence a later pass must read; appending a sibling row would destroy it. Restore the archived gate through the operator bypass (`fn_task_bypass_review`) or let its remediation owner run.",
    );
  }

  /*
  Reviewer identity is the dispatch authority's own record, not a tool argument: the reviewer-run row
  the sweep opened names who was asked. A foreign caller is refused outright; the ABSENCE of a live row
  is not a refusal, because the stranded-run sweeps close rows as `engine-lost:` and such a card needs
  its verdict more than anything else — the ledger fields then report that nothing was closed.
  */
  let liveRun: ReviewerRunRow | null = null;
  try {
    liveRun = await ledger.findLiveRun(store, live.id);
  } catch (error) {
    // A store without the pg async layer holds no ledger at all; that is the briefed
    // "no live row -> success with ledgerClosed: false" shape, not a failure.
    log.debug(
      `[review-verdict] reviewer-run lookup unavailable for ${live.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    liveRun = null;
  }
  const ledgerSkippedForeign = liveRun !== null && liveRun.reviewerAgentId !== callingAgentId;
  if (ledgerSkippedForeign) {
    return refuse(
      "task-not-owned",
      `Task ${live.id}'s live reviewer-run attempt belongs to "${liveRun?.reviewerAgentId}", not the calling agent "${callingAgentId}". Nothing was recorded.`,
    );
  }

  /*
  FNXC:HeartbeatReviewVerdict 2026-11-12-20:17 (RUFU-531):
  Tip equality is PROVEN through the shipped primitive, never asserted from the clock. The briefed rule
  ("last row is within the wake window") would refuse a genuinely owed verdict on an idle card - RUFU-288
  measured 55 wakes in 58 minutes with the freshest row 62 s old every single time. `reviewedCommitSha`
  is absent on legacy rows and on graph-authored `pending` rows, and the only honest answer about a prior
  round whose commit anchor is missing is "unprovable", which the `already-proven` message states. State
  `changed` means the content moved under the reviewer, so the owed outcome is a NEW review at a NEW
  fingerprint and nothing is appended here.
  */
  if (row.reviewedCommitSha) {
    const changes = await probeReviewChangesSinceCommit(live.worktree ?? "", row.reviewedCommitSha);
    if (changes.state === "unavailable") {
      return refuse(
        "tip-state-unavailable",
        `Cannot prove the live code-review row's reviewed commit is still the checkout tip (${changes.reason}); refusing to append over an unprovable content state. Nothing was recorded.`,
      );
    }
    if (changes.state === "changed") {
      return refuse(
        "content-drift",
        `The live code-review row inspected commit ${row.reviewedCommitSha}, which is ${changes.commitCount} commit(s) behind the current checkout. The owed outcome is a fresh review at a fresh fingerprint; nothing was recorded.`,
      );
    }
  }

  /*
  Content proof outranks the candidacy check: a row that already carries `reviewInputFingerprint` proves
  its own input, and the honest answer is that this seam appends nothing - including the idempotent second
  call of a round that already recorded (the "second call same round" data state, which merge readers
  resolve with `.at(-1)`).
  */
  if (row.reviewInputFingerprint !== undefined) {
    if (row.verdict && row.verdict !== input.verdict) {
      return refuse(
        "verdict-contradiction",
        `The live code-review row already carries verdict ${row.verdict} for this review input and the caller offered ${input.verdict}; refusing to overwrite another pass's decision. Nothing was recorded.`,
      );
    }
    /*
    Idempotence is observational: the caller learns the verdict already on disk instead of duplicating it,
    and the reviewer-run attempt is settled ONLY when that verdict matches the caller's. A verdict-less row
    that carries content proof belongs to FN-279's no-verdict re-seed lane, which is why nothing is closed
    for it - retiring the attempt record a re-seed still needs would strand the card deeper.
    */
    const matchingVerdict = row.verdict != null && row.verdict === input.verdict;
    return {
      outcome: "refused",
      code: "already-proven",
      recordedVerdict: row.verdict,
      message: row.verdict
        ? `The live code-review row already delivered verdict ${row.verdict} against review input ${row.reviewInputFingerprint}; this seam appends nothing.${matchingVerdict ? " The caller's verdict matches it, so the reviewer-run attempt was settled." : ""}`
        : `The live code-review row already carries content proof (${row.reviewInputFingerprint})${row.reviewedCommitSha ? "" : " and has no reviewedCommitSha, so tip equality is unprovable and this seam will not assume it"}. A verdict-less row with content proof belongs to FN-279's no-verdict re-seed lane; a fresh review at a new fingerprint is the only way this seam writes again. Nothing was recorded.`,
      ...(matchingVerdict
        ? await closeLiveRun(ledger, store, live.id, callingAgentId, input.verdict, input.summary, deps.now, liveRun)
        : NO_LEDGER),
    };
  }

  if (row.status !== "pending" && !isVerdictLessFailedGateRow(row)) {
    /*
    A verdict-less `failed` gate IS a candidate — it is the reported symptom itself (FN-8492 rewrites an
    orphaned `pending` to `failed`, and the original card carried `failed` + "…before producing a
    verdict…"), so refusing it would leave the tool unable to fix the bug it exists for. The reuse of
    `isVerdictLessFailedGateRow` keeps this seam and the FN-279/FN-8492 recovery lanes agreeing about
    which rows owe a verdict; an authored verdict, an adjudicated row, or a waived `skipped` row is not
    this seam's to redo.
    */
    if (row.verdict && row.verdict !== input.verdict) {
      return refuse(
        "verdict-contradiction",
        `The live code-review row already carries verdict ${row.verdict} for this review input and the caller offered ${input.verdict}; refusing to overwrite another pass's decision. Nothing was recorded.`,
      );
    }
    return refuse(
      "gate-not-pending",
      row.verdict
        ? `The live code-review row already carries an authored verdict (${row.verdict}), so this lane duplicates nothing. If that row is wrong for the current content, the remedy is FN-279's re-seed or the operator bypass, not a second verdict.`
        : `The live code-review gate is ${row.status}${row.bypassedBy ? " and carries an operator waiver" : ""}; a row in that state is owned by its own recovery lane, not by this seam. Nothing was recorded.`,
    );
  }

  // ---- Content proof ------------------------------------------------------------------------
  if (!live.worktree) {
    return refuse(
      "worktree-missing",
      `Task ${live.id} has no acquired checkout to measure, and reviewing the engine's process working directory would record a review of the wrong repository. Nothing was recorded.`,
    );
  }

  const probe = await probeDoorReviewInput(live);
  const approving = input.verdict !== "REVISE";
  if (probe.state === "unavailable" && approving) {
    // RUFU-430's lesson: a refusal that reads as a reviewer problem summons a fix agent that can do
    // nothing about it. Name it as what it is — its remedy is a fresh wake.
    return refuse(
      "fingerprint-unavailable",
      `Could not measure the review input against the merge base (${probe.reason}), so an approving verdict would carry no content proof the merge door can match. No row was written and the reviewer-run attempt stays live: the remedy is a fresh wake, not a change to the card.`,
    );
  }
  if (probe.state === "unavailable") {
    // REVISE blocks the door regardless of proof, so a fingerprint-less row still carries the
    // reviewer's honest decision and the fix cycle still gets its findings.
    log.debug(`[review-verdict] recording REVISE for ${live.id} with no review-input fingerprint (probe unavailable)`);
  }

  // ---- REVISE needs a concrete objection ----------------------------------------------------
  const findings = (input.findings ?? []).map((finding, index) => ({
    ...finding,
    id: finding.id || `heartbeat-${now}-${index + 1}`,
    resolution: finding.resolution ?? ("open" as const),
  }));
  if (!approving) {
    /*
    Reuses the shipped severity gate rather than a local severity list, and consults it only to answer
    "is anything actionable open?". Downgrading a heartbeat REVISE into an approval here would be this
    seam authoring an approval it was not given, so a gate that would downgrade is a refusal instead —
    fail closed, never approve.
    */
    const gated = applyReviewSeverityGate({
      verdict: input.verdict,
      findings,
      threshold: "any",
      findingsUnreadable: findings.length === 0,
    });
    if (gated.downgraded || gated.blocking.length === 0) {
      if (!claimsHardBlocker(input.summary)) {
        return refuse(
          "revise-without-finding",
          "A REVISE needs at least one open actionable finding, or a summary naming a hard blocker (missing credential, unreproducible environment, cannot-be-reviewed condition). Neither was supplied, so no approval was fabricated and nothing was recorded.",
        );
      }
    }
  }

  // ---- Persist first, close the ledger second -----------------------------------------------
  const resultRow: WorkflowStepResult = {
    workflowStepId: CODE_REVIEW_GROUP_ID,
    workflowStepName: "Code Review",
    phase: "pre-merge",
    source: "node",
    status: approving ? "passed" : "failed",
    verdict: input.verdict,
    verdictRequired: true,
    reviewKind: "code",
    output: input.summary,
    notes: input.summary,
    ...(findings.length ? { findings } : {}),
    /*
    The empty state persists the shared sentinel rather than a digest, exactly as the graph lane's
    `computeCodeReviewInputFingerprint` does. An ABSENT fingerprint stays absent: it is the marker that
    separates an actually-empty review from an unprovable one, and the door reads that difference.
    */
    ...(probe.state === "fingerprint"
      ? { reviewInputFingerprint: probe.fingerprint }
      : probe.state === "empty"
        ? { reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT }
        : {}),
    startedAt: stamp,
    completedAt: stamp,
  };

  const receipt = await persistWorkflowStepResultWithOutcome(
    {
      store,
      getRunContextFor: (taskId: string) => deps.getRunContextFor?.(taskId),
      readTaskArtifact: async () => undefined,
    },
    live.id,
    resultRow,
    { signal: args.signal },
  );

  if (!receipt.persisted) {
    const disposition = receipt.disposition;
    const code: ReviewVerdictRefusalCode =
      disposition === "no-writer"
        ? "no-writer"
        : disposition === "scope-superseded"
          ? "scope-superseded"
          : disposition === "aborted"
            ? "aborted"
            : disposition === "fence-refused"
              ? "fence-refused"
              : "persist-error";
    return refuse(
      code,
      `The code-review row was not persisted (disposition "${disposition}"). The reviewer-run attempt was left live on purpose so this card is dispatched again; no verdict was delivered.`,
    );
  }

  const fingerprintState: ReviewVerdictFingerprintState =
    probe.state === "fingerprint" ? "fingerprint" : probe.state === "empty" ? "empty" : "absent-revise";
  const ledgerState = await closeLiveRun(ledger, store, live.id, callingAgentId, input.verdict, input.summary, deps.now, liveRun);
  const recordedFingerprint = receipt.persistedResult?.reviewInputFingerprint ?? resultRow.reviewInputFingerprint;

  /*
  Provenance, ids/count/fixed-enum only. The digest, the summary, the findings, and any error text stay
  on the durable row: an audit row carrying review prose would put reviewer output into a store that
  anything with query access can read.
  */
  await emitBoundedRunAudit(store, {
    taskId: live.id,
    agentId: callingAgentId,
    runId: deps.getRunContextFor?.(live.id)?.runId ?? `heartbeat-review-verdict:${live.id}`,
    domain: "database",
    mutationType: "task:review-verdict-recorded",
    target: live.id,
    metadata: {
      taskId: live.id,
      reviewerAgentId: callingAgentId,
      verdict: input.verdict,
      fingerprintState,
      ledgerClosed: ledgerState.ledgerClosed,
    },
  });

  return {
    outcome: "recorded",
    verdict: input.verdict,
    fingerprintState,
    ...(recordedFingerprint ? { reviewInputFingerprint: recordedFingerprint } : {}),
    ...ledgerState,
  };
}

/**
 * Closes the reviewer-run attempt the dispatch sweep opened for THIS agent. The transition is the
 * ledger's own owned single-slot write, so a displaced reviewer can never settle its successor's row;
 * `false` means the row already reached a terminal status, which is success rather than an error.
 */
async function closeLiveRun(
  ledger: NonNullable<RecordReviewVerdictDeps["ledger"]>,
  store: TaskStore,
  taskId: string,
  callingAgentId: string,
  verdict: HeartbeatReviewVerdict,
  summary: string,
  now: (() => number) | undefined,
  prefetched: ReviewerRunRow | null,
): Promise<RecordReviewVerdictLedgerState> {
  const liveRun = prefetched ?? (await ledger.findLiveRun(store, taskId).catch(() => null));
  if (!liveRun) return NO_LEDGER;
  if (liveRun.reviewerAgentId !== callingAgentId) {
    return { ledgerClosed: false, ledgerSkippedForeign: true, ledgerAlreadySettled: false };
  }
  const transitioned = await ledger.completeRun(store, {
    taskId,
    id: liveRun.id,
    status: verdict === "REVISE" ? "revise" : "approve",
    at: new Date(now?.() ?? Date.now()).toISOString(),
    summary,
  });
  return { ledgerClosed: transitioned, ledgerSkippedForeign: false, ledgerAlreadySettled: !transitioned };
}
