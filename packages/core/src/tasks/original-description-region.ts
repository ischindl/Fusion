import { createLogger } from "../process/logger.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
  resolveOriginalDescriptionEnd,
} from "./original-description-policy.js";

/**
 * FNXC:PlanApproval 2026-07-15-21:30:
 * FN-8008 — Original Description bodies are verbatim, so marker-like text can occur both
 * inside the generated body and later in operator-authored prompt content. The generated
 * closing marker is bounded by the next known PROMPT section (or end of file), preventing a
 * later literal marker from swallowing a real Mission/Steps/File Scope revision.
 *
 * FNXC:SpecLock 2026-09-07-05:09:
 * The spec-lock parser and approval fingerprint share this resolver so operator prose cannot
 * drift their view of planner-authored prompt structure.
 *
 * FNXC:SpecLock 2026-09-09-08:09:
 * FN-9272 derives accepted marker successors from the policy-owned terminator list. This keeps
 * the planner-required What This Delivers section aligned with spec-lock parsing while retaining
 * the known-heading boundary that prevents literal markers in operator prose from swallowing plans.
 */
export function findGeneratedOriginalDescriptionEnd(promptText: string, start: number): number {
  if (start === -1) return -1;
  const result = resolveOriginalDescriptionEnd(
    promptText,
    start + ORIGINAL_DESCRIPTION_START_MARKER.length,
  );
  return result.resolved ? result.end : -1;
}

/**
 * FNXC:PromptSpecIntegrity 2026-11-11-07:05 (RUFU-536):
 * Absolute [start, end) range of the generated Original Description section — its
 * `## Original Description` heading (or, when that heading line was edited away, its start marker)
 * through its generated closing marker — or null when the document carries no resolvable generated
 * region. This is the ONE geometry answer for every
 * consumer that needs to know which bytes of a PROMPT.md are verbatim operator text rather than
 * planner-authored structure: `stripGeneratedOriginalDescription` deletes the range,
 * `maskGeneratedOriginalDescription` blanks it in place, and the step parser refuses to read step
 * headings out of it. One resolver, one range: a second reader re-deriving this boundary is what
 * let quoted operator text be counted as document structure in the first place. Unresolved stays
 * loud here because this is the read path, and unresolved takes precedence over skipped candidates.
 */
export function findGeneratedOriginalDescriptionRange(promptText: string): { start: number; end: number } | null {
  const start = promptText.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
  if (start === -1) return null;
  const result = resolveOriginalDescriptionEnd(
    promptText,
    start + ORIGINAL_DESCRIPTION_START_MARKER.length,
  );
  // The read path alone reports ambiguity: unresolved takes precedence over skipped candidates.
  if (!result.resolved) {
    createLogger("original-description-region").warn(
      `Generated Original Description start marker has no acceptable end marker; successor heading: ${result.rejectedSuccessorHeading ?? "(no following H2 heading)"}; skipped candidates: ${result.skippedCandidateCount}`,
    );
    return null;
  }
  if (result.skippedCandidateCount > 0) {
    createLogger("original-description-region").warn(
      `Generated Original Description skipped candidates before a resolved end marker: ${result.skippedCandidateCount}`,
    );
  }

  // The generated section always carries its heading above its start marker, so the heading is where the
  // region begins. A document whose heading line was edited away still has a marker-delimited verbatim
  // body, and that body is still operator text: fall back to the start marker rather than to "no region",
  // because returning null here would hand the quoted body back to every raw reader — which is exactly how
  // a quoted previous generation's `### Step N:` headings became the board's step list (RUFU-536).
  const heading = promptText.lastIndexOf(ORIGINAL_DESCRIPTION_HEADING, start);
  const regionStart = heading === -1 ? start : heading;
  if (heading === -1) {
    createLogger("original-description-region").warn(
      "Generated Original Description end marker resolved but no heading precedes the start marker; masking from the start marker.",
    );
  }
  return { start: regionStart, end: result.end + ORIGINAL_DESCRIPTION_END_MARKER.length };
}

/** Remove only the exact deterministic Original Description section injected during specification hygiene. */
export function stripGeneratedOriginalDescription(promptText: string): string {
  const range = findGeneratedOriginalDescriptionRange(promptText);
  if (!range) return promptText;
  const before = promptText.slice(0, range.start).trimEnd();
  const after = promptText.slice(range.end).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/*
FNXC:PromptSpecIntegrity 2026-11-11-07:05 (RUFU-536):
Byte-length-preserving alternative to the strip: every character of the generated region becomes a
space except its newlines, so an offset located in the masked text addresses the SAME byte of the
original document. Consumers that must report or slice offsets into the durable PROMPT.md — the step
matcher, whose callers slice the raw prompt with the indices they were handed — cannot use a strip
without mis-slicing, and cannot ignore the region without promoting quoted operator text into the
board's step list. Masking is the only shape that satisfies both.
*/
/** Mask the generated Original Description region without changing the document's byte length. */
export function maskGeneratedOriginalDescription(promptText: string): string {
  const range = findGeneratedOriginalDescriptionRange(promptText);
  if (!range) return promptText;
  const masked = promptText.slice(range.start, range.end).replace(/[^\n]/g, " ");
  return `${promptText.slice(0, range.start)}${masked}${promptText.slice(range.end)}`;
}
