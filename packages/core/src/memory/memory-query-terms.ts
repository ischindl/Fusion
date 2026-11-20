/**
 * Shared query-term and result-window primitives for every deterministic memory lane.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012):
 * Memory relevance used to be computed three times over, each time on its own inline ASCII
 * character class (`/[^a-z0-9_-]+/i`) and its own `normalized.includes(term)` substring test —
 * in `scoreAgentMemorySnippet` (agent lane), in `searchMemoryFiles` (project lane), and in
 * `deriveRecallKeywords` (lane P recall keywords). Measured consequences in a deployment whose
 * operator language is Slovak, i.e. with diacritics on the DEFAULT query shape rather than on an
 * edge case:
 *
 * - Diacritics are separators under an ASCII class, so a whole word is lost or shredded:
 *   `"Ktorá časť file scope je operatívna"` -> `["ktor","as","file","scope","je","operat","vna"]`;
 *   `"zlucovanie dlhodobej pamäte"` -> `["zlucovanie","dlhodobej","pam","te"]`;
 *   `"pamätaj systémove pravidlo"` -> `["pam","taj","syst","move","pravidlo"]`.
 *   `"čo je 1122"` loses `čo` ENTIRELY (both fragments are below the length floor).
 * - The substring matcher lets a shredded fragment cash in as a match: against the English
 *   sentence "never start test servers on it: the system route delete rate template", the
 *   fragments `te` and `syst` both score. One accidental substring was enough to rank a wholly
 *   irrelevant 12-line block first in production (the reported `PG-gated test harness recipe`
 *   query surfacing a `Hard Rules` block that carried only the word `test`).
 * - Independently, the window walk advanced by 8 lines on a 12-line window, so adjacent windows
 *   shared 4 lines and ONE result set legitimately contained `97-108` next to `105-116`
 *   (= 1+8*12, 1+8*13) — half of the agent's slots were near-duplicates.
 *
 * This module is therefore the ONE source of truth for three facts, and no lane may re-derive
 * any of them inline: (1) what a word is, (2) what counts as a match for a word, and (3) how
 * wide a result window is and how far the walk advances. A fourth call site that invents its own
 * regex or its own stride is the class re-forming — see
 * `docs/solutions/reliability/memory-retrieval-unicode-tokenizer-and-window-geometry.md`.
 *
 * Deliberately NOT here: the cross-scope score offset, the merge ordering, and every result limit.
 * The offset was `+ 1000` and is now `AGENT_MEMORY_SCOPE_TIEBREAK` (RUFU-665 Step 6): this scorer
 * returns a DISTINCT-WORD COUNT, so a flat 1000 made the agent's own note outrank a project line that
 * matched five times as many words. It stays OUT of this module all the same — it is a scope policy
 * applied by the lane that merges scopes, not a fact about what a word or a window is.
 */

/**
 * Unicode-aware token boundary: every code point outside letters (`\p{L}`), digits (`\p{N}`),
 * underscore and hyphen splits a token, under the `u` flag.
 *
 * Two properties are load-bearing and must not be traded away:
 * - An accented letter is a LETTER, so `operatívna` stays one token instead of `operat` + `vna`.
 * - A hyphen is INSIDE a token, so `post-merge` and `project-wide` stay single terms on BOTH
 *   sides of the matcher. Splitting them would be a silent regression: a query token
 *   `post-merge` could never equal a candidate token `post`, so the constant has to be shared by
 *   the query side and the candidate side, not merely correct on one of them.
 *
 * This mirrors the boundary already proven in this repo (`recall-search.ts` keyword matcher and
 * lane T's `FOCUS_QUERY_TOKEN_BOUNDARY`); those lanes are the reference implementation, not
 * surfaces to change.
 */
export const MEMORY_QUERY_TOKEN_BOUNDARY = /[^\p{L}\p{N}_-]+/u;

/**
 * Minimum token length in characters. Held at 2 exactly as every pre-fix lane used it.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012):
 * Raising this floor would look like a fix for the false-positive defect and would not be one:
 * the false positives came from fragments produced BY the ASCII split, and the honest repair is
 * that a fragment no longer exists (Unicode split) plus a match no longer being a substring
 * (set membership). Widening the floor to 3+ instead would silently drop legitimate short content
 * words in both operator languages (`lcm`, `co`, `je`, `api`), which is appeasement — it deletes
 * signal rather than noise.
 */
export const MEMORY_QUERY_MIN_TERM_LENGTH = 2;

/** How many lines one result window covers. Unchanged from the pre-fix lanes (anti-appeasement). */
export const MEMORY_SNIPPET_WINDOW_LINES = 12;

/**
 * How far the window walk advances between windows.
 *
 * FNXC:MemoryWindowGeometry 2026-11-19-04:35 (RUFU-1012):
 * `MEMORY_SNIPPET_STRIDE_LINES === MEMORY_SNIPPET_WINDOW_LINES` IS the distinctness invariant:
 * when the walk advances by exactly the window width, no two windows of one file can share a
 * line, so one result set can never spend two slots on the same text. The pre-fix value was 8
 * against a 12-line window, which overlaps by 4 lines by construction and produced the observed
 * `97-108` + `105-116` pairs. Lowering the window or raising the limit to hide duplicates would
 * have been the appeasement version of this fix.
 */
export const MEMORY_SNIPPET_STRIDE_LINES = 12;

/** The minimum structural shape `dropLineOverlappingMemoryHits` needs from a hit. */
export interface MemoryHitLineRange {
  path: string;
  lineStart: number;
  lineEnd: number;
}

function tokenize(text: string): string[] {
  // NFC first: a decomposed corpus (e.g. `a` + U+0301) and a composed query (`á`) must compare
  // equal, otherwise the operator types a word exactly as it appears on screen and gets no hit.
  return text.normalize("NFC").toLowerCase().split(MEMORY_QUERY_TOKEN_BOUNDARY).filter(Boolean);
}

/**
 * Normalize a query into the terms that decide memory relevance: NFC, lowercase, split on the
 * shared Unicode boundary, drop tokens shorter than {@link MEMORY_QUERY_MIN_TERM_LENGTH}, dedupe
 * keeping first occurrence. Returns `[]` for a query with no usable tokens (punctuation-only,
 * `*`, blank), which is the `no-query-terms` state its consumers distinguish.
 *
 * Pure and total: never throws, whatever is passed in.
 */
export function deriveMemoryQueryTerms(query: unknown): string[] {
  if (typeof query !== "string" || query.trim().length === 0) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokenize(query)) {
    if (token.length < MEMORY_QUERY_MIN_TERM_LENGTH) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/**
 * Count how many of `terms` occur in `text` as WHOLE TOKENS, tokenized with the same boundary as
 * the query side and compared by set membership.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012):
 * Set membership replaces `normalized.includes(term)`. Substring containment is what made a
 * 2-character fragment worth a point against unrelated English prose (`te` inside `system`,
 * `route`, `delete`, `rate`, `template`); word-level matching makes `te` worth nothing there.
 * Scoring stays one point per DISTINCT matching term (never per occurrence), so the arithmetic a
 * caller sees is unchanged apart from the false positives disappearing.
 */
export function countMemoryTermMatches(text: string, terms: readonly string[]): number {
  if (typeof text !== "string" || text.length === 0 || terms.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  let score = 0;
  for (const term of terms) {
    if (typeof term !== "string") continue;
    if (haystack.has(term.normalize("NFC").toLowerCase())) score += 1;
  }
  return score;
}

/**
 * Drop result windows whose line range intersects an already-accepted window for the SAME path,
 * preserving input order and keeping the first accepted window.
 *
 * This is the guard for producers whose geometry is not ours to choose — the `qmd` search lanes,
 * where the windows come from an external binary's index. The file lanes fix the same invariant
 * at the source by walking with {@link MEMORY_SNIPPET_STRIDE_LINES}; a producer that controls its
 * own walk should use the stride, not this filter.
 *
 * Ranges are compared per path and never across paths, so an agent-memory window and a
 * project-memory window covering the same line numbers are both kept — the line numbers do not
 * refer to the same text. A hit with unusable line numbers is treated as a 1-line window at
 * `lineStart` rather than dropped, because dropping unreadable rows would make the tool silently
 * lose results it cannot prove are duplicates.
 */
export function dropLineOverlappingMemoryHits<T extends MemoryHitLineRange>(hits: readonly T[]): T[] {
  const accepted = new Map<string, Array<[number, number]>>();
  const kept: T[] = [];
  for (const hit of hits) {
    const start = Number.isFinite(hit?.lineStart) ? Math.trunc(hit.lineStart) : 1;
    const rawEnd = Number.isFinite(hit?.lineEnd) ? Math.trunc(hit.lineEnd) : start;
    const end = Math.max(start, rawEnd);
    const ranges = accepted.get(hit.path) ?? [];
    if (ranges.some(([acceptedStart, acceptedEnd]) => acceptedStart <= end && start <= acceptedEnd)) {
      continue;
    }
    ranges.push([start, end]);
    accepted.set(hit.path, ranges);
    kept.push(hit);
  }
  return kept;
}
