/*
FNXC:DeterministicSpecRejection 2026-11-08-03:20 (RUFU-485):
Planning can refuse its own output. On RUFU-482 the planner wrote a scanned-section note whose path
token ended in U+2026, the deterministic dangling-reference checker read that ellipsis as a file name
and REVISEd, and the planner regenerated the identical sentence from the unchanged input: three
sessions (02:18Z, 02:39Z, 02:49Z), one diagnostic, zero information gained. FN-9512 then routed the
exhaustion through the shared RUFU-768 re-seed seam, which made the SAME unchanged input strictly more
expensive — up to `PLANNING_RESEED_CYCLE_LIMIT` x `MAX_RECOVERY_RETRIES` = 9 identical planner
sessions — and left the resulting `failed` park with no reader at all.

The cadence cannot see this shape because it counts attempts, not inputs: a retry over an unchanged
spec is a byte-for-byte copy of the attempt that just failed, and the deterministic checker is a
function, so its verdict is a function of the spec content alone. This module is the missing input
identity — one sha256 over (diagnostic, spec fingerprint) that says "this is the same refusal over the
same bytes" — plus the terminal disposition that identity earns: park immediately, name a remedy
somebody can actually perform, and leave an owner that can undo the park when the bytes change.

Two discipline rules inherited from the episodes this is modelled on:
- RUFU-246: the identity deliberately EXCLUDES `task.status`. The escalation itself writes status, so
  a status-keyed identity would make every refusal a new episode and the bound would never bite.
- RUFU-395: every number the park reads must be cleared by the SAME operator Retry patch, or Retry is
  a no-op. Hence the key-level clear in `buildManualRetryResetPatch` (core), not a counter here.

Lane boundaries this module must never blur: `PLANNING_RESEED_CYCLE_EXHAUSTED:` (RUFU-768) stays the
honest disposition for *drifting* planning failures, and `PLANNING_FENCE_UNAVAILABLE:` /
`PLANNING_FAILED_EXHAUSTED:` (RUFU-287/288) stay the infrastructure-fence lane's own vocabulary. This
sentinel is authored only by the deterministic spec-validation branch and read only by this lane's
owner and wedge matcher.
*/
import { createHash } from "node:crypto";
import {
  DETERMINISTIC_SPEC_REJECTION_METADATA_KEY,
  type Task,
  type TaskDeterministicSpecRejectionEpisode,
} from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

/** Re-exported so engine readers can name the episode without reaching past this lane's module. */
export type { TaskDeterministicSpecRejectionEpisode } from "@fusion/core";

/**
 * Sentinel prefix of the terminal park error, with the colon, so `startsWith` on the stored error is
 * the one discriminator every consumer uses (sweep candidacy, wedge classification, tests).
 * Precedents: `PLANNING_RESEED_CYCLE_EXHAUSTED` and `SPEC_STALENESS_RECOVERY_EXHAUSTED`.
 */
export const DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED = "DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED:";

/**
 * Window for the card's own History line about the park. Seven days, not one: an operator often returns
 * to a parked card over a week later, and a re-dispatch of the same refusal inside the window must not
 * stack duplicate sentences on the card. The episode plus this window is what keeps the park to one
 * sentence — the shape RUFU-273 gave the planning-admission stall mirror.
 */
export const DETERMINISTIC_SPEC_PARK_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The ONE spec-content normalization, shared by the triage writer and the self-healing reader so the
 * two lanes can literally never disagree about whether the spec changed. Content is what the check is
 * a function of, so this is the fingerprint's whole subject: CRLF is folded to LF and trailing blank
 * lines are dropped, because a trailing newline is not a change in the specification and a re-admission
 * earned by one would burn a session on a refusal that must recur.
 *
 * No whitespace-insensitive trimming inside the body: a planner that rewords a sentence has changed the
 * input the checker consumes, and that is a fresh episode with a full budget by design.
 */
export function computeSpecFingerprint(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/[\r\n]+$/, "");
  return sha256(normalized);
}

/**
 * Rejection identity: WHICH deterministic verdict this is, and nothing else.
 *
 * Two facts force this narrower subject, and both were measured while writing the first board test:
 * - The deterministic branch is reached only when the planner REWROTE the artifact
 *   (`artifactChangedByAttempt = planningAttempt.baseline !== written`, where `baseline` is the
 *   PROMPT.md read immediately before the attempt). A fingerprint of the whole spec inside the identity
 *   therefore differs on literally every reachable refusal, the episode never carries, and the park is
 *   unreachable over RUFU-482's own shape - the same refused sentence regenerated while unrelated bytes
 *   move. That would have shipped this whole bound as dead code.
 * - The checker's diagnostic already names what it refused (the offending path tokens, the heading it
 *   expected), so the diagnostic IS the complete statement of the refused defect. Two identical
 *   diagnostics mean the same defect survived the rewrite, which is the only thing a refusal bound on
 *   "deterministic" may key on.
 *
 * `task.status` is NOT an input (RUFU-246's discipline): the escalation writes status, so a status-keyed
 * identity would make every refusal a new episode. The spec fingerprint is carried separately as the
 * evidence that the INPUT changed - see `advanceDeterministicSpecRejectionEpisode`.
 */
export function computeDeterministicRejectionIdentity(input: { diagnostic: string }): string {
  return sha256(JSON.stringify({ diagnostic: input.diagnostic }));
}

function isEpisodeShape(value: unknown): value is TaskDeterministicSpecRejectionEpisode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.rejectionIdentity === "string"
    && typeof candidate.specFingerprint === "string"
    && typeof candidate.rejectionCount === "number"
    && Number.isInteger(candidate.rejectionCount)
    && (candidate.escalation === "hold" || candidate.escalation === "park")
    && typeof candidate.firstAt === "string"
    && typeof candidate.lastAt === "string";
}

/**
 * Reads the durable episode from a task row. A malformed or legacy value reads as `null`, which is a
 * deliberate fail-OPEN: an unreadable episode must not short-circuit a card whose input the lane
 * cannot prove unchanged, so the card falls back to today's retry-hold / re-seed ladder instead of
 * crashing or park-ing on a corrupt read.
 */
export function readDeterministicSpecRejectionEpisode(
  task: Pick<Task, "sourceMetadata"> | undefined,
): TaskDeterministicSpecRejectionEpisode | null {
  const raw = task?.sourceMetadata?.[DETERMINISTIC_SPEC_REJECTION_METADATA_KEY];
  return isEpisodeShape(raw) ? raw : null;
}

/** One step of the episode ladder, with the verdict the caller must act on. */
export interface DeterministicSpecRejectionStep {
  episode: TaskDeterministicSpecRejectionEpisode;
  /** True when this refusal is the SAME deterministic verdict the episode already records. */
  identicalRejection: boolean;
  /**
   * Why a prior episode was not carried: `diagnostic-drift` is a different defect (a different
   * deterministic answer), `input-changed` is the SAME defect over a spec the lane can prove was
   * rewritten since the park - the one repair the park's own sentence promises.
   */
  resetReason?: "diagnostic-drift" | "input-changed";
}

/**
 * Advances the episode for one deterministic refusal of `specContent`.
 *
 * Ladder (RUFU-485):
 * - refusal 1 records `escalation: "hold"` and the caller keeps today's bounded retry cadence;
 * - the SECOND identical verdict earns `escalation: "park"`, because a deterministic checker cannot
 *   return a different answer while the defect it named is still in the spec - no cadence and no
 *   re-seed cycle is spent on a copy of the same input;
 * - a DIFFERENT verdict is a different defect and earns the full budget, so a legitimate replan is
 *   never short-circuited (this is the drift rule);
 * - a card already parked at this verdict that arrives over a CHANGED spec fingerprint gets exactly one
 *   fresh attempt (`resetReason: "input-changed"`), which is the repair the park sentence names; over
 *   UNCHANGED bytes the park is carried with its count untouched, because re-counting it would let a
 *   repeated dispatch inflate a number the operator reads (RUFU-395).
 */
export function advanceDeterministicSpecRejectionEpisode(
  task: Pick<Task, "sourceMetadata"> | undefined,
  input: { diagnostic: string; specContent: string; now?: () => Date },
): DeterministicSpecRejectionStep {
  const specFingerprint = computeSpecFingerprint(input.specContent);
  const identity = computeDeterministicRejectionIdentity({ diagnostic: input.diagnostic });
  const now = (input.now ?? (() => new Date()))().toISOString();
  const prior = readDeterministicSpecRejectionEpisode(task);
  const sameVerdict = prior !== null && prior.rejectionIdentity === identity;
  const inputChanged = prior === null || prior.specFingerprint !== specFingerprint;

  if (sameVerdict && prior.escalation === "park") {
    if (!inputChanged) {
      // Already parked on this exact verdict over these exact bytes: the terminal write happened once,
      // so neither the count nor `lastAt` moves.
      return { episode: prior, identicalRejection: true };
    }
    // The input genuinely changed since the park: that is the promised repair and buys one attempt.
    return {
      episode: freshEpisode(identity, specFingerprint, now),
      identicalRejection: false,
      resetReason: "input-changed",
    };
  }

  if (sameVerdict) {
    return {
      episode: {
        rejectionIdentity: identity,
        specFingerprint,
        rejectionCount: prior.rejectionCount + 1,
        escalation: "park",
        firstAt: prior.firstAt,
        lastAt: now,
        parkedAt: now,
        ...(prior.staleSpecFingerprint !== undefined
          ? { staleSpecFingerprint: prior.staleSpecFingerprint }
          : {}),
      },
      identicalRejection: true,
    };
  }

  const resetReason: DeterministicSpecRejectionStep["resetReason"] = inputChanged
    ? "input-changed"
    : "diagnostic-drift";
  return {
    episode: freshEpisode(identity, specFingerprint, now),
    identicalRejection: false,
    ...(prior ? { resetReason } : {}),
  };
}

function freshEpisode(
  rejectionIdentity: string,
  specFingerprint: string,
  now: string,
): TaskDeterministicSpecRejectionEpisode {
  return {
    rejectionIdentity,
    specFingerprint,
    rejectionCount: 1,
    escalation: "hold",
    firstAt: now,
    lastAt: now,
  };
}

/**
 * The operator/planner-facing terminal-park sentence. Every remedy it names is reachable:
 * `fn_task_prompt_write` (rewrite this card's own PROMPT.md from the assigned lane), `fn_task_update`
 * (rewrite its description), or an on-disk PROMPT.md edit by an operator. It must never name a demand
 * no lane can perform. The copy FN-9512 retired gated a retry on adjusting the prompt or the model -
 * precisely the lever no lane here holds - and it is what left RUFU-482's author and reviewer each
 * waiting for the other.
 */
export function buildDeterministicSpecExhaustedError(input: {
  attempts: number;
  diagnostic: string;
}): string {
  return `${DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED} specification was refused for the identical `
    + `deterministic reason on ${input.attempts} consecutive attempts (${input.diagnostic}). `
    + `Repeating cannot pass - the assigned lane can rewrite this card's own spec `
    + `(fn_task_prompt_write) or description (fn_task_update), or an operator can edit the on-disk `
    + `PROMPT.md; this card is re-admitted automatically once its spec changes.`;
}

/** True when a stored task error is this lane's terminal park. One discriminator for every reader. */
export function isDeterministicSpecValidationParkError(
  error: string | null | undefined,
): boolean {
  return typeof error === "string" && error.startsWith(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
}

/** Patch fragment that records the episode. Merge is KEY-level, like every other episode marker. */
export function deterministicSpecRejectionPatch(
  episode: TaskDeterministicSpecRejectionEpisode,
): { sourceMetadataPatch: Record<string, TaskDeterministicSpecRejectionEpisode> } {
  return { sourceMetadataPatch: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: episode } };
}

/**
 * The parked shape this lane's OWNER selects: the sentinel error AND a readable episode at
 * `escalation: "park"`. Both halves are required because each alone over-accepts. A `failed` card whose
 * error names the sentinel but whose episode is unreadable has no recorded known-rejected fingerprint,
 * so the owner cannot prove the spec moved - it must stay parked rather than re-admit on a guess. An
 * episode stuck at `"hold"` beside the sentinel is the same proof gap in the other direction.
 *
 * Sibling of `getPlanningFencePark` (RUFU-288): the park and its owner read the SAME predicate, so the
 * two lanes cannot disagree about whether a card is still parked.
 */
export function readDeterministicSpecRejectionPark(
  task: Pick<Task, "status" | "error" | "sourceMetadata"> | undefined,
): TaskDeterministicSpecRejectionEpisode | null {
  if (!task || task.status !== "failed") return null;
  if (!isDeterministicSpecValidationParkError(task.error)) return null;
  const episode = readDeterministicSpecRejectionEpisode(task);
  return episode?.escalation === "park" ? episode : null;
}

/**
 * Patch fragment for the owner's single re-admission: the episode returns to `"hold"` (a further attempt
 * is allowed again) and stamps `staleSpecFingerprint` with the bytes that earned the repair, so the same
 * content can never re-admit a second time.
 *
 * `rejectionCount` deliberately SURVIVES. The next identical verdict therefore parks after ONE session
 * instead of two, which is the whole bound this card exists to enforce: a repair that rewrote the count
 * would give every subsequent copy of the same refusal a fresh pair of sessions, and the operator would
 * watch the card oscillate between `needs-replan` and the park while the refused defect stayed put.
 */
export function deterministicSpecRepairPatch(
  episode: TaskDeterministicSpecRejectionEpisode,
  staleSpecFingerprint: string,
): { sourceMetadataPatch: Record<string, TaskDeterministicSpecRejectionEpisode> } {
  const repaired: TaskDeterministicSpecRejectionEpisode = {
    rejectionIdentity: episode.rejectionIdentity,
    specFingerprint: episode.specFingerprint,
    rejectionCount: episode.rejectionCount,
    escalation: "hold",
    firstAt: episode.firstAt,
    lastAt: episode.lastAt,
    staleSpecFingerprint,
  };
  return { sourceMetadataPatch: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: repaired } };
}

/*
FNXC:DeterministicSpecRejection 2026-11-08-03:20 (RUFU-485):
One row per terminal park, so a card that stopped on its own handwriting is queryable instead of being
an ordinary `failed` row: before this event the only trace of an identical-input park was the History
line, and RUFU-768 established why the park needs a row of its own (`a failed card has no automatic
planning claimant`, so the park is invisible to every discovery pass). Metadata is ids/counts/digests/
fixed enums only - never the diagnostic text or the spec content. Emission is the FN-9175 bounded seam,
so telemetry can never prevent the park it records.
*/
export function emitDeterministicSpecRejectionParkAudit(
  store: RunAuditSinkHost,
  input: {
    taskId: string;
    runContext?: { agentId?: string; runId?: string };
    rejectionCount: number;
    rejectionIdentity: string;
  },
): Promise<void> {
  return emitBoundedRunAudit(store, {
    taskId: input.taskId,
    agentId: input.runContext?.agentId ?? "triage",
    runId: input.runContext?.runId ?? generateSyntheticRunId("deterministic-spec-rejection", input.taskId),
    domain: "database",
    mutationType: "task:deterministic-spec-rejection-parked",
    target: input.taskId,
    metadata: {
      taskId: input.taskId,
      // The digest of the verdict this lane recognised as already-known. It is an id, not prose: it is
      // the only way a reader can join two parks and ask "the same refusal?", and the diagnostic
      // sentence itself stays on the card.
      rejectionIdentity: input.rejectionIdentity,
      rejectionCount: input.rejectionCount,
      outcome: "parked",
    },
  });
}

