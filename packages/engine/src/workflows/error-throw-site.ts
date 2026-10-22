/*
FNXC:ErrorThrowSite 2026-10-22-13:38:
RUFU-773: a deployment recorded 75 cards failing Plan Review with the persisted History body
`Plan Review failed before producing a verdict: Cannot read properties of undefined (reading 'trim')`
and no stack frame anywhere. The graph's node-failure writer kept only `error.message`, so a
`TypeError` thrown inside an agent review node named its message but never its throw site, and the
card's History line was the only surviving record. Requirement: the error TEXT that reaches step
output / History / `task.error` must also carry a bounded throw site (the first `at ` frames of
`Error.stack`), while the original message stays an EXACT prefix — message-substring consumers
(`isNonPlanDefectPlanReviewFailure`, the provider/transient classifiers, the branch-provenance
`includes` check in `handle-graph-failure.ts`) keep matching unchanged.

Two hard placement constraints:
 - The throw site belongs on the CARD (task error / step output / History) only. Run-audit metadata
   is ids/counts/fixed-enums by repo rule, so frame text (paths + prose) must never go there.
 - `node:<id>:error` is not only display text — it is classifier input downstream.
   `isSessionContentionGraphFailure` pattern-matches every `:error` value, and
   `extractMissingWorktreePathFromSessionStartFailure` reads EVERYTHING after a known prefix as a
   filesystem path. Appended frames would corrupt that extraction and could misroute a real
   exception into a contention hold, so a message those two classes own stays byte-identical.
   Unclassified failures — the ones with no known cause, which is what this exists to name — gain
   the throw site.
*/

import { isSessionContentionError } from "../errors/transient-error-patterns.js";
import { isMissingWorktreeSessionStartFailure } from "../healing/restart-recovery-coordinator.js";

/** Frames kept from a throw site. Enough to name the function and its call chain, bounded so a
 *  deep recursion cannot grow the card's History body without limit. */
export const MAX_THROW_SITE_FRAMES = 4;

/** Separator between frames: keeps the whole throw site on ONE line, because
 *  `graphFailureNodeErrorText` whitespace-normalizes the terminal diagnostic and the History body
 *  is read as a single line. */
const FRAME_SEPARATOR = " | ";

/**
 * Turn a thrown value into a bounded throw-site string: drop `Error.stack`'s leading message
 * line, keep up to {@link MAX_THROW_SITE_FRAMES} lines starting with `at `, join them with
 * {@link FRAME_SEPARATOR}. Returns `undefined` for a non-Error throw, an absent/blank stack, or a
 * stack that carries no `at ` frame (a message-only synthetic stack).
 */
export function formatThrowSite(thrown: unknown): string | undefined {
  const stack = thrown instanceof Error ? thrown.stack : undefined;
  if (typeof stack !== "string" || stack.trim() === "") return undefined;
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    frames.push(trimmed);
    if (frames.length === MAX_THROW_SITE_FRAMES) break;
  }
  return frames.length > 0 ? frames.join(FRAME_SEPARATOR) : undefined;
}

/**
 * The error text a graph node failure should publish: the original message, then the bounded throw
 * site when one is available and safe to append. The message remains an exact prefix, so every
 * existing match on it is unaffected.
 */
export function errorTextWithThrowSite(message: string, thrown: unknown): string {
  if (isMissingWorktreeSessionStartFailure(message) || isSessionContentionError(message)) return message;
  const throwSite = formatThrowSite(thrown);
  return throwSite ? `${message}${FRAME_SEPARATOR}${throwSite}` : message;
}
