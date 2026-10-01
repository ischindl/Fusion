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
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryBackupManager, memoryLongTermPath } from "@fusion/core";
import type { ProjectSettings } from "@fusion/core";
import {
  MEMORY_LONG_TERM_BYTE_BUDGET,
  MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES,
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
 * memory tree → re-verify each file still holds the bytes the plan was built from → write → read back.
 * One backup per sweep covers every target because `MemoryBackupManager` archives `.fusion/memory` and
 * `.fusion/agent-memory` together, which avoids burning retention slots per file; the re-verify closes
 * the window in which an append landing after the plan would otherwise be overwritten. If an operator
 * narrowed `memoryBackupScope`, an uncovered target is reported as a `backup-scope` failure and left
 * untouched rather than written without its backup.
 */
export async function runLongTermMemoryMaintenance(
  options: LongTermMemoryMaintenanceOptions,
): Promise<LongTermMemoryMaintenanceResult> {
  const budgetBytes = options.budgetBytes ?? MEMORY_LONG_TERM_BYTE_BUDGET;
  const maxBytes = options.maxBytes ?? MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES;
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
        // burn backup retention and churn a file no reader is hurting on.
        result.withinBudget += 1;
        continue;
      }

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
      });
      if (planned.changed) {
        pending.push({ target, original: content, planned, bytesBefore: bytes, entryCountBefore: planned.entriesBefore });
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
  let receipt: LongTermMemoryBackupReceipt | null = null;
  try {
    receipt = options.createBackup
      ? await options.createBackup()
      : await createMemoryBackupManager(join(options.rootDir, ".fusion"), options.settings).createBackup();
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
        // duplicate collapse must never overwrite a concurrent append.
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

      await writeFile(item.target.path, item.planned.content, "utf8");
      const written = await readFile(item.target.path, "utf8");
      if (written !== item.planned.content) {
        result.failures += 1;
        await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.failed, {
          target: auditTargetFor(item.target),
          metadata: { ...identity, stage: "verify", bytes: item.bytesBefore, bytesAfterRewrite: Buffer.byteLength(written, "utf8") },
        });
        continue;
      }

      result.rewritten += 1;
      const bytesAfter = Buffer.byteLength(written, "utf8");
      await safeAudit(options.audit, LONG_TERM_MEMORY_AUDIT_EVENTS.consolidated, {
        target: auditTargetFor(item.target),
        metadata: {
          ...identity,
          bytesBefore: item.bytesBefore,
          bytesAfter,
          budgetBytes,
          entryCountBefore: item.entryCountBefore,
          entryCountAfter: item.planned.entriesAfter,
          duplicateSectionsCollapsed: item.planned.duplicateSectionsCollapsed,
          conflictsRetained: item.planned.conflictsRetained,
          // Task premise 4: after a rewrite that still exceeds the bound, the original breach row and
          // this number together put BOTH the pre- and post-rewrite breach on the record.
          stillOverBudget: bytesAfter > budgetBytes,
        },
      });
      options.log?.debug?.(
        `long-term memory consolidated (${auditTargetFor(item.target)}): ${item.entryCountBefore} -> ${item.planned.entriesAfter} entries, ` +
          `${item.bytesBefore} -> ${bytesAfter} bytes (budget ${budgetBytes}).`,
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
