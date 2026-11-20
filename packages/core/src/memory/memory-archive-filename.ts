/**
 * The cold-tier memory filename, as ONE shared contract.
 *
 * FNXC:MemoryBudget 2026-11-20-10:55 (RUFU-665):
 * Budget maintenance retires whole `## ` sections out of a hot `MEMORY.md` into a dated cold-tier file
 * beside it. That single decision needs TWO authorities that cannot disagree: the writer (engine
 * `memory-budget.ts` / `long-term-consolidation.ts`, which names the file it creates) and the readers
 * (core `memory-backend.ts` listing and path allowance, `project-memory.ts` disk fallback, and the
 * agent-tool filename guard, which decide whether a search hit or a read of that file is answerable at
 * all). A read path that accepts a looser shape than the writer produces names files nothing wrote; a
 * read path stricter than the writer means a retired note is searchable in one lane and refused in
 * another — which is precisely the loss this card is about.
 *
 * So the shape lives HERE, in a module that imports nothing, because `@fusion/core` may not import
 * `@fusion/engine` and this leaf is the lowest place both sides can share. Both the engine constant and
 * the core allowance are derivations of what follows; neither re-declares it.
 */

/** Filename prefix of the cold tier. A cold file is always `ARCHIVE-YYYY-MM-DD.md`. */
export const MEMORY_ARCHIVE_FILENAME_PREFIX = "ARCHIVE-";

/**
 * Strict filename shape for the cold tier. Anchored, so a path separator can never match, and each
 * component is exactly two digits, so `ARCHIVE-2026-9-30.md` is not accepted while
 * `ARCHIVE-2026-09-30.md` is. Calendar validity is checked separately by
 * {@link isArchiveMemoryFileName} — a shape-only test would accept `ARCHIVE-2026-13-99.md`, and a file
 * no clock could ever have produced is not a file a read path should open.
 */
const MEMORY_ARCHIVE_FILENAME_RE = /^ARCHIVE-\d{4}-\d{2}-\d{2}\.md$/;

/** Cold-tier filename for a date, in the same UTC calendar the daily memory files use. */
export function archiveMemoryFileName(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `${MEMORY_ARCHIVE_FILENAME_PREFIX}${iso}.md`;
}

/**
 * Is `fileName` a cold-tier archive file this codebase may list or read?
 *
 * Bare filenames only: no directory component, no traversal, no double extension, no impossible
 * calendar date. `Date.UTC` normalizes month 13 into the next year rather than rejecting it, so the
 * components are round-tripped instead of range-checked by hand.
 */
export function isArchiveMemoryFileName(fileName: string): boolean {
  if (!MEMORY_ARCHIVE_FILENAME_RE.test(fileName)) return false;
  const [year, month, day] = fileName
    .slice(MEMORY_ARCHIVE_FILENAME_PREFIX.length)
    .replace(/\.md$/, "")
    .split("-")
    .map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The fixed preamble every newly-created cold-tier file starts with.
 *
 * Deliberately clock-free: the DATE lives in the filename, so the same input bytes produce a
 * byte-identical archive body whenever the roll-up runs, which is what makes "a re-run after a partial
 * failure is idempotent" provable rather than hoped for. The wording is the contract a future reader
 * needs: this text is verbatim author content, it is searchable, and it is not in the prompt.
 */
export const MEMORY_ARCHIVE_PREAMBLE_LINES: readonly string[] = [
  "# Archived long-term memory",
  "",
  "<!-- Verbatim entries moved out of MEMORY.md by budget maintenance.",
  "     Searchable via fn_memory_search / fn_memory_get; never injected into agent context.",
  "     Append-only: do not edit or delete these entries. -->",
  "",
];

/** The exact bytes a newly-created LF cold-tier file starts with. */
export const MEMORY_ARCHIVE_PREAMBLE = `${MEMORY_ARCHIVE_PREAMBLE_LINES.join("\n")}\n`;
