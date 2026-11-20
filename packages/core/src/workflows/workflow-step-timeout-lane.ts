/*
FNXC:WorkflowStepTimeoutLane 2026-11-18-02:25 (RUFU-684):
Every prompt-mode workflow step shared ONE per-session-attempt budget (`workflowStepTimeoutMs`, 900 s),
while the lanes' real durations differ by an order of magnitude. The card that opened this work measured
361 primary-timeout rows across 95 cards (Code Review 206, Plan Review 81, Post-merge verification 65,
Completion summary 9) over 646 retained task-directory mirrors — a lower bound, because the agent log is
capped and the overflow is deleted. The durable ledger this module's vocabulary now lets a census read
tells the same story from the other side: 1,071 persisted review/plan/verification gate episodes on this
board carry the canonical timeout sentence in exactly ONE of them, while the same cards' surviving History
windows still hold 456 timeout lines and 298 second-attempt re-arms. The class is common and the durable
sources cannot see it. So the review lanes paid a two-budget latency tax on most cards and recorded the
tax nowhere durable.

This module is the single vocabulary that fixes both halves. It owns:

- the lane classifier (so the engine's budget decision, the `task:workflow-step-timeout` audit row and
  `scripts/workflow-step-timeout-census.mjs` cannot disagree about which lane a step belongs to), and
- the per-lane budget resolution, which keeps the 60 s floor and never invents a third attempt.

The classification rules are NOT new policy: they are the predicate that previously lived inline in
`packages/engine/src/executor/execute-workflow-step.ts` (`isPlanReviewStep` /
`isReviewTypeWorkflowStep`), moved here verbatim so the shipped product has exactly one copy of each
literal instead of one per consumer. A census script cannot import the engine's executor, so an inline
engine-only predicate leaves the measurement and the fix spelling the lanes differently by construction.

Deliberate literals below: `PLAN_REVIEW_STEP_NAME`, `CODE_REVIEW_NAME` and `COMPLETION_SUMMARY_STEP_ID`
mirror the authored built-in step names/ids. They were already literals at the engine read site; moving
them here removes the second copy rather than adding one.
*/

import { PLAN_REVIEW_GROUP_ID } from "./builtin-plan-review-group.js";
import { CODE_REVIEW_GROUP_ID } from "./builtin-code-review-group.js";
import { DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS, DEFAULT_WORKFLOW_STEP_TIMEOUT_MS } from "./builtin-workflow-settings.js";
import type { Settings } from "../types.js";

/** The review group id that is also a lane name, kept explicit so the vocabulary is greppable. */
const BROWSER_VERIFICATION_GROUP_ID = "browser-verification";
/** Graph prompt node that writes the card's completion summary; not a review surface. */
const COMPLETION_SUMMARY_STEP_ID = "completion-summary";
/** DELIBERATE-LITERAL: mirrors the built-in's authored `name` for the completion summary node. A caller
 *  that only holds a step NAME (a History line, where the id was never written) still lands in the right
 *  lane because of it. */
const COMPLETION_SUMMARY_STEP_NAME = "Completion Summary";
/** DELIBERATE-LITERAL: the built-in post-merge group authors its step as `Post-merge verification`. A
 *  caller that knows only the NAME (a History line carries no `phase`) still resolves the lane through it;
 *  without this the same step would be `post-merge-verification` to the engine and `other-prompt-step` to
 *  the census, which is precisely the disagreement this module exists to prevent. */
const POST_MERGE_NAME_PREFIX = "post-merge";
/** DELIBERATE-LITERAL: mirrors the built-in's authored `name` for Plan Review. */
const PLAN_REVIEW_STEP_NAME = "Plan Review";
/** DELIBERATE-LITERAL: mirrors the built-in's authored `name` for Code Review. */
const CODE_REVIEW_NAME = "Code Review";
/** DELIBERATE-LITERAL: the same review-type name test the executor has always used. */
const REVIEW_TYPE_NAME_RE = /(?:^|\b)(?:review|verification)(?:\b|$)/i;

/**
 * The closed lane vocabulary of prompt-mode workflow steps. A lane is a *budget* class and an
 * *audit* label at the same time, which is the point: one row of the census and one budget
 * decision must name the same population.
 */
export const WORKFLOW_STEP_TIMEOUT_LANES = [
  "plan-review",
  "code-review",
  "post-merge-verification",
  "completion-summary",
  "other-prompt-step",
] as const;

export type WorkflowStepTimeoutLane = (typeof WORKFLOW_STEP_TIMEOUT_LANES)[number];

/** Coerce an arbitrary persisted/external string into the lane vocabulary (`null` = unknown). */
export function asWorkflowStepTimeoutLane(value: unknown): WorkflowStepTimeoutLane | null {
  return typeof value === "string" && (WORKFLOW_STEP_TIMEOUT_LANES as readonly string[]).includes(value)
    ? (value as WorkflowStepTimeoutLane)
    : null;
}

/**
 * Everything a caller may know about one prompt-mode step. Both shapes are supported on purpose:
 * the engine has the live graph node (raw `nodeId` plus its `optionalGroupId`), while a census over
 * persisted `tasks.workflow_step_results` only has the ids that were stamped at run time
 * (`stepId` = `optionalGroupId ?? nodeId` minus the `graph:` prefix).
 */
export type WorkflowPromptStepInput = {
  /** Persisted/effective step id (already group-resolved). */
  stepId?: string | null;
  /** Raw graph node id, when the caller is inside graph execution. */
  nodeId?: string | null;
  /** Step name at execution time. */
  name?: string | null;
  /** `pre-merge` | `post-merge`, from the node or the persisted result. */
  phase?: string | null;
  /** Owning optional group, when known. */
  optionalGroupId?: string | null;
  /** Author-declared review category. */
  reviewKind?: string | null;
  /** Author-declared review capability flag (engine only). */
  reviewCanFixInline?: boolean;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Resolve the optional-group id the step belongs to, from whichever shape the caller holds. */
function resolveOptionalGroupId(input: WorkflowPromptStepInput): string | null {
  if (typeof input.optionalGroupId === "string" && input.optionalGroupId.trim()) {
    return input.optionalGroupId.trim();
  }
  // A raw graph node id means the caller had the node in hand; absence of a group is real absence.
  // With no node id at all, the persisted effective step id IS the group id when one existed.
  if (input.nodeId) return null;
  const stepId = typeof input.stepId === "string" ? input.stepId.trim() : "";
  return stepId || null;
}

/** Resolve the effective step id the executor would have computed. */
function resolveEffectiveStepId(input: WorkflowPromptStepInput, optionalGroupId: string | null): string {
  if (optionalGroupId) return optionalGroupId;
  if (input.nodeId) return input.nodeId.replace(/^graph:/, "").trim();
  return (input.stepId ?? "").trim();
}

/** True for the Plan Review gate, by node id, authored name, or owning group id. */
export function isPlanReviewPromptStep(input: WorkflowPromptStepInput): boolean {
  return input.nodeId === "graph:plan-review-step"
    || normalize(input.name) === normalize(PLAN_REVIEW_STEP_NAME)
    || resolveOptionalGroupId(input) === PLAN_REVIEW_GROUP_ID;
}

/**
 * True when the step is an independent validation surface (validator lane). This is exactly the
 * predicate the executor used to inline: it decides the model lane, the read-only tool policy, and
 * from RUFU-684 on, which timeout budget applies.
 */
export function isReviewTypePromptStep(input: WorkflowPromptStepInput): boolean {
  const optionalGroupId = resolveOptionalGroupId(input);
  return isPlanReviewPromptStep(input)
    || input.reviewCanFixInline === true
    || REVIEW_TYPE_NAME_RE.test(input.name ?? "")
    || optionalGroupId === PLAN_REVIEW_GROUP_ID
    || optionalGroupId === CODE_REVIEW_GROUP_ID
    || optionalGroupId === BROWSER_VERIFICATION_GROUP_ID;
}

/**
 * Classify one prompt-mode step into the closed lane vocabulary.
 *
 * Order matters and is the contract: Plan Review and the completion summary are named before the
 * generic review-name test (both also satisfy it), and a post-merge validation surface is its own
 * lane because it runs after the card has landed, where a timeout costs differently than pre-merge.
 */
export function classifyWorkflowPromptStepLane(input: WorkflowPromptStepInput): WorkflowStepTimeoutLane {
  const optionalGroupId = resolveOptionalGroupId(input);
  const effectiveStepId = resolveEffectiveStepId(input, optionalGroupId);
  if (isPlanReviewPromptStep(input)) return "plan-review";
  if (
    normalize(effectiveStepId) === normalize(COMPLETION_SUMMARY_STEP_ID)
    || normalize(input.name) === normalize(COMPLETION_SUMMARY_STEP_NAME)
  ) {
    return "completion-summary";
  }
  const name = normalize(input.name);
  if ((normalize(input.phase) === "post-merge" || name.startsWith(POST_MERGE_NAME_PREFIX))
    && REVIEW_TYPE_NAME_RE.test(input.name ?? "")) {
    return "post-merge-verification";
  }
  if (optionalGroupId === CODE_REVIEW_GROUP_ID || normalize(input.reviewKind) === "code" || normalize(input.name) === normalize(CODE_REVIEW_NAME)) {
    return "code-review";
  }
  return "other-prompt-step";
}

/**
 * The floor every prompt-mode budget keeps regardless of lane. A step that cannot run for one
 * minute is a misconfiguration, not a bound, and the pre-RUFU-684 read site already refused lower.
 */
export const WORKFLOW_STEP_TIMEOUT_FLOOR_MS = 60_000;

/** Which knob answered for a lane — surfaced so the audit row and the docs name the same thing. */
export type WorkflowStepTimeoutKnob = "workflowReviewStepTimeoutMs" | "workflowStepTimeoutMs";

export type WorkflowStepTimeoutBudget = {
  lane: WorkflowStepTimeoutLane;
  reviewType: boolean;
  knob: WorkflowStepTimeoutKnob;
  timeoutMs: number;
};

/**
 * Resolve the per-session-attempt budget for one prompt-mode step.
 *
 * Review-type lanes read `workflowReviewStepTimeoutMs`; everything else keeps
 * `workflowStepTimeoutMs` byte-for-byte, so raising the review budget cannot delay detection of a
 * hung execution, summary, or post-merge session. `settings` MUST be the MERGED effective map: a raw
 * graph-supplied map carries neither a declaration default nor an operator's stored workflow value.
 *
 * FNXC:WorkflowStepTimeoutLane 2026-11-19-07:10 (RUFU-684):
 * A review-type lane arms the LARGER of its own knob and the shared knob, never less than the shared one.
 * The re-run of the census that motivated this card found the reason sitting in live configuration: two
 * boards had already raised the shared `workflowStepTimeoutMs` to rescue their reviews -- 2 700 s on one,
 * 1 800 s on another, against the 900 s default -- which is the same conclusion this card reached, paid
 * for by widening every lane at once. If the review lane read its own knob ALONE, shipping a 1 800 s
 * review default would have quietly CUT those boards' review budget from 45 min to 30 min: a card that
 * today completes a review would start spending two budgets and end unreviewed, by an upgrade, which is
 * the exact failure this card exists to remove. Taking the max keeps the knob strictly additive -- no
 * board's review budget shrinks because of this change -- while the shared number still cannot starve a
 * review on boards that never raised it (unset shared leaves the review default in charge).
 * The anti-appeasement property is preserved: the shared DEFAULT stays 900 s, so nothing here buys extra
 * time for a hung execution or summary lane, and a raised shared value remains the operator's own choice.
 */
export function resolveWorkflowStepTimeoutBudget(
  settings: Pick<Settings, "workflowStepTimeoutMs" | "workflowReviewStepTimeoutMs"> | null | undefined,
  input: WorkflowPromptStepInput,
): WorkflowStepTimeoutBudget {
  const reviewType = isReviewTypePromptStep(input);
  const lane = classifyWorkflowPromptStepLane(input);
  const sharedBudget = settings?.workflowStepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS;
  const declarationDefault = reviewType
    ? DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS
    : DEFAULT_WORKFLOW_STEP_TIMEOUT_MS;
  const configured = reviewType ? settings?.workflowReviewStepTimeoutMs : settings?.workflowStepTimeoutMs;
  const candidate = reviewType
    ? Math.max(configured ?? declarationDefault, sharedBudget)
    : (configured ?? declarationDefault);
  return {
    lane,
    reviewType,
    knob: reviewType ? "workflowReviewStepTimeoutMs" : "workflowStepTimeoutMs",
    timeoutMs: Math.max(WORKFLOW_STEP_TIMEOUT_FLOOR_MS, candidate),
  };
}
