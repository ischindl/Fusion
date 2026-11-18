export interface ExplicitDuplicateMarker {
  canonicalId: string;
}

export type ExplicitDuplicateMarkerSource = "prompt" | "title";

export interface ExplicitDuplicateMarkerResolution {
  marker: ExplicitDuplicateMarker | null;
  source: ExplicitDuplicateMarkerSource | null;
  conflict: boolean;
}

/*
FNXC:DuplicateIntake 2026-11-18-05:59 (RUFU-730):
This is the SECOND parser of the same `DUPLICATE:` sentinel sentence, and its id grammar deliberately
DIFFERS from the shared dictionary in `packages/core/src/tasks/task-id-token.ts` that RUFU-730 moved
`parseNoOpCompletionMarker` onto. Recorded here so the divergence reads as a decision, not a stray third
grammar: this pattern is anchored at BOTH ends on a single-line sentinel (`^…\s*$` over one non-blank
line), so the syntax already bounds the id and the prose variant's `(?![\w-])` right boundary is not
needed. What would change is breadth: `[A-Z]+-\d+` is LETTERS-only-prefix, while the canonical token
admits digits inside the prefix, so composing it would newly accept `A1-2` and `SANE4-42` at this surface.
This is the refusal/redirect surface - a matched id sends an operator's card to that canonical twin - so it
keeps the stricter grammar, while the completion-summary parser (which only reports, and whose input is
free text) takes the shared one. Both agree on every id the canonical minting grammar produces with a
letters-only prefix, which is what the cross-parser agreement case pins.
*/
const DUPLICATE_MARKER_PATTERN = /^DUPLICATE:\s*([A-Z]+-\d+)\s*$/i;

function stripCodeFenceLayer(content: string): string {
  const fenceMatch = content.match(/^```(?:[\t ]*(?:text|markdown))?[\t ]*\n([\s\S]*?)\n```$/i);
  if (!fenceMatch) {
    return content;
  }
  return fenceMatch[1] ?? "";
}

function stripSingleWrapper(line: string): string {
  if (line.startsWith("`") && line.endsWith("`") && line.length >= 2) {
    return line.slice(1, -1).trim();
  }
  if (line.startsWith("**") && line.endsWith("**") && line.length >= 4) {
    return line.slice(2, -2).trim();
  }
  return line;
}

/**
 * Detects the canonical triage "redirect" marker emitted by the planning
 * agent when the new task duplicates an existing one.
 */
export function parseExplicitDuplicateMarker(content: string): ExplicitDuplicateMarker | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const withoutFence = stripCodeFenceLayer(trimmed).trim();
  const nonBlankLines = withoutFence
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonBlankLines.length !== 1) {
    return null;
  }

  const candidate = stripSingleWrapper(nonBlankLines[0] ?? "");
  const match = candidate.match(DUPLICATE_MARKER_PATTERN);
  if (!match) {
    return null;
  }

  return {
    canonicalId: match[1].toUpperCase(),
  };
}

/*
FNXC:DuplicateIntake 2026-08-09-01:02:
FN-8840 requires every duplicate-decision and admission surface to evaluate the exact marker in
both PROMPT.md and the task title. Prompt wins only when both sources name the same canonical ID;
conflicting redirects fail closed so Fusion never silently chooses an operator's target.
*/
export function resolveExplicitDuplicateMarker(
  promptContent: string | null | undefined,
  title: string | null | undefined,
): ExplicitDuplicateMarkerResolution {
  const promptMarker = typeof promptContent === "string" ? parseExplicitDuplicateMarker(promptContent) : null;
  const titleMarker = typeof title === "string" ? parseExplicitDuplicateMarker(title) : null;

  if (promptMarker && titleMarker && promptMarker.canonicalId !== titleMarker.canonicalId) {
    return { marker: null, source: null, conflict: true };
  }
  if (promptMarker) return { marker: promptMarker, source: "prompt", conflict: false };
  if (titleMarker) return { marker: titleMarker, source: "title", conflict: false };
  return { marker: null, source: null, conflict: false };
}

/** True when the exact prompt/title contract blocks execution pending duplicate resolution. */
export function isDuplicateRedirectOnlyPrompt(content: string | null | undefined, title?: string | null): boolean {
  const resolution = resolveExplicitDuplicateMarker(content, title);
  return resolution.marker !== null || resolution.conflict;
}

/** Operator-facing dispatch refusal reason, preserving the source that declared the redirect. */
export function nonExecutableDuplicateRedirectReason(
  content: string | null | undefined,
  title?: string | null,
): string | null {
  const resolution = resolveExplicitDuplicateMarker(content, title);
  if (resolution.conflict) {
    return "PROMPT.md and task title declare conflicting duplicate redirects; resolve the conflict before execution";
  }
  if (!resolution.marker || !resolution.source) return null;
  const source = resolution.source === "prompt" ? "PROMPT.md" : "task title";
  return `${source} is a duplicate redirect marker (DUPLICATE: ${resolution.marker.canonicalId}), not an executable plan`;
}

/*
FNXC:DuplicateIntake 2026-07-26-10:40:
Recovery parser for a duplicate verdict the planner announced in its REPLY instead of writing it to
PROMPT.md. Observed on FN-8600 (2026-07-26): the planner correctly identified the duplicate, said
"DUPLICATE: FN-8595" followed by its reasoning, and explicitly declined to write a spec file — so the
engine, which reads the verdict only from PROMPT.md's contents, saw a planner that produced no plan.
The card then failed deterministic validation, retried, terminalized, and was re-planned in a loop,
never reaching the branch that records the operator's keep-or-delete decision.

Deliberately NARROWER than a "find the word anywhere" scan, because session text is prose and a
planner may legitimately discuss another task's duplicate marker while writing a real spec:
 - the marker must occupy an ENTIRE line by itself (same shape the file contract demands), so a
   mention inside a sentence never triggers it;
 - only the FIRST such line counts — a planner listing several ids has not made a single decision;
 - callers must gate on "no plan was written", so this can never override a real spec.
*/
export function parseDuplicateMarkerFromSessionText(text: string): ExplicitDuplicateMarker | null {
  if (!text.trim()) return null;

  for (const rawLine of text.split("\n")) {
    const candidate = stripSingleWrapper(rawLine.trim());
    const match = candidate.match(DUPLICATE_MARKER_PATTERN);
    if (match) {
      return { canonicalId: match[1].toUpperCase() };
    }
  }
  return null;
}
