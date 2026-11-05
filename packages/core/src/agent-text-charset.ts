/*
FNXC:AgentTextCharset 2026-11-04-12:08 (RUFU-307):
A generation defect lets a model substitute a look-alike glyph from another script into the MIDDLE of a
Slovak word and leave the rest of the word intact. Measured 2026-09-22..2026-09-24 across two lanes and two
agents: seven cards carried Han code points in `title`/`description` (RUFU-266/269/270/285/295/297/298 — on
RUFU-295 `U+521B U+5EFA` replaced the "vytvara" stem while the "-uje" ending survived), and shared project
memory carried `U+8DDF U+8FDB`. Memory is loaded into every agent prompt, so damaged text re-entered later
sessions. No write path validated character content at all.

The invariant this module owns: agent-authored text that an operator reads is checked against an EXPLICITLY
ENUMERATED allowlist, and a violation is never retained silently. Two properties are load-bearing:

1. The allowlist is an enumerated set, never a deny-list ("everything except ..."). A deny-list erased
   legitimate Slovak diacritics and turned the fix into a new defect (operator requirement 2).
2. The check is pure — no store, no I/O — so every surface that shows agent text to the operator can call
   the same predicate and cannot drift. Callers own their local refusal shape (tool `ERROR:` text, CLI
   `{ isError: true }`, or save-with-warning on the PROMPT.md lane).

This guard sits BESIDE the title-shape guard (`describeTaskTitleRejection` in `ai/ai-summarize.ts`), never in
place of it: the two are independent, and a title can be shape-valid yet charset-invalid.

Deliberate rejections worth naming, because each one has looked like over-reach: Tab (U+0009) is rejected —
operator-visible prose is single-run text, and a stray tab is a paste artifact, not content. Em dash (U+2014)
and typographic quotes are rejected — they are Common-script and render fine, so the ONLY reason to reject
them is that this guard has one honest rule (ASCII + Slovak diacritics) and a hole for pretty punctuation is
where the next code-switch walks in. Non-ASCII prose that must survive does so as `U+XXXX` notation, which is
exactly how the incident evidence above is written. See docs/agents.md.
*/

/**
 * The exact lowercase Slovak diacritic letters an agent may write. Enumerated, not derived from a Unicode
 * property, so widening the set is a deliberate edit that review can see.
 */
const SLOVAK_DIACRITICS_LOWER = "áäčďéíĺľňóôŕšťúýž";

/** The uppercase counterparts of {@link SLOVAK_DIACRITICS_LOWER}. */
const SLOVAK_DIACRITICS_UPPER = "ÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ";

/**
 * Build the allowlist as a code-point set from the enumerated members. Printable ASCII (U+0020-U+007E),
 * the newline pair (U+000A/U+000D), and the two diacritic literals above — nothing else.
 */
const ALLOWED_CODE_POINTS: ReadonlySet<number> = (() => {
  const allowed = new Set<number>();
  for (let cp = 0x0020; cp <= 0x007e; cp += 1) allowed.add(cp);
  allowed.add(0x000a);
  allowed.add(0x000d);
  for (const ch of SLOVAK_DIACRITICS_LOWER) allowed.add(ch.codePointAt(0)!);
  for (const ch of SLOVAK_DIACRITICS_UPPER) allowed.add(ch.codePointAt(0)!);
  return allowed;
})();

/** A disallowed code point found in agent text, plus where it first appeared. */
export interface AgentTextDisallowedChar {
  /** 0-based index of the FIRST occurrence of this code point (UTF-16 index, matching `indexOf`). */
  index: number;
  /** The offending code point in uppercase `U+XXXX` notation. Never the raw character. */
  codePoint: string;
}

/** Distinct disallowed code points enumerated in a rejection sentence before collapsing to a `+N more` tail. */
export const AGENT_TEXT_REJECTION_MAX_ENUMERATED = 12;

/** Format a code point the way every surface reports it: `U+521B`, uppercase hex, minimum 4 digits. */
export function formatAgentTextCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Find every disallowed code point in `text`, one entry per DISTINCT code point at its first index.
 *
 * Deduplicated because the useful signal for a rewriting agent is "these letters are wrong", not a 400-entry
 * list of the same Han letter repeated across a paragraph. The full list is never truncated here — the
 * formatter caps the enumeration and always reports the total count.
 *
 * Returns an empty array for `""` and for `undefined`/`null`: emptiness is upstream validation's job, and an
 * absent optional field must not be reported as a charset violation.
 */
export function findDisallowedAgentTextChars(
  text: string | null | undefined,
): AgentTextDisallowedChar[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const firstSeen = new Map<number, number>();
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    if (!ALLOWED_CODE_POINTS.has(cp) && !firstSeen.has(cp)) firstSeen.set(cp, i);
    // Surrogate pair (emoji, rare CJK extensions): consume both UTF-16 units so the index stays aligned.
    i += cp > 0xffff ? 2 : 1;
  }

  // Emit ordered by first index so the rejection sentence reads in text order.
  return [...firstSeen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([codePoint, index]) => ({ index, codePoint: formatAgentTextCodePoint(codePoint) }));
}

/** True when every code point in `text` is on the allowlist (empty/absent text is allowed). */
export function isAgentTextAllowed(text: string | null | undefined): boolean {
  return findDisallowedAgentTextChars(text).length === 0;
}

/** The allowlist described for an agent that has to rewrite its text, without naming any file or symbol. */
export function describeAgentTextAllowlist(): string {
  return "printable ASCII, newline, and Slovak diacritics (lowercase and uppercase)";
}

/**
 * The rejection sentence every guarded surface reports, minus that surface's local prefix convention
 * (`ERROR: `, `REFUSED: `, or a `WARNING` suffix). Names at most
 * {@link AGENT_TEXT_REJECTION_MAX_ENUMERATED} distinct code points with their indices and always the total,
 * so an agent can locate and rewrite the offenders without the message scaling with document size.
 */
export function formatAgentTextRejection(field: string, findings: AgentTextDisallowedChar[]): string {
  const named = findings.slice(0, AGENT_TEXT_REJECTION_MAX_ENUMERATED);
  const rest = findings.length - named.length;
  const listed = named.map((f) => `${f.codePoint} (index ${f.index})`).join(", ");
  const tail = rest > 0 ? `, +${rest} more` : "";
  return `Agent text rejected: field "${field}" contains ${findings.length} disallowed code point(s): ${listed}${tail}. Allowed: ${describeAgentTextAllowlist()}. Rewrite with allowed characters and retry.`;
}

/**
 * Thrown by {@link assertAgentTextAllowed}. Exported so a route that reaches the assertion through a shared
 * chokepoint (the CLI's `fn_task_create`, which imports `createAgentTask` from `@fusion/engine`) can catch
 * this ONE type and convert it to its own tool-error result instead of letting an exception escape `execute`.
 */
export class AgentTextCharsetError extends Error {
  readonly field: string;
  readonly findings: AgentTextDisallowedChar[];
  readonly rejection: string;

  constructor(field: string, findings: AgentTextDisallowedChar[]) {
    const rejection = formatAgentTextRejection(field, findings);
    super(rejection);
    this.name = "AgentTextCharsetError";
    this.field = field;
    this.findings = findings;
    this.rejection = rejection;
  }
}

/**
 * Throw {@link AgentTextCharsetError} when `text` carries a disallowed code point.
 *
 * For lanes where rejection is the whole answer. The PROMPT.md lane deliberately does NOT use this — it
 * persists with a warning plus an audit row, because refusing a plan write dead-locks the card lifecycle.
 */
export function assertAgentTextAllowed(field: string, text: string | null | undefined): void {
  const findings = findDisallowedAgentTextChars(text);
  if (findings.length > 0) throw new AgentTextCharsetError(field, findings);
}
