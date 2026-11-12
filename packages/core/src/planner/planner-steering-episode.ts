/**
 * FNXC:PlannerOversight 2026-11-11-11:35:
 * RUFU-586: the durable anti-spam budget behind planner-overseer steering.
 *
 * The overseer's only bound on repeating ITS OWN instruction used to be a count kept in a `Map` inside
 * `PlannerRecoveryController`. Three ordinary production events lower that count - an engine restart empties
 * the Map, a healthy signal deletes the key (FN-7577 does it deliberately, because the card's overseer badge
 * derives from `attemptCount > 0`), and a watched-stage change moves to a new key - so the documented cap of
 * 3 was unreachable for a card whose signal oscillates. One card measured 77 byte-identical
 * `[planner-oversight]` comments in ~20 h, each one a durable row in `comments` AND `steering_comments`
 * (both arrays plus their `search_vector` GIN entries get rewritten per append), an intervention-timeline
 * entry, and a task-log line. (The spec priced each duplicate at an RUFU-259 inbox delivery and a wake of the
 * assignee too; measurement disproved that - `deliverTaskCommentFromStore` is reached only from the CLI,
 * dashboard routes and Planner Chat, never from `addSteeringCommentImpl`, which is the path the overseer uses.)
 * Two guards that landed after this was first reported (`PLANNER_OVERSIGHT_GUIDANCE_DEDUPE_MS`
 * in the controller, newest-entry equality in `addSteeringCommentImpl`) key on byte-identical TEXT and are
 * in-process, so they absorb only the homogeneous case; a stalled card alternating `stuck`/`blocked` still
 * wrote one comment per problem tick on main when this was measured.
 *
 * This module is the count that cannot be reset: one budget per REASON SIGNATURE per card, persisted on
 * `task.sourceMetadata[PLANNER_OVERSIGHT_STEERING_METADATA_KEY]`, so it survives restarts, `clear()`, and
 * signal flaps. It is pure - no store, no clock, no I/O - so the arithmetic is testable without a database
 * and the engine ledger owns only the read/write. It never throws: anything it cannot parse degrades to
 * "no budget recorded", which delivers and lets the next write repair the value, because steering that fails
 * closed would silence a card that is genuinely stuck.
 *
 * Why the episode carries a budget PER SIGNATURE and not one active budget: a single-slot budget is reset by
 * the very shape this bug is about. `reasonForSignal` renders "Signal: `stuck`" and "Signal: `blocked`" for
 * the same stall, so a card flapping between them flips the slot every tick and every tick looks like a new
 * reason - measured at 24 posts in 24 ticks. `prior` keeps the other instructions' budgets alive, LRU-capped,
 * so oscillation costs a card its quiet, not its budget.
 *
 * The ceiling this buys is PER REASON CLASS, never per card, and the comment that claimed otherwise is corrected
 * by measurement: one watched stage can render at most three classes for the gated actions (`stuck`/`blocked`
 * for `inject_guidance` at planner-recovery.ts:353, `failed` for the reviewer stage at :313, and one fixed
 * string for `request_targeted_fix` at :332), so a single stage fits inside `PLANNER_STEERING_TRACKED_SIGNATURES`;
 * two flapping watched stages can present more classes than the episode tracks, and an evicted `prior` entry
 * refills its budget when it returns. The store's newest-entry equality guard contributes NOTHING to that
 * churning case - `addSteeringCommentImpl` refuses only a BYTE-IDENTICAL newest `steeringComments` entry
 * (task-artifacts-ops.ts:869), and alternating reason texts are not byte-identical - so it absorbs only the
 * homogeneous flood this card actually measured. A per-card bound, if the board ever wants one, is an aggregate
 * counter per cooldown window in this episode, or evicting already-cooled `prior` entries first.
 */

import { createHash } from "node:crypto";
import type { PlannerOversightSteeringEpisode, PlannerSteeringBudgetEntry } from "../types.js";
import { PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS, PLANNER_RECOVERY_MAX_ATTEMPTS } from "./planner-recovery.js";

/**
 * What makes one steering instruction the same instruction. `action` keeps a targeted fix distinct from
 * guidance even if their reasons ever converged; `stage` keeps a reviewer's steering from spending an
 * executor's budget; the reason class carries the substance.
 *
 * Every digit RUN becomes one `N` and whitespace collapses, because several reason strings interpolate
 * elapsed time ("inactive for over 3h", "41m elapsed"). A signature that churned with the clock would
 * restart its budget every tick - RUFU-442's measured failure was exactly "a bound whose key changed each
 * cycle". A run collapses to one `N` rather than per-digit `N`s precisely so a clock crossing 9 → 10 does
 * not change the key either.
 */
export function deriveSteeringReasonClass(reason: string): string {
  return String(reason ?? "").trim().replace(/\s+/g, " ").replace(/\d+/g, "N");
}

/** Stable 16-hex identity of one instruction: `sha256(action|stage|reasonClass)`. Length-free and never throws. */
export function deriveSteeringSignature(input: { action: string; stage: string; reason: string }): string {
  const reasonClass = deriveSteeringReasonClass(input?.reason);
  const action = String(input?.action ?? "");
  const stage = String(input?.stage ?? "");
  return createHash("sha256").update(`${action}|${stage}|${reasonClass}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * How many distinct instructions one card's episode tracks: the active one plus this many `prior` entries.
 * The reason vocabulary is a handful of templates per watched stage, so four is room to spare; the cap is
 * what stops a card that fabricates reasons from accumulating metadata forever.
 */
export const PLANNER_STEERING_TRACKED_SIGNATURES = 4;

/** `"suppress"` refuses the post; `"deliver"` and `"re-arm"` both post, and only `"re-arm"` resets its budget. */
export type PlannerSteeringEpisodeVerdict = "deliver" | "re-arm" | "suppress";

/** WHY the verdict is what it is - a fixed union so a caller can branch on cause without parsing prose. */
export type PlannerSteeringEpisodeBasis =
  /** No budget recorded for this instruction: the planner has never told the agent this thing. */
  | "fresh"
  /** Another instruction's budget exists but not this one's: different information, new budget. */
  | "reason-changed"
  /** Same instruction, still under its cap: this repeat is inside its own budget. */
  | "cooldown"
  /** Same instruction, cap spent, cooldown elapsed: a stalled card earns one fresh delivery. */
  | "cooldown-elapsed"
  /** Same instruction, cap spent, cooldown still running: nothing new to tell the agent. */
  | "cap-reached";

export interface EvaluatePlannerSteeringEpisodeInput {
  /** The signature of the instruction about to be posted (see `deriveSteeringSignature`). */
  signature: string;
  /** Epoch ms. Callers pass the overseer's own `ctx.now()` seam so no test needs fake timers. */
  now: number;
  /** Deliveries allowed per instruction per episode. Defaults to the shared bounded-recovery cap. */
  cap?: number;
  /** Silence required after an instruction spends its cap before it re-arms. Defaults to `PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS`. */
  cooldownMs?: number;
}

export interface PlannerSteeringEpisodeEvaluation {
  verdict: PlannerSteeringEpisodeVerdict;
  basis: PlannerSteeringEpisodeBasis;
  /** Convenience for the dispatch gate: `verdict !== "suppress"`. */
  allowed: boolean;
  /** Signature this evaluation is about - echoed so a writer never re-derives it and drifts. */
  signature: string;
  /** Deliveries already recorded for THIS instruction (0 when none). */
  deliveredCount: number;
  /** Count this instruction will carry if the delivery is made. */
  deliveredCountAfter: number;
  /** The budget entry this decision was made against (null when the instruction is untracked). */
  entry: PlannerSteeringBudgetEntry | null;
  /** Effective cap used for the decision. */
  cap: number;
  /** True when this instruction is at or past its cap (the fact the cooldown is now waiting out). */
  budgetExhausted: boolean;
  /** True when a delivery starts a fresh clock for this instruction (`firstAt` moves to `now`). */
  startsNewEpisode: boolean;
}

function isUsableEntry(value: unknown): value is PlannerSteeringBudgetEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<PlannerSteeringBudgetEntry>;
  if (typeof entry.signature !== "string" || entry.signature.length === 0) return false;
  if (typeof entry.deliveredCount !== "number" || !Number.isFinite(entry.deliveredCount) || entry.deliveredCount < 0) {
    return false;
  }
  return Date.parse(String(entry.lastAt ?? "")) > 0;
}

/** Episode-shaped and at least its active entry parses. Anything else is "no episode" to this module. */
function isUsableEpisode(value: unknown): value is PlannerOversightSteeringEpisode {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isUsableEntry(value);
}

function parseTime(value: unknown, fallback: number): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTiming(input: EvaluatePlannerSteeringEpisodeInput | undefined) {
  const now = Number.isFinite(input?.now) ? (input!.now as number) : Date.now();
  const cap = Number.isFinite(input?.cap) && (input!.cap as number) > 0 ? (input!.cap as number) : PLANNER_RECOVERY_MAX_ATTEMPTS;
  const cooldownMs =
    Number.isFinite(input?.cooldownMs) && (input!.cooldownMs as number) >= 0
      ? (input!.cooldownMs as number)
      : PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS;
  return { now, cap, cooldownMs, signature: String(input?.signature ?? "") };
}

function freshDecision(signature: string, cap: number): PlannerSteeringEpisodeEvaluation {
  return {
    verdict: "deliver",
    basis: "fresh",
    allowed: true,
    signature,
    deliveredCount: 0,
    deliveredCountAfter: 1,
    entry: null,
    cap,
    budgetExhausted: false,
    startsNewEpisode: true,
  };
}

/**
 * The budget entry governing one instruction, active slot first. `prior` entries written by an older build
 * or corrupted by hand are skipped rather than trusted, so a bad entry can never grant a fresh budget
 * forever nor crash the gate.
 */
function findEntry(episode: PlannerOversightSteeringEpisode | null | undefined, signature: string): PlannerSteeringBudgetEntry | null {
  if (!isUsableEpisode(episode)) return null;
  if (episode.signature === signature) return episode;
  const priors = Array.isArray(episode.prior) ? episode.prior : [];
  for (const candidate of priors) {
    if (isUsableEntry(candidate) && candidate.signature === signature) return candidate;
  }
  return null;
}

/**
 * Decide whether one steering instruction may be posted, given the card's recorded budgets. Pure and total:
 * an instruction with no usable budget reads as untracked, which delivers and lets the next write record it.
 */
export function evaluatePlannerSteeringEpisode(
  episode: PlannerOversightSteeringEpisode | null | undefined,
  input: EvaluatePlannerSteeringEpisodeInput,
): PlannerSteeringEpisodeEvaluation {
  const { now, cap, cooldownMs, signature } = resolveTiming(input);
  const entry = findEntry(episode, signature);

  if (!entry) {
    const decision = freshDecision(signature, cap);
    // A tracked-but-different instruction is worth naming in the verdict: "the planner is steering about
    // something else" is the fact an operator reads, not "nothing was ever delivered".
    return isUsableEpisode(episode) ? { ...decision, basis: "reason-changed", entry: null } : decision;
  }

  const deliveredCount = Math.floor(entry.deliveredCount);
  const base = { signature, cap, entry } as const;

  if (deliveredCount < cap) {
    return {
      ...base,
      verdict: "deliver",
      basis: "cooldown",
      allowed: true,
      deliveredCount,
      deliveredCountAfter: deliveredCount + 1,
      budgetExhausted: false,
      startsNewEpisode: false,
    };
  }

  const lastAt = parseTime(entry.lastAt, now);
  if (now - lastAt >= cooldownMs) {
    return {
      ...base,
      verdict: "re-arm",
      basis: "cooldown-elapsed",
      allowed: true,
      deliveredCount,
      deliveredCountAfter: 1,
      budgetExhausted: true,
      startsNewEpisode: true,
    };
  }

  return {
    ...base,
    verdict: "suppress",
    basis: "cap-reached",
    allowed: false,
    deliveredCount,
    deliveredCountAfter: deliveredCount,
    budgetExhausted: true,
    startsNewEpisode: false,
  };
}

export type ApplyPlannerSteeringDeliveryInput = EvaluatePlannerSteeringEpisodeInput;

function toEntry(entry: PlannerSteeringBudgetEntry): PlannerSteeringBudgetEntry {
  const stamped: PlannerSteeringBudgetEntry = {
    signature: entry.signature,
    deliveredCount: Math.max(0, Math.floor(entry.deliveredCount)),
    firstAt: entry.firstAt,
    lastAt: entry.lastAt,
  };
  if (entry.noticeRecordedAt) stamped.noticeRecordedAt = entry.noticeRecordedAt;
  return stamped;
}

/** Entries other than `keep`, newest-first, minus anything corrupt and anything equal to the active slot. */
function otherEntries(episode: PlannerOversightSteeringEpisode | null | undefined, keep: string): PlannerSteeringBudgetEntry[] {
  if (!isUsableEpisode(episode)) return [];
  const collected: PlannerSteeringBudgetEntry[] = [];
  if (episode.signature !== keep && isUsableEntry(episode)) collected.push(toEntry(episode));
  for (const candidate of Array.isArray(episode.prior) ? episode.prior : []) {
    if (isUsableEntry(candidate) && candidate.signature !== keep) collected.push(toEntry(candidate));
  }
  collected.sort((a, b) => parseTime(b.lastAt, 0) - parseTime(a.lastAt, 0));
  return collected.slice(0, PLANNER_STEERING_TRACKED_SIGNATURES - 1);
}

/**
 * The episode value to persist AFTER a steering comment actually landed. Callers must reach it only past the
 * gate and only on a real delivery: an episode advanced for a post that never happened would silence a card
 * whose store write failed.
 *
 * The delivered instruction becomes the active slot, which is what keeps oscillation from refilling anything
 * - the other instructions' budgets ride in `prior`, newest-first and LRU-capped. A re-arm and an untracked
 * instruction both start a new clock for themselves, so that entry's `firstAt` moves to `now`: an entry's
 * `firstAt` means "when this instruction started being delivered", never "when the card first went stale".
 * The one-shot notice marker is dropped when an entry restarts, so each episode gets exactly one "already
 * delivered" timeline row per instruction and never more.
 */
export function applyPlannerSteeringDelivery(
  episode: PlannerOversightSteeringEpisode | null | undefined,
  input: ApplyPlannerSteeringDeliveryInput,
): PlannerOversightSteeringEpisode {
  const { now, signature } = resolveTiming(input);
  const stamp = new Date(now).toISOString();
  const decision = evaluatePlannerSteeringEpisode(episode, { ...input, now });
  const delivered: PlannerSteeringBudgetEntry = {
    signature,
    deliveredCount: decision.deliveredCountAfter,
    firstAt: decision.startsNewEpisode || !decision.entry ? stamp : decision.entry.firstAt ?? stamp,
    lastAt: stamp,
    ...(decision.entry?.noticeRecordedAt && !decision.startsNewEpisode ? { noticeRecordedAt: decision.entry.noticeRecordedAt } : {}),
  };

  return {
    ...toEntry(delivered),
    prior: otherEntries(episode, signature),
  };
}

/**
 * The one-shot "already delivered" notice stamp, written at most once per instruction per episode so the
 * intervention timeline answers "why did the planner stop steering?" without a row per 45 s poll.
 *
 * `promoteSignature` is the refused instruction. A refusal against a `prior` budget makes that instruction the
 * most recent one, so it moves into the ACTIVE slot (only the active slot carries the stamp) and its stale twin
 * must not stay in `prior` consuming a tracked slot; `otherEntries` re-derives the survivors, which is the SAME
 * slot arithmetic `applyPlannerSteeringDelivery` uses. Without that parameter the stamp lands on the active slot
 * and `prior` rides along untouched — the shape used right after a real delivery, where the caller has just
 * written the active slot itself.
 *
 * FNXC:PlannerOversight 2026-11-12-14:54 (RUFU-586 review F-2):
 * Promotion used to live in the engine ledger, which kept its own copy of the slot rule ("mirrors core's own
 * slot arithmetic") so its notice write and core's delivery write could not disagree. Two copies of one rule
 * that must agree is drift waiting to happen, so the rule now exists once, here, and the ledger passes the
 * signature it is announcing instead of recomputing the survivor list.
 */
export function withPlannerSteeringNotice(
  episode: PlannerOversightSteeringEpisode | null | undefined,
  now: number,
  promoteSignature?: string,
): PlannerOversightSteeringEpisode | null {
  if (!isUsableEpisode(episode)) return null;
  const stamp = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  if (promoteSignature !== undefined) {
    const prior = Array.isArray(episode.prior) ? episode.prior : [];
    const target =
      episode.signature === promoteSignature
        ? episode
        : prior.find((candidate) => isUsableEntry(candidate) && candidate?.signature === promoteSignature);
    if (target) {
      const promoted = toEntry(target);
      promoted.noticeRecordedAt = stamp;
      return { ...promoted, prior: otherEntries(episode, promoteSignature) };
    }
  }
  const active = toEntry(episode);
  active.noticeRecordedAt = stamp;
  return { ...active, prior: Array.isArray(episode.prior) ? episode.prior : undefined };
}

/**
 * Reads a raw `sourceMetadata` value back without trusting the shape: anything unusable reads as "no
 * episode" rather than throwing at the gate. The caller passes the value it read under
 * `PLANNER_OVERSIGHT_STEERING_METADATA_KEY`, so this module never duplicates that key literal.
 */
export function asPlannerSteeringEpisode(value: unknown): PlannerOversightSteeringEpisode | null {
  return isUsableEpisode(value) ? value : null;
}
