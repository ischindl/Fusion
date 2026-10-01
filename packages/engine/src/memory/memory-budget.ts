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

/** Which long-term memory file a measurement or rewrite is about. */
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
    `Over budget by ${formatMemorySize(params.report.overByBytes)}: scheduled maintenance will back up the file and collapse exactly duplicated entries. ` +
    `It will not shorten or drop entries you wrote, so prefer consolidating related notes into one entry.`
  );
}
