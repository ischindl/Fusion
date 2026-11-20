/**
 * Loss-free consolidation and default-on maintenance for long-term `MEMORY.md` files.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279: `MEMORY.md` grew to 594,273 bytes / 306 entries while the run-audit store held zero
 * `memory:*` rows. Three separate facts produced that divergence, and this module exists because of
 * the third one: `MemoryConsolidationService` (despite the name, and despite the `Memory Keeper` lane
 * that runs it) maintains the knowledge graph, recall records, and semantics — it never reads
 * `MEMORY.md`. There was no code path at all that consolidated the durable memory file, and the only
 * writer of long-term memory (`fn_memory_append`) appends blindly, so the file could only grow.
 *
 * The two hard properties of this maintenance path:
 *
 * 1. DETERMINISTIC — no LLM, no summarization, no judgment. Exact-duplicate collapse is a pure function
 *    of the file's bytes, so a re-run on unchanged input reproduces byte-identical output and the
 *    whole sweep is testable without a model, a provider, or an operator toggle.
 * 2. LOSS-FREE — nothing an author wrote is ever discarded or rewritten. Only sections that are exact
 *    duplicates collapse to one copy, and a same-heading/different-body pair is a conflict that is
 *    COUNTED and left alone, because deciding which of two different notes wins is an author's
 *    decision, not a maintenance pass's.
 *
 * And one ordering invariant: no rewrite happens unless a backup covering that file succeeded in the
 * same sweep, taken after the bytes were read. The backup is also what makes "loss-free" auditable —
 * if a collapse is ever disputed, the pre-rewrite file is on disk.
 *
 * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
 * RUFU-279 shipped the DETECTION half of this contract and stopped at a demonstrable dead end: the only
 * legal shrink was an exact-duplicate collapse, so a file whose sections are all distinct could be
 * reported over budget forever and could never converge. This module now owns the CONVERGENCE half too,
 * with a second hard property added to the two above:
 *
 * 3. CONVERGENT WITHOUT EDITING. When collapsing duplicates cannot reach the budget, whole `## `
 *    sections are RETIRED out of the hot file into a dated cold-tier file beside it
 *    (`ARCHIVE-YYYY-MM-DD.md`), byte-for-byte and in append order. Retirement is a move, never a
 *    rewrite: no summarization, no merging, no rewording, no split section, and no LLM in the loop --
 *    the module stays deterministic and its loss-freedom stays provable by comparing bytes.
 *
 * Two rules keep the cold tier from becoming a new problem. It is REACHABLE: the file is enumerated,
 * indexed, and returned by `fn_memory_search` / `fn_memory_get`, so retiring a note costs it its prompt
 * slot and nothing else (only the injected prompt index deliberately stays hot-file-only). And it is
 * NEVER A MAINTENANCE TARGET: `discoverLongTermMemoryTargets` only ever lists `MEMORY.md` paths, so the
 * convergence loop cannot simply relocate the ceiling onto a file that keeps growing. That is why the
 * archive is a flat sibling in the same directory rather than a subdirectory, and dated rather than one
 * perpetually-appended `ARCHIVE.md`.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMemoryBackupManager, memoryLongTermPath, MEMORY_ARCHIVE_PREAMBLE_LINES } from "@fusion/core";
import type { ProjectSettings } from "@fusion/core";
import {
  MEMORY_LONG_TERM_BYTE_BUDGET,
  MEMORY_LONG_TERM_HOT_TARGET_BYTES,
  MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES,
  archiveMemoryFileName,
  countMemoryEntries,
  parseMemoryFile,
  renderMemoryFile,
  type LongTermMemoryScope,
  type MemorySection,
} from "./memory-budget.js";
/** Run-audit event names owned by this module (declared in `util/run-audit.ts`). */
export const LONG_TERM_MEMORY_AUDIT_EVENTS = {
  overBudget: "memory:long-term-over-budget",
  consolidated: "memory:long-term-consolidated",
  failed: "memory:long-term-consolidation-failed",
} as const;

/** Result of consolidating one file's content in memory. */
export type LongTermMemoryConsolidationPlan = {
  /** Consolidated content — identical to the input when nothing collapsed. */
  content: string;
  changed: boolean;
  entriesBefore: number;
  entriesAfter: number;
  /** Section occurrences dropped because an earlier section was their exact duplicate. */
  duplicateSectionsCollapsed: number;
  /** Sections retained under a heading that also holds a different-bodied sibling: counted, never resolved. */
  conflictsRetained: number;
};

/**
 * Collapse exactly duplicated `## ` sections.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — duplicates are real in production: the append tool writes `\n${content}\n` for every
 * call, so the same lesson recorded twice is present twice, and a 306-entry file is largely re-appended
 * restatements. The identity rule is deliberately narrow: the same heading modulo case and internal
 * whitespace AND the same body modulo per-line trailing whitespace and trailing blank lines. Anything
 * looser (semantic similarity, paraphrase, "same topic") would let a maintenance pass decide that two
 * different sentences mean the same thing, which is the exact judgment this task forbids.
 *
 * The first occurrence wins positionally so the file's reading order is stable, and every untouched
 * section is re-emitted from its raw source lines, so an unchanged file round-trips byte-identically.
 */
export function consolidateLongTermMemoryContent(content: string): LongTermMemoryConsolidationPlan {
  const parts = parseMemoryFile(content);
  const seen = new Map<string, string>();
  const retained: MemorySection[] = [];
  let collapsed = 0;

  for (const section of parts.sections) {
    const key = `${section.normalizedHeading}\u0000${section.normalizedBody}`;
    if (seen.has(key)) {
      // An exact duplicate of an already-retained section: dropping it loses nothing, but prove it
      // before trusting the render, so a parser bug cannot silently drop a non-duplicate section.
      const survivor = seen.get(key)!;
      if (!retained.some((kept) => kept.text === survivor)) {
        throw new Error(
          `memory:long-term-consolidation lost the surviving twin of section "${section.heading}"`,
        );
      }
      collapsed += 1;
      continue;
    }
    seen.set(key, section.text);
    retained.push(section);
  }

  const output = renderMemoryFile(parts, retained);
  assertSectionsRetained(retained, output, parts.newline);

  return {
    content: output,
    changed: output !== content,
    entriesBefore: parts.sections.length,
    entriesAfter: retained.length,
    duplicateSectionsCollapsed: collapsed,
    conflictsRetained: countHeadingConflicts(retained),
  };
}

/** Same-heading groups holding more than one distinct body — retained, and reported so an author can merge them. */
function countHeadingConflicts(sections: MemorySection[]): number {
  const bodiesByHeading = new Map<string, Set<string>>();
  for (const section of sections) {
    const bodies = bodiesByHeading.get(section.normalizedHeading) ?? new Set<string>();
    bodies.add(section.normalizedBody);
    bodiesByHeading.set(section.normalizedHeading, bodies);
  }
  let conflicts = 0;
  for (const section of sections) {
    if ((bodiesByHeading.get(section.normalizedHeading)?.size ?? 0) > 1) conflicts += 1;
  }
  return conflicts;
}

/** Loss guard: every retained section must still appear verbatim in the rendered output. */
function assertSectionsRetained(retained: MemorySection[], output: string, newline: string): void {
  for (const section of retained) {
    if (!output.includes(section.lines.join(newline))) {
      throw new Error(`memory:long-term-consolidation dropped retained section "${section.heading}"`);
    }
  }
}

/*
FNXC:MemoryBudget 2026-11-20-10:20 (RUFU-665):
Preamble of a cold-tier file. The TEXT is core's (`MEMORY_ARCHIVE_PREAMBLE_LINES`), because the lane that
lists these files and the lane that writes them must agree on what a cold file is; only the newline
rendering stays here. Deliberately clock-free: the DATE lives in the filename (`ARCHIVE-YYYY-MM-DD.md`),
so the same input bytes produce a byte-identical archive body whenever the roll-up runs, which is what
makes "a re-run after a partial failure is idempotent" provable rather than hoped for. The wording is the
contract a future reader needs: this text is verbatim author content, it is searchable, and it is not in
the prompt.
*/
/**
 * The exact bytes a newly-created cold-tier file starts with (LF form; a CRLF source renders CRLF).
 *
 * FNXC:MemoryBudget 2026-11-20-12:48 (RUFU-665 landing fix, CEO lane):
 * This is a function, not an eagerly-rendered module constant, and the shape it replaces was a real defect,
 * not a style choice. The module aliased core's `MEMORY_ARCHIVE_PREAMBLE_LINES` into a module-level `const`
 * and called `.join()` on it at import time. Entered through `self-healing.ts` (the order the `engine-core`
 * gate exercises), that `@fusion/core` binding is not initialized while this module evaluates, so the alias
 * captured `undefined`: seven gate test files died at IMPORT time with
 * `Cannot read properties of undefined (reading 'join')`, and the two roll-up sites that read the same alias
 * would have thrown at RUNTIME on the identical premise. Reading the imported binding inside a function is
 * sound - by call time core is fully evaluated, and ESM live bindings then carry the true value. The rule
 * this encodes: no engine module may render core memory text at import time.
 */
export function archiveMemoryPreamble(newline = "\n"): string {
  return `${MEMORY_ARCHIVE_PREAMBLE_LINES.join(newline)}${newline}`;
}

/** Result of planning a byte-quota roll-up over one file's content. */
export type LongTermMemoryRollupPlan = {
  /** Hot-file content after the move — identical to the input when nothing moved. */
  content: string;
  /** Cold-tier body: deterministic preamble + every moved section, verbatim. `null` when nothing moved. */
  archivedContent: string | null;
  /**
   * The moved sections themselves. Maintenance needs the SECTIONS, not the rendered body, because a
   * same-day re-run must merge into an archive that already exists; re-parsing `archivedContent` would
   * reintroduce the blank-line-normalizing artifacts the merge helper would then treat as new text.
   */
  archivedSections: MemorySection[];
  changed: boolean;
  /** Whether the hot output is within `targetBytes`; false means the breach is reported, not hidden. */
  converged: boolean;
  sectionsBefore: number;
  sectionsAfter: number;
  /** Whole `## ` sections moved out of the hot file. */
  rolledUpSections: number;
  /** Bytes removed from the hot file by the move (`bytesBefore - bytesAfter`). */
  rolledUpBytes: number;
  bytesBefore: number;
  bytesAfter: number;
};

function linesByteLength(lines: string[]): number {
  let sum = 0;
  for (const line of lines) sum += Buffer.byteLength(line, "utf8");
  return sum;
}

/**
 * Plan a loss-free byte-quota roll-up: keep the newest whole sections that fit `targetBytes`, move the
 * earlier whole sections verbatim into a cold-tier body.
 *
 * FNXC:MemoryBudget 2026-11-20-10:20 (RUFU-665):
 * RUFU-279's collapse is the only shrink it knows, and on the measured production shape (594,273 B /
 * 306 entries, every section distinct) it moves zero bytes — the repo's own test asserted that dead
 * end (`stillOverBudget: true`, all sections retained). This planner is the missing convergent half,
 * built from three constraints that survive the obvious shortcuts:
 *
 * 1. WHOLE SECTIONS ONLY, UNEDITED. A section is the unit an author wrote and the unit the memory
 *    index renders, so the split point is between sections, never inside one. Nothing is shortened,
 *    merged, reordered, or reworded — an LLM digest cannot prove which memory was still needed, and a
 *    truncated section is content loss wearing a size fix.
 * 2. NEWEST STAYS HOT. The file's order is append order, so the tail is the working set the operator
 *    is actually reasoning about; "oldest first out" needs no timestamps because the contract is
 *    append-only. The newest section stays even when it alone exceeds the target, because an empty hot
 *    file is a worse failure than a still-over-budget one — and that case reports `converged: false`
 *    rather than pretending.
 * 3. THE MOVE IS ONLY LOSS-FREE IF IT IS PROVEN. Every kept and every moved section's raw lines must
 *    appear verbatim in one of the two outputs, and the incremental byte accounting is cross-checked
 *    against a real render before anything is returned. A planner that could silently misplace a
 *    section would be strictly worse than the non-converging sweep it replaces.
 *
 * Determinism: the result is a pure function of the input bytes and `targetBytes` — no clock, no
 * random, no filesystem — so re-planning unchanged bytes returns byte-identical outputs.
 */
export function planLongTermMemoryRollup(params: { content: string; targetBytes: number }): LongTermMemoryRollupPlan {
  const targetBytes = Math.max(0, Math.floor(params.targetBytes));
  const parts = parseMemoryFile(params.content);
  const bytesBefore = Buffer.byteLength(params.content, "utf8");

  const noop = (converged: boolean): LongTermMemoryRollupPlan => ({
    content: params.content,
    archivedContent: null,
    archivedSections: [],
    changed: false,
    converged,
    sectionsBefore: parts.sections.length,
    sectionsAfter: parts.sections.length,
    rolledUpSections: 0,
    rolledUpBytes: 0,
    bytesBefore,
    bytesAfter: bytesBefore,
  });

  // Nothing to do: already within the target, or there is no whole section that could be moved. A
  // preamble-only file has no author entry to move, so it is reported not-converged, never rewritten.
  if (bytesBefore <= targetBytes) return noop(true);
  if (parts.sections.length <= 1) return noop(false);

  /*
   * Incremental byte accounting instead of re-rendering per candidate: the production file is
   * hundreds of sections and multi-megabyte, and `renderMemoryFile` per probe would make the walk
   * O(sections x file). The formula mirrors `renderMemoryFile` exactly — every line, one separator
   * between adjacent lines, plus the restored closing line break — and the chosen split is verified
   * against a real render below, so a drift here fails loudly instead of mis-planning.
   */
  const nlBytes = Buffer.byteLength(parts.newline, "utf8");
  const trailingBytes = parts.trailingNewline ? nlBytes : 0;
  const preambleLines = parts.preamble.length;
  const preambleBytes = linesByteLength(parts.preamble);
  const renderedBytes = (extraLines: number, extraBytes: number): number => {
    const totalLines = preambleLines + extraLines;
    if (totalLines === 0) return trailingBytes;
    return preambleBytes + extraBytes + nlBytes * (totalLines - 1) + trailingBytes;
  };

  let keepFrom = parts.sections.length - 1;
  let keptLines = parts.sections[keepFrom]!.lines.length;
  let keptBytes = linesByteLength(parts.sections[keepFrom]!.lines);
  for (let index = keepFrom - 1; index >= 0; index -= 1) {
    const candidate = parts.sections[index]!;
    const candidateLines = keptLines + candidate.lines.length;
    const candidateBytes = keptBytes + linesByteLength(candidate.lines);
    if (renderedBytes(candidateLines, candidateBytes) > targetBytes) break;
    keepFrom = index;
    keptLines = candidateLines;
    keptBytes = candidateBytes;
  }

  const moved = parts.sections.slice(0, keepFrom);
  const kept = parts.sections.slice(keepFrom);
  if (moved.length === 0) return noop(renderedBytes(keptLines, keptBytes) <= targetBytes);

  const hotContent = renderMemoryFile(parts, kept);
  const hotBytes = Buffer.byteLength(hotContent, "utf8");
  const expectedHotBytes = renderedBytes(keptLines, keptBytes);
  if (hotBytes !== expectedHotBytes) {
    throw new Error(
      `memory:long-term-rollup byte accounting disagreed with the render (${expectedHotBytes} planned, ${hotBytes} rendered)`,
    );
  }

  const archiveBody = [
    ...MEMORY_ARCHIVE_PREAMBLE_LINES,
    ...moved.flatMap((section) => [...section.lines, ""]),
  ].join(parts.newline);
  const archivedContent = archiveBody.endsWith(parts.newline) ? archiveBody : `${archiveBody}${parts.newline}`;

  // Loss proof across BOTH outputs: every moved section must be present in the archive body, and every
  // kept section must survive in the rendered hot file. A section that appears in neither is a bug this
  // planner refuses to ship, so both halves are asserted against the RENDERED bytes rather than against
  // the section arrays the plan was built from — planning a loss and rendering a loss are different
  // failures, and only the render is what gets written.
  assertSectionsRetained(kept, hotContent, parts.newline);
  for (const section of moved) {
    if (!archivedContent.includes(section.lines.join(parts.newline))) {
      throw new Error(`memory:long-term-rollup dropped archived section "${section.heading}"`);
    }
  }

  return {
    content: hotContent,
    archivedContent,
    archivedSections: moved,
    changed: hotContent !== params.content,
    converged: hotBytes <= targetBytes,
    sectionsBefore: parts.sections.length,
    sectionsAfter: kept.length,
    rolledUpSections: moved.length,
    rolledUpBytes: bytesBefore - hotBytes,
    bytesBefore,
    bytesAfter: hotBytes,
  };
}

/** Cold-tier filename for a date, re-exported so maintenance and its tests share one source of truth. */
export { archiveMemoryFileName };

/**
 * Merge moved sections into an existing cold-tier body without duplicating anything.
 *
 * FNXC:MemoryBudget 2026-11-20-10:20 (RUFU-665):
 * A same-day second sweep must append only what has not been archived yet — the hot file may have
 * gained new material between sweeps, and a naive append after a partial failure would write the same
 * author text twice into the same file. Identity is the same key the duplicate collapse uses (heading
 * modulo case/whitespace + body modulo trailing whitespace), so the archive dedupes on exactly the
 * notion of "the same entry" the rest of the module already uses. Existing archive bytes are kept
 * untouched, so an append never rewrites what is already cold.
 */
export function mergeSectionsIntoArchive(params: {
  existing: string | null;
  sectionsToAppend: MemorySection[];
  newline: string;
}): { content: string; appended: number; skippedDuplicates: number } {
  const newline = params.newline;
  const existing = params.existing;
  if (params.sectionsToAppend.length === 0) {
    return { content: existing ?? "", appended: 0, skippedDuplicates: 0 };
  }

  const existingKeys = new Set<string>();
  if (existing) {
    for (const section of parseMemoryFile(existing).sections) {
      existingKeys.add(`${section.normalizedHeading}\u0000${section.normalizedBody}`);
    }
  }

  const toWrite: MemorySection[] = [];
  let skipped = 0;
  const seenThisRun = new Set<string>();
  for (const section of params.sectionsToAppend) {
    const key = `${section.normalizedHeading}\u0000${section.normalizedBody}`;
    if (existingKeys.has(key) || seenThisRun.has(key)) {
      skipped += 1;
      continue;
    }
    seenThisRun.add(key);
    toWrite.push(section);
  }

  if (toWrite.length === 0) return { content: existing ?? "", appended: 0, skippedDuplicates: skipped };

  const body = toWrite.flatMap((section) => [...section.lines, ""]).join(
    existing && existing.length > 0 ? (existing.includes("\r\n") ? "\r\n" : "\n") : newline,
  );
  // A cold file written for the first time gets the preamble in the SOURCE file's newline shape, so a
  // CRLF memory tree never grows an LF-headed archive beside it; an existing cold file keeps its own.
  const freshBase = archiveMemoryPreamble(newline);
  const base = existing && existing.length > 0 ? existing : freshBase;
  const baseNewline = base.includes("\r\n") ? "\r\n" : "\n";
  const joined = base.endsWith(baseNewline) ? `${base}${body}` : `${base}${baseNewline}${body}`;
  return {
    content: joined.endsWith(baseNewline) ? joined : `${joined}${baseNewline}`,
    appended: toWrite.length,
    skippedDuplicates: skipped,
  };
}

/**
 * The moved sections whose exact text is ABSENT from an archive body read back from disk.
 *
 * FNXC:MemoryBudget 2026-11-20-12:40 (RUFU-665):
 * Byte-equality between what was written and what was read back proves the write landed; it cannot prove
 * the move survived, because the merge that produced those bytes is the code that could have decided a
 * section was already cold and skipped it. This predicate asks the question the claim actually needs:
 * is each section's own text in the file? Exported as a pure function so the refusal it controls is
 * testable without staging a partial write against a real filesystem.
 */
export function movedSectionsMissingFromArchive(
  archiveContent: string,
  sections: readonly MemorySection[],
  newline: string,
): MemorySection[] {
  return sections.filter((section) => !archiveContent.includes(section.lines.join(newline)));
}

/** One long-term memory file the maintenance sweep may measure and reorganize. */
export type LongTermMemoryTarget = {
  scope: LongTermMemoryScope;
  /** Set for `agent` scope; used for audit identity. */
  agentId?: string;
  path: string;
};

/**
 * Discover long-term memory files.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — discovery is a depth-1 filesystem scan rather than an `AgentStore` query on purpose. The
 * durable agents' `MEMORY.md` files live in `.fusion/agent-memory/<agentId>/`, and consolidating a file
 * whose agent was later deleted is harmless because this sweep never deletes anything; a store query
 * would add a DB round-trip to a startup step and would silently skip the residue of deleted agents,
 * which is exactly the content still crowding context. A failed listing means "no agent memory", which
 * is also the honest reading of a missing directory.
 *
 * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
 * Discovery is restricted to `MEMORY.md` by construction and must stay that way. Cold-tier files
 * (`ARCHIVE-YYYY-MM-DD.md`) live in these SAME directories, so a discovery rule that listed "every `.md`
 * in here" would make the archive a maintenance target, and the convergence loop would relocate the
 * unbounded-growth ceiling onto the archive file while calling it a fix. The archive is append-only and
 * never re-planned; the maintenance suite pins that an `ARCHIVE-*.md` is never treated as a target.
 */
export function discoverLongTermMemoryTargets(rootDir: string): LongTermMemoryTarget[] {
  const targets: LongTermMemoryTarget[] = [];
  const projectPath = memoryLongTermPath(rootDir);
  if (existsSync(projectPath)) targets.push({ scope: "project", path: projectPath });

  const agentRoot = join(rootDir, ".fusion", "agent-memory");
  let entries: string[] = [];
  try {
    entries = readdirSync(agentRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const candidate = join(agentRoot, entry, "MEMORY.md");
    if (existsSync(candidate)) targets.push({ scope: "agent", agentId: entry, path: candidate });
  }
  return targets;
}

/** Fixed-enum failure stage for `memory:long-term-consolidation-failed`. */
export type LongTermMemoryFailureStage =
  | "read"
  | "too-large"
  | "backup"
  | "backup-scope"
  | "concurrent-write"
  | "write"
  | "verify";

/** Receipt shape consumed from `MemoryBackupManager.createBackup()` — only its scope matters here. */
export type LongTermMemoryBackupReceipt = { scope?: string };

/** Sink for run-audit rows; the caller passes `emitBoundedRunAudit` so telemetry can never fail the sweep. */
export type LongTermMemoryAuditEmit = (
  eventType: string,
  payload: { target: string; metadata: Record<string, unknown> },
) => Promise<void> | void;

export type LongTermMemoryMaintenanceOptions = {
  rootDir: string;
  /** Audit sink, invoked through the bounded seam by the caller. */
  audit: LongTermMemoryAuditEmit;
  /** Backup factory covering the memory tree; defaults to the configured `MemoryBackupManager`. */
  createBackup?: () => Promise<LongTermMemoryBackupReceipt>;
  /**
   * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
   * What the roll-up aims the hot file under. Defaults to `MEMORY_LONG_TERM_HOT_TARGET_BYTES` when the
   * caller keeps the shipped budget, and to 75 % of the injected budget otherwise, so a test (or a
   * future caller) that narrows `budgetBytes` gets a proportionally narrowed target instead of a
   * target above its own budget, which would silently plan no roll-up at all.
   */
  hotTargetBytes?: number;
  /*
   * FNXC:MemorySnapshotRetention 2026-11-05-10:28 (RUFU-441):
   * RUFU-279 made this path a snapshot producer but left its only eviction routine
   * (`MemoryBackupManager.cleanupOldBackups`) reachable only from `runMemoryBackupCommand`, so on a
   * default project — where `memoryBackupEnabled: false` means the scheduled backup is never even
   * created — every snapshot this sweep took survived forever. A snapshot producer owns its eviction,
   * so the seam carries the cleanup companion next to the create it bounds. It is entered only after a
   * snapshot actually succeeded, and it runs best-effort: a rejection here cannot reject a maintenance
   * pass that already did its work. An injected `createBackup` with NO companion performs no eviction —
   * the injection then owns both halves — which is why every pre-existing single-field injection stays
   * valid.
   */
  cleanupOldBackups?: () => Promise<number>;
  /** Settings used to resolve the operator's backup dir/retention/scope. */
  settings?: Partial<ProjectSettings>;
  budgetBytes?: number;
  maxBytes?: number;
  /** Minimum interval between identical over-budget findings. */
  cooldownMs?: number;
  now?: () => number;
  /** Signature → last emitted timestamp; owned by the caller so the rate limit survives across sweeps. */
  overBudgetAuditState?: Map<string, number>;
  targets?: LongTermMemoryTarget[];
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
};

/** Per-sweep summary, returned for the caller's log line and tests. */
export type LongTermMemoryMaintenanceResult = {
  scanned: number;
  withinBudget: number;
  overBudget: number;
  findingsEmitted: number;
  suppressedFindings: number;
  duplicateSectionsCollapsed: number;
  conflictsRetained: number;
  /** Whole sections that actually moved into a cold tier in THIS sweep (planned-but-refused moves are not counted). */
  rolledUpSections: number;
  /** Bytes that actually left the hot files into cold tiers in this sweep. */
  rolledUpBytes: number;
  rewritten: number;
  skippedTooLarge: number;
  failures: number;
};

/** Default cooldown between identical over-budget findings: 6 hours. */
export const LONG_TERM_MEMORY_OVER_BUDGET_AUDIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Rate-limit key for an over-budget finding.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — a breach that never self-heals must not write a run-audit row every maintenance batch, but
 * a flat per-file dedupe would also swallow a file that keeps growing. The signature buckets bytes by
 * whole budget multiples and entries by 16s, so steady state emits one row per cooldown while genuine
 * growth (or a newly discovered conflict or duplicate) emits immediately.
 */
export function longTermMemoryOverBudgetSignature(params: {
  scope: LongTermMemoryScope;
  agentId?: string;
  bytes: number;
  entryCount: number;
  budgetBytes: number;
  duplicatesFound: boolean;
  conflictsFound: boolean;
  tooLarge: boolean;
}): string {
  /*
   * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
   * The shape is deliberately unchanged by the roll-up. The two convergence-possibility booleans
   * (`collapseCanConverge`, `retirementCanConverge`) are per-row facts, not rate-limit identity: a
   * file's size and entry count already re-announce it when either bucket moves, and folding a boolean
   * that flips mid-episode into the key would let one file spend two cooldown windows per flip.
   */
  const budgetMultiples = Math.floor(params.bytes / Math.max(1, params.budgetBytes));
  return [
    params.scope,
    params.agentId ?? "-",
    `b${budgetMultiples}`,
    `e${Math.floor(params.entryCount / 16)}`,
    params.duplicatesFound ? "dup" : "nodup",
    params.conflictsFound ? "conf" : "noconf",
    params.tooLarge ? "toolarge" : "parseable",
  ].join(":");
}

/** Which scopes one backup receipt actually covers (`MemoryBackupScope` = "project" | "agents" | "all"). */
function backupCoversScope(receipt: LongTermMemoryBackupReceipt, scope: LongTermMemoryScope): boolean {
  if (receipt.scope === undefined || receipt.scope === "all") return true;
  if (receipt.scope === "project") return scope === "project";
  if (receipt.scope === "agents") return scope === "agent";
  return false;
}

function auditTargetFor(target: LongTermMemoryTarget): string {
  return target.scope === "agent" ? `agent:${target.agentId ?? "?"}` : "project";
}

function identityOf(target: LongTermMemoryTarget): Record<string, unknown> {
  return { scope: target.scope, ...(target.agentId ? { agentId: target.agentId } : {}) };
}

type PendingRewrite = {
  target: LongTermMemoryTarget;
  /** Exact bytes the plan was built from, for the pre-write change check. */
  original: string;
  planned: LongTermMemoryConsolidationPlan;
  /** Byte-quota roll-up plan, or `null` when the collapse alone was enough (or nothing moved). */
  rollup: LongTermMemoryRollupPlan | null;
  /** Final hot-file bytes: the roll-up's kept tail when sections moved, otherwise the collapsed content. */
  finalContent: string;
  /** Newline shape of the source file, reused so the cold tier matches its hot sibling. */
  newline: string;
  /** Cold-tier path the moved sections go to (`null` when nothing moves). */
  archivePath: string | null;
  bytesBefore: number;
  entryCountBefore: number;
};

/**
 * Measure every long-term memory file, report breaches, and collapse exact duplicates behind a backup.
 *
 * FNXC:MemoryBudget 2026-09-29-23:56:
 * RUFU-279 — this is the default-on maintenance path the defect was missing: it runs from engine
 * startup recovery and every maintenance batch, independent of the opt-in `Memory Keeper` runtime
 * switch, and it is the only code in the repo that rewrites a long-term memory file.
 *
 * Ordering is load-bearing: read → plan → (nothing to collapse: report only) → ONE backup of the whole
 * memory tree → evict that directory back to `memoryBackupRetention` → re-verify each file still holds
 * the bytes the plan was built from → write → read back.
 * One backup per sweep covers every target because `MemoryBackupManager` archives `.fusion/memory` and
 * `.fusion/agent-memory` together, which avoids burning retention slots per file; the eviction that
 * RUFU-441 wired in is scoped the same way, one entry per sweep rather than one per rewritten target, so
 * the pass cannot grow the directory it just paid for. The re-verify closes
 * the window in which an append landing after the plan would otherwise be overwritten. If an operator
 * narrowed `memoryBackupScope`, an uncovered target is reported as a `backup-scope` failure and left
 * untouched rather than written without its backup.
 */
export async function runLongTermMemoryMaintenance(
  options: LongTermMemoryMaintenanceOptions,
): Promise<LongTermMemoryMaintenanceResult> {
  const budgetBytes = options.budgetBytes ?? MEMORY_LONG_TERM_BYTE_BUDGET;
  const maxBytes = options.maxBytes ?? MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES;
  const hotTargetBytes = options.hotTargetBytes ?? (
    options.budgetBytes === undefined ? MEMORY_LONG_TERM_HOT_TARGET_BYTES : Math.floor(budgetBytes * 0.75)
  );
  const now = options.now ?? Date.now;
  const state = options.overBudgetAuditState ?? new Map<string, number>();
  const cooldownMs = options.cooldownMs ?? LONG_TERM_MEMORY_OVER_BUDGET_AUDIT_COOLDOWN_MS;
  const targets = options.targets ?? discoverLongTermMemoryTargets(options.rootDir);

  const result: LongTermMemoryMaintenanceResult = {
    scanned: 0,
    withinBudget: 0,
    overBudget: 0,
    findingsEmitted: 0,
    suppressedFindings: 0,
    duplicateSectionsCollapsed: 0,
    conflictsRetained: 0,
    rolledUpSections: 0,
    rolledUpBytes: 0,
    rewritten: 0,
    skippedTooLarge: 0,
    failures: 0,
  };

  async function emitFinding(input: {
    target: LongTermMemoryTarget;
    bytes: number;
    entryCount: number;
    duplicatesFound: boolean;
    conflictsFound: boolean;
    tooLarge: boolean;
    /*
     * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
     * Two booleans the operator needs to route the finding, carried on the row rather than inferred
     * from the file. "Over budget" alone conflates two different jobs: a file whose breach is a pile of
     * re-appended restatements is fixed by collapsing duplicates, while the measured production file
     * (every section distinct) is not, and maintenance has to say which lever exists before an author
     * goes looking for one. `retirementCanConverge` false beside `collapseCanConverge` false is the
     * only honest "this one needs a human decision" signal; `tooLarge` is reported as both false
     * because an un-parsed file proves nothing about either remedy.
     */
    collapseCanConverge: boolean;
    retirementCanConverge: boolean;
  }): Promise<void> {
    const signature = longTermMemoryOverBudgetSignature({
      scope: input.target.scope,
      agentId: input.target.agentId,
      bytes: input.bytes,
      entryCount: input.entryCount,
      budgetBytes,
      duplicatesFound: input.duplicatesFound,
      conflictsFound: input.conflictsFound,
      tooLarge: input.tooLarge,
    });
    const lastEmitted = state.get(signature);
    if (lastEmitted !== undefined && now() - lastEmitted < cooldownMs) {
      result.suppressedFindings += 1;
      return;
    }
    state.set(signature, now());
    result.findingsEmitted += 1;
    await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget, {
      target: auditTargetFor(input.target),
      metadata: {
        ...identityOf(input.target),
        bytes: input.bytes,
        budgetBytes,
        overByBytes: Math.max(0, input.bytes - budgetBytes),
        entryCount: input.entryCount,
        duplicatesFound: input.duplicatesFound,
        conflictsFound: input.conflictsFound,
        tooLarge: input.tooLarge,
        collapseCanConverge: input.collapseCanConverge,
        retirementCanConverge: input.retirementCanConverge,
      },
    });
  }

  const pending: PendingRewrite[] = [];

  for (const target of targets) {
    result.scanned += 1;
    try {
      const size = await stat(target.path).then((st) => st.size).catch(() => -1);
      if (size < 0) continue; // vanished between discovery and stat

      if (size > maxBytes) {
        // Cost bound: report the breach, refuse to parse it. This is a deliberate skip, not a failure.
        result.overBudget += 1;
        result.skippedTooLarge += 1;
        await emitFinding({
          target,
          bytes: size,
          entryCount: 0,
          duplicatesFound: false,
          conflictsFound: false,
          tooLarge: true,
          // An un-parsed file proves nothing about either remedy; claiming either would be a guess.
          collapseCanConverge: false,
          retirementCanConverge: false,
        });
        await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
          target: auditTargetFor(target),
          metadata: { ...identityOf(target), stage: "too-large", bytes: size, maxBytes },
        });
        continue;
      }

      const content = await readFile(target.path, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      const planned = consolidateLongTermMemoryContent(content);

      if (bytes <= budgetBytes) {
        // Within budget: leave the file byte-identical. Consolidating a file that does not need it would
        // burn backup retention (one snapshot per sweep, each taking a retention slot) and churn a file no
        // reader is hurting on.
        result.withinBudget += 1;
        continue;
      }

      /*
       * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
       * Collapse first, then plan a byte-quota roll-up over the COLLAPSED bytes, in that order and for
       * one reason: collapsing exact duplicates removes text that is provably redundant, while retiring
       * a section moves text that might still be wanted. Doing it the other way round would push a
       * duplicate pair into the cold tier (both copies) instead of deleting one, and would make the
       * rolled-up count overstate the retirement. A file with no duplicates still plans a roll-up, which
       * is precisely the case RUFU-279 could not converge.
       */
      const rollup = planned.changed
        ? planLongTermMemoryRollup({ content: planned.content, targetBytes: hotTargetBytes })
        : planLongTermMemoryRollup({ content, targetBytes: hotTargetBytes });
      const collapseOnlyConverges = Buffer.byteLength(planned.content, "utf8") <= budgetBytes;
      const finalContent = rollup.changed ? rollup.content : planned.content;

      result.overBudget += 1;
      result.duplicateSectionsCollapsed += planned.duplicateSectionsCollapsed;
      result.conflictsRetained += planned.conflictsRetained;
      await emitFinding({
        target,
        bytes,
        entryCount: planned.entriesBefore,
        duplicatesFound: planned.duplicateSectionsCollapsed > 0,
        conflictsFound: planned.conflictsRetained > 0,
        tooLarge: false,
        collapseCanConverge: planned.duplicateSectionsCollapsed > 0 && collapseOnlyConverges,
        retirementCanConverge: rollup.changed && rollup.converged,
      });
      if (planned.changed || rollup.changed) {
        pending.push({
          target,
          original: content,
          planned,
          rollup: rollup.changed ? rollup : null,
          finalContent,
          newline: parseMemoryFile(content).newline,
          archivePath: rollup.changed && rollup.archivedSections.length > 0
            ? join(dirname(target.path), archiveMemoryFileName(new Date(now())))
            : null,
          bytesBefore: bytes,
          entryCountBefore: planned.entriesBefore,
        });
      }
    } catch (error) {
      result.failures += 1;
      options.log?.warn?.(`long-term memory maintenance failed for ${target.path}: ${describe(error)}`);
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
        target: auditTargetFor(target),
        metadata: { ...identityOf(target), stage: "read" },
      });
    }
  }

  if (pending.length === 0) return result;

  // No rewrite without a backup taken in this same sweep, after the planned bytes were read.
  // The manager instance is held, not discarded, because the same object owns the eviction below.
  let receipt: LongTermMemoryBackupReceipt | null = null;
  let evictSnapshots: (() => Promise<number>) | null = null;
  try {
    if (options.createBackup) {
      receipt = await options.createBackup();
      evictSnapshots = options.cleanupOldBackups ?? null;
    } else {
      const manager = createMemoryBackupManager(join(options.rootDir, ".fusion"), withEvictableRetention(options.settings));
      receipt = await manager.createBackup();
      evictSnapshots = () => manager.cleanupOldBackups();
    }
  } catch (error) {
    options.log?.warn?.(`long-term memory maintenance skipped ${pending.length} rewrite(s): backup failed (${describe(error)})`);
    receipt = null;
  }

  if (!receipt) {
    for (const item of pending) {
      result.failures += 1;
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
        target: auditTargetFor(item.target),
        metadata: {
          ...identityOf(item.target),
          stage: "backup",
          bytes: item.bytesBefore,
          duplicateSectionsCollapsed: item.planned.duplicateSectionsCollapsed,
          conflictsRetained: item.planned.conflictsRetained,
        },
      });
    }
    return result;
  }

  /*
   * FNXC:MemorySnapshotRetention 2026-11-05-10:28 (RUFU-441):
   * A snapshot that nothing ever evicts is an unbounded disk leak, not a safety net: this sweep runs at
   * engine startup and in maintenance batch 1 with no cadence gate of its own, so its frequency is the
   * maintenance tick — `settings.maintenanceIntervalMs`, whose shipped default is 300 000 (5 min ⇒ up to
   * 288 passes a day; the engine's nullish fallback of 900 000 would be 96). Every pass with a pending
   * rewrite leaves a full copy of both memory trees behind — including copies taken for rewrites that were
   * later refused, because acquisition happens before the write. So the pass mirrors the
   * create-then-cleanup pairing `fn memory-backup --create` already uses (`runMemoryBackupCommand`),
   * scoped to the pass rather than to a target, and reads `memoryBackupRetention` through the same
   * manager that read `memoryBackupDir`/`memoryBackupScope`.
   *
   * Two properties the rest of this block must not lose:
   * 1. It runs only after a snapshot SUCCEEDED. A pass with nothing pending returns earlier and a failed
   *    snapshot returns below, so neither ever scans or deletes the directory.
   * 2. It is best-effort. `cleanupOldBackups()` already swallows its own listing and per-directory `rm`
   *    errors, so a partial eviction returns quietly in production; an injected seam that rejects must
   *    likewise neither reject this pass nor change its audit outcome. Losing the eviction is a disk cost,
   *    failing the consolidation would be data loss.
   */
  if (evictSnapshots) {
    try {
      const evicted = await evictSnapshots();
      if (evicted > 0) {
        options.log?.debug?.(`long-term memory snapshot retention: evicted ${evicted} old memory backup(s).`);
      }
    } catch (error) {
      options.log?.warn?.(`long-term memory snapshot retention sweep failed: ${describe(error)}`);
    }
  }

  for (const item of pending) {
    const identity = identityOf(item.target);
    if (!backupCoversScope(receipt, item.target.scope)) {
      result.failures += 1;
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
        target: auditTargetFor(item.target),
        metadata: { ...identity, stage: "backup-scope", bytes: item.bytesBefore, backupScope: receipt.scope ?? "unknown" },
      });
      continue;
    }

    try {
      const current = await readFile(item.target.path, "utf8");
      if (current !== item.original) {
        // Someone wrote the file after we planned. Their bytes win and the next sweep re-plans; a
        // maintenance rewrite must never overwrite a concurrent append. The cold tier is gated on the
        // SAME proof: an archive append whose hot sections were refused would duplicate author text
        // into a second file with nothing removed from the first.
        result.failures += 1;
        const fresh = consolidateLongTermMemoryContent(current);
        await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
          target: auditTargetFor(item.target),
          metadata: {
            ...identity,
            stage: "concurrent-write",
            bytes: Buffer.byteLength(current, "utf8"),
            duplicateSectionsCollapsed: fresh.duplicateSectionsCollapsed,
          },
        });
        continue;
      }

      /*
       * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
       * Archive BEFORE the hot shrink, and read it back before anything leaves the hot file. The two
       * failure shapes are not equally acceptable: writing the hot file first and then failing the
       * archive would DISCARD author content, which is the one outcome this module exists to make
       * impossible. This order can only ever fail toward duplication -- an archive append with the hot
       * file untouched means the section briefly exists in two places, which is a tidiness problem an
       * operator can see and repair, not a loss. A failed archive write therefore records stage `write`
       * and leaves the hot file byte-identical.
       */
      let archiveWrittenTo: string | null = null;
      if (item.rollup && item.archivePath && item.rollup.archivedSections.length > 0) {
        let existingArchive: string | null = null;
        try {
          if (existsSync(item.archivePath)) existingArchive = await readFile(item.archivePath, "utf8");
        } catch (error) {
          result.failures += 1;
          options.log?.warn?.(`long-term memory cold tier unreadable for ${item.archivePath}: ${describe(error)}`);
          await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
            target: auditTargetFor(item.target),
            metadata: { ...identity, stage: "read", bytes: item.bytesBefore },
          });
          continue;
        }
        const merged = mergeSectionsIntoArchive({
          existing: existingArchive,
          sectionsToAppend: item.rollup.archivedSections,
          newline: item.newline,
        });
        try {
          if (!existingArchive) await mkdir(dirname(item.archivePath), { recursive: true });
          await writeFile(item.archivePath, merged.content, "utf8");
          const archiveReadBack = await readFile(item.archivePath, "utf8");
          /*
           * FNXC:MemoryBudget 2026-11-20-12:40 (RUFU-665):
           * Byte equality against what this process just wrote proves the WRITE landed; it does not prove
           * the MOVED CONTENT survived, because the merge that produced those bytes is the very code that
           * could have decided a section was already cold and skipped it. So every moved section's exact
           * text is required to be present in the bytes read back from disk — the loss-free claim rests on
           * the file, not on the writer's return value.
           *
           * A miss needs no restore, and that is the point of the archive-first order above: the hot file
           * has not been touched yet, so refusing here leaves the author's content exactly where it was,
           * in one place, with the failure recorded. A restore would only be the remedy for an order that
           * shrank the hot file first.
           */
          const missing = movedSectionsMissingFromArchive(
            archiveReadBack,
            item.rollup.archivedSections,
            item.newline,
          );
          if (archiveReadBack !== merged.content || missing.length > 0) {
            result.failures += 1;
            options.log?.warn?.(
              `long-term memory cold tier verify refused the roll-up for ${item.archivePath}: ` +
                `${missing.length} of ${item.rollup.archivedSections.length} moved sections absent after read-back`,
            );
            await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
              target: auditTargetFor(item.target),
              metadata: { ...identity, stage: "verify", bytes: item.bytesBefore, rolledUpSections: merged.appended },
            });
            continue;
          }
          archiveWrittenTo = item.archivePath;
        } catch (error) {
          result.failures += 1;
          options.log?.warn?.(`long-term memory cold tier write failed for ${item.archivePath}: ${describe(error)}`);
          await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
            target: auditTargetFor(item.target),
            metadata: { ...identity, stage: "write", bytes: item.bytesBefore },
          });
          continue;
        }
      }

      await writeFile(item.target.path, item.finalContent, "utf8");
      const written = await readFile(item.target.path, "utf8");
      if (written !== item.finalContent) {
        result.failures += 1;
        await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
          target: auditTargetFor(item.target),
          metadata: { ...identity, stage: "verify", bytes: item.bytesBefore, bytesAfterRewrite: Buffer.byteLength(written, "utf8") },
        });
        continue;
      }

      const movedSections = archiveWrittenTo ? item.rollup?.archivedSections.length ?? 0 : 0;
      /*
       * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
       * `rolledUpBytes` is the RETIREMENT delta only, not `bytesBefore - bytesAfter`. The two differ
       * whenever a sweep also collapsed duplicates, and the row already reports the collapse separately
       * as `duplicateSectionsCollapsed`; a key named for the move that also counted the collapse would
       * make "how much did retirement free?" unanswerable, which is the one number this row exists to
       * give an operator deciding whether to trust the cold tier.
       */
      const movedBytes = archiveWrittenTo ? Math.max(0, item.rollup?.rolledUpBytes ?? 0) : 0;
      result.rewritten += 1;
      result.rolledUpSections += movedSections;
      result.rolledUpBytes += movedBytes;
      const bytesAfter = Buffer.byteLength(written, "utf8");
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.consolidated, {
        target: auditTargetFor(item.target),
        metadata: {
          ...identity,
          bytesBefore: item.bytesBefore,
          bytesAfter,
          budgetBytes,
          hotTargetBytes,
          entryCountBefore: item.entryCountBefore,
          entryCountAfter: countMemoryEntries(written),
          duplicateSectionsCollapsed: item.planned.duplicateSectionsCollapsed,
          conflictsRetained: item.planned.conflictsRetained,
          // Counts only. The cold tier's FILENAME, path, date and headings live in the file itself and
          // in the debug line below, never in a queryable row: an archive name is a dated path, and a
          // dated path is exactly the kind of value the memory audit contract keeps out of run-audit.
          rolledUpSections: movedSections,
          rolledUpBytes: movedBytes,
          // Task premise 4: after a rewrite that still exceeds the bound, the original breach row and
          // this number together put BOTH the pre- and post-rewrite breach on the record. A converged
          // roll-up flips this to false, which is the durable proof that the sweep converged.
          stillOverBudget: bytesAfter > budgetBytes,
        },
      });
      options.log?.debug?.(
        `long-term memory consolidated (${auditTargetFor(item.target)}): ${item.entryCountBefore} -> ${countMemoryEntries(written)} entries, ` +
          `${item.bytesBefore} -> ${bytesAfter} bytes (budget ${budgetBytes}, hot target ${hotTargetBytes}, ` +
          `collapsed ${item.planned.duplicateSectionsCollapsed}, rolled up ${movedSections}${archiveWrittenTo ? ` into ${archiveWrittenTo}` : ""}).`,
      );
    } catch (error) {
      result.failures += 1;
      options.log?.warn?.(`long-term memory rewrite failed for ${item.target.path}: ${describe(error)}`);
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
        target: auditTargetFor(item.target),
        metadata: { ...identity, stage: "write", bytes: item.bytesBefore },
      });
    }
  }

  return result;
}

/** Best-effort audit: an absent or hostile sink must never change what the sweep did to the files. */
async function safeAudit(
  audit: LongTermMemoryAuditEmit,
  eventType: string,
  payload: { target: string; metadata: Record<string, unknown> },
): Promise<void> {
  try {
    await audit(eventType, payload);
  } catch {
    // Telemetry is not a lifecycle dependency; the durable evidence is the file plus its backup.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * FNXC:MemorySnapshotRetention 2026-11-05-10:28 (RUFU-441):
 * `memoryBackupRetention` reaches this module straight from project settings, and unlike
 * `autoBackupRetention` it has no server-side range check on the settings write path (the route validates
 * that DB-backup key through `validateBackupRetention`, which accepts 1-100; the memory key is unchecked,
 * and the dashboard flags an out-of-range value in the form without the write path refusing it). Before
 * RUFU-441 an out-of-range value was inert here because nothing on this path evicted; now that the pass
 * reads its own retention, a count below 1 would make the eviction delete the snapshot this very pass
 * took, breaking the "no backup, no write" guarantee one step after honoring it. The floor therefore
 * belongs where the value is consumed: `cleanupOldBackups()` is shared with `fn memory-backup --create`
 * and `packages/core/src/memory/memory-backup.ts` stays unmodified. An unset or valid value passes through
 * untouched, so the manager's own constructor defaults remain the single source of truth.
 */
function withEvictableRetention(settings?: Partial<ProjectSettings>): Partial<ProjectSettings> | undefined {
  const configured = settings?.memoryBackupRetention;
  if (typeof configured !== "number" || configured >= 1) return settings;
  return { ...settings, memoryBackupRetention: 1 };
}
