import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";
import { MEMORY_LONG_TERM_HOT_TARGET_BYTES } from "../memory/memory-budget.js";

/**
 * RUFU-279: long-term `MEMORY.md` maintenance has to run on the default path, not behind the optional
 * `Memory Keeper` runtime switch that built-in provisioning seeds disabled. Self-healing is that
 * default path, so these tests pin its end-to-end behavior: what a breach does to the file, what it
 * leaves in the audit store, and what it refuses to do when nothing is wrong.
 */

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-selfheal-mem-"));
  tempDirs.push(root);
  await mkdir(join(root, ".fusion"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type AuditRow = { mutationType: string; target: string; metadata: Record<string, unknown> };

function fakeStore(rows: AuditRow[], opts: { hostile?: boolean } = {}) {
  return {
    getSettings: vi.fn(async () => {
      if (opts.hostile) throw new Error("settings backend down");
      return undefined;
    }),
    recordRunAuditEvent: vi.fn(async (event: AuditRow) => {
      if (opts.hostile) throw new Error("audit sink down");
      rows.push(event);
      return { id: `audit-${rows.length}` };
    }),
  } as never;
}

/** Body prose shared by every note, so a loss check is one exact-string search per note. */
function detail(i: number): string {
  return `Durable detail ${i}: ${"the maintenance pass must never rewrite this prose ".repeat(2)}`;
}

/**
 * A file shaped like the measured production one: hundreds of distinct notes (so a duplicate collapse
 * alone cannot fix the size) plus a few exact duplicate sections.
 *
 * `oversizedCount` appends notes that are individually bigger than the whole budget. That shape is what
 * no maintenance rule can shrink, and the rate-limiting test needs a breach that STAYS standing after a
 * successful convergence, or the cooldown it pins would have nothing left to suppress.
 */
function overBudgetMemory(uniqueCount: number, duplicateCount: number, oversizedCount = 0): string {
  const lines = ["# Project Memory", ""];
  for (let i = 0; i < uniqueCount; i++) {
    lines.push(`## Convention ${i}`, detail(i), "");
  }
  for (let d = 0; d < duplicateCount; d++) {
    lines.push(`## Convention ${d}`, detail(d), "");
  }
  for (let o = 0; o < oversizedCount; o++) {
    // Newest, and bigger on its own than the 32 KiB bound: retirement cannot move it and still converge.
    lines.push(`## Oversized ${o}`, `unshrinkable ${"u".repeat(40_000)}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function headingCount(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("## ")).length;
}

/**
 * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
 * The cold tier is what makes a maintenance pass that CONVERGES possible, so every loss-free assertion
 * has to be taken across BOTH tiers now: "still in MEMORY.md" is no longer the property the author
 * depends on, "still reachable" is. The sweep addresses the archive by the host clock, so this lists the
 * memory directories by shape rather than recomputing a date here.
 */
async function readArchiveBodies(root: string): Promise<string[]> {
  const dirs = [join(root, ".fusion", "memory"), join(root, ".fusion", "agent-memory", "agent-1")];
  const bodies: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((candidate) => /^ARCHIVE-\d{4}-\d{2}-\d{2}\.md$/.test(candidate))) {
      bodies.push(await readFile(join(dir, name), "utf8"));
    }
  }
  return bodies;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

describe("self-healing long-term memory budget sweep", () => {
  /*
   * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
   * RUFU-279's version of this test asserted `headingCount(after) === 300`, `entryCountAfter: 300` and
   * `stillOverBudget: true`. Those three numbers were the dead end written down as the expected result:
   * the collapse deleted the 3 repeats and left a ~42 KB file over a 32 KiB bound, so the sweep
   * re-announced the same breach every maintenance batch forever. The test's subject (a breach that
   * cannot be fixed) is what the change removed, so it is replaced with the new contract: converge, and
   * prove the loss across the two tiers rather than inside one file.
   */
  it("backs up an over-budget project file, collapses exact duplicates, retires the oldest, and reports both", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const before = overBudgetMemory(300, 3);
    await writeFile(memoryPath, before);

    const rows: AuditRow[] = [];
    const manager = new SelfHealingManager(fakeStore(rows), { rootDir: root } as never);
    const result = await manager.reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({
      scanned: 1,
      overBudget: 1,
      duplicateSectionsCollapsed: 3,
      conflictsRetained: 0,
      rewritten: 1,
      failures: 0,
    });
    expect(result.rolledUpSections).toBeGreaterThan(0);
    expect(result.rolledUpBytes).toBeGreaterThan(0);

    const after = await readFile(memoryPath, "utf8");
    const archives = await readArchiveBodies(root);
    expect(headingCount(before)).toBe(303);
    // The bound is now enforced, not merely reported: the hot file fits the target with margin.
    expect(headingCount(after)).toBeLessThan(303);
    expect(Buffer.byteLength(after, "utf8")).toBeLessThanOrEqual(MEMORY_LONG_TERM_HOT_TARGET_BYTES);
    expect(archives.length).toBe(1);
    // Loss-free across the two tiers: every distinct note survives byte-for-byte in one of them.
    for (let i = 0; i < 300; i++) {
      const note = `## Convention ${i}\n${detail(i)}`;
      expect(after.includes(note) || archives.some((text) => text.includes(note))).toBe(true);
    }
    // Nothing was duplicated by the move: a collapsed duplicate exists exactly once across both tiers.
    const total = occurrences(after, "## Convention 0") + archives.reduce((n, text) => n + occurrences(text, "## Convention 0"), 0);
    expect(total).toBe(1);
    // Retirement is oldest-first, so the newest note is still hot and the ordering inside the archive is
    // the author's original one.
    expect(after).toContain(`## Convention 299\n${detail(299)}`);
    expect(archives[0].indexOf("## Convention 0")).toBeLessThan(archives[0].indexOf("## Convention 9"));

    // The backup is a precondition, so it must exist before the rewrite it authorizes.
    const backups = await readdir(join(root, ".fusion", "backups", "memory"));
    expect(backups.length).toBe(1);

    expect(rows.map((row) => row.mutationType)).toEqual(["memory:long-term-over-budget", "memory:long-term-consolidated"]);
    expect(rows[0]).toMatchObject({
      target: "memory:project",
      metadata: {
        scope: "project",
        bytes: Buffer.byteLength(before, "utf8"),
        budgetBytes: 32_768,
        overByBytes: Buffer.byteLength(before, "utf8") - 32_768,
        entryCount: 303,
        duplicatesFound: true,
        conflictsFound: false,
        tooLarge: false,
        // The two routing booleans: duplicates exist but cannot fix a 42 KB file; retirement can.
        collapseCanConverge: false,
        retirementCanConverge: true,
      },
    });
    expect(rows[1]).toMatchObject({
      target: "memory:project",
      metadata: {
        scope: "project",
        entryCountBefore: 303,
        duplicateSectionsCollapsed: 3,
        conflictsRetained: 0,
        rolledUpSections: result.rolledUpSections,
        rolledUpBytes: result.rolledUpBytes,
        // Convergence is now the expected outcome, and the row is the durable proof of it.
        stillOverBudget: false,
      },
    });
    expect(Number(rows[1].metadata.entryCountAfter)).toBeLessThan(303);
  });

  it("keeps audit metadata free of memory content and paths", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(memoryPath, overBudgetMemory(300, 2));

    const rows: AuditRow[] = [];
    await new SelfHealingManager(fakeStore(rows), { rootDir: root } as never).reconcileLongTermMemoryBudget();

    const wire = JSON.stringify(rows);
    expect(wire).not.toContain("Durable detail");
    expect(wire).not.toContain("Convention");
    expect(wire).not.toContain(root);
    expect(wire).not.toContain("MEMORY.md");
    /*
     * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
     * The cold tier's FILENAME is a dated path, and the roll-up metadata grew two keys at the moment this
     * row started describing a move. The count is allowed; the address, the date, and the archive's own
     * generated preamble are not, because "memory metadata carries no path or content" is closed and the
     * roll-up is the newest temptation to break it.
     */
    expect(wire).not.toContain("ARCHIVE-");
    expect(Object.keys(rows[1]!.metadata).sort()).toEqual([
      "budgetBytes",
      "bytesAfter",
      "bytesBefore",
      "conflictsRetained",
      "duplicateSectionsCollapsed",
      "entryCountAfter",
      "entryCountBefore",
      "hotTargetBytes",
      "rolledUpBytes",
      "rolledUpSections",
      "scope",
      "stillOverBudget",
    ]);
  });

  it("leaves a within-budget file byte-identical and emits nothing", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const content = overBudgetMemory(6, 2);
    await writeFile(memoryPath, content);

    const rows: AuditRow[] = [];
    const result = await new SelfHealingManager(fakeStore(rows), { rootDir: root } as never).reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({ scanned: 1, withinBudget: 1, overBudget: 0, rewritten: 0, rolledUpSections: 0, failures: 0 });
    expect(await readFile(memoryPath, "utf8")).toBe(content);
    expect(rows).toEqual([]);
    expect(existsSync(join(root, ".fusion", "backups"))).toBe(false);
    // Convergence must not leak a cold tier next to a file that never breached.
    expect(await readArchiveBodies(root)).toEqual([]);
  });

  /*
   * FNXC:MemoryBudget 2026-11-20-10:24 (RUFU-665):
   * RUFU-279 could pin this test with an ordinary over-budget file because maintenance could not fix
   * one: the breach stayed standing and the cooldown had something to suppress. Now a first sweep
   * converges such a file and sweeps two and three report `withinBudget` with nothing to suppress at all.
   * The rate limit is still worth pinning, so the file gains an unshrinkable note -- one section bigger
   * than the whole budget, which no rule in this module may edit -- so a real, permanent breach remains
   * after the convergence and the signature cooldown is exercised on it.
   */
  it("reports a breach once per signature instead of once per sweep", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(memoryPath, overBudgetMemory(300, 3, 1));

    const rows: AuditRow[] = [];
    const manager = new SelfHealingManager(fakeStore(rows), { rootDir: root } as never);

    // A card that stays in the same condition must not re-announce itself every maintenance batch.
    const first = await manager.reconcileLongTermMemoryBudget();
    const second = await manager.reconcileLongTermMemoryBudget();
    const third = await manager.reconcileLongTermMemoryBudget();

    expect(first.findingsEmitted).toBe(1);
    expect(second.suppressedFindings + third.suppressedFindings).toBeGreaterThan(0);
    const findings = rows.filter((row) => row.mutationType === "memory:long-term-over-budget");
    // The convergence itself moves the size bucket exactly once, so at most one further row is a NEW
    // signature; every later pass over the same bytes is suppressed.
    expect(findings.length).toBeLessThanOrEqual(2);
    expect(third.rewritten).toBe(0);
    // And the breach is honestly still reported, not hidden: the unshrinkable note keeps the file over
    // the bound, so convergence has a ceiling this row still names.
    expect(Number(findings.at(-1)?.metadata.bytes)).toBeGreaterThan(32_768);
  });

  it("still maintains the file when the audit sink and settings are both hostile", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const before = overBudgetMemory(300, 4);
    await writeFile(memoryPath, before);

    const manager = new SelfHealingManager(fakeStore([], { hostile: true }), { rootDir: root } as never);
    const result = await manager.reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({ overBudget: 1, duplicateSectionsCollapsed: 4, rewritten: 1, failures: 0 });
    const after = await readFile(memoryPath, "utf8");
    expect(headingCount(after)).toBeLessThan(headingCount(before));
    expect(Buffer.byteLength(after, "utf8")).toBeLessThan(Buffer.byteLength(before, "utf8"));
    // Sink health cannot change the repair: every distinct note is still reachable, hot or cold.
    const archives = await readArchiveBodies(root);
    for (let i = 0; i < 300; i++) {
      const note = `## Convention ${i}\n${detail(i)}`;
      expect(after.includes(note) || archives.some((text) => text.includes(note))).toBe(true);
    }
    expect(await readdir(join(root, ".fusion", "backups", "memory"))).toHaveLength(1);
  });

  it("registers the sweep in startup recovery and maintenance batch 1", async () => {
    /*
     * Structural guard: the whole point of RUFU-279 is that maintenance runs on the default path. A
     * registration is invisible from behavior alone when the healthy case emits nothing, so the two
     * call sites are asserted as a code construct rather than inferred from a log line.
     */
    const source = await readFile(join(process.cwd(), "src", "self-healing.ts"), "utf8");
    expect(source.split('name: "reconcile-long-term-memory-budget"').length - 1).toBe(2);
  });
});
