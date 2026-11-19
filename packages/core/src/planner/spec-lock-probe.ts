/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
A `PROMPT.md` that lacks the spec lock's ONLY required section can never be plan-approved, and until
this module nothing said so. `canonicalizePlan` declares `mission` as its single `required: true`
section, a zero-match yields `unavailable / mission-missing`, and the first unavailable section
short-circuits `contentHash` — so the store funnel throws `UnavailablePlanLockError` and triage parks
`PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)`. That text names a parser code and
never states the operative fact: the spec's OWN missing required section makes approval impossible as
written. Measured live at filing: RUFU-424 (no `## Mission` anywhere, Slovak intake stub) and RUFU-492
(re-authored; now refused for a duplicated `## File Scope`) both sat in `todo` indefinitely, with the
identical-sourceHash dedup re-parking silently.

The invariant encoded here: an unavailable lock is classified by its REAL cause, naming the section,
the heading the author must write, the spec file path, and who owns the recovery. Three classes are
deliberately distinct because their remedies differ:
  - `unapprovable` — the authoring shape cannot lock (missing / empty / duplicated section);
  - `intentionally-inert` — the card is a `DUPLICATE: <ID>` redirect sentinel and owes no lock at all;
  - `prompt-file-missing` — there is no readable spec to lock, which is not an authoring verdict.

This module is pure: it parses nothing of its own and touches no filesystem, so the census CLI, the
store funnel, and triage all read the SAME classification. It never re-parses — a caller holding an
already-canonical plan calls `classifyCanonicalPlan` directly.
*/
import { parseExplicitDuplicateMarker } from "../duplicates/explicit-duplicate-marker.js";
import {
  canonicalizePlan,
  SPEC_LOCK_EXPECTED_HEADINGS,
  type CanonicalPlan,
  type PlanEvidenceBindings,
  type SpecLockSection,
  type SpecParseReason,
} from "./spec-lock.js";

/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
Re-exported so a consumer that already imports the probe reads the heading it must write from the same
module that named it as missing. The declaration stays in `spec-lock.js`, the parse owner — one table,
two names for it.
*/
export { SPEC_LOCK_EXPECTED_HEADINGS };

/**
 * What an unavailable lock MEANS for recovery. Locked vocabulary — the census CLI's exit code and the
 * history sentence both key on it, so a new class must be added here and classified deliberately.
 */
export type SpecLockDisposition = "lockable" | "unapprovable" | "intentionally-inert" | "prompt-file-missing";

/** Who can end the state. `none` means nothing is owed; `operator` means a planner cannot act. */
export type SpecLockRecoveryOwner = "none" | "planner-respec" | "operator";

/** Parser reasons whose remedy is re-authoring a heading, not recovering bytes. */
const DUPLICATE_SHAPE_REASONS: ReadonlySet<SpecParseReason> = new Set<SpecParseReason>(["mission-duplicate", "section-duplicate"]);

export interface SpecLockProbeInput {
  /** The spec text exactly as the lock attempt would feed it to `canonicalizePlan`. */
  prompt: string;
  /** Same binding derivation the lock funnel uses, so a probe can never disagree with the lock. */
  bindings?: PlanEvidenceBindings;
  taskId?: string;
  /** Absolute path of the `PROMPT.md` the prompt came from, echoed verbatim into the verdict. */
  promptPath?: string;
  /** Live pause state (`userPaused === true || paused === true`) of the card being probed. */
  paused?: boolean;
  /** The on-disk spec is absent or unreadable, independent of what the prompt string holds. */
  promptFileMissing?: boolean;
}

/** Context for a caller that already holds the parse (`classifyCanonicalPlan`). */
export interface SpecLockClassificationContext {
  taskId?: string;
  promptPath?: string;
  paused?: boolean;
  promptFileMissing?: boolean;
  /**
   * Raw spec text, consulted ONLY for the `DUPLICATE: <ID>` sentinel classification. Omitted, a
   * sentinel cannot be recognised from a plan alone and the verdict falls to `unapprovable`.
   */
  prompt?: string;
}

export interface SpecLockLockableVerdict {
  status: "lockable";
  disposition: "lockable";
  recoveryOwner: "none";
}

export interface SpecLockUnavailableVerdict {
  status: "unavailable";
  reason: SpecParseReason | "unknown";
  /** The first section the parser refused; `mission` stands in only for a malformed plan. */
  missingSection: SpecLockSection;
  /** The heading text the author must write, e.g. `## Mission`. */
  expectedHeading: string;
  promptPath: string | null;
  disposition: Exclude<SpecLockDisposition, "lockable">;
  recoveryOwner: SpecLockRecoveryOwner;
  /**
   * Operator sentence naming section + heading + path + owner. It NEVER carries the
   * heading-exculpation stem, which is RUFU-534's sentence about prompt SIZE and stays beside this one.
   */
  summary: string;
}

export type SpecLockVerdict = SpecLockLockableVerdict | SpecLockUnavailableVerdict;

/** A spec whose lock is unavailable, classified by its real cause without re-parsing. */
export function classifyCanonicalPlan(
  plan: CanonicalPlan,
  context: SpecLockClassificationContext = {},
): SpecLockVerdict {
  const promptPath = context.promptPath?.trim() || null;
  const subject = context.taskId?.trim() || promptPath || "the spec";
  const section = firstUnavailableSection(plan);
  const expectedHeading = SPEC_LOCK_EXPECTED_HEADINGS[section];
  const location = promptPath ? ` in ${promptPath}` : "";

  /*
  FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
  A blank or absent spec is not an authoring verdict — there is nothing to re-author — so it is
  classified BEFORE the parse verdict and never reported as `mission-missing`. The recovery belongs to
  a human because restoring a deleted spec file is not something a planner turn can do.
  */
  if (context.promptFileMissing || (context.prompt !== undefined && context.prompt.trim() === "")) {
    return {
      status: "unavailable",
      reason: plan.status === "unavailable" && plan.reason ? plan.reason : "unknown",
      missingSection: section,
      expectedHeading,
      promptPath,
      disposition: "prompt-file-missing",
      recoveryOwner: "operator",
      summary: `${subject} has no readable PROMPT.md${location}, so its plan cannot be locked at all. Recovery owner: operator — restore the spec file, then re-plan.`,
    };
  }

  /*
  FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
  The `DUPLICATE: <ID>` sentinel is a redirect the planner wrote on purpose: the card is inert and
  correctly so. Its PROMPT.md will never carry `## Mission`, so without this class a census would
  report ten intentional parks as ten failures and bury the one card that really is unapprovable.
  Reuses the shared sentinel parser rather than re-regexing it here.
  */
  if (context.prompt !== undefined) {
    const sentinel = parseExplicitDuplicateMarker(context.prompt);
    if (sentinel) {
      return {
        status: "unavailable",
        reason: plan.status === "unavailable" && plan.reason ? plan.reason : "unknown",
        missingSection: section,
        expectedHeading,
        promptPath,
        disposition: "intentionally-inert",
        recoveryOwner: "none",
        summary: `${subject} is a deliberate redirect to ${sentinel.canonicalId}${location}; its spec carries no lockable section on purpose and no lock recovery is owed. Recovery owner: none.`,
      };
    }
  }

  if (plan.status === "available" && plan.contentHash) {
    return { status: "lockable", disposition: "lockable", recoveryOwner: "none" };
  }

  const reason: SpecParseReason | "unknown" = plan.status === "unavailable" && plan.reason ? plan.reason : "unknown";
  /*
  FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
  A pause changes the OWNER and never the disposition: the defect is still in the spec, but a planner
  cannot re-author a held card, so naming "planner-respec" would point at an action nobody may take.
  Duplicates are re-authoring fixes too — measured on RUFU-492, whose `## File Scope` appears twice —
  so they share this owner rule rather than reading as damage.
  */
  const recoveryOwner: SpecLockRecoveryOwner = context.paused ? "operator" : "planner-respec";
  const remedy = context.paused
    ? "unpause the card, then re-author that heading in PROMPT.md"
    : "re-author that heading in PROMPT.md";
  const cause = DUPLICATE_SHAPE_REASONS.has(reason as SpecParseReason)
    ? `declares its ${expectedHeading} section more than once`
    : reason === "mission-empty"
      ? `carries an empty ${expectedHeading} section`
      : `has no ${expectedHeading} section`;

  return {
    status: "unavailable",
    reason,
    missingSection: section,
    expectedHeading,
    promptPath,
    disposition: "unapprovable",
    recoveryOwner,
    summary: `${subject} can never be plan-approved as written: the spec ${cause}${location} (parser reason: ${reason}, section: ${section}). Recovery owner: ${recoveryOwner} — ${remedy}; the identical-prompt dedup releases on the first changed spec.`,
  };
}

/**
 * Deterministic pre-flight probe: parse with the SAME entry point the approval gate uses, then
 * classify. Callers that already parsed pass the plan to `classifyCanonicalPlan` instead.
 */
export function probeSpecLockReadiness(input: SpecLockProbeInput): SpecLockVerdict {
  const plan = canonicalizePlan(input.prompt, input.bindings);
  return classifyCanonicalPlan(plan, {
    taskId: input.taskId,
    promptPath: input.promptPath,
    paused: input.paused,
    promptFileMissing: input.promptFileMissing,
    prompt: input.prompt,
  });
}

/**
 * The section the lock refused, in the parser's own declaration order.
 *
 * FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
 * `canonicalizePlan` short-circuits on the FIRST unavailable section, so asking the section map is
 * what reproduces the reported reason. `mission` is the honest stand-in for a plan carrying no
 * unavailable entry (a malformed or hand-edited snapshot), because it is the only required section.
 */
function firstUnavailableSection(plan: CanonicalPlan): SpecLockSection {
  for (const [key, section] of Object.entries(plan.sections) as Array<[SpecLockSection, CanonicalPlan["sections"][SpecLockSection]]>) {
    if (section?.status === "unavailable") return key;
  }
  return "mission";
}
