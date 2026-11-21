/**
 * RUFU-1088 — the Stash result page must be usable, not merely populated.
 *
 * Why this module exists. Measured 2026-11-18T13:58Z on the served build (`b9d149751f`), one
 * `fn_memory_search` for "blanking predikatel" returned 10 rows, `backend=stash`, every `score`
 * `0.18558138608932495` identical to the last digit, 9 of the 10 paths
 * `stash://session/fusion-task-SANE-367:1-1` (one session, nine times), and every snippet the literal
 * four-character string `bash`. The read was authenticated and returned hits, and it was still useless:
 * one session owned the page, no row could be told from another, and no row carried text an agent
 * could act on.
 *
 * Two mechanisms produced it, both on the read side:
 * - Identity: a row's `path` is built from `session_id`, so N events from one session arrive as N
 *   visually identical rows, and nothing capped rows per session.
 * - Honesty: tier 1 of `stashRelevanceScore` passes the server's `score` through verbatim. Our
 *   deployed Stash image sends a constant, which tier 1 therefore promoted into a relevance claim.
 *
 * Everything here is pure: no I/O, no clock, no map-iteration-order leakage. Same input → same output,
 * same order. The lane stays the only read path (see `scopeItemsToProject`); this module runs on the
 * far side of that scoping, because a hygiene pass over another project's rows would spend the page on
 * rows we are not allowed to read.
 */
import type { MemoryRankingSource } from "./memory-backend.js";

/** A row shaped like Stash's search response, structurally — declared here so this module never
 *  imports the backend that imports it. */
export interface StashHygieneItem {
  id?: string | number;
  content?: string;
  snippet?: string;
  event_type?: string;
  session_id?: string;
  rank?: unknown;
  score?: unknown;
}

/*
FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
The measurement this constant answers is 9 of 10 slots owned by `fusion-task-SANE-367`. One row per
session is the policy: a page is a survey of which sessions hold the answer, and once one row from a
session is on the page, a second row from the SAME session adds no locatable information — it carries
the same path, the same line range, and (measured) the same score. Raising this to 2 is a one-line
policy change, deliberately not taken: with `limit` defaulting to 5 and the recall lane at 9, two rows
per session would still let one busy session take half the page back.
*/
export const STASH_MAX_ROWS_PER_SESSION = 1;

/**
 * FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
 * An ALLOWLIST of the event types that hold authored prose, built from the literals this repo actually
 * writes (`packages/engine/src/executor/memory-capture.ts` writes `tool_use`; the chat and note lanes
 * write the others). It is an allowlist and never a negation (`!== "tool_use"`) so that
 * `tool_use` / `tool_result` / `tool_error`, an unknown future type, and a MISSING type are all
 * non-exempt by construction rather than by tomorrow's edit. The exemption exists because an authored
 * one-word note ("DECISION") is legitimate content; a bare token that came from a tool lane is not.
 */
export const STASH_PROSE_EVENT_TYPES: readonly string[] = [
  "memory",
  "message",
  "user_message",
  "assistant_message",
  "note",
];

/**
 * FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
 * A single token longer than this is treated as content, not as a label. 32 is above every tool name
 * observed in the capture lane (`bash`, `read_file`, `execute_command` are all shorter) and below a
 * sentence, so the rule reads the SHAPE the measurement showed rather than a name list.
 */
export const STASH_SINGLE_TOKEN_MAX_CHARS = 32;

/** Closed classification of one row's text. `usable` is the only keepable state. */
export type StashRowClass = "usable" | "empty" | "bare-token";

/**
 * Classify a row's text. Exactly two drop arms, both shape-based:
 * - `empty`: nothing survives `trim()`.
 * - `bare-token`: no ASCII whitespace after trim AND `<= STASH_SINGLE_TOKEN_MAX_CHARS` AND the event
 *   type is not prose-exempt. That is the `bash` row from the measurement: a tool name stored as an
 *   event of type `tool_use`.
 * There is deliberately NO length-only third arm: it would drop authored one-word notes, which the
 * prose allowlist above exists to protect, and existing fixtures legitimately use them.
 */
export function classifyStashRow(text: string | undefined, eventType: string | undefined): StashRowClass {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return "empty";
  const isSingleToken = !/\s/.test(trimmed) && trimmed.length <= STASH_SINGLE_TOKEN_MAX_CHARS;
  if (isSingleToken && !(eventType !== undefined && STASH_PROSE_EVENT_TYPES.includes(eventType))) {
    return "bare-token";
  }
  return "usable";
}

/** The text a row delivers to a caller, in the order each lane already uses. */
function rowText(item: StashHygieneItem): string {
  return (item.snippet ?? item.content ?? "").substring(0, 500);
}

/** Identity used for dedup: the event id when the server sent one, else (session, normalized text). */
function hygieneKey<T extends StashHygieneItem>(item: T, textOf: (item: T) => string): string {
  if (item.id !== undefined && item.id !== null && item.id !== "") return `id:${String(item.id)}`;
  const normalized = textOf(item).replace(/\s+/g, " ").trim().toLowerCase();
  return `txt:${item.session_id ?? ""}|${normalized}`;
}

/**
 * Ordered, pure hygiene over rows that have ALREADY been project-scoped, in this order:
 * 1. drop low-signal rows (`empty`, `bare-token`);
 * 2. dedup by event identity (`id`, else `session_id` + normalized text) so the same event arriving
 *    twice — or, with no id, the same text inside one session — occupies one slot;
 * 3. cap rows per `session_id` at `STASH_MAX_ROWS_PER_SESSION`. The cap keys on `session_id`, never on
 *    the rendered `stash://session/...` path, and it applies ONLY to rows that carry a session id: a
 *    sessionless event has no session to be capped against;
 * 4. slice to the caller's `limit`.
 *
 * The result can be SHORTER than `limit`, including empty. That is the honest answer, and it is the
 * caller's job to say so (`no-match` on the read outcome, `NONE (reason)` on the tool) rather than
 * pad the page with rows nobody can use.
 */
export function hygieneStashItems<T extends StashHygieneItem>(
  items: readonly T[],
  limit: number,
  /**
   * The text the caller would DELIVER for this row. The keyword and vector lanes pick `snippet`/`content`
   * in opposite orders, so each passes its own: a row must be judged on the text the agent will see,
   * not on the other lane's field order.
   */
  textOf: (item: T) => string = (item) => rowText(item),
): T[] {
  // A zero page is a zero page: the loop below would otherwise deliver one row before its own check.
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const perSession = new Map<string, number>();
  const kept: T[] = [];
  for (const item of items) {
    if (classifyStashRow(textOf(item), item.event_type) !== "usable") continue;
    const key = hygieneKey(item, textOf);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.session_id !== undefined && item.session_id !== "") {
      const used = perSession.get(item.session_id) ?? 0;
      if (used >= STASH_MAX_ROWS_PER_SESSION) continue;
      perSession.set(item.session_id, used + 1);
    }
    kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** One delivered row's number plus, only where honesty demands it, where that number came from. */
export interface StashRankedRow {
  score: number;
  rankingSource?: MemoryRankingSource;
}

/** Tier-2 arithmetic shared with `stashRelevanceScore`: rank relative to the page's max rank. */
function parseUsableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * RUFU-1088 AC 2 — a number identical on every row is not a relevance claim.
 *
 * LOCKED rule. `scored` is today's `stashRelevanceScore` output, computed by the caller UNCHANGED.
 * Then:
 * - a page with ONE row, or whose scores differ anywhere, is not degenerate: every row is returned
 *   with the number it already had and NO `rankingSource`, so non-degenerate result objects stay
 *   byte-identical and non-Stash backends never see the field;
 * - a page of MORE THAN ONE row whose scores are ALL identical is degenerate — the server sent a
 *   constant. If usable, distinct `rank` values exist, the page is re-scored from the rank tier and
 *   every row is labelled `server-rank-fallback`. If no rank signal exists, the numbers are KEPT
 *   exactly as they are (no magnitude change: merged-page composition and the tier-3 `2.0`/`1.0`
 *   arithmetic downstream are untouched) and every row is labelled `positional`, which says out loud
 *   what is actually true — the order is the server's response order, not a relevance judgement.
 *
 * Pure, and never reorders the page.
 */
export function labelStashRanking(
  items: readonly StashHygieneItem[],
  scored: readonly number[],
): StashRankedRow[] {
  if (scored.length <= 1) return scored.map((score) => ({ score }));
  const first = scored[0]!;
  const degenerate = scored.every((s) => s === first);
  if (!degenerate) return scored.map((score) => ({ score }));

  // Degenerate: the server's `score` is a constant, so the page carries no ordering information in it.
  const ranks = items.map((it) => parseUsableNumber(it.rank));
  const usable = ranks.filter((r): r is number => r !== null);
  const maxRank = usable.reduce((max, r) => (r > max ? r : max), 0);
  const distinctRanks = new Set(usable).size > 1;
  if (distinctRanks && maxRank > 0) {
    return scored.map((score, i) => {
      const rank = ranks[i];
      return {
        // A row with no rank keeps the number it had; the label says the page's order is rank-derived.
        score: rank === null ? score : Math.min(1, Math.max(0, rank / maxRank)),
        rankingSource: "server-rank-fallback" as const,
      };
    });
  }
  // No rank signal either: keep the magnitudes (downstream arithmetic is untouched) and say plainly
  // that the order came from the response, not from a relevance judgement.
  return scored.map((score) => ({ score, rankingSource: "positional" as const }));
}
