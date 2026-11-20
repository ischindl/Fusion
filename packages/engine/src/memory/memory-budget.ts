/**
 * Code-owned size bound for long-term memory.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 measured a production project `MEMORY.md` at 594,273 bytes / 306 `## ` entries while the
 * run-audit store held ZERO `memory:*` rows, i.e. no consolidation ever ran against the file that the
 * append tool keeps growing. There was no size bound to enforce: no settings key, constant, or check for
 * a long-term byte budget exists anywhere in the repository (`memoryLongTermBudgetBytes` has never been
 * declared), and no code in Fusion or the pinned pi runtime can format the `49.6 KB used, limit 32 KB`
 * sentence the operator remembers — the append tool returned a success message with no measurement in
 * it, and nothing ever read the file back. Two properties fix that:
 *
 * 1. The budget is a code constant, not a settings knob. A settings key is policy that a project can
 *    leave unset; the constant is the number both the write path (`fn_memory_append`) and the
 *    maintenance path (`reconcile-long-term-memory-budget`) actually compare against, so the report
 *    and the sweep cannot disagree about what "over budget" means.
 * 2. Breach produces honest reporting plus scheduled maintenance — never a refusal. A memory tool that
 *    refuses to record a lesson because a file is large loses the lesson permanently, while the
 *    crowding it protects against is only expensive. The number is reported so the author learns the
 *    cost; the rewrite is deferred to maintenance so the fix is loss-free and backed up.
 *
 * 32 KiB is the ceiling carried over from the operator's report of the intended behavior; it is an
 * intentional working-set bound (the file is injected into agent context), not a measurement of the
 * largest file that ever existed. Files above it stay intact and are reorganized by maintenance.
 */

/** The code-owned long-term memory budget, shared by the append tool and the maintenance sweep. */
export const MEMORY_LONG_TERM_BYTE_BUDGET = 32 * 1024;

/**
 * Cost bound for one maintenance pass over one file.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * Parsing is O(file), and the sweep runs on startup recovery plus every maintenance batch, so a
 * pathologically large file must not be re-parsed every pass. Above this ceiling the sweep still
 * reports the breach but does not attempt a rewrite, which keeps the sweep's worst case bounded
 * without ever discarding content.
 */
export const MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES = 8 * 1024 * 1024;

/*
FNXC:MemoryBudget 2026-11-20-10:20 (RUFU-665):
RUFU-279 shipped the measurement half of maintenance but no convergence half, so the repo's own tests
asserted the dead end (`stillOverBudget: true` with every section retained): collapsing exact
duplicates is the only legal shrink, and a file of genuinely different notes has almost none. The
result was a permanent red announcement with no operator-reachable fix except raising the budget,
which the task forbids. Three separate numbers now exist and conflating any two of them re-creates
that dead end, so each owns one question:

- `MEMORY_LONG_TERM_BYTE_BUDGET` (32 KiB) is the WORKING-SET BOUND: what a file may measure before it
  counts as a breach that must be reported. Reporting is independent of what maintenance can do.
- `MEMORY_LONG_TERM_HOT_TARGET_BYTES` (24 KiB) is the CONVERGENCE TARGET the roll-up aims under. It is
  deliberately strictly below the budget, not equal to it: maintenance runs on the maintenance tick,
  so a hot file parked at exactly 32 KiB would be re-breached by the next append inside the same
  interval and the author would keep getting the breach sentence for work the sweep already did. The
  25 % margin is the room `fn_memory_append` needs to keep appending between sweeps.
- `ARCHIVE_MEMORY_FILENAME_PREFIX` names the COLD TIER: a flat sibling file in the same memory
  directory holding whole sections moved out of the hot file, byte-for-byte. It is enumerated,
  indexed, and searchable through `fn_memory_search` / `fn_memory_get`; it is never injected into the
  prompt index, and it is never a maintenance target, so the convergence loop cannot move the ceiling
  onto a file that just keeps growing.

The flat-sibling shape (same directory, one new filename, dated) is a settled decision from RUFU-735
and the alternatives were rejected for concrete loss reasons: daily notes are reset by the dream
processor after synthesis, so a moved entry would later vanish; `DREAMS.md` is consumed by the dream
prompt which re-promotes durable lessons back into `MEMORY.md`, creating a growth loop; an LLM digest
is non-deterministic and cannot prove losslessness; and a subdirectory is refused by
`resolveAgentMemoryFilePath`, which rejects any path component below the agent memory folder.
*/

/** Convergence target for the hot file: strictly below the budget, leaving append headroom. */
export const MEMORY_LONG_TERM_HOT_TARGET_BYTES = Math.floor(MEMORY_LONG_TERM_BYTE_BUDGET * 0.75);

/**
 * Filename prefix of the cold tier. A cold file is always `ARCHIVE-YYYY-MM-DD.md`.
 *
 * FNXC:MemoryBudget 2026-11-20-11:05 (RUFU-665):
 * The shape is NOT declared here. It lives in `@fusion/core`'s import-free memory filename leaf, because
 * the core read lanes (listing, `fn_memory_get` path allowance, the disk fallback) and this engine write
 * lane have to agree on one name or a retired note is searchable in one lane and refused in the other,
 * and `@fusion/core` may not import `@fusion/engine`. These three names are re-exports, not a second
 * definition: one authority, greppable from either side.
 */
export {
  MEMORY_ARCHIVE_FILENAME_PREFIX as ARCHIVE_MEMORY_FILENAME_PREFIX,
  archiveMemoryFileName,
  isArchiveMemoryFileName,
} from "@fusion/core";

/**
 * Which long-term memory file a measurement or rewrite is about. */
export type LongTermMemoryScope = "project" | "agent";

/**
 * One `## ` section of a memory file, kept as raw source lines so a rewrite can reproduce untouched
 * sections byte-for-byte.
 */
export type MemorySection = {
  /** Heading text after `## `, trimmed. */
  heading: string;
  /** Raw source lines including the heading line, in original order. */
  lines: string[];
  /** Raw section text (lines joined with the file's newline). */
  text: string;
  /** Comparison key for the body: per-line trailing whitespace and trailing blank lines removed. */
  normalizedBody: string;
  /** Comparison key for the heading: case-folded, whitespace-collapsed. */
  normalizedHeading: string;
};

/** A memory file split into the lines before the first heading plus its `## ` sections. */
export type MemoryFileParts = {
  /** Lines before the first `## ` heading (front-matter, title, blank lines). */
  preamble: string[];
  /** Sections in file order. */
  sections: MemorySection[];
  /** Line separator used by the file, preserved so re-render is byte-identical. */
  newline: string;
  /**
   * Whether the file ended in a line break. `split(/\r?\n/)` discards it, so a re-render that ignored
   * this would silently drop the final newline of every rewritten memory file — churn that has nothing
   * to do with the duplicate collapse and shows up in every later diff.
   */
  trailingNewline: boolean;
};

/**
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * Heading counting must agree with the index that agents actually see, or the reported entry count
 * silently disagrees with the `## ` list rendered into context.
 * `buildAgentMemoryIndex`'s `parseHeadings` (`packages/engine/src/agents/agent-memory-index.ts`) is
 * the authoritative reader but is module-private, so this is a byte-for-byte mirror of its recognition
 * rule — a trimmed line starting with `## ` whose remainder is non-empty — rather than a re-derivation.
 * `memory-budget.test.ts` pins the parity rule against the sibling module's real output so the two
 * cannot drift.
 */
export function parseMemoryFile(content: string): MemoryFileParts {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  // The final empty element is the split artifact of the file's closing line break, not a blank line
  // inside a section: `renderMemoryFile` restores it from `trailingNewline`, so keeping it here would
  // double the newline whenever the last section is the one dropped as a duplicate.
  if (trailingNewline) lines.pop();
  const preamble: string[] = [];
  const sections: MemorySection[] = [];
  let heading: string | null = null;
  let current: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") && trimmed.slice(3).trim()) {
      if (current && heading) sections.push(buildSection(heading, current, newline));
      heading = trimmed.slice(3).trim();
      current = [line];
      continue;
    }
    if (current) current.push(line);
    else preamble.push(line);
  }
  if (current && heading) sections.push(buildSection(heading, current, newline));

  return { preamble, sections, newline, trailingNewline };
}

function buildSection(heading: string, lines: string[], newline: string): MemorySection {
  return {
    heading,
    lines,
    text: lines.join(newline),
    normalizedHeading: heading.trim().replace(/\s+/g, " ").toLowerCase(),
    normalizedBody: normalizeMemoryBody(lines.slice(1)),
  };
}

/** Body comparison form: per-line trailing whitespace removed, then leading/trailing blank lines trimmed. */
export function normalizeMemoryBody(bodyLines: string[]): string {
  return bodyLines
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Re-render parsed parts; with no sections dropped this returns the original bytes. */
export function renderMemoryFile(parts: MemoryFileParts, sections: MemorySection[]): string {
  const body = [...parts.preamble, ...sections.flatMap((section) => section.lines)].join(parts.newline);
  return parts.trailingNewline ? `${body}${parts.newline}` : body;
}

/** Count the `## ` entries a reader would see in this content. */
export function countMemoryEntries(content: string): number {
  return parseMemoryFile(content).sections.length;
}

/** Measured state of one long-term memory file against the code-owned budget. */
export type LongTermMemoryBudgetReport = {
  scope: LongTermMemoryScope;
  /** Present only for the `agent` scope, so audit metadata stays ids-only. */
  agentId?: string;
  /** UTF-8 byte length of the file. */
  bytes: number;
  /** `## ` entry count, counted the way the memory index counts it. */
  entryCount: number;
  /** The budget this measurement was taken against. */
  budgetBytes: number;
  overBudget: boolean;
  overByBytes: number;
  /** `bytes / budgetBytes` as a whole percentage (>=100 once over). */
  budgetPercent: number;
};

/**
 * FNXC:MemoryBudget 2026-09-29-23:56: RUFU-279 — the append tool's success message previously carried
 * no number at all, so an agent had no signal that the file it just wrote to was 18x its budget.
 * Measurement is by UTF-8 bytes (what the file costs on disk and in context), never by lines or
 * characters, so the number matches `stat().size` and the maintenance sweep's own report.
 */
export function measureLongTermMemory(params: {
  content: string;
  scope: LongTermMemoryScope;
  agentId?: string;
  budgetBytes?: number;
}): LongTermMemoryBudgetReport {
  const budgetBytes = params.budgetBytes ?? MEMORY_LONG_TERM_BYTE_BUDGET;
  const bytes = Buffer.byteLength(params.content, "utf8");
  const entryCount = countMemoryEntries(params.content);
  return {
    scope: params.scope,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    bytes,
    entryCount,
    budgetBytes,
    overBudget: bytes > budgetBytes,
    overByBytes: Math.max(0, bytes - budgetBytes),
    budgetPercent: budgetBytes > 0 ? Math.round((bytes / budgetBytes) * 100) : 100,
  };
}

/**
 * Render a byte count the same way a memory backup receipt does.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — `MemoryBackupManager`'s private `formatBytes` (packages/core/src/memory/memory-backup.ts)
 * is the formatter an operator sees on a backup receipt. The budget report mirrors it (binary units,
 * `toFixed(2)` rounded through `parseFloat` so a trailing `.0` disappears) so the size in a breach
 * report and the size in the backup that covers it are the same string for the same file.
 * `memory-budget.test.ts` pins that parity against a real backup receipt rather than trusting the copy.
 */
export function formatMemorySize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Compact budget status for tool reports and logs: `580.34 KB of 32 KB budget (1814%, 306 entries)`. */
export function formatMemoryBudgetStatus(report: LongTermMemoryBudgetReport): string {
  const entries = `${report.entryCount} ${report.entryCount === 1 ? "entry" : "entries"}`;
  return `${formatMemorySize(report.bytes)} of ${formatMemorySize(report.budgetBytes)} budget (${report.budgetPercent}%, ${entries})`;
}

/**
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — the whole point of the budget is that the author is told the truth at the moment they
 * write. Over budget, the message names both halves of the remedy: maintenance will back the file up
 * and collapse exactly duplicated entries, and it will NOT shorten what the author wrote — so nobody
 * waits for an automation that is designed not to shrink their prose.
 *
 * FNXC:MemoryBudget 2026-11-20-10:20 (RUFU-665):
 * The RUFU-279 sentence promised only a duplicate collapse, which for the production file shape (every
 * section distinct) is a remedy that moves zero bytes. An author reading it concluded the only way out
 * was to file another card about the same defect, and that sentence was the driver behind a family of
 * duplicate cards filed in one day. So the message now names the remedy that ACTUALLY converges an
 * all-unique file — the oldest whole entries move verbatim into `ARCHIVE-<date>.md` beside `MEMORY.md`,
 * where `fn_memory_search` still returns them — and states the one thing the author must not do, which
 * is delete their own notes to make the number go down. Concrete remedy, concrete non-action.
 */
export function formatLongTermMemoryAppendReport(params: {
  scopeLabel: string;
  appendedBytes: number;
  report: LongTermMemoryBudgetReport;
}): string {
  const status = formatMemoryBudgetStatus(params.report);
  if (!params.report.overBudget) {
    return `Appended to ${params.scopeLabel} memory (${formatMemorySize(params.appendedBytes)} appended; ${status}).`;
  }
  return (
    `Appended to ${params.scopeLabel} memory (${formatMemorySize(params.appendedBytes)} appended; ${status}). ` +
    `Over budget by ${formatMemorySize(params.report.overByBytes)}: scheduled maintenance will back up the file and collapse exactly duplicated entries, ` +
    `and when duplicates alone cannot converge it it moves your oldest entries verbatim into ARCHIVE-YYYY-MM-DD.md in this same memory folder, ` +
    `where fn_memory_search and fn_memory_get still return them. ` +
    `It will not shorten or drop entries you wrote, so do not delete entries to fix the number; ` +
    `prefer consolidating related notes into one entry.`
  );
}
