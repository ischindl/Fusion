/**
 * Execution re-arm (RUFU-308).
 *
 * A stuck-session disposal leaves the card's own `kind:"task"` continuation `failed` (the workflow
 * task runtime terminalizes it on the `failed` disposition), and the due-poll dispatches only
 * `runnable`/`retrying` rows while `stranded-continuation-reclaim` deliberately refuses to touch
 * exactly those states. So the card has no re-entry owner, and every recovery arm that could give it
 * one refuses itself: the lifecycle-containment seam will not move a card out of `in-progress`, and
 * the one in-place fallback (`retryStep`, FN-9359) needs `status:"failed"` — which the stuck-session
 * path clears first. RUFU-291 sat dead for 1h42m between two executor sessions on exactly that
 * deadlock, with four committed steps sitting in its worktree the whole time.
 *
 * This module is the seam that resolves the deadlock without weakening it. A **lifecycle move**
 * changes the card's lane (or parks it) and stays governed by containment. An **execution re-arm**
 * changes neither column nor status: it installs a runnable continuation at the same node that just
 * failed, so the scheduler re-enters the same step. Containment has nothing to refuse, because
 * nothing moves.
 */
import type { CheckoutEmptinessVerdict, MergeDetails, TaskDetail, TaskStore } from "@fusion/core";
import { EXECUTION_REARM_EPISODE_METADATA_KEY, findWorkflowNodeInstance, isPlanReviewSatisfied, resolveWorkflowIrForTask } from "@fusion/core";
import { isDurableBlockedTask } from "../execution-block-classifier.js";
import { checkoutEmptinessProverFor, checkoutEmptinessEntries, type CheckoutEmptinessProver } from "../worktree/checkout-emptiness.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";

/**
 * The persisted ladder. It lives under `sourceMetadata[EXECUTION_REARM_EPISODE_METADATA_KEY]`, NOT in
 * `mergeDetails`: `cleanupMergeStateForReverification` legitimately writes `mergeDetails: null` on the
 * stale-merge-state path that every re-arming card walks (measured on RUFU-278: `Executor detected
 * stale merge state …` immediately precedes each of its 327 re-arms in 24 h, every one `attempt: 1`).
 * A counter that bounds a lifecycle loop cannot live in a column an unrelated cleanup nulls.
 * The pre-RUFU-1027 `mergeDetails.executionRearm` shape is still READ, so a card that accumulated
 * attempts before the upgrade is not forgiven its budget; it is never written again.
 */
export interface ExecutionRarmMarker {
  signature: string;
  attempt: number;
  refusal: number;
  firstAt: string;
  at: string;
  heldAt: string | null;
  /**
   * FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
   * The durable question this park answered: the step-execute node plus the step ledger, carrying NO live
   * evidence token and no `status`/`error`. `signature` cannot serve this purpose because it embeds the
   * `occupied`/`unproven` evidence verdict, and that token flips while the same question is still
   * unanswered — a park keyed on it would release itself whenever a worktree probe disagreed with itself.
   */
  questionStamp?: string | null;
}

/** A row shaped like the ones this ladder is read from (`Task` or `TaskDetail`). */
type TaskLikeWithRarmEpisode = {
  mergeDetails?: MergeDetails;
  sourceMetadata?: Record<string, unknown> | null;
};

function isExecutionRarmMarker(value: unknown): value is ExecutionRarmMarker {
  return !!value && typeof value === "object"
    && typeof (value as ExecutionRarmMarker).signature === "string";
}

/** Reads the ladder: the durable episode key first, the pre-RUFU-1027 `mergeDetails` shape as fallback. */
export function readExecutionRarmMarker(task: TaskLikeWithRarmEpisode | undefined): ExecutionRarmMarker | undefined {
  const episode = task?.sourceMetadata?.[EXECUTION_REARM_EPISODE_METADATA_KEY];
  if (isExecutionRarmMarker(episode)) return episode;
  const legacy = task?.mergeDetails?.executionRearm;
  return isExecutionRarmMarker(legacy) ? legacy : undefined;
}

/**
 * Key-level `sourceMetadataPatch`: replaces this episode's key only, so unrelated provenance keys
 * (duplicate-of, handoff-from, the other parks' registers) survive a re-arm untouched — the same
 * write shape RUFU-246/273/393/395 established, and the same one operator Retry clears.
 */
function executionRarmPatch(marker: ExecutionRarmMarker): Record<string, unknown> {
  return { [EXECUTION_REARM_EPISODE_METADATA_KEY]: marker };
}

/** Attempts allowed for one unchanged evidence signature before the card is terminalized once. */
export const MAX_EXECUTION_REARM_ATTEMPTS = 4;
/**
 * Refusals (no work evidence / not eligible) tolerated on an unchanged signature before the card is
 * terminalized with one operator-visible notice. Higher than the attempt budget because a refusal is
 * not a burn — it is the containment loop's own repetition, which is what the spec refuses to let run
 * "donekonečna" (hundreds of identical log lines every ~45 s).
 */
export const MAX_EXECUTION_REARM_REFUSALS = 20;

export type ExecutionRarmOutcome =
  /** A runnable continuation was installed at the failed step's owner node. */
  | "rearmed"
  /** Another active continuation already owns the card — the drain owns its re-entry, nothing to do. */
  | "already-owned"
  /** The card is not in a shape execution may re-enter (wrong lane, paused, live session, no such node). */
  | "not-eligible"
  /** No worktree proof that there is step work to preserve: re-arm is evidence-bound, so nothing ran. */
  | "no-work-evidence"
  /** The bounded budget for this signature is spent; the card is terminalized and announced once. */
  | "budget-exhausted"
  /** The store refused the seed for a reason other than an existing active row: caller must park. */
  | "seed-failed";

export interface ExecutionRarmInput {
  taskId: string;
  /** The node whose run failed, as recorded by the graph (`steps#1:step-execute` form). */
  failedNode: string | null | undefined;
  /** The workflow's WIP lane. A re-arm is only ever legal while the card is still in it. */
  wipColumn: string;
  /** Recovery reason that asked for the re-entry; recorded in the log line and audit row. */
  reason: string;
}

export interface ExecutionRarmDeps {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  /** Any live executor/session surface. A live run already owns the card. */
  hasLiveExecutionSurface?: (taskId: string) => boolean;
  /** Injectable prover so evidence behavior is unit-testable without a real worktree. */
  emptinessProver?: CheckoutEmptinessProver;
  now?: () => number;
}

export interface ExecutionRarmResult {
  outcome: ExecutionRarmOutcome;
  /** Operator-readable sentence explaining the outcome (log/notice text, never a stack). */
  detail: string;
}

function normalizeNodeId(nodeId: string | null | undefined): string | null {
  const trimmed = typeof nodeId === "string" ? nodeId.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The failed node must be a `step-execute` seam node of the card's current IR. A bare
 * `step-execute` covers a non-foreach template; `steps#N:step-execute` is the instantiated
 * per-step owner. Any other node (merge, review, parse) is not step execution and must not be
 * re-entered by this seam — the caller keeps its own recovery or terminal park.
 */
export async function resolveStepExecuteOwner(
  store: TaskStore,
  task: TaskDetail,
  failedNode: string | null | undefined,
): Promise<string | null> {
  const nodeId = normalizeNodeId(failedNode);
  if (!nodeId) return null;
  const ir = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  const node = ir ? findWorkflowNodeInstance(ir, nodeId) : undefined;
  if (!node) return null;
  const seam = (node.config as { seam?: string } | undefined)?.seam;
  return node.kind === "prompt" && seam === "step-execute" ? nodeId : null;
}

/**
 * Evidence gate: at least one retained checkout must be `occupied` — a dirty tree or commits ahead
 * of its resolved base. The verdict comes from the shared per-repository prover so a workspace card
 * cannot be re-armed on the strength of one clean sub-repository, and `unknown` (git failed, base
 * unresolvable, path gone) is never evidence: guessing wrong about `unknown` costs someone's
 * uncommitted work, which is exactly the work this task exists to protect.
 *
 * FNXC:ExecutionReArm 2026-10-07-13:48 (RUFU-308):
 * This is the INVERSE polarity of the prover's other consumers. Everywhere else the verdict is a
 * downgrade-only input (`empty` releases a blocker, so a missing verdict must never release live work);
 * here `occupied` is the only verdict that GRANTS an action, so `empty` and `unknown` both fall through
 * to today's behavior. The two polarities cannot drift into each other because neither one ever acts on
 * a verdict it did not ask for.
 */
export async function hasStepWorkEvidence(
  deps: ExecutionRarmDeps,
  task: TaskDetail,
): Promise<{ hasEvidence: boolean; verdicts: string }> {
  const entries = checkoutEmptinessEntries(task);
  if (entries.length === 0) return { hasEvidence: false, verdicts: "no-checkout" };
  const rootDir = deps.store.getRootDir?.() ?? "";
  if (!rootDir) return { hasEvidence: false, verdicts: "no-root-dir" };
  // The store is offered so a refused lane leg reaches the card; proof verdicts are unchanged by it.
  const prover = deps.emptinessProver ?? checkoutEmptinessProverFor(rootDir, { store: deps.store });
  const settings = await deps.store.getSettings?.().catch(() => undefined);
  const integrationBranch = settings
    ? await resolveIntegrationBranch(rootDir, settings, {}).catch((): string | null => null)
    : null;
  const proofs = await prover
    .proveTask(task, { integrationBranch })
    .catch((): Map<string, CheckoutEmptinessVerdict> => new Map());
  const collected: string[] = [];
  for (const entry of entries) {
    const verdict = proofs.get(entry.key) ?? "unknown";
    collected.push(`${entry.key || "singular"}=${verdict}`);
  }
  const hasEvidence = entries.some((entry) => proofs.get(entry.key) === "occupied");
  return { hasEvidence, verdicts: collected.join(",") };
}

/** Durable-IR step rows, sorted, for the signature — same shape as the merge-boundary ladder. */
function stepSignature(task: TaskDetail): string {
  const rows = [...(task.workflowStepResults ?? [])]
    .sort((left, right) => left.workflowStepId.localeCompare(right.workflowStepId))
    .map((result) => `${result.workflowStepId}:${result.status}`);
  const steps = (task.steps ?? []).map((step, index) => `${index}:${step.status}`);
  return `${rows.join(",")}|${steps.join(",")}`;
}

/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
The question a park answers, minus everything a transient can move. `rearmSignature` is the identity of an
EPISODE and deliberately carries the evidence verdict; a PARK must not be keyed on it, or a card whose worktree
probe flips its verdict between two polls earns a fresh ladder for the identical question. A genuine forward
move in the step ledger (a gate that passed, a step that completed) IS a different question and must release
the park.

The stamp is deliberately NARROWER than `stepSignature`, and the reason is measured rather than stylistic:
`cleanupMergeStateForReverification` keeps only the pre-execution Plan Review row and DROPS every other
workflow-step row (`preservePreExecutionWorkflowStepResults`). A stamp reading all step rows therefore moved
every time that cleanup ran, which is precisely the writer this park must survive; the first version of this
stamp did exactly that, and the merge-reset test caught it. So it reads the two halves that cleanup cannot
touch, using the SAME authority the board already agrees on: `isPlanReviewSatisfied` is the pre-execution gate
the cleanup preserves and reconstructs, and the completed-step count is the ledger's own forward progress. A
plan review passing or a step completing is a new question; a wiped badge, a verdict flip, or a cleared
post-execution row is not.
*/
function durableQuestionStamp(nodeId: string, task: TaskDetail): string {
  const planReviewSatisfied = (task.workflowStepResults ?? []).some((result) => isPlanReviewSatisfied(result));
  const completedSteps = (task.steps ?? []).filter((step) => step.status === "done").length;
  return `${nodeId}|${planReviewSatisfied ? "plan-review-satisfied" : "plan-review-none"}|${completedSteps}`;
}

/**
 * Does the standing park still answer the question being asked? A marker written before RUFU-1028 carries
 * no stamp at all: the park HOLDS, because a false hold costs an operator one press of Retry while a false
 * release costs the board an unbounded loop — the asymmetry that made a sticky guard necessary.
 */
function parkHoldsForQuestion(prior: ExecutionRarmMarker, questionStamp: string): boolean {
  if (prior.heldAt == null) return false;
  if (typeof prior.questionStamp !== "string" || prior.questionStamp === "") return true;
  return prior.questionStamp === questionStamp;
}

/*
FNXC:ExecutionReArmCeiling 2026-11-13-22:44 (RUFU-1027):
The episode identity used to include the live `task.status` and `task.error` columns. Both are written
by the recovery itself (the successful re-arm clears them two statements after the claim) and by the
stale-merge-state cleanup that runs before it — so every cycle computed a DIFFERENT key, `unchanged`
resolved false, and the ladder restarted at 1 no matter how many times the same node had already
failed. A bound whose key is recomputed from fields the bounded loop itself rewrites is not a bound.
The identity is therefore the durable question being retried: the node, the step ledger's shape, and
the evidence verdict. Genuine step progress still ends an episode, because it changes the step ledger.
*/
function rearmSignature(nodeId: string, task: TaskDetail, evidence: string): string {
  return [
    "rearm",
    nodeId,
    stepSignature(task),
    evidence,
  ].join(":");
}

/** Prefix of the one-shot terminal park's error sentence — the marker the sticky hold recognizes. */
export const EXECUTION_REARM_EXHAUSTED_PREFIX = "EXECUTION_REARM_EXHAUSTED";

/**
 * Atomically claim one attempt (or one refusal) for an unchanged signature. Mirrors
 * `recoverMergeBoundaryEvidenceGap`: the write re-validates the live row under the shared per-task
 * advisory lock, so a pause, a lane change, or genuine step progress during the git evidence read
 * makes this claim — and therefore the seed — not happen. The claim is confirmed by reading the
 * written marker back: a concurrent writer that lands second replaces `at`, and the loser treats the
 * lost claim as "the card changed under recovery" rather than proceeding.
 */
async function claimRearmSlot(
  deps: ExecutionRarmDeps,
  input: ExecutionRarmInput,
  signature: string,
  questionStamp: string,
  kind: "attempt" | "refusal",
): Promise<{ allowed: boolean; attempts: number; refusals: number; held: boolean; parked: boolean; liveChanged: boolean }> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  const failed = { allowed: false, attempts: 0, refusals: 0, held: false, parked: false, liveChanged: false };
  /*
  FNXC:ExecutionReArm 2026-10-07-15:22 (RUFU-308 Step 3):
  The terminal park must be STICKY, or the bounded loop is only relabelled. `terminalizeRearmBudget`
  writes `heldAt`, and the ladder below deliberately restarts after a hold so an operator's Retry is not
  swallowed — which without this guard means the next ~45 s poll builds a fresh four-attempt ladder,
  re-parks, and re-notifies forever (measured in Step 2's own test: a held marker made `unchanged` false
  and the attempts counter went 1,2,3,4 again). While the park still stands ON THE ROW — `failed` plus
  our own error sentence — there is nothing to claim and nothing to announce: the row itself is the
  proof. The moment either changes (operator Retry clears the marker's subject, a fresh graph run stamps
  its own failure, or the card leaves the lane) the guard stops applying and a new episode may run its
  own ladder.
  */
  let alreadyParked = false;
  /*
  FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
  RUFU-1027 made the ceiling REACHABLE; this makes it HOLD. The RUFU-308 guard above proved "a park stands"
  from the two row columns the park used to announce itself in, and the line below it made `heldAt != null`
  force `unchanged` false — so any writer that cleared or replaced those columns turned the terminal park
  into a fresh four-attempt ladder with a new `firstAt` and `heldAt: null`. Measured live on the shipped
  ceiling (RUFU-583, 2026-11-14): `attempt 4/4` at 15:49:50, `5/4 EXHAUSTED` at 15:52:54, `attempt 1/4` again
  at 15:55:57 — 44 re-arm grants between 14:10 and 16:04, with the card's own episode row showing `firstAt`
  moving forward twice. The re-dispatch that followed that park was an `overseer:intervention action:"retry"`
  at 15:53:25, and no audit row exists for the statement that cleared the columns, which is exactly why a
  guard may not rest on them. The park's proof is now the durable episode and nothing else, because
  `status`/`error` belong to every writer on the board.

  The episode is released only by its owners: operator/agent Retry (which nulls the episode key in
  `buildManualRetryResetPatch`), a card leaving the WIP lane, a pause, or genuine durable step-ledger progress
  past the stamp taken at park time.
  */
  let parkAnnouncementLost = false;
  let parkMarker: ExecutionRarmMarker | null = null;
  try {
    const updated = await deps.store.updateTaskAtomic(input.taskId, (current) => {
      if (!current || current.deletedAt) return null;
      if (current.paused === true || current.userPaused === true) return null;
      if (current.column !== input.wipColumn) return null;
      const prior = readExecutionRarmMarker(current);
      if (prior && parkHoldsForQuestion(prior, questionStamp)) {
        alreadyParked = true;
        parkMarker = prior;
        // Disturbance detection, not a decision: the park holds either way, and this only records that the
        // row-level announcement an earlier build depended on has been cleared by someone else.
        parkAnnouncementLost = !(current.status === "failed"
          && (current.error ?? "").startsWith(EXECUTION_REARM_EXHAUSTED_PREFIX));
        return null;
      }
      const unchanged = prior?.signature === signature && prior.heldAt == null;
      const attempts = (unchanged ? prior?.attempt ?? 0 : 0) + (kind === "attempt" ? 1 : 0);
      const refusals = (unchanged ? prior?.refusal ?? 0 : 0) + (kind === "refusal" ? 1 : 0);
      const exhausted = attempts > MAX_EXECUTION_REARM_ATTEMPTS || refusals > MAX_EXECUTION_REARM_REFUSALS;
      return {
        sourceMetadataPatch: executionRarmPatch({
          signature,
          attempt: attempts,
          refusal: refusals,
          firstAt: unchanged ? prior?.firstAt ?? at : at,
          at,
          heldAt: exhausted ? at : null,
          questionStamp,
        }),
      };
    }, deps.getRunContextFor?.(input.taskId));
    if (alreadyParked) {
      // No write, no notice: the existing park is the answer.
      if (parkAnnouncementLost && parkMarker) {
        const runContext = deps.getRunContextFor?.(input.taskId);
        await announceExecutionRearmParkDisturbed({
          store: deps.store,
          taskId: input.taskId,
          agentId: runContext?.agentId ?? "executor",
          runId: runContext?.runId,
          marker: parkMarker,
          observedFrom: "rearm-claim",
          resetSource: "unknown",
        });
      }
      return { allowed: false, attempts: 0, refusals: 0, held: true, parked: true, liveChanged: false };
    }
    const marker = readExecutionRarmMarker(updated);
    if (!marker || marker.at !== at) {
      // Either the fence refused the patch or another writer overwrote it: the card moved under us.
      return { ...failed, liveChanged: true };
    }
    if (marker.heldAt === at) {
      return { allowed: false, attempts: marker.attempt, refusals: marker.refusal, held: true, parked: false, liveChanged: false };
    }
    // A first sighting always proceeds; the ceiling is what bounds the loop, not the first pass.
    return { allowed: true, attempts: marker.attempt, refusals: marker.refusal, held: false, parked: false, liveChanged: false };
  } catch {
    // A failed claim must not be mistaken for permission: the caller keeps its existing behavior.
    return failed;
  }
}

/*
FNXC:RunAudit 2026-10-07-14:03 (RUFU-308):
An execution re-arm writes no lifecycle row, so the audit row is the ONLY durable record that the
re-entry was granted and by which evidence it was granted. Both rows stay ids/counts/fixed enums: the
worktree verdicts are the fixed `empty|occupied|unknown` enum, never a path, a diff, or error prose.
Emission uses the bounded FN-9175 seam — telemetry must never become the reason a step did not re-run.
*/
function emitExecutionRearmAudit(
  deps: ExecutionRarmDeps,
  input: ExecutionRarmInput,
  mutationType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const runContext = deps.getRunContextFor?.(input.taskId);
  return emitBoundedRunAudit(deps.store, {
    taskId: input.taskId,
    agentId: runContext?.agentId ?? "executor",
    runId: runContext?.runId ?? generateSyntheticRunId("execution-rearm", input.taskId),
    domain: "database",
    mutationType,
    target: input.taskId,
    metadata: { taskId: input.taskId, ...metadata },
  });
}

/**
 * A standing terminal park whose row-level announcement was cleared by someone else is a disturbance, and a
 * disturbance that records nothing is how RUFU-583 looped 44 times unseen. ONE audit row and ONE History
 * line per episode window, never one per poll: the bounded `logEntryOnce` write is the dedupe authority and
 * the audit row follows only when that write was appended, so a sustained disturbance stays countable at
 * four records an hour per card instead of one per dispatch.
 *
 * The park is NEVER released here — this records the wipe and does not decide from it. Metadata stays
 * ids/counts/fixed enums: no signature, no error sentence, no path.
 */
/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
How long the park-disturbance announcement is allowed to take before the writer stops waiting for it. Not a
retry budget and not the park's own bound — it is the wall-clock ceiling on one best-effort History write, so
that a stuck log sink costs a missing notice instead of a stuck card.
*/
const PARK_ANNOUNCEMENT_BOUND_MS = 2_000;

export async function announceExecutionRearmParkDisturbed(input: {
  store: TaskStore;
  taskId: string;
  agentId?: string;
  runId?: string;
  marker: ExecutionRarmMarker;
  observedFrom: "rearm-claim" | "merge-reset";
  resetSource: "execute-preflight" | "lane-return" | "unknown";
}): Promise<void> {
  const { store, taskId, marker } = input;
    const dedupeKey = `execution-rearm-park-marker-cleared:${taskId}`;
    // The History line is the bound itself: a repeat inside its window answers false, which is what stops a
    // reset that runs on every dispatch from announcing on every dispatch (RUFU-442). The key carries no
    // growing counter, because a key that changes each cycle is not a bound at all.
    //
    // FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028): the write is bounded by ITS OWN wall clock, and
    // the reason is measured: awaiting it unbounded let a never-settling log sink hang the stale-merge cleanup
    // that observed the disturbance — a test caught the reset never returning at all. Telemetry that can stop
    // the writer it describes is the exact defect this card removes, so a sink that will not answer simply
    // means "not announced".
    let appended = false;
    if (typeof store.logEntryOnce === "function") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const attempt = store
          .logEntryOnce(taskId, {
            action:
              "Execution re-arm park still stands on this card, but the row-level notice an earlier pass " +
              "wrote was cleared by another writer. The card stays held; operator Retry resumes the step.",
            outcome: "execution-rearm-park-marker-cleared",
            dedupeKey,
            windowMs: 6 * 60 * 60 * 1000,
          })
          .then((written: unknown) => Boolean(written))
          .catch(() => false);
        const bound = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), PARK_ANNOUNCEMENT_BOUND_MS);
          timer.unref?.();
        });
        appended = await Promise.race([attempt, bound]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  if (!appended) return;
  await emitBoundedRunAudit(store, {
    taskId,
    agentId: input.agentId ?? "executor",
    runId: input.runId ?? generateSyntheticRunId("execution-rearm", taskId),
    domain: "database",
    mutationType: "task:execution-rearm-park-marker-cleared",
    target: taskId,
    metadata: {
      taskId,
      outcome: "marker-cleared",
      observedFrom: input.observedFrom,
      resetSource: input.resetSource,
      attempt: marker.attempt,
      refusal: marker.refusal,
      attemptLimit: MAX_EXECUTION_REARM_ATTEMPTS,
      refusalLimit: MAX_EXECUTION_REARM_REFUSALS,
      parkHeld: marker.heldAt != null,
    },
  });
}

/** One durable, operator-visible park: the card stops looping and says why, exactly once. */
async function terminalizeRearmBudget(
  deps: ExecutionRarmDeps,
  input: ExecutionRarmInput,
  task: TaskDetail,
  nodeId: string | null,
  detail: string,
): Promise<void> {
  const message = `Execution re-arm budget exhausted for step '${nodeId ?? "unknown"}' — ${detail}. Card left in '${task.column}' for operator action (Retry resumes the same step; no further automatic re-arms).`;
  const exhaustedReason = detail.includes("no worktree evidence") ? "no-evidence" : "no-progress";
  const current = await deps.store.getTask(input.taskId).catch(() => task);
  const priorMarker = readExecutionRarmMarker(current);
  await deps.store.updateTask(
    input.taskId,
    {
      status: "failed",
      error: `EXECUTION_REARM_EXHAUSTED: ${detail}`,
      sourceMetadataPatch: executionRarmPatch({
        signature: priorMarker?.signature ?? "",
        attempt: priorMarker?.attempt ?? 0,
        refusal: priorMarker?.refusal ?? 0,
        firstAt: priorMarker?.firstAt ?? new Date().toISOString(),
        at: new Date().toISOString(),
        heldAt: new Date().toISOString(),
        // Stamped from the question that EXHAUSTED the budget, so a later pass asking the same question is
        // refused while a card that genuinely moved forward is not.
        questionStamp: nodeId ? durableQuestionStamp(nodeId, task) : priorMarker?.questionStamp ?? null,
      }),
    },
    deps.getRunContextFor?.(input.taskId),
  ).catch(() => undefined);
  // `logEntryOnce` is the durable dedupe the History surface needs: an in-process set would restart
  // the notice on every engine restart, which is how a bounded loop silently becomes an unbounded one.
  await deps.store.logEntryOnce(input.taskId, {
    action: message,
    outcome: "execution-rearm-exhausted",
    dedupeKey: `execution-rearm-exhausted:${input.taskId}:${nodeId ?? "unknown"}`,
    windowMs: 6 * 60 * 60 * 1000,
  }).catch(() => undefined);
  await emitExecutionRearmAudit(deps, input, "task:execution-rearm-exhausted", {
    nodeId: nodeId ?? "unknown",
    reason: exhaustedReason,
    attempt: priorMarker?.attempt ?? 0,
    refusal: priorMarker?.refusal ?? 0,
    attemptLimit: MAX_EXECUTION_REARM_ATTEMPTS,
    refusalLimit: MAX_EXECUTION_REARM_REFUSALS,
    column: task.column,
    outcome: "exhausted",
  });
}

/**
 * Re-enter the failed step in place. The seed is the whole point: clearing `status`/`error` without a
 * runnable continuation is what produced RUFU-291's dead-but-unmovable card, because the due-poll
 * only reads `runnable`/`retrying` task continuations.
 */
export async function attemptExecutionRearm(
  deps: ExecutionRarmDeps,
  input: ExecutionRarmInput,
): Promise<ExecutionRarmResult> {
  const task = await deps.store.getTask(input.taskId);
  if (!task || task.deletedAt) return { outcome: "not-eligible", detail: "task is gone" };
  if (task.paused === true || task.userPaused === true) {
    return { outcome: "not-eligible", detail: "a human holds the card" };
  }
  if (isDurableBlockedTask(task)) return { outcome: "not-eligible", detail: "the card is durably blocked" };
  if (task.column !== input.wipColumn) {
    return { outcome: "not-eligible", detail: `card is in '${task.column}', not the WIP lane` };
  }
  if (deps.hasLiveExecutionSurface?.(input.taskId)) {
    return { outcome: "not-eligible", detail: "a live execution session still owns the card" };
  }

  const nodeId = await resolveStepExecuteOwner(deps.store, task, input.failedNode);
  if (!nodeId) {
    return { outcome: "not-eligible", detail: `'${input.failedNode ?? "unknown"}' is not a step-execute node` };
  }

  const evidence = await hasStepWorkEvidence(deps, task);
  const signature = rearmSignature(nodeId, task, evidence.hasEvidence ? "occupied" : "unproven");
  const claim = await claimRearmSlot(
    deps, input, signature, durableQuestionStamp(nodeId, task), evidence.hasEvidence ? "attempt" : "refusal",
  );
  if (!claim.allowed) {
    if (claim.liveChanged) return { outcome: "not-eligible", detail: "the card changed under recovery" };
    if (claim.parked) {
      // Step 3's terminal invariant: an existing park is honored verbatim — no second write, no
      // second notification, so "exactly one operator notice" survives an unbounded number of polls.
      return { outcome: "budget-exhausted", detail: "the terminal re-arm park already stands on the card" };
    }
    if (claim.held) {
      await terminalizeRearmBudget(deps, input, task, nodeId, evidence.hasEvidence
        ? `${MAX_EXECUTION_REARM_ATTEMPTS} re-arms produced no step progress`
        : `${MAX_EXECUTION_REARM_REFUSALS} recovery passes found no worktree evidence to preserve`);
      return {
        outcome: "budget-exhausted",
        detail: evidence.hasEvidence ? "re-arm budget exhausted with no step progress" : "no worktree evidence after bounded recovery passes",
      };
    }
    return { outcome: "not-eligible", detail: "the re-arm claim could not be written" };
  }

  if (!evidence.hasEvidence) {
    return {
      outcome: "no-work-evidence",
      detail: `worktree proves no commit or in-progress diff (${evidence.verdicts}); refusal ${claim.refusals}/${MAX_EXECUTION_REARM_REFUSALS}`,
    };
  }

  try {
    await deps.store.replaceActiveTaskWorkflowContinuation({
      taskId: input.taskId,
      runId: `${input.taskId}:execution-rearm:${nodeId}`,
      nodeId,
      kind: "task",
      state: "runnable",
      attempt: 1,
      blockedReason: `execution-rearm:${input.reason}`,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      onlyIfNoActiveTaskContinuation: true,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ActiveTaskContinuationError") {
      return { outcome: "already-owned", detail: `an active continuation already owns '${nodeId}'` };
    }
    return { outcome: "seed-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  /*
  FNXC:LifecycleContainment 2026-10-07-14:10 (RUFU-308):
  Past the seed the card already has its re-entry, so a marker write that fails must not be reported as
  "not handled" — the caller would then park a card the scheduler is about to dispatch. The lane never
  changes here, and the card returns to the "executing, no error" shape it carried while the disposed
  session was running.
  */
  let markersCleared = true;
  try {
    await deps.store.updateTask(input.taskId, { status: null, error: null }, deps.getRunContextFor?.(input.taskId));
  } catch {
    markersCleared = false;
  }
  const message = `Execution re-arm: resuming step '${nodeId}' in place (attempt ${claim.attempts}/${MAX_EXECUTION_REARM_ATTEMPTS}) — worktree evidence, same node and step, no lane change${markersCleared ? "" : "; the failure marker could not be cleared, so the card keeps its error text"}`;
  await deps.store.logEntry(input.taskId, message, undefined, deps.getRunContextFor?.(input.taskId)).catch(() => undefined);
  await emitExecutionRearmAudit(deps, input, "task:execution-rearmed", {
    nodeId,
    reason: normalizeExecutionRarmReason(input.reason),
    attempt: claim.attempts,
    attemptLimit: MAX_EXECUTION_REARM_ATTEMPTS,
    evidence: "occupied",
    outcome: "rearmed",
  });
  return { outcome: "rearmed", detail: message };
}

/*
FNXC:LifecycleContainment 2026-10-07-13:48, extended 2026-10-07-14:05 (RUFU-308):
The closed vocabulary of recovery reasons that ask for the *same* node and step rather than a lane
change, and therefore the complete set of values the `task:execution-rearmed` audit `reason` key can
ever hold. A revision reason (plan/code review, verification, merge fix) owns a contained backward
move and is deliberately absent: routing one here would replace a real remediation with a re-run of
the step that already produced the findings. `merge-boundary-evidence-recovery` already runs its own
bounded ladder in the resume router and is absent for the same reason.
*/
export const EXECUTION_REARM_STEP_FAILED_REASON = "step-failed";

export const EXECUTION_REARM_RECOVERY_REASONS: ReadonlySet<string> = new Set([
  // A step-execute node's run ended in failure — the shape a stuck-session disposal leaves behind.
  EXECUTION_REARM_STEP_FAILED_REASON,
  "self-healing-stranded-recovery",
  "self-healing-session-recovery",
  "self-healing-worktree-reclaim",
]);

/** Normalizes any caller-supplied reason into the closed audit vocabulary. */
export function normalizeExecutionRarmReason(reason: string | null | undefined): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return EXECUTION_REARM_RECOVERY_REASONS.has(trimmed) ? trimmed : "unclassified";
}

/*
FNXC:ExecutionReArm 2026-10-07-15:22 (RUFU-308 Step 3):
An already-stranded card carries no `failedNode` — the graph run that failed it is gone, and the
stuck-session disposal cleared the status that FN-9359's in-place fallback needs. So a recovery pass
that only sees the row has to name the owner node itself, and it may only ever NAME a node, never
assume one: each candidate is validated by `resolveStepExecuteOwner` inside `attemptExecutionRearm`,
which declines before the budget is touched when the candidate is not a `step-execute` seam node of the
card's current IR. Order of trust: the node id the terminalization wrote into `error` (the graph's own
words), then the instantiated owner of the first non-terminal step, then the bare template node of a
non-foreach workflow.
*/
const FAILED_NODE_IN_ERROR = /at node '([^']+)'/;

/** The best `step-execute` owner candidate for a card whose graph run is already over, or null. */
export async function resolveStrandedStepExecuteNode(
  store: TaskStore,
  task: Pick<TaskDetail, "id"> & Partial<Pick<TaskDetail, "error" | "steps">>,
): Promise<string | null> {
  const ir = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  if (!ir) return null;
  const candidates: string[] = [];
  const namedInError = (task.error ?? "").match(FAILED_NODE_IN_ERROR)?.[1];
  if (namedInError) candidates.push(namedInError);
  const pendingStep = (task.steps ?? []).findIndex((step) => step.status !== "done" && step.status !== "skipped");
  if (pendingStep >= 0) candidates.push(`steps#${pendingStep}:step-execute`);
  candidates.push("step-execute");
  for (const candidate of candidates) {
    const node = findWorkflowNodeInstance(ir, candidate);
    const seam = (node?.config as { seam?: string } | undefined)?.seam;
    if (node?.kind === "prompt" && seam === "step-execute") return candidate;
  }
  return null;
}
