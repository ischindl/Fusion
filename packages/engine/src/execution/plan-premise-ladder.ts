import { createHash } from "node:crypto";
import {
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  type PlanPremiseRejectionEpisode,
  type Task,
} from "@fusion/core";
import type { PlanPremiseCheckResult } from "./plan-premise-check.js";

/*
FNXC:PlanPremises 2026-09-16-03:20:
RUFU-246 escalation ladder for repeated identical plan-premise release refusals. A premise refusal
must survive replanning, so the episode lives on `sourceMetadata.planPremiseRejection` (see the
core FNXC block on that key) and is written only through key-preserving `sourceMetadataPatch`
updates. The ladder is deliberately driven by the REJECTION IDENTITY, not the status:
signature = sha256(plan-review node id, authoritative-prompt fingerprint, sorted dependencies,
sorted violated premises [kind, path, reason]). `task.status` is NOT an input — the same broken
plan refuses identically whether or not a prior refusal changed status, and any input change
(replanned PROMPT.md, edited dependencies, different violated set) starts a fresh budget.
Ladder per identical signature: refusal 1 → hold without status change; refusal 2 →
`needs-replan` carrying `lastDetail` to the planner; refusal 3 → terminal park (`failed` +
`PLAN PREMISE CONTRACT EXHAUSTED:` sentinel) that later releases short-circuit on.
*/

/** Sentinel prefix on the terminal-park error; operators and tests match on it. */
export const PLAN_PREMISE_EXHAUSTED_PREFIX = "PLAN PREMISE CONTRACT EXHAUSTED:";

/*
FNXC:PlanPremises 2026-09-16-03:36:
RUFU-246 — the refusal episode logs as ONE action-keyed History entry per action+detail, not a
line per gate poll: `logEntryOnce` dedupes on `plan-premise-refusal:<detailHash>` within a wide
window, so the whole hold→replan→park walk over one unchanged rejection writes a single entry and
the terminal sticky-park cannot re-log. The window only needs to outlive concurrent doors plus
repeated release attempts over the same broken plan; the episode's signature drift starts a fresh
log the moment the plan (or deps, or violated set) actually changes. Triage replans read the
planner-facing detail from the durable episode, not from this log.
*/
export const TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION = "Plan premise release gate refused execution";
export const PLAN_PREMISE_REFUSAL_LOG_WINDOW_MS = 7 * 24 * 60 * 60_000;

/*
FNXC:PlanPremises 2026-09-27-03:00:
STAS-282 — the delivery-invalidated verdict is evidence, not a refusal, so it gets its own action key
and its own one-shot window. Keeping it a distinct action is what lets the release doors write the
evidence WITHOUT touching the refusal episode: an operator reading History sees that the card's own
commits are what falsified its plan, and the planner is never handed a card whose work already exists.
*/
export const TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION = "Plan premise invalidated by the card's own delivery";

export type PlanPremiseEscalation = "hold" | "replan" | "park";

export interface PlanPremiseLadderStep {
  episode: PlanPremiseRejectionEpisode;
  escalation: PlanPremiseEscalation;
  /** Set when a prior episode was discarded because the rejection identity changed. */
  resetReason?: "signature-drift";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Rejection identity: everything that describes WHY the card was refused, nothing else. */
export function computePlanPremiseRejectionSignature(input: {
  planReviewNodeId: string;
  check: Pick<PlanPremiseCheckResult, "promptFingerprint" | "premiseViolations">;
  dependencies: readonly string[];
}): string {
  const violations = input.check.premiseViolations
    .map((violation) => ({
      kind: violation.premise.kind,
      path: violation.premise.path,
      literal: "literal" in violation.premise ? violation.premise.literal : null,
      reason: violation.reason,
    }))
    .sort((a, b) =>
      // Sort key extends the spec's kind+path+reason with the literal: two same-path text
      // premises sharing a reason would otherwise sort unstably and drift the signature.
      `${a.kind}\u0000${a.path}\u0000${a.reason}\u0000${a.literal}`.localeCompare(`${b.kind}\u0000${b.path}\u0000${b.reason}\u0000${b.literal}`),
    );
  return sha256(JSON.stringify({
    planReviewNodeId: input.planReviewNodeId,
    promptFingerprint: input.check.promptFingerprint,
    dependencies: [...input.dependencies].sort(),
    violations,
  }));
}

function isEpisodeShape(value: unknown): value is PlanPremiseRejectionEpisode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.signature === "string"
    && typeof candidate.refusalCount === "number"
    && Number.isInteger(candidate.refusalCount)
    && typeof candidate.lastDetail === "string"
    && typeof candidate.lastAt === "string"
    && (candidate.escalation === "hold" || candidate.escalation === "replan" || candidate.escalation === "park")
    && typeof candidate.detailHash === "string";
}

/** Reads the durable episode from a task row; malformed or absent state reads as null. */
export function readPlanPremiseRejectionEpisode(task: Task): PlanPremiseRejectionEpisode | null {
  const raw = task.sourceMetadata?.[PLAN_PREMISE_REJECTION_METADATA_KEY];
  return isEpisodeShape(raw) ? raw : null;
}

/**
 * Advances the episode for one more refusal of `check`. A signature mismatch resets the count
 * (fresh plan revision, edited dependencies, or a different violated set is a fresh episode); a
 * prior `park` with the SAME signature stays parked rather than silently reopening the ladder.
 */
export function advancePlanPremiseRejectionEpisode(
  task: Task,
  input: { planReviewNodeId: string; check: PlanPremiseCheckResult; now?: () => Date },
): PlanPremiseLadderStep {
  const signature = computePlanPremiseRejectionSignature({
    planReviewNodeId: input.planReviewNodeId,
    check: input.check,
    dependencies: task.dependencies ?? [],
  });
  const prior = readPlanPremiseRejectionEpisode(task);
  if (prior && prior.signature === signature && prior.escalation === "park") {
    return { episode: prior, escalation: "park" };
  }
  const carrying = prior !== null && prior.signature === signature;
  const refusalCount = carrying ? prior.refusalCount + 1 : 1;
  const escalation: PlanPremiseEscalation = refusalCount >= 3 ? "park" : refusalCount === 2 ? "replan" : "hold";
  const detail = "detail" in input.check ? input.check.detail : "";
  return {
    episode: {
      signature,
      refusalCount,
      lastDetail: detail,
      lastAt: (input.now ?? (() => new Date()))().toISOString(),
      escalation,
      detailHash: sha256(detail),
    },
    escalation,
    ...(prior && prior.signature !== signature ? { resetReason: "signature-drift" as const } : {}),
  };
}

/** Operator/planner-facing terminal-park sentence built around the checker's refusal detail. */
export function buildPlanPremiseExhaustedError(detail: string): string {
  return `${PLAN_PREMISE_EXHAUSTED_PREFIX} ${detail} — the same plan premises were refused three times in a row; rewrite the plan against the current code or delete this card.`;
}

/**
 * True when the card is terminally parked on an exhausted premise contract. Release doors
 * short-circuit on this so a parked card is never re-evaluated, re-refused, or released.
 */
export function isPlanPremiseParkTerminal(task: Task): boolean {
  const episode = readPlanPremiseRejectionEpisode(task);
  return episode?.escalation === "park"
    && task.status === "failed"
    && typeof task.error === "string"
    && task.error.startsWith(PLAN_PREMISE_EXHAUSTED_PREFIX);
}
