/*
FNXC:PromptSpecIntegrity 2026-11-11-07:05 (RUFU-536):
A durable PROMPT.md may contain each lockable section exactly ONCE outside the fenced verbatim
operator-request region. Two different producers had been breaking that independently: a planner
publication that appended a second generation instead of replacing the first, and the specification
hygiene writer that spliced the regenerated `## Original Description` region over a document which
already carried the section, leaving the previous generation's headings stranded below it. Neither
was caught because the only code that could see it — `canonicalizePlan` — reports a duplicated
section as a *plan-approval* degradation and stays silent at the write boundary, so a spliced
document reached disk, and the card then carried two contradictory contracts at once (measured on
RUFU-519: `## Original Description`, `## What This Delivers`, `## Steps` and `## Non-Goals` each
present twice, with the board showing the previous generation's steps).

This module is the single detector for that invariant. It is a thin report over `canonicalizePlan`
rather than a second parser, on purpose: section identity, alias handling (`## Non-Goals` beside
`## Do NOT` is ONE section, not two), and duplicate detection have one owner in the spec lock, and
forking them is how the two views drift apart again. Anything that needs the verdict asks this
module, so the write path and the lock can never disagree.

Refusal policy is deliberately narrower than the report. `blocking` is set for the duplication
classes only, because those are the ones the lock cannot recover from and the ones this invariant
names. The other findings — a section that is merely missing, a region whose boundary cannot be
resolved, a successor heading missing from the section vocabulary — are reported and never refused:
they have a lifecycle owner elsewhere (planning refusal recovery, hygiene repair), and refusing a
publication on a *geometry* judgment the lock itself tolerates would create a refusal with no
recovery path. See `docs/run-audit.md` / `docs/architecture.md` for the refusal-recovery contract.

The report is a pure function of the candidate string: it never rewrites, never trims, and returns
no rewritten content, so a caller cannot accidentally persist a "repaired" document.
*/

import { canonicalizePlan, type SpecLockSection, type SpecParseReason } from "../planner/spec-lock.js";
import {
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
  isKnownPromptSectionHeading,
  resolveOriginalDescriptionEnd,
} from "./original-description-policy.js";
import { findGeneratedOriginalDescriptionRange } from "./original-description-region.js";

export type PromptIntegrityIssueKind =
  /** The same H2 (or one of its declared aliases) appears more than once outside the region. */
  | "section-duplicate"
  /** A lockable section is missing or empty. Reported, never refused — that is planning's call. */
  | "section-unavailable"
  /** An authored `## Original Description` heading outside the generated region (or >1 when unmarked). */
  | "original-description-heading-duplicated"
  /** A generated start marker whose end boundary cannot be resolved from the document. */
  | "original-description-region-unresolved"
  /** The heading after a generated region is not in the section vocabulary (template drift). */
  | "original-description-successor-unknown";

export interface PromptIntegrityIssue {
  kind: PromptIntegrityIssueKind;
  /** Lock section key, present for the section-scoped kinds. */
  section?: SpecLockSection;
  /** `canonicalizePlan`'s own reason, carried through unchanged so the verdict stays comparable. */
  reason?: SpecParseReason;
  /** Only blocking issues refuse a publication. */
  blocking: boolean;
  /** Short actionable sentence naming the heading and the fix. Never quotes operator prose. */
  detail: string;
}

export interface PromptDocumentIntegrityReport {
  /** True when no blocking issue was found. This is the publication gate's verdict. */
  ok: boolean;
  issues: PromptIntegrityIssue[];
  blockingIssues: PromptIntegrityIssue[];
  /** Section keys the document repeats, for callers that only need the offending identity. */
  duplicatedSections: SpecLockSection[];
}

/** Publication refusal: the candidate document would hold one section twice. */
export class DuplicatedPromptSectionError extends Error {
  readonly taskId: string;
  readonly section?: SpecLockSection;
  readonly reason: SpecParseReason | "original-description-duplicate";

  constructor(
    taskId: string,
    section: SpecLockSection | undefined,
    reason: SpecParseReason | "original-description-duplicate",
    detail: string,
  ) {
    super(
      `PROMPT.md for ${taskId} would contain ${section ? `the "${section}" section` : "a section"} twice `
      + `(${reason}). ${detail} Publish one generation: replace the earlier section in place rather `
      + "than appending a second copy below it.",
    );
    this.name = "DuplicatedPromptSectionError";
    this.taskId = taskId;
    this.section = section;
    this.reason = reason;
  }
}

export function isDuplicatedPromptSectionError(value: unknown): value is DuplicatedPromptSectionError {
  return value instanceof DuplicatedPromptSectionError;
}

const DUPLICATE_REASONS: readonly SpecParseReason[] = ["mission-duplicate", "section-duplicate"];

/**
 * Run the single-generation report over a candidate document.
 *
 * Side-effect free by contract: the candidate is never rewritten and no repaired text is returned.
 * The blocking verdict equals `canonicalizePlan`'s own for the duplication classes because it IS
 * that verdict, read from the sections table it returns.
 */
export function inspectPromptDocument(candidate: string): PromptDocumentIntegrityReport {
  const issues: PromptIntegrityIssue[] = [];

  // 1) The lock's own verdict, alias rules included, on the candidate exactly as submitted.
  const plan = canonicalizePlan(candidate);
  const duplicatedSections: SpecLockSection[] = [];
  if (plan.status === "unavailable") {
    for (const [key, section] of Object.entries(plan.sections) as [SpecLockSection, (typeof plan.sections)[SpecLockSection]][]) {
      if (section.status !== "unavailable" || !section.reason) continue;
      const duplicated = DUPLICATE_REASONS.includes(section.reason);
      if (duplicated) duplicatedSections.push(key);
      issues.push({
        kind: duplicated ? "section-duplicate" : "section-unavailable",
        section: key,
        reason: section.reason,
        blocking: duplicated,
        detail: duplicated
          ? `Remove the repeated \`## ${headingLabelFor(key)}\` heading so the section appears once.`
          : `The lockable section is ${section.reason === "mission-empty" ? "empty" : "missing"}; it is reported, not refused.`,
      });
    }
  }

  // 2) Fence integrity the lock deliberately never sees.
  const normalized = candidate.replace(/\r\n?/g, "\n");
  const region = findGeneratedOriginalDescriptionRange(normalized);
  const startMarkerOffset = normalized.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);

  if (startMarkerOffset !== -1 && region === null) {
    const resolution = resolveOriginalDescriptionEnd(normalized, startMarkerOffset + ORIGINAL_DESCRIPTION_START_MARKER.length);
    const successor = resolution.rejectedSuccessorHeading;
    issues.push({
      kind: successor && !isKnownPromptSectionHeading(successor)
        ? "original-description-successor-unknown"
        : "original-description-region-unresolved",
      blocking: false,
      detail: successor
        ? `The generated Original Description region is followed by \`${successor}\`, which is not a known PROMPT section, so the region cannot be bounded and its quoted headings read as document structure.`
        : "The generated Original Description region has no resolvable closing boundary.",
    });
  }

  // 3) A generated region is the ONLY legal home for `## Original Description` when it exists: its own
  //    heading sits inside the resolved range, so any counted copy is a second, authored one. A
  //    document with no markers cannot be bounded from its own text, so there a copy is only reported
  //    (the legacy shape is one unmarked heading, and a refusal the lock cannot diagnose has no
  //    recovery owner). The copy matters for more than tidiness: text outside the region is not
  //    masked, so headings the operator merely quoted read as document structure to both the spec
  //    lock and the board's step parser.
  const authoredHeadingCount = countAuthoredOriginalDescriptionHeadings(normalized, region);
  const allowedAuthoredHeadings = region === null ? 1 : 0;
  if (authoredHeadingCount > allowedAuthoredHeadings) {
    issues.push({
      kind: "original-description-heading-duplicated",
      blocking: region !== null,
      detail: region
        ? `The document carries ${authoredHeadingCount} extra \`${ORIGINAL_DESCRIPTION_HEADING}\` heading(s) outside the generated region, which already carries the operator's verbatim request. Remove the extra copy or move it inside the marked region.`
        : `The document declares \`${ORIGINAL_DESCRIPTION_HEADING}\` ${authoredHeadingCount} times and has no generated region to bound them. Keep exactly one.`,
    });
  }

  const blockingIssues = issues.filter((issue) => issue.blocking);
  return { ok: blockingIssues.length === 0, issues, blockingIssues, duplicatedSections };
}

/**
 * The store-boundary gate: refuse a candidate that would publish a duplicated section.
 *
 * Throws `DuplicatedPromptSectionError` naming the first offending section. Call it BEFORE the row
 * commits so a refusal is a total no-op — nothing is written, and the caller keeps the previous
 * durable document, its approval fingerprint, and its evidence untouched.
 */
export function assertPromptDocumentPublishable(taskId: string, candidate: string): void {
  const report = inspectPromptDocument(candidate);
  const first = report.blockingIssues[0];
  if (!first) return;
  throw new DuplicatedPromptSectionError(
    taskId,
    first.section,
    first.reason ?? "original-description-duplicate",
    first.detail,
  );
}

/** Count authored `## Original Description` H2s, skipping the generated region and fenced code blocks. */
function countAuthoredOriginalDescriptionHeadings(
  text: string,
  region: { start: number; end: number } | null,
): number {
  const heading = new RegExp(`^${ORIGINAL_DESCRIPTION_HEADING}\\s*$`, "i");
  let count = 0;
  let offset = 0;
  let insideCodeFence = false;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideCodeFence = !insideCodeFence;
      continue;
    }
    if (insideCodeFence) continue;
    if (region && lineStart >= region.start && lineStart < region.end) continue;
    if (heading.test(line.trimEnd())) count += 1;
  }
  return count;
}

/** Human heading label for a lock key, used only in the refusal sentence. */
function headingLabelFor(section: SpecLockSection): string {
  switch (section) {
    case "mission": return "Mission";
    case "file-scope": return "File Scope";
    case "steps": return "Steps";
    case "acceptance-criteria": return "Completion Criteria";
    case "non-goals": return "Do NOT";
    case "dependencies": return "Dependencies";
    case "lineage": return "Mission Lineage";
  }
}
