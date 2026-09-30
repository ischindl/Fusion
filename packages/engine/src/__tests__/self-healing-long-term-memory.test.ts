import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";

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

/**
 * A file shaped like the measured production one: hundreds of distinct notes (so it stays over budget
 * after the duplicates are collapsed) plus a few exact duplicate sections.
 */
function overBudgetMemory(uniqueCount: number, duplicateCount: number): string {
  const lines = ["# Project Memory", ""];
  for (let i = 0; i < uniqueCount; i++) {
    lines.push(`## Convention ${i}`, `Durable detail ${i}: ${"the maintenance pass must never rewrite this prose ".repeat(2)}`, "");
  }
  for (let d = 0; d < duplicateCount; d++) {
    lines.push(`## Convention ${d}`, `Durable detail ${d}: ${"the maintenance pass must never rewrite this prose ".repeat(2)}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function headingCount(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("## ")).length;
}

describe("self-healing long-term memory budget sweep", () => {
  it("backs up an over-budget project file, collapses only exact duplicates, and reports both", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const before = overBudgetMemory(300, 3);
    await writeFile(memoryPath, before);

    const rows: AuditRow[] = [];
    const manager = new SelfHealingManager(fakeStore(rows), { rootDir: root } as never);
    const result = await manager.reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({ scanned: 1, overBudget: 1, duplicateSectionsCollapsed: 3, conflictsRetained: 0, rewritten: 1, failures: 0 });

    const after = await readFile(memoryPath, "utf8");
    expect(headingCount(before)).toBe(303);
    expect(headingCount(after)).toBe(300);
    // Loss-free: every distinct note survives byte-for-byte; only the repeats disappeared.
    for (let i = 0; i < 300; i++) {
      expect(after).toContain(`## Convention ${i}\nDurable detail ${i}: the maintenance pass must never rewrite this prose the maintenance pass must never rewrite this prose`);
    }
    expect(after.indexOf("## Convention 0")).toBe(after.lastIndexOf("## Convention 0"));

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
      },
    });
    expect(rows[1]).toMatchObject({
      target: "memory:project",
      metadata: {
        scope: "project",
        entryCountBefore: 303,
        entryCountAfter: 300,
        duplicateSectionsCollapsed: 3,
        conflictsRetained: 0,
        // Collapsing three notes out of a 41 KB file cannot fix the size; the row says so instead of
        // implying the breach is resolved.
        stillOverBudget: true,
      },
    });
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
  });

  it("leaves a within-budget file byte-identical and emits nothing", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const content = overBudgetMemory(6, 2);
    await writeFile(memoryPath, content);

    const rows: AuditRow[] = [];
    const result = await new SelfHealingManager(fakeStore(rows), { rootDir: root } as never).reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({ scanned: 1, withinBudget: 1, overBudget: 0, rewritten: 0, failures: 0 });
    expect(await readFile(memoryPath, "utf8")).toBe(content);
    expect(rows).toEqual([]);
    expect(existsSync(join(root, ".fusion", "backups"))).toBe(false);
  });

  it("reports a breach once per signature instead of once per sweep", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(memoryPath, overBudgetMemory(300, 3));

    const rows: AuditRow[] = [];
    const manager = new SelfHealingManager(fakeStore(rows), { rootDir: root } as never);

    // A card that stays in the same condition must not re-announce itself every maintenance batch.
    const first = await manager.reconcileLongTermMemoryBudget();
    const second = await manager.reconcileLongTermMemoryBudget();
    const third = await manager.reconcileLongTermMemoryBudget();

    expect(first.findingsEmitted).toBe(1);
    expect(second.suppressedFindings + third.suppressedFindings).toBeGreaterThan(0);
    const findings = rows.filter((row) => row.mutationType === "memory:long-term-over-budget");
    expect(findings.length).toBeLessThanOrEqual(2);
    expect(third.rewritten).toBe(0);
  });

  it("still maintains the file when the audit sink and settings are both hostile", async () => {
    const root = await tempRoot();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(memoryPath, overBudgetMemory(300, 4));

    const manager = new SelfHealingManager(fakeStore([], { hostile: true }), { rootDir: root } as never);
    const result = await manager.reconcileLongTermMemoryBudget();

    expect(result).toMatchObject({ overBudget: 1, duplicateSectionsCollapsed: 4, rewritten: 1, failures: 0 });
    expect(headingCount(await readFile(memoryPath, "utf8"))).toBe(300);
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
