import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LONG_TERM_MEMORY_AUDIT_EVENTS,
  consolidateLongTermMemoryContent,
  discoverLongTermMemoryTargets,
  longTermMemoryOverBudgetSignature,
  runLongTermMemoryMaintenance,
  type LongTermMemoryAuditEmit,
  type LongTermMemoryBackupReceipt,
} from "../long-term-consolidation.js";

/**
 * RUFU-279: the durable `MEMORY.md` files had no maintenance path at all. These tests own the two
 * properties that make a maintenance path safe to run by default on every engine start: it must be a
 * pure function of the bytes (no model, no judgment) and it must never lose or overwrite content.
 */

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-memory-consolidation-"));
  tempDirs.push(root);
  await mkdir(join(root, ".fusion", "memory"), { recursive: true });
  return root;
}

async function writeProjectMemory(root: string, content: string): Promise<string> {
  const path = join(root, ".fusion", "memory", "MEMORY.md");
  await writeFile(path, content);
  return path;
}

async function writeAgentMemory(root: string, agentId: string, content: string): Promise<string> {
  const dir = join(root, ".fusion", "agent-memory", agentId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "MEMORY.md");
  await writeFile(path, content);
  return path;
}

/** A body large enough to breach a small injected budget, with `duplicates` repeated sections. */
function memoryContent(entries: number, opts?: { duplicateOf?: number }): string {
  const lines = ["# Project Memory", ""];
  for (let i = 0; i < entries; i++) {
    lines.push(`## Entry ${i}`, `Body ${i} — a durable lesson about ${"padding ".repeat(6)}.`, "");
  }
  if (opts?.duplicateOf) {
    for (let i = 0; i < opts.duplicateOf; i++) {
      // Re-appended restatements: same heading, same body, cosmetically different whitespace/case.
      lines.push(`## ENTRY ${i} `, `Body ${i} — a durable lesson about ${"padding ".repeat(6)}.`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function collectAudit(): { rows: Array<{ event: string; target: string; metadata: Record<string, unknown> }>; emit: LongTermMemoryAuditEmit } {
  const rows: Array<{ event: string; target: string; metadata: Record<string, unknown> }> = [];
  return {
    rows,
    emit: async (event, payload) => {
      rows.push({ event, target: payload.target, metadata: payload.metadata });
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("consolidateLongTermMemoryContent", () => {
  it("returns the input unchanged when nothing is an exact duplicate", () => {
    const content = "# T\n\n## A\nalpha\n\n## B\nbeta\n";
    const plan = consolidateLongTermMemoryContent(content);

    expect(plan.content).toBe(content);
    expect(plan.changed).toBe(false);
    expect(plan.duplicateSectionsCollapsed).toBe(0);
    expect(plan.conflictsRetained).toBe(0);
    expect(plan.entriesBefore).toBe(2);
  });

  it("collapses an exact duplicate to the first occurrence, whitespace and case aside", () => {
    const content = "# T\n\n## Rule\nbody text\n\n##  rule \nbody text  \n\n## Other\nkept\n";
    const plan = consolidateLongTermMemoryContent(content);

    expect(plan.duplicateSectionsCollapsed).toBe(1);
    expect(plan.entriesBefore).toBe(3);
    expect(plan.entriesAfter).toBe(2);
    expect(plan.content).toContain("## Rule");
    expect(plan.content).not.toContain("##  rule ");
    expect(plan.content).toContain("## Other");
    // Untouched sections keep their raw bytes, so the only change is the dropped duplicate.
    expect(plan.content).toContain("body text\n\n## Other");
  });

  it("counts a same-heading different-body pair as a conflict and keeps both", () => {
    const content = "# T\n\n## Rule\nfirst stance\n\n## Rule\nsecond stance\n";
    const plan = consolidateLongTermMemoryContent(content);

    expect(plan.duplicateSectionsCollapsed).toBe(0);
    expect(plan.conflictsRetained).toBe(2);
    expect(plan.content).toContain("first stance");
    expect(plan.content).toContain("second stance");
    expect(plan.entriesAfter).toBe(2);
  });

  it("is idempotent and deterministic", () => {
    const first = consolidateLongTermMemoryContent(memoryContent(8, { duplicateOf: 4 }));
    const second = consolidateLongTermMemoryContent(first.content);

    expect(first.duplicateSectionsCollapsed).toBe(4);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(consolidateLongTermMemoryContent(memoryContent(8, { duplicateOf: 4 })).content).toBe(first.content);
  });

  it("survives a CRLF file without normalizing line endings", () => {
    const crlf = "# T\r\n## A\r\nalpha\r\n## A\r\nalpha\r\n";
    const plan = consolidateLongTermMemoryContent(crlf);

    expect(plan.duplicateSectionsCollapsed).toBe(1);
    expect(plan.content).toBe("# T\r\n## A\r\nalpha\r\n");
    // No stray LF: a rewrite must not silently re-endline the file for every reader and git diff.
    expect(plan.content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("collapses a 306-entry file down while keeping every distinct body verbatim", () => {
    // The real-world shape from the defect: hundreds of entries, a meaningful share of them re-appends.
    const content = memoryContent(306, { duplicateOf: 60 });
    const before = consolidateLongTermMemoryContent(content);

    expect(before.entriesBefore).toBe(366);
    expect(before.duplicateSectionsCollapsed).toBe(60);
    expect(before.entriesAfter).toBe(306);
    for (let i = 0; i < 306; i++) {
      expect(before.content).toContain(`Body ${i} — a durable lesson about`);
    }
    expect(before.content).not.toContain("## ENTRY 59");
  });
});

describe("discoverLongTermMemoryTargets", () => {
  it("finds the project file and every agent file, ignoring other content", async () => {
    const root = await makeTempProject();
    await writeProjectMemory(root, "# Project Memory\n");
    await writeAgentMemory(root, "agent-b", "# B\n\n## x\ny\n");
    await writeAgentMemory(root, "agent-a", "# A\n");
    await mkdir(join(root, ".fusion", "agent-memory", "agent-c"), { recursive: true });
    await writeFile(join(root, ".fusion", "agent-memory", "agent-c", "dreams.md"), "# not memory\n");

    const targets = discoverLongTermMemoryTargets(root);
    expect(targets.map((t) => t.scope).sort()).toEqual(["agent", "agent", "project"]);
    expect(targets.filter((t) => t.scope === "agent").map((t) => t.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(targets.find((t) => t.scope === "project")?.path).toBe(join(root, ".fusion", "memory", "MEMORY.md"));
  });

  it("returns nothing when no memory tree exists yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-memory-empty-"));
    tempDirs.push(root);
    expect(discoverLongTermMemoryTargets(root)).toEqual([]);
  });
});

describe("runLongTermMemoryMaintenance", () => {
  it("leaves a within-budget file byte-identical and emits no audit row", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(3, { duplicateOf: 1 }));
    const before = await readFile(path, "utf8");
    const audit = collectAudit();

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 100_000,
      audit: audit.emit,
      createBackup: async () => ({ scope: "all" }),
    });

    expect(result).toMatchObject({ scanned: 1, withinBudget: 1, overBudget: 0, rewritten: 0, failures: 0 });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(audit.rows).toEqual([]);
  });

  it("reports a breach, backs up first, then collapses exact duplicates", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const audit = collectAudit();
    const createBackup = vi.fn(async () => ({ scope: "all" }) satisfies LongTermMemoryBackupReceipt);

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      createBackup,
    });

    expect(result.overBudget).toBe(1);
    expect(result.duplicateSectionsCollapsed).toBe(3);
    expect(result.rewritten).toBe(1);
    // Backup ordering is the loss-free guarantee: the backup must have been taken for this sweep.
    expect(createBackup).toHaveBeenCalledTimes(1);

    const after = await readFile(path, "utf8");
    expect(Buffer.byteLength(after, "utf8")).toBeLessThan(Buffer.byteLength(memoryContent(6, { duplicateOf: 3 }), "utf8"));
    for (let i = 0; i < 6; i++) expect(after).toContain(`Body ${i} —`);

    expect(audit.rows.map((row) => row.event)).toEqual([
      LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget,
      LONG_TERM_MEMORY_AUDIT_EVENTS.consolidated,
    ]);
    expect(audit.rows[0].metadata).toMatchObject({ scope: "project", budgetBytes: 200, entryCount: 9 });
    expect(audit.rows[1].metadata).toMatchObject({
      scope: "project",
      entryCountBefore: 9,
      entryCountAfter: 6,
      duplicateSectionsCollapsed: 3,
      stillOverBudget: true,
    });
  });

  /*
   * FNXC:MemoryBudget 2026-09-30-01:29 (RUFU-279):
   * This is the shape the production file actually had: 594,273 bytes over 306 entries, every one of
   * them a distinct body, so the breach was real but deduplication could legally remove nothing. The
   * honest result is a report and an untouched file — maintenance must never invent a compaction (a
   * summary pass would mean deleting durable memory, which RUFU-279 rules out) and must not spend a
   * backup snapshot when there is no rewrite to protect.
   */
  it("reports an all-unique breach without backing up or touching the file", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6));
    const before = await readFile(path, "utf8");
    const audit = collectAudit();
    const createBackup = vi.fn(async () => ({ scope: "all" }) satisfies LongTermMemoryBackupReceipt);

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      createBackup,
    });

    expect(result).toMatchObject({ overBudget: 1, duplicateSectionsCollapsed: 0, conflictsRetained: 0, rewritten: 0, failures: 0 });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(createBackup).not.toHaveBeenCalled();
    expect(audit.rows.map((row) => row.event)).toEqual([LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget]);
    expect(audit.rows[0].metadata).toMatchObject({ duplicatesFound: false, conflictsFound: false, tooLarge: false });
  });

  it("never writes when the backup fails, and records the stage", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const before = await readFile(path, "utf8");
    const audit = collectAudit();

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      createBackup: async () => {
        throw new Error("disk full");
      },
    });

    expect(await readFile(path, "utf8")).toBe(before);
    expect(result.rewritten).toBe(0);
    expect(result.failures).toBe(1);
    const failed = audit.rows.find((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.failed);
    expect(failed?.metadata).toMatchObject({ stage: "backup" });
    expect(audit.rows.some((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.consolidated)).toBe(false);
  });

  it("leaves a target uncovered by the backup scope untouched", async () => {
    const root = await makeTempProject();
    const projectPath = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const agentPath = await writeAgentMemory(root, "agent-1", memoryContent(6, { duplicateOf: 3 }));
    const agentBefore = await readFile(agentPath, "utf8");
    const audit = collectAudit();

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      createBackup: async () => ({ scope: "project" }),
    });

    expect(await readFile(agentPath, "utf8")).toBe(agentBefore);
    expect(await readFile(projectPath, "utf8")).not.toBe(agentBefore);
    expect(result.rewritten).toBe(1);
    const scopeFailure = audit.rows.find((row) => row.metadata.stage === "backup-scope");
    expect(scopeFailure?.metadata).toMatchObject({ scope: "agent", agentId: "agent-1", backupScope: "project" });
  });

  it("aborts a rewrite when the file changed after the plan was built", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const audit = collectAudit();
    const concurrentAppend = "\n## Someone else\nwritten during the sweep\n";

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      // The backup call is the window in which a concurrent append can land; prove the re-read wins.
      createBackup: async () => {
        await writeFile(path, memoryContent(6, { duplicateOf: 3 }) + concurrentAppend);
        return { scope: "all" };
      },
    });

    const after = await readFile(path, "utf8");
    expect(result.rewritten).toBe(0);
    expect(result.failures).toBe(1);
    // The concurrent author's bytes survive untouched; the collapse waits for the next sweep.
    expect(after).toContain(concurrentAppend.trim());
    expect(audit.rows.some((row) => row.metadata.stage === "concurrent-write")).toBe(true);
  });

  it("reports a file above the cost bound without parsing it", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const before = await readFile(path, "utf8");
    const audit = collectAudit();

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      maxBytes: 64,
      audit: audit.emit,
      createBackup: async () => ({ scope: "all" }),
    });

    expect(result.overBudget).toBe(1);
    expect(result.skippedTooLarge).toBe(1);
    expect(result.rewritten).toBe(0);
    // A deliberate skip is not a maintenance failure.
    expect(result.failures).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(audit.rows.some((row) => row.metadata.stage === "too-large")).toBe(true);
    expect(audit.rows.some((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget && row.metadata.tooLarge === true)).toBe(true);
  });

  it("keeps a within-budget file untouched even when it holds duplicates", async () => {
    const root = await makeTempProject();
    const path = await writeAgentMemory(root, "agent-1", "## A\nalpha\n\n## A\nalpha\n");
    const before = await readFile(path, "utf8");
    const audit = collectAudit();

    await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 10_000,
      audit: audit.emit,
      createBackup: async () => ({ scope: "all" }),
    });

    expect(await readFile(path, "utf8")).toBe(before);
    expect(audit.rows).toEqual([]);
  });

  it("rate-limits identical breach findings while still reporting growth", async () => {
    const root = await makeTempProject();
    await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const audit = collectAudit();
    const state = new Map<string, number>();
    let nowValue = 1_000_000;
    const run = () =>
      runLongTermMemoryMaintenance({
        rootDir: root,
        budgetBytes: 200,
        audit: audit.emit,
        overBudgetAuditState: state,
        now: () => nowValue,
        // Nothing may be rewritten: keep the file stable so the finding signature is the variable.
        createBackup: async () => {
          throw new Error("no backup: keep the file as-is");
        },
      });

    await run();
    expect(audit.rows.filter((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget)).toHaveLength(1);

    // Same state, inside the cooldown: the finding is suppressed rather than re-emitted.
    nowValue += 60_000;
    const suppressed = await run();
    expect(suppressed.suppressedFindings).toBe(1);
    expect(audit.rows.filter((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget)).toHaveLength(1);

    // Cooldown expiry re-reports the standing breach.
    nowValue += 6 * 60 * 60 * 1000;
    await run();
    expect(audit.rows.filter((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget)).toHaveLength(2);

    // Genuine growth crosses a budget multiple, which is a new signature and reports immediately.
    await writeProjectMemory(root, memoryContent(40, { duplicateOf: 3 }));
    nowValue += 1_000;
    await run();
    expect(audit.rows.filter((row) => row.event === LONG_TERM_MEMORY_AUDIT_EVENTS.overBudget)).toHaveLength(3);
  });

  it("treats the audit sink as non-load-bearing", async () => {
    const root = await makeTempProject();
    const path = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    const before = await readFile(path, "utf8");

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: async () => {
        throw new Error("audit sink offline");
      },
      createBackup: async () => ({ scope: "all" }),
    });

    expect(result.rewritten).toBe(1);
    expect(await readFile(path, "utf8")).not.toBe(before);
  });

  it("reports a per-target read failure without aborting the sweep", async () => {
    const root = await makeTempProject();
    const goodPath = await writeProjectMemory(root, memoryContent(6, { duplicateOf: 3 }));
    await writeAgentMemory(root, "agent-1", memoryContent(6, { duplicateOf: 3 }));
    const audit = collectAudit();

    const result = await runLongTermMemoryMaintenance({
      rootDir: root,
      budgetBytes: 200,
      audit: audit.emit,
      // One target is unreadable (a directory where a file is expected): the other must still land.
      targets: [
        { scope: "project", path: goodPath },
        { scope: "agent", agentId: "agent-broken", path: join(root, ".fusion", "memory") },
      ],
      createBackup: async () => ({ scope: "all" }),
    });

    expect(result.rewritten).toBe(1);
    expect(result.failures).toBe(1);
    expect(audit.rows.some((row) => row.metadata.stage === "read" && row.metadata.agentId === "agent-broken")).toBe(true);
  });
});

describe("longTermMemoryOverBudgetSignature", () => {
  it("buckets bytes by budget multiples and distinguishes scope and agent", () => {
    const base = { bytes: 40_000, entryCount: 20, budgetBytes: 32_768, duplicatesFound: true, conflictsFound: false, tooLarge: false };
    const project = longTermMemoryOverBudgetSignature({ ...base, scope: "project" });
    const agent = longTermMemoryOverBudgetSignature({ ...base, scope: "agent", agentId: "agent-a" });

    expect(project).not.toBe(agent);
    expect(longTermMemoryOverBudgetSignature({ ...base, scope: "agent", agentId: "agent-b" })).not.toBe(agent);
    expect(longTermMemoryOverBudgetSignature({ ...base, scope: "project", bytes: 70_000 })).not.toBe(project);
    expect(longTermMemoryOverBudgetSignature({ ...base, scope: "project", conflictsFound: true })).not.toBe(project);
    // Steady state (same bucket) must collapse to the same key, or the cooldown can never fire.
    expect(longTermMemoryOverBudgetSignature({ ...base, scope: "project", bytes: 36_000 })).toBe(project);
  });

  it("carries no durable memory content", () => {
    const signature = longTermMemoryOverBudgetSignature({
      scope: "agent",
      agentId: "agent-a",
      bytes: 1000,
      entryCount: 3,
      budgetBytes: 512,
      duplicatesFound: false,
      conflictsFound: false,
      tooLarge: false,
    });
    // Ids, bucketed counts, and fixed flags only — never a path, heading, or entry text.
    expect(signature).toMatch(/^[a-z-]+:[a-zA-Z0-9._-]+:b\d+:e\d+:(nodup|dup):(noconf|conf):(toolarge|parseable)$/);
  });
});
