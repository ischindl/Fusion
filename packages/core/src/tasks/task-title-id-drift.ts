import { MAX_TITLE_LENGTH } from "../ai/ai-summarize.js";
import { TASK_ID_TOKEN_PROSE_SOURCE, createTaskIdProseRegExp, taskIdPrefixOf } from "./task-id-token.js";

/*
FNXC:TaskIdGrammar 2026-11-18-06:10 (RUFU-730):
This scan-and-strip pair used to hardcode `FN-\d+`, so on a project whose `settings.taskPrefix` is RUFU or
SANE a title carrying a stale foreign card id was read as naming no id at all: `hasTitleIdDrift` answered
false and `normalizeTitleForTaskId` returned the title untouched, so the card kept a title pointing at
another card and the `Title normalized: stripped legacy task-id reference` History line never fired.
Both halves now compose the one dictionary in `./task-id-token.ts`, and they must move together: a token
`extractTaskIdTokens` can see but the strip pattern cannot remove would leave the normalizer reporting
`changed: false` while drift was detected, which is worse than either consistent behaviour.

One consequence callers must know: `TASK_ID_TOKEN_RE`'s capture group 1 is now the WHOLE id (previously only
the digits), matching `createTaskIdProseRegExp`'s documented contract; its only in-repo consumer reads
`match[0]`.

FNXC:TitleNormalization 2026-11-18-07:22 (RUFU-730, code-review P1):
"Id-shaped" is not "names a card", and this module's write is a rewrite of operator-authored text. Composing
the shared prose token with no further test made the strip delete EVERY id-shaped compound in a title,
measured on this file's own grammar:
  "Add UTF-8 support to the importer"    -> "Add support to the importer"
  "Prepare SOC-2 audit evidence"         -> "Prepare audit evidence"
  "Parse RFC-2616 header folding"        -> "Parse header folding"
  "Fix TLS-1.2 handshake alert"          -> "Fix .2 handshake alert"   (punctuation residue left behind)
The `FN-\d+` regex it replaced left all four untouched, so the generalization had opened a new class of
silent title mutation, and every one of them logged `Title normalized: stripped legacy task-id reference`
- a History line asserting the opposite of what happened. Nor is the shape rare: `normalizeTitleForTaskId`
runs unguarded on every create, refinement and rename (`task-creation.ts:738`, `task-creation.ts:1306`,
`task-update.ts:338`), and `hasTitleIdDrift` - the would-be guard - is precisely the predicate such a token
satisfies, because `UTF-8` never equals the row id.

The decision is therefore bound to provenance and not to shape: a token counts as a CARD REFERENCE only when
its prefix is one this board provably mints. Two provenances are provable from inside a pure module: the
row's own prefix (the row exists, so this board minted that prefix) and `FN`, the product's fallback minting
prefix (`tasks/distributed-task-id.ts` reads `settings?.taskPrefix ?? "FN"` and falls back to `"FN"` on both
of its error paths). That pair is what keeps a renamed-prefix board working, so `Align with FN-4847 badge
behaviour` on `RUFU-730` is still drift and still strips. Anything else must be NAMED by the caller through
`knownPrefixes` - the seam for a store-backed prefix census, which no caller passes today.

The strict direction is the honest one here, for the same reason RUFU-352 bounded the prose token: a missed
cleanup costs a stale title that stays visible and reparable, while a wrong strip silently rewrites an
operator's title and reports a cleanup that never happened.
*/

/*
FNXC:TaskIdGrammar 2026-11-18-07:22 (RUFU-730, code-review P2):
This shared `g` instance carries a narrower contract than {@link createTaskIdProseRegExp}, and the difference
is worth spelling out because that helper documents why a fresh instance per call is the default.
`String.prototype.matchAll` builds its own clone and only READS `lastIndex`, so the single module-level
`matchAll` consumer below is safe. `exec`/`test` against THIS exported instance would ADVANCE the shared
`lastIndex` and make the next scan start mid-string - the exact bug the factory exists to prevent. It stays
exported (pre-existing public surface on both core barrels), so the rule for a new consumer is: `matchAll`
here, or build your own instance.
*/
export const TASK_ID_TOKEN_RE = createTaskIdProseRegExp(true);

/*
FNXC:TitleNormalization 2026-11-18-07:22 (RUFU-730): The one prefix a board provably mints whatever its
`settings.taskPrefix` says, for the reason in the block above: `distributed-task-id.ts` mints under
`settings?.taskPrefix ?? "FN"` and answers `"FN"` again when the settings row is missing or unreadable, so an
`FN-<n>` id can exist on any board - including this project, whose rulebook and history carry both `FN-*`
and `RUFU-*` ids. Every other prefix has to be earned: either it is the row's own prefix, or a caller names
it in `knownPrefixes`.
*/
export const DEFAULT_BOARD_MINTED_TASK_PREFIXES: readonly string[] = Object.freeze(["FN"]);

/** Caller-supplied vocabulary of id prefixes this board mints cards under (`["RUFU", "SANE"]`). */
export type TaskIdPrefixVocabulary = Iterable<string>;

/**
 * The prefixes whose tokens may be read as card references: the always-mintable fallback, the row's own
 * prefix, plus whatever the caller names. Additive by design - a caller can only ever widen the vocabulary,
 * never pass `[]` and switch drift detection off by accident.
 */
function resolveMintedTaskPrefixes(rowId: string, knownPrefixes?: TaskIdPrefixVocabulary): ReadonlySet<string> {
  const prefixes = new Set<string>(DEFAULT_BOARD_MINTED_TASK_PREFIXES);
  const ownPrefix = taskIdPrefixOf(rowId);
  if (ownPrefix) prefixes.add(ownPrefix);
  for (const raw of knownPrefixes ?? []) {
    const prefix = raw.trim().toUpperCase();
    if (prefix) prefixes.add(prefix);
  }
  return prefixes;
}

/** Keeps the tokens whose prefix `prefixes` declares mintable. Tokens come from the grammar, so they are whole ids. */
function restrictToMintedPrefixes(tokens: readonly string[], prefixes: ReadonlySet<string>): string[] {
  return tokens.filter((token) => {
    const prefix = taskIdPrefixOf(token);
    return prefix !== null && prefixes.has(prefix);
  });
}

const CONNECTOR_RE = /[:\-—–]/;
const EMPTY_PLACEHOLDER_CONTENT_RE = /^[\s,:;\-—–.!?]*$/;

export const DANGLING_TAIL_STOPWORDS = new Set([
  "of", "for", "to", "from", "as", "in", "on", "with", "by", "and", "or", "the", "a", "an", "at", "into", "onto",
  "about", "via", "per", "vs",
]);

export function stripDanglingTail(text: string): string {
  let normalized = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const words = normalized.split(/\s+/).filter(Boolean);
    const tail = words.at(-1)?.toLowerCase();
    if (!tail || !DANGLING_TAIL_STOPWORDS.has(tail)) {
      break;
    }
    words.pop();
    normalized = stripEmptyPlaceholders(words.join(" "));
    if (!normalized) {
      break;
    }
  }
  return normalized;
}

export function stripEmptyPlaceholders(text: string): string {
  let normalized = text;

  // Remove empty bracketed placeholders ((), [], {}) that contain only
  // whitespace or punctuation residue/connectors.
  normalized = normalized.replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, (match, paren, square, brace) => {
    const content = (paren ?? square ?? brace ?? "").trim();
    return EMPTY_PLACEHOLDER_CONTENT_RE.test(content) ? " " : match;
  });

  normalized = normalized
    .replace(/\s+([,:;.!?])/g, "$1")
    .replace(/([:\-—–])\s*(?=[:\-—–])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  normalized = normalized
    .replace(new RegExp(`(?:\\s*${CONNECTOR_RE.source}\\s*)+$`), "")
    .replace(/[,:;.!?]+$/g, "")
    .trim();

  return normalized;
}

/**
 * Every id-SHAPED token in the title, upper-cased, deduplicated - the grammar view, not a verdict that a
 * card is being named. Omit `knownPrefixes` and a title about `UTF-8` reports `UTF-8`; that is deliberate, the
 * scanner answers "what looks like an id" while the two deciders below answer "does it name a card". Consumers
 * that need the second question are `hasTitleIdDrift` and `normalizeTitleForTaskId`; a caller that wants to
 * report what was actually removed uses {@link removedTaskIdTokens} rather than this view.
 *
 * @param knownPrefixes restrict the scan to these prefixes (case-insensitive) instead of all of them
 */
export function extractTaskIdTokens(title: string, knownPrefixes?: TaskIdPrefixVocabulary): string[] {
  const tokens = new Set<string>();
  for (const match of title.matchAll(TASK_ID_TOKEN_RE)) {
    const raw = match[0];
    if (raw) {
      tokens.add(raw.toUpperCase());
    }
  }
  if (!knownPrefixes) return [...tokens];
  const prefixes = new Set<string>();
  for (const raw of knownPrefixes) {
    const prefix = raw.trim().toUpperCase();
    if (prefix) prefixes.add(prefix);
  }
  return restrictToMintedPrefixes([...tokens], prefixes);
}

/**
 * Drift means the title names a card that is not this row, where "names a card" is decided by the minted
 * prefix vocabulary rather than by the token's shape. A title whose only id-shaped tokens are compounds like
 * `SOC-2` or `TLS-1` names nothing and is never drift, whatever those tokens look like.
 */
export function hasTitleIdDrift(
  title: string | undefined | null,
  rowId: string,
  knownPrefixes?: TaskIdPrefixVocabulary,
): boolean {
  if (!title) return false;
  const tokens = extractTaskIdTokens(title);
  if (tokens.length === 0) return false;
  const normalizedRowId = rowId.toUpperCase();
  if (tokens.some((token) => token === normalizedRowId)) return false;
  return restrictToMintedPrefixes(tokens, resolveMintedTaskPrefixes(rowId, knownPrefixes)).length > 0;
}

/*
FNXC:TitleNormalization 2026-11-18-07:55 (RUFU-730, code-review P1):
The four callers (`task-creation.ts`, `task-update.ts`, `project-store-ops.ts`, `update-task-deps.ts`) log
`Title normalized: stripped legacy task-id reference (removed=[...])` on the card, so that History line claims
what was taken. Deriving it from the grammar view made the claim false in exactly the case this card's review
caught: a title carrying both `UTF-8` and `FN-4847` was corrected and then reported BOTH as removed, when the
strip kept `UTF-8` by design. Reporting a cleanup that never happened is the same defect one line further
out, so the diagnostic asks for the removal set instead of the shape set. It composes the same filter the
strip composes - that shared predicate, not a re-derived guess, is what keeps the log and the title agreeing.
*/

/**
 * The tokens `normalizeTitleForTaskId` actually removes from `title` for `rowId`: id-shaped, naming a card
 * other than this row, and carrying a prefix this board mints. Callers must not substitute
 * {@link extractTaskIdTokens} here - that view also lists id-shaped compounds the strip deliberately keeps,
 * and a log line built from it over-reports the cleanup.
 */
export function removedTaskIdTokens(
  title: string | undefined | null,
  rowId: string,
  knownPrefixes?: TaskIdPrefixVocabulary,
): string[] {
  if (!title) return [];
  const own = rowId.trim().toUpperCase();
  return restrictToMintedPrefixes(extractTaskIdTokens(title), resolveMintedTaskPrefixes(rowId, knownPrefixes))
    .filter((token) => token !== own);
}

export function normalizeTitleForTaskId(
  title: string | undefined | null,
  rowId: string,
  knownPrefixes?: TaskIdPrefixVocabulary,
): { title: string | null; changed: boolean } {
  const initial = title ?? null;
  if (initial === null || initial.length === 0) {
    return { title: initial, changed: false };
  }
  if (!hasTitleIdDrift(initial, rowId, knownPrefixes)) {
    return { title: initial, changed: false };
  }

  /*
  FNXC:TaskIdGrammar 2026-11-18-06:10 (RUFU-730): composed from the shared token instead of a second
  `FN-\d+` literal, so a non-FN id is stripped on exactly the tokens `extractTaskIdTokens` can see. The
  trailing connector stays optional and unconsumed-by-intent: it is absorbed with the token so
  `RUFU-318: Report` collapses to `Report` rather than `: Report`. A fresh instance per call, because this
  is a `g` pattern and a shared `lastIndex` would make the second replacement start mid-string.

  FNXC:TitleNormalization 2026-11-18-07:22 (RUFU-730, code-review P1): the replacement is a FUNCTION, not a
  constant, so a match whose prefix this board does not mint is returned verbatim - connector and all. That
  filter is the guard the shape-only regex had none of: `UTF-8`, `SOC-2` and `TLS-1` survive, `FN-4847` on a
  `RUFU-*` row and `RUFU-523` on a `RUFU-524` row are still removed.
  */
  const mintedPrefixes = resolveMintedTaskPrefixes(rowId, knownPrefixes);
  let normalized = initial.replace(
    new RegExp(`\\b(${TASK_ID_TOKEN_PROSE_SOURCE})\\s*[:\\-—–]?\\s*`, "gi"),
    (matched: string, token: string) => {
      const prefix = taskIdPrefixOf(token.toUpperCase());
      return prefix !== null && mintedPrefixes.has(prefix) ? " " : matched;
    },
  );
  normalized = stripEmptyPlaceholders(normalized);
  const beforeDanglingTail = normalized;
  const beforeTail = beforeDanglingTail.split(/\s+/).filter(Boolean).at(-1)?.toLowerCase();
  const hadDanglingStopwordTail = Boolean(beforeTail && DANGLING_TAIL_STOPWORDS.has(beforeTail));
  normalized = stripDanglingTail(normalized);

  if (normalized.length > MAX_TITLE_LENGTH) {
    normalized = normalized.slice(0, MAX_TITLE_LENGTH).trim();
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const nextTitle =
    normalized.length === 0
      ? null
      : hadDanglingStopwordTail && normalized !== beforeDanglingTail
        ? null
        : /^close\s+as\s+duplicate(?:\s+of)?$/i.test(normalized)
          ? null
          : words.length === 1 && DANGLING_TAIL_STOPWORDS.has(words[0]!.toLowerCase())
            ? null
            : normalized;
  return { title: nextTitle, changed: nextTitle !== initial };
}
