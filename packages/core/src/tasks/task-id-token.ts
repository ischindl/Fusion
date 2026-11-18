/**
 * The ONE task-id grammar for the whole product.
 *
 * Pure leaf: no `node:`, no store, no DB imports, so any layer (core, engine, dashboard) may compose it
 * without dragging a dependency graph along.
 *
 * The token shape is the canonical id grammar id minting and integrity checks already use
 * (`^([A-Z][A-Z0-9]*)-(\d+)$` in `packages/core/src/tasks/task-id-integrity.ts`), matched
 * case-insensitively because ids appear in hand-authored text (commit subjects, trailer lines, card
 * titles, completion summaries) as well as in Fusion-authored strings.
 *
 * FNXC:TaskIdGrammar 2026-11-18-05:58:
 * RUFU-352 generalized commit-message attribution onto this token but left it inside
 * `packages/engine/src/execution/branch-conflicts.ts`. RUFU-730 relocates the source here because three
 * production parsers in `@fusion/core` (`merge/no-op-completion-marker.ts`,
 * `task-store/errors.ts`, `tasks/task-title-id-drift.ts`) were still hardcoded to `FN-\d+` and therefore
 * read a card minted under any other `settings.taskPrefix` (RUFU, SANE, …) as naming no card at all:
 * a `DUPLICATE: RUFU-318 …` close returned no `canonicalId`, a `Finalize RUFU-517 …` card depending on
 * `RUFU-517` slipped past the self-defeating-dependency refusal and its auto-reconcile, and a stale
 * foreign id in a title was never detected as drift.
 *
 * The rule this file exists to enforce: CORE OWNS THE GRAMMAR, AND THE ENGINE RE-EXPORTS IT.
 * Core may not import the engine (circularity; `@fusion/*` imports must stay statically analyzable, and
 * `setCreateFnAgent` DI exists for exactly this reason), while the engine already depends on core.
 * Writing a second `[A-Z][A-Z0-9]*-\d+` literal anywhere is the asymmetry RUFU-292 and RUFU-352 remove,
 * so compose from these exports instead.
 */

/**
 * The bare token. Correct only where the SURROUNDING SYNTAX already bounds the id — a commit subject
 * ends it at `):`, a trailer at end-of-line, an anchored `^…$` test at both ends. In free text use
 * {@link TASK_ID_TOKEN_PROSE_SOURCE}; see its comment for why `\b` alone is not a right boundary.
 */
export const TASK_ID_TOKEN_SOURCE = "[A-Z][A-Z0-9]*-\\d+";

/*
FNXC:TaskIdGrammar 2026-11-18-05:58 (relocated verbatim from branch-conflicts.ts by RUFU-730):
`TASK_ID_TOKEN_SOURCE` alone is only correct where the surrounding syntax already bounds the id. Scanning
free text needs a right boundary of its own. `\b` after `\d+` is satisfied by a hyphen, so a naive
`\b(TOKEN)\b` over "step-3-build" reports the phantom card `STEP-3`. In an orchestrable surface that
error is not benign: room coordination turns a matched id into `defer-suggested` with "do NOT call
fn_task_create", so an invented id silently blocks legitimate filing, while a missed id only costs one
extra clarifying question. This source adds the trailing `(?![\w-])` so a token embedded in a longer
hyphenated compound never matches, and it is exported rather than open-coded per site for the same
reason the token is — a second hand-rolled boundary is how these grammars drift apart again.
Structured branch names do not need it: the `^fusion/<token>$` gate is already bounded by its anchors.
*/
export const TASK_ID_TOKEN_PROSE_SOURCE = `${TASK_ID_TOKEN_SOURCE}(?![\\w-])`;

/**
 * Build a fresh case-insensitive RegExp that scans FREE TEXT (titles, summaries, error sentences) for a
 * task id, with the id as capture group 1.
 *
 * A new instance per call is deliberate: a `g`/`y` RegExp carries mutable `lastIndex` state, so sharing
 * one module-level instance across `matchAll`/`exec` callers makes a scan silently start mid-string.
 *
 * @param global  opt into `g` for `matchAll`/repeated-`exec` consumers; omit for a one-shot `match`/`test`
 */
export function createTaskIdProseRegExp(global = false): RegExp {
  return new RegExp(`\\b(${TASK_ID_TOKEN_PROSE_SOURCE})\\b`, global ? "gi" : "i");
}

/*
FNXC:TaskIdGrammar 2026-11-18-05:58 (RUFU-730):
The anchored form, for the case where the whole string must BE an id (`task-store/errors.ts` filters a
declared-dependency list this way). It composes the bare token rather than the prose token because the
`^…$` anchors already bound both ends, and it is exposed as a predicate instead of a source string so no
consumer re-anchors it by hand and drifts the grammar. Kept intentionally byte-equivalent to
`task-id-integrity.ts`'s capture-group pattern, which must stay a separate literal because
`detectTaskIdIntegrityAnomalies` indexes its numbered groups.
*/
const ANCHORED_TASK_ID_RE = new RegExp(`^(${TASK_ID_TOKEN_SOURCE})$`, "i");

/** True when the whole string is one task id in the canonical grammar, case-insensitively. */
export function isTaskIdToken(value: string): boolean {
  return ANCHORED_TASK_ID_RE.test(value.trim());
}

/*
FNXC:TaskIdGrammar 2026-11-18-07:22 (RUFU-730 code-review remediation):
Who must know a task id's PREFIX: a consumer that has to decide whether an id-shaped token names a card
this board could have minted (`tasks/task-title-id-drift.ts` refuses to rewrite an operator's title over a
token whose prefix nothing mints). It is answered here rather than at the call site because splitting the
id is a grammar operation: the token alphabet excludes `-` from the prefix (`[A-Z][A-Z0-9]*`), so the LAST
hyphen inside a whole-id match is the separator by construction. Any other split — `split("-")` over an
arbitrary string, a second `[A-Z]+-` regex — is a second source of truth, and one that also answers for
strings the grammar already refused.
*/

/**
 * The upper-cased id PREFIX of a canonical task id (`"RUFU-517"` -> `"RUFU"`), or `null` when the value is
 * not a whole task id. Case-insensitive on input, normalised on output, so prefixes can seed a `Set`.
 */
export function taskIdPrefixOf(value: string): string | null {
  const whole = ANCHORED_TASK_ID_RE.exec(value.trim())?.[1];
  if (!whole) return null;
  return whole.slice(0, whole.lastIndexOf("-")).toUpperCase();
}
