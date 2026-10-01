/**
 * App-runtime-safe mirror of core's canonical description→label derivation.
 *
 * FNXC:TaskTitleDerivation 2026-09-26-02:28:
 * RUFU-295 makes ONE rule produce every task label a description can yield, for three surfaces:
 * the persisted board title fallback (`deriveFallbackTaskTitle` in `@fusion/core`), this dashboard
 * projection, and the durable Patchnode delivery ledger (`buildPatchnodeSnapshotLabel`). Before
 * this change the dashboard and the ledger each took the description's RAW first line or a raw
 * 220-character prefix, so a spec-shaped description rendered `## Pôvodný popis` as the card label
 * and froze the same junk into a permanent History row.
 *
 * The rule is DUPLICATED here rather than imported for the same package-boundary reason the ledger
 * mirror has: `@fusion/core` cannot depend on the dashboard, and the dashboard's browser bundle
 * aliases `@fusion/core` to its type-only `types.ts`, so a value import from core into `app/` has
 * no runtime to bind to (Step 0 of this task verified there is no value-import precedent).
 * Drift is therefore pinned, not hoped for: `app/__tests__/task-title-derivation-parity.test.ts`
 * runs one shared case table through the core helper, this module, AND the ledger builder.
 *
 * The rule, in order:
 * 1. skip fenced code blocks, blank lines, thematic breaks / frontmatter delimiters, setext
 *   underlines, and table rows;
 * 2. a line that is only an ATX heading is NOT a title while any non-heading content exists — its
 *   marker-stripped text is used only when the description contains nothing but headings;
 * 3. real content loses blockquote / list / task-list markers;
 * 4. cut at the first sentence terminator (`.` `!` `?`) followed by whitespace or end, skipping
 *   abbreviations (`e.g.`, `i.e.`, `etc.`, `vs.`, `No.`) and cuts shorter than three characters;
 * 5. cap at `maxLength` on a word boundary, and hard-truncate at EXACTLY `maxLength` with no
 *   ellipsis or suffix when the content offers no whitespace boundary — that is what keeps the
 *   FN-391 "bounded to exactly 220 characters, no suffix" contract truthful for derived content;
 * 6. run the title rejection rules (empty placeholders, dangling connector/preposition tails,
 *   assistant confirmation prose) at that same budget.
 */

/** Model-independent fallback label when a description carries nothing derivable. */
export const FALLBACK_TASK_LABEL = "Untitled task";

/** Historical 60-character title budget (core's `MAX_TITLE_LENGTH`). */
export const DEFAULT_TASK_LABEL_MAX_LENGTH = 60;

const MAX_TITLE_LENGTH = DEFAULT_TASK_LABEL_MAX_LENGTH;

const ATX_HEADING_LINE_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE_LINE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;
const SETEXT_UNDERLINE_RE = /^ {0,3}=+\s*$/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:[-*_]\s*){3,}$/;
const TABLE_ROW_RE = /^\s*\|/;
const FRONTMATTER_DELIMITER_RE = /^ {0,3}(?:-{3,}|={3,})\s*$/;
/** Bound so an unclosed leading `---` thematic break cannot swallow the whole description. */
const FRONTMATTER_MAX_LINES = 40;
/** Lines that carry no word characters are structural noise (`***`, `|---|`, `~~~`, `…`). */
const NO_WORD_CHARS_RE = /^[\s|:*_~—–.…\u2014\u2013-]*$/;
const SENTENCE_TERMINATOR_RE = /[.!?](?=\s|$)/g;
/** Abbreviation/initial tails that must not be read as a sentence terminator. */
const ABBREVIATION_TAIL_RE = /(?:\b(?:e\.?g|i\.?e|etc|vs|cf|approx|nr|no|str|resp|inc|ltd|mr|mrs|ms|dr|prof)\.?\s*|\b[a-z])$/i;

const EMPTY_PLACEHOLDER_CONTENT_RE = /^[\s,:;\-—–.!?]*$/;
const DANGLING_TAIL_STOPWORDS = new Set([
  "of", "for", "to", "from", "as", "in", "on", "with", "by", "and", "or", "the", "a", "an", "at", "into", "onto",
  "about", "via", "per", "vs",
]);

function stripEmptyPlaceholders(text: string): string {
  let normalized = text;
  normalized = normalized.replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, (match, paren, square, brace) => {
    const content = (paren ?? square ?? brace ?? "").trim();
    return EMPTY_PLACEHOLDER_CONTENT_RE.test(content) ? " " : match;
  });
  normalized = normalized
    .replace(/\s+([,:;.!?])/g, "$1")
    .replace(/([:\-—–])\s*(?=[:\-—–])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function stripDanglingTail(text: string): string {
  let normalized = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const words = normalized.split(/\s+/).filter(Boolean);
    const tail = words.at(-1)?.toLowerCase();
    if (!tail || !DANGLING_TAIL_STOPWORDS.has(tail)) break;
    words.pop();
    normalized = stripEmptyPlaceholders(words.join(" "));
    if (!normalized) break;
  }
  return normalized;
}

/** Mirror of core `sanitizeTitle`: the rejection rules, run at a caller-supplied budget. */
function sanitizeLabel(raw: string | undefined | null, maxLength: number): string | null {
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return null;

  let title = firstLine
    .replace(/^[-*]\s+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  title = title.replace(/^(?:title|subject|here(?:'s| is)(?: the)? title|generated title)\s*[:-]\s*/i, "").trim();
  title = title
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, "$1")
    .replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, "$1");

  // Assistant confirmation prose is never a label ("Created task FN-1234 ...").
  if (/^created\s+(?:task\s+)?(?:fn-\d+\b|\*\*\s*fn-\d+\s*\*\*)/i.test(title)) return null;

  title = stripEmptyPlaceholders(title);
  const beforeDanglingTail = title;
  const beforeTail = beforeDanglingTail.split(/\s+/).filter(Boolean).at(-1)?.toLowerCase();
  const hadDanglingStopwordTail = Boolean(beforeTail && DANGLING_TAIL_STOPWORDS.has(beforeTail));
  title = stripDanglingTail(title);
  title = title.replace(/[.!?,;:]+$/, "").trim();
  if (!title) return null;

  const words = title.split(/\s+/).filter(Boolean);
  if (
    (hadDanglingStopwordTail && title !== beforeDanglingTail)
    || /^close\s+as\s+duplicate(?:\s+of)?$/i.test(title)
    || (words.length === 1 && DANGLING_TAIL_STOPWORDS.has(words[0]!.toLowerCase()))
  ) {
    return null;
  }

  if (title.length > maxLength) title = title.slice(0, maxLength).trim();
  return title || null;
}

/*
FNXC:TaskTitleDerivation 2026-09-26-02:43:
RUFU-295 (kept byte-identical to core's copy): markers strip in stacks, so one ordered pass is not
enough. `> ## - Ship the derived label` lost only its `> ` in a single pass and rendered as
`## - Ship the derived label` — the heading-shaped junk this task removes. Each pass re-tries every
marker family until the text stops changing, bounded so pathological input cannot spin.
*/
const MARKDOWN_MARKER_STRIP_MAX_PASSES = 6;

function stripLeadingDescriptionMarkdown(text: string): string {
  let cleaned = text.trim();
  for (let pass = 0; pass < MARKDOWN_MARKER_STRIP_MAX_PASSES; pass++) {
    const stripped = cleaned
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "")
      .trim();
    if (stripped === cleaned) break;
    cleaned = stripped;
  }
  return cleaned;
}

function truncateLabelAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const capped = text.slice(0, maxLength).trim();
  const boundary = capped.search(/\s+\S*$/);
  const candidate = boundary > Math.floor(maxLength * 0.5) ? capped.slice(0, boundary).trim() : capped;
  return stripDanglingTail(stripEmptyPlaceholders(candidate)) || capped;
}

/** A single label candidate line: marker-stripped, never markdown structure, never empty. */
function firstLabelCandidateLine(description: string | undefined | null): string | null {
  const headingOnlyCandidates: string[] = [];
  const lines = (description ?? "").replace(/\r\n?/g, "\n").split("\n");
  let insideFence = false;
  let leadingLineChecked = false;
  let insideFrontmatter = false;
  let frontmatterOpenedAt = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (!leadingLineChecked) {
      leadingLineChecked = true;
      if (FRONTMATTER_DELIMITER_RE.test(line)) {
        insideFrontmatter = true;
        frontmatterOpenedAt = index;
        continue;
      }
    }
    if (insideFrontmatter) {
      if (FRONTMATTER_DELIMITER_RE.test(line)) insideFrontmatter = false;
      else if (index - frontmatterOpenedAt > FRONTMATTER_MAX_LINES) {
        insideFrontmatter = false;
        index = frontmatterOpenedAt;
      }
      continue;
    }
    if (FENCE_LINE_RE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    if (SETEXT_UNDERLINE_RE.test(line) || THEMATIC_BREAK_RE.test(line) || TABLE_ROW_RE.test(line)) continue;
    const stripped = stripLeadingDescriptionMarkdown(line);
    if (!stripped || NO_WORD_CHARS_RE.test(stripped)) continue;
    if (ATX_HEADING_LINE_RE.test(line)) {
      headingOnlyCandidates.push(stripped);
      continue;
    }
    return stripped;
  }
  return headingOnlyCandidates[0] ?? null;
}

/** Cut a candidate line at its first real sentence terminator; keep the text, drop the mark. */
function cutFirstSentence(text: string): string {
  SENTENCE_TERMINATOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_TERMINATOR_RE.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    if (before.length < 3) continue;
    if (ABBREVIATION_TAIL_RE.test(before)) continue;
    return before.trim();
  }
  const ellipsis = text.indexOf("\u2026");
  if (ellipsis >= 3) return text.slice(0, ellipsis).trim();
  return text.trim();
}

/** A derived label plus the fact of whether the budget cut it short. */
export interface TaskLabelDerivation {
  /** Single-line, markdown-free label, or {@link FALLBACK_TASK_LABEL} when nothing is derivable. */
  label: string;
  /** True when the derivable sentence was longer than `maxLength` (the label is a truncation). */
  truncated: boolean;
}

/** See the file-level FNXC block for the rule this implements. */
export function deriveTaskLabelDetails(
  description: string | undefined | null,
  maxLength = DEFAULT_TASK_LABEL_MAX_LENGTH,
): TaskLabelDerivation {
  const candidate = firstLabelCandidateLine(description);
  if (!candidate) return { label: FALLBACK_TASK_LABEL, truncated: false };

  const sentence = cutFirstSentence(candidate);
  const full = sanitizeLabel(sentence, Number.MAX_SAFE_INTEGER);
  if (!full) return { label: FALLBACK_TASK_LABEL, truncated: false };
  if (full.length <= maxLength) return { label: full, truncated: false };

  const capped = truncateLabelAtWordBoundary(full, maxLength);
  return { label: sanitizeLabel(capped, maxLength) ?? capped.slice(0, maxLength), truncated: true };
}

/** The canonical description→label derivation at the dashboard's app layer. */
export function deriveTaskLabelFromDescription(
  description: string | undefined | null,
  maxLength = DEFAULT_TASK_LABEL_MAX_LENGTH,
): string {
  return deriveTaskLabelDetails(description, maxLength).label;
}

/** True when a line is only ATX heading structure, so it can never be a card label. */
export function isHeadingShapedLabel(title: string | undefined | null): boolean {
  return ATX_HEADING_LINE_RE.test((title ?? "").trim());
}

/** Length a label derived at the historical 60-character budget cannot exceed. */
export const MAX_COMPAT_TASK_TITLE_LENGTH = MAX_TITLE_LENGTH;
