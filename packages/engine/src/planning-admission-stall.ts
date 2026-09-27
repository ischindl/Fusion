/**
 * Pure helpers for the planning-admission stall family (RUFU-273).
 *
 * Everything here is store-free and importable on its own so the age/precedence rules are a narrow
 * test seam rather than something only reachable through a 15 s poll or a self-healing pass.
 *
 * The ladder below is the ONLY place the "which reason does this silent card deserve" question is
 * answered. Triage answers a narrower version of it (it only ever reports the gate it just hit), and
 * the core derivation only reads back what a writer stored; keeping the sweep's precedence here rather
 * than inline in `self-healing.ts` is what makes the ordering testable without a store, a poll, or a
 * git subprocess.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskPlanAdmissionStallCode, TaskPlanAdmissionStallEpisode, WorkflowIr } from "@fusion/core";
import {
  PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS,
  columnsWithFlag,
  declaresAnyLifecycleTrait,
  isFastExecutionMode,
  workflowDeclaresColumnModel,
  workflowPlansInColumn,
  type WorkflowIrColumn,
} from "@fusion/core";
import { getPromptPath } from "./execution/spec-staleness.js";

/**
 * How long a card may sit in a planning lane untouched before its silence becomes reportable.
 *
 * Policy-over-setting, matching the RUFU-180/RUFU-283 surfacing family: the value is a constant, not a
 * new operator knob, and a workflow that wants a different bar declares `recovery.stalenessMs` on its
 * planning column. 48 h is chosen so a card left overnight at the end of a working week never trips
 * the threshold while the operator is away, yet the "it's been sitting there for days" case always does.
 */
export const PLANNING_ADMISSION_STALL_DEFAULT_MS = 48 * 60 * 60_000;

/** A task-shaped row narrowed to what the age computation reads, so callers may pass slim rows. */
interface AgedRow {
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * The card's age in the planning lane: `now - max(createdAt, updatedAt)` (RUFU-273).
 *
 * `updatedAt` rather than `columnMovedAt` on purpose. A card whose plan was rejected and re-seeded in
 * place gets a fresh `updatedAt`, so it is measured from the moment it started waiting *again* — using
 * the original creation time would name a card that has already been through two planning attempts as
 * if it had never been touched. Returns `undefined` when neither timestamp parses, and `0` keeps a card
 * silent: an unparseable clock must never manufacture an "aged" verdict.
 */
export function planningAdmissionAgeMs(task: AgedRow, now: number = Date.now()): number | undefined {
  const stamps = [task.createdAt, task.updatedAt]
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) return undefined;
  const age = now - Math.max(...stamps);
  return Number.isFinite(age) ? age : undefined;
}

/*
FNXC:PlanningAdmissionStall 2026-09-27-04:47 (RUFU-350):
The waiting clock a named card must be measured against.

`planningAdmissionAgeMs` reads `now - max(createdAt, updatedAt)`, and the sweep's own naming write moves
`updatedAt` — `updateTask` stamps it on every accepted write. Measured that way, the pass right after naming
sees a ~0 s card, the age gate fails, and the sweep retracts the badge it wrote minutes earlier with outcome
`no-longer-aged`. RUFU-273's own cadence invariant — a same-code stall refreshes instead of restarting, and
a badge must never erase itself — therefore needs a clock a diagnostic write cannot reset.

REJECTED FIRST: a new `agedFromMs` field on `TaskPlanAdmissionStallEpisode`. It was rejected for what it does
to the OTHER writer, not for its shape. Triage stamps the same key and does not know such a field, and
`planAdmissionStallWrite` copies forward only the keys it knows — so a schema field would either be dropped on
the first triage refresh or force a schema change plus a migration onto a value the sweep can already derive.
The episode already stores its own waiting base in two fields every writer maintains: `firstAt` (when this
gate was first seen) and `ageMs` (how old the card was at that observation). The base is therefore a
derivation, `Date.parse(firstAt) - ageMs`, with no new field and no migration.

REJECTED SECOND: trusting `firstAt` alone. `firstAt` is when the GATE was first seen, which is the very
quantity RUFU-273 fixed — a card that waited five days before any gate could be named restarts its clock at
the naming. A `firstAt`-only base is still self-erasing, because that age sits under the threshold on the
very next pass, and it understates the wait the operator asked to see. `firstAt - ageMs` carries the
pre-existing wait forward; the write may refresh `lastAt` all it likes without touching either term.
*/

/**
 * Signature prefix that identifies the reconciliation sweep as the writer of an episode.
 *
 * The sweep already stamped it (`sweep:<code>`); it is exported so the ownership test below and the write
 * site cannot drift apart on a literal.
 */
export const PLANNING_ADMISSION_STALL_SWEEP_SIGNATURE_PREFIX = "sweep:";

/**
 * Whether an episode carries an age claim the sweep is allowed to reason about.
 *
 * The sweep owns an episode it wrote (its signature carries the prefix) and one that carries no signature at
 * all — only the sweep stamps a code with no composite gate identity, so a signature-less episode is either
 * its own or corrupt. A FOREIGN episode belongs to triage's FN-8600 throttle site, which stamps a
 * pipe-joined gate signature and no `ageMs` the sweep may inherit: reading that card's wait through it would
 * promote another lane's bookkeeping into this sweep's admission arithmetic.
 */
export function isSweepOwnedPlanningAdmissionEpisode(
  episode: TaskPlanAdmissionStallEpisode | undefined | null,
): boolean {
  if (!episode) return true;
  const signature = episode.signature;
  if (typeof signature !== "string" || signature === "") return true;
  return signature.startsWith(PLANNING_ADMISSION_STALL_SWEEP_SIGNATURE_PREFIX);
}

/**
 * The base the waiting clock runs from, or `undefined` when the episode cannot prove one.
 *
 * Only a sweep-owned episode whose `firstAt` parses and whose `ageMs` is a finite number qualifies; the
 * caller falls back to the raw clock for everything else. `firstAt - ageMs` is stable across a refresh only
 * while the refresh re-stamps the PRIOR `ageMs` — stamping the grown age instead slides the base earlier by
 * the refresh interval on every refresh, which the base-stability case pins.
 */
export function planningAdmissionAgeBaseMs(
  episode: TaskPlanAdmissionStallEpisode | undefined | null,
): number | undefined {
  if (!episode || !isSweepOwnedPlanningAdmissionEpisode(episode)) return undefined;
  /*
  FNXC:PlanningAdmissionStall 2026-09-27-05:20 (RUFU-350):
  The stamp must be a STRING before it is parsed, matching `planningAdmissionAgeMs` above. `Date.parse` coerces
  its argument, so a `Date` instance parses too — and parses lossily, dropping the milliseconds. A base built
  from that coercion would be a number nobody wrote, which is exactly the class of invented clock this helper
  exists to stop. A non-string `firstAt` therefore proves no base and falls back to the raw clock.
  */
  const firstAtMs = typeof episode.firstAt === "string" ? Date.parse(episode.firstAt) : Number.NaN;
  const ageMs = episode.ageMs;
  if (!Number.isFinite(firstAtMs) || typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return undefined;
  return firstAtMs - ageMs;
}

/**
 * How long the card has actually been waiting: the reconstructed base when the episode proves one, the raw
 * creation/update clock otherwise.
 *
 * The reconstruction never reads `updatedAt`, which is the point — it is the field the sweep's own write
 * moves. Fresh cards (no episode), cards named by triage (a foreign signature, no inheritable base), and
 * cards whose stamps are corrupt all keep the raw behavior unchanged.
 */
export function planningAdmissionEffectiveAgeMs(
  task: AgedRow,
  episode: TaskPlanAdmissionStallEpisode | undefined | null,
  now: number = Date.now(),
): number | undefined {
  const baseMs = planningAdmissionAgeBaseMs(episode);
  if (baseMs !== undefined) return Math.max(0, now - baseMs);
  // Clamped like the reconstructed arm: a row whose `updatedAt` sits a few ms ahead of this call's clock (or a
  // writer that stamped it in the same pass) has no meaningful negative wait, and an audit row reading `-1`
  // explains nothing to an operator.
  const rawMs = planningAdmissionAgeMs(task, now);
  return rawMs === undefined ? undefined : Math.max(0, rawMs);
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273 Step 3):
How long a `plan-admission-throttled` episode stays TRIAGE-OWNED after its last stamp.

Triage refreshes a sustained throttle at most once per `PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS` (15 min)
and nothing at all while the gate signature is unchanged, so a genuinely throttled card can carry an
episode whose `lastAt` is up to one floor old before the next refresh. A sweep that treats anything
older than the floor as abandoned would name the same card `plan-no-admission` in the gap between two
triage refreshes, and the badge would flip-flop every sweep for as long as the cap holds — which reads
to the operator as an unstable board and destroys the reason's value.

Four floors (60 min) is the honest bound: it is comfortably longer than any refresh gap, and shorter
than the interval after which a "throttled" episode is certainly stale history — a card still throttled
an hour later has been refreshed several times over by a poll that runs every 15 s.
*/
export const PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS = PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS * 4;

/**
 * Branch probes allowed per sweep pass (RUFU-273).
 *
 * The probe is two bounded git subprocesses per card (`rev-parse` + `rev-list`), so it is the only part
 * of this sweep that costs real I/O. Aging cards are rare (that is the point of the threshold), but the
 * cap is what makes "rare" a guarantee rather than an expectation — the same budget shape RUFU-283's
 * vanished-work sweep uses. Cards past the cap stay unnamed; the next pass reaches them.
 */
export const PLANNING_ADMISSION_STALL_MAX_BRANCH_PROBES = 12;

/**
 * Cards one sweep pass will classify (RUFU-273).
 *
 * The shared snapshot is createdAt-ascending, so slicing takes the OLDEST cards first: the card that
 * has been silent longest is the one whose silence is least explainable, and a pathological board cannot
 * starve it by adding newer cards. The cap bounds the per-card IR resolution, not the scan.
 */
export const PLANNING_ADMISSION_STALL_MAX_CANDIDATES = 200;

/**
 * What one aged card's classification pass did to its row (RUFU-273 Step 3).
 *
 * Two counters rather than one — and never one signed number: naming a cause and retracting a cause that
 * stopped being true are different operator facts, and a pass that totalled them together would make a
 * board where work started look identical to a board where work stalled.
 */
export type PlanningAdmissionPassResult = { named: number; retracted: number };

/** The shared "this card's row was not touched" result, one frozen value instead of a fresh literal per site. */
export const PLANNING_ADMISSION_PASS_NOOP: PlanningAdmissionPassResult = { named: 0, retracted: 0 };

/** Outcome of "can this card's spec be read" — the three states are NOT interchangeable. */
export type TaskSpecReadOutcome = "readable" | "absent" | "unreadable";

/**
 * Read a task's `PROMPT.md` far enough to know whether it COULD be read.
 *
 * Absence and unreadability are different diagnoses with different owners. A card with no `PROMPT.md`
 * has simply not been planned yet — the ordinary state of a fresh intake card, and triage's own business
 * — so it must not be named `plan-spec-unreadable`. A file that exists and cannot be read (permissions,
 * a directory in its place, an I/O error) means the planner is being refused input, which no other
 * surface reports. `ENOENT` is therefore `absent`; every other failure is `unreadable`.
 *
 * The content is read and discarded: this asks "is it readable", not "what does it say", so no spec
 * text is retained anywhere and none can reach a log line or an audit row.
 */
export async function probeTaskSpecReadable(rootDir: string, taskId: string): Promise<TaskSpecReadOutcome> {
  try {
    await readFile(getPromptPath(join(rootDir, ".fusion", "tasks"), taskId), { encoding: "utf8" });
    return "readable";
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

/**
 * The card's own planning-lane threshold: its column's declared `recovery.stalenessMs`, else the
 * 48 h default. Declared on the column rather than the workflow because a board can run several intake
 * lanes with different patience, and this is the same precedence the surfacing family applies.
 */
export function resolvePlanningStallThresholdMs(ir: WorkflowIr | undefined, columnId: string): number {
  const declared = ir && "columns" in ir
    ? (ir.columns as WorkflowIrColumn[] | undefined)?.find((column) => column.id === columnId)?.recovery?.stalenessMs
    : undefined;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : PLANNING_ADMISSION_STALL_DEFAULT_MS;
}

/**
 * True when nothing in this card's workflow will ever plan it automatically.
 *
 * Three real shapes, all of which currently look identical to an operator: the fast lane skips planning
 * BY DESIGN (`executionMode: "fast"` with no human plan approval); the column opted out of automatic
 * intake (`intake` trait config `autoTriage: false`), so a human is expected to drive it; and the card
 * rests in a column whose graph has no planning node at all.
 *
 * FAILS OPEN. When the workflow cannot answer the placement question — no IR, or a v1 IR with no column
 * model — this returns `false`, i.e. "probably eligible". Silence from a workflow is not evidence of
 * ineligibility, and the residual `plan-no-admission` sentence is honest about the uncertainty where a
 * "your workflow never plans this" sentence would be wrong.
 */
export function isPlanningLaneIneligible(task: Task, ir: WorkflowIr | undefined): boolean {
  if (isFastExecutionMode(task)) return true;
  if (!ir || !workflowDeclaresColumnModel(ir)) return false;
  // `traits` is an ARRAY of `{trait, config}` on the IR column — the same shape `isManualIntakeColumn` reads in core.
  const intakeTrait = ir && "columns" in ir
    ? (ir.columns as WorkflowIrColumn[] | undefined)
      ?.find((column) => column.id === task.column)?.traits?.find((trait) => trait.trait === "intake")
    : undefined;
  if ((intakeTrait?.config as { autoTriage?: boolean } | undefined)?.autoTriage === false) return true;
  return !workflowPlansInColumn(ir, task.column);
}

/**
 * The lanes one IR plans in, as a set of column ids — or `undefined` when that IR cannot answer the
 * question at all (no IR, or a v1 IR with no column model).
 *
 * FNXC:PlanningAdmissionStall 2026-09-25-20:59:
 * The sweep gained a RETRACT half in the same change as its naming half, and both directions now ask this
 * one question. A boolean here would have made the naming side safe (it skipped on silence) while the clear
 * side corrupted it (an empty set reads as "not a planning lane", so an unreadable workflow would un-name
 * cards it had never seen). Requirement: an IR that cannot answer must be distinguishable from an IR that
 * answers "none".
 *
 * THREE outcomes, not two (RUFU-273). Core already names the trap: `synthesizeDefaultColumns` upgrades a
 * v1 graph by emitting every default column with `traits: []`, so such a board resolves cleanly and answers
 * EMPTY for every role while its lanes plainly exist and hold cards. `declaresAnyLifecycleTrait` is core's
 * own disambiguator for that third state, and `workflowDeclaresColumnModel` covers the column-less IR.
 * Treating either non-answer as "read, and the answer is none" would let the same silence name nothing yet
 * RETRACT what an earlier, resolvable workflow had named — so an IR that cannot answer returns `undefined`
 * and both directions of the sweep stand down on it, while a real IR that simply does not plan in this
 * card's column answers with a set that excludes it.
 *
 * Trait resolution goes through `columnsWithFlag`, the registry-backed accessor every other role query in
 * the repo uses, so this cannot drift from what the board itself renders.
 */
export function resolvePlanningLanes(ir: WorkflowIr | undefined): Set<string> | undefined {
  if (!ir || !workflowDeclaresColumnModel(ir) || !declaresAnyLifecycleTrait(ir)) return undefined;
  return new Set([...columnsWithFlag(ir, "intake"), ...columnsWithFlag(ir, "hold")]);
}

/** The git/worktree evidence for one card, gathered by the sweep and consumed by the ladder. */
export interface PlanningAdmissionBranchEvidence {
  /** The card claims a branch (`task.branch` non-empty). Without one there is nothing to probe. */
  branchClaimed: boolean;
  /**
   * A checkout for this branch is RECORDED and it exists. "Usable" is never "unrecorded": a card whose
   * `worktree` field is absent or blank has no usable checkout, which is precisely the shape the sweep
   * must reach the probe for.
   *
   * FNXC:PlanningAdmissionStall 2026-09-26-00:22 (RUFU-273 code review P1 — an unrecorded worktree read
   * as usable): the reported cards carry a bare `branch` with no `worktree` at all, because the executor's
   * worktree was cleaned up and only the branch claim survived. Reading that as `true` made the
   * `recoverable-work` rung — which asks "is there work nothing can show?" — unreachable for the exact
   * population it was written for. The sweep resolves `isUsableTaskWorktree` for a recorded path and
   * answers `false` for an absent one.
   */
  worktreeUsable: boolean;
  /** Commits on the branch that are not on the integration base; `undefined` = probe failed/unrun. */
  uniqueCommitCount: number | undefined;
}

/** Everything the ladder may consider, already resolved from the row, the IR, and the probes. */
export interface PlanningAdmissionEvidence {
  /** Card age in the planning lane; the sweep only calls with an aged card. */
  ageMs: number;
  /** RUFU-246's premise-rejection episode is present — the card names a reason already. */
  premiseEpisodePresent: boolean;
  /** `nextRecoveryAt` is in the future: the recovery lane owns the card. */
  recoveryBackoffActive: boolean;
  /** `PROMPT.md` exists but could not be read for a reason other than absence (non-`ENOENT`). */
  specUnreadable: boolean;
  /** The workflow offers no planning for this card (no planning node, manual intake, or fast lane). */
  laneIneligible: boolean;
  branch: PlanningAdmissionBranchEvidence;
  /** The persisted planning-admission episode, if any. */
  episode?: TaskPlanAdmissionStallEpisode;
}

/**
 * The ladder's verdict: write this code, or leave the card alone for this named reason.
 *
 * `skip.reason` is the run-audit `outcome` vocabulary for the no-action event, so the ladder and the
 * telemetry cannot drift apart.
 */
export type PlanningAdmissionDecision =
  | { outcome: "write"; code: TaskPlanAdmissionStallCode; uniqueCommitCount?: number }
  | { outcome: "skip"; reason: "already-named" | "premise-held" | "recovery-backoff" | "triage-owned" };

/**
 * Classify an aged planning-lane card into the stall code it should name, or into a skip.
 *
 * PRECEDENCE IS A CONTRACT (RUFU-273). The order is most-specific-evidence first:
 * 1. RUFU-246's premise episode wins — it is a named, richer reason recorded by the lane that actually
 *    read the spec, and this sweep must never overwrite it.
 * 2. A live `nextRecoveryAt` backoff — the core derivation names `plan-recovery-backoff` from that
 *    field alone, so a sweep write would be redundant at best.
 * 3. An unreadable spec — the card is admitted but its plan cannot be read; nothing downstream can work.
 * 4. Lane ineligibility — the workflow never planned to touch this card (manual intake, no planning
 *    node, fast lane). Saying "no admission" here would be the wrong sentence for the operator.
 * 5. Recoverable branch work — the ONLY code that describes work rather than a waiting state, so a
 *    stale episode that claims a waiting state must be corrected by it.
 * 6. A triage-owned throttle episode — triage is still reporting the live gate; see the ownership doc.
 * 7. Otherwise the residual `plan-no-admission`, which means "the loop should have admitted this and
 *    nothing explains why it did not", and stays strictly last because every other code is truer.
 *
 * A card that already names exactly the code the ladder reached is left untouched rather than
 * re-stamped: a badge that is already right needs no refresh, and re-writing it every pass would make
 * the sweep a permanent row-writer for as long as the card sits there.
 */
export function decidePlanningAdmissionStall(
  evidence: PlanningAdmissionEvidence,
  now: number = Date.now(),
): PlanningAdmissionDecision {
  if (evidence.premiseEpisodePresent) return { outcome: "skip", reason: "premise-held" };
  if (evidence.recoveryBackoffActive) return { outcome: "skip", reason: "recovery-backoff" };

  if (evidence.specUnreadable) {
    return writeUnlessAlreadyNamed(evidence, "plan-spec-unreadable");
  }
  if (evidence.laneIneligible) {
    return writeUnlessAlreadyNamed(evidence, "plan-lane-ineligible");
  }
  if (
    evidence.branch.branchClaimed
    && !evidence.branch.worktreeUsable
    && typeof evidence.branch.uniqueCommitCount === "number"
    && evidence.branch.uniqueCommitCount > 0
  ) {
    return writeUnlessAlreadyNamed(evidence, "recoverable-work", evidence.branch.uniqueCommitCount);
  }

  /*
  The residual. A card that already names the residual needs no re-stamp — ever — because nothing new can
  be learned about it while it sits there: re-writing it would turn an hourly sweep into a permanent
  row-writer for the whole life of the card. A card naming a DIFFERENT reason is a different question:
  is that reason still corroborated, or is it history?

  Freshness answers it, because every other writer refreshes its own code on a short poll — triage
  re-stamps a sustained throttle at least once per ownership window, and this sweep re-stamps an
  evidence-backed code whenever the evidence still holds. A fresh episode therefore means "somebody is
  still observing this reason", and a stale one means the reason has outlived its observer. Correcting a
  stale episode is the honest half of the flip-flop guard: without it a card throttled for a capacity
  window that closed three days ago would claim "waiting for a planner slot" forever, which is a worse
  lie than the residual's honesty.
  */
  const episode = evidence.episode;
  if (episode) {
    if (episode.code === "plan-no-admission") return { outcome: "skip", reason: "already-named" };
    const lastAtMs = Date.parse(episode.lastAt);
    const ageSinceStamp = Number.isFinite(lastAtMs) ? now - lastAtMs : Number.POSITIVE_INFINITY;
    if (ageSinceStamp < PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS) {
      return {
        outcome: "skip",
        reason: episode.code === "plan-admission-throttled" ? "triage-owned" : "already-named",
      };
    }
    return { outcome: "write", code: "plan-no-admission" };
  }

  return { outcome: "write", code: "plan-no-admission" };
}

/** A code the card already carries is not a write; a different code corrects the episode. */
function writeUnlessAlreadyNamed(
  evidence: PlanningAdmissionEvidence,
  code: TaskPlanAdmissionStallCode,
  uniqueCommitCount?: number,
): PlanningAdmissionDecision {
  if (evidence.episode?.code === code) return { outcome: "skip", reason: "already-named" };
  return uniqueCommitCount === undefined
    ? { outcome: "write", code }
    : { outcome: "write", code, uniqueCommitCount };
}
