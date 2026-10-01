import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemoryBackupCommand, type ProjectSettings } from "@fusion/core";
import { buildMemoryHeadingIndex } from "../../agents/agent-memory-index.js";
import {
  MEMORY_LONG_TERM_BYTE_BUDGET,
  countMemoryEntries,
  formatLongTermMemoryAppendReport,
  formatMemoryBudgetStatus,
  formatMemorySize,
  measureLongTermMemory,
  parseMemoryFile,
  renderMemoryFile,
} from "../memory-budget.js";

/**
 * RUFU-279 pinned the long-term memory budget because a production project `MEMORY.md` had reached
 * 594,273 bytes / 306 entries while nothing reported it. These tests own the two properties the fix
 * depends on: the entry count must be the count a reader actually sees, and the size must be the size
 * the backup receipt prints.
 */

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-memory-budget-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseMemoryFile / countMemoryEntries", () => {
  /*
   * FNXC:MemoryBudget 2026-09-29-23:56 (RUFU-279): the reported entry count is only honest if it is the
   * same count the memory index renders into agent context. `parseHeadings` in agent-memory-index.ts is
   * module-private, so parity is pinned against that module's public renderer instead of a second copy
   * of the rule. A drift between the two would print a number no reader can reproduce.
   */
  const CONTENT = [
    "# Project Memory",
    "",
    "## Alpha rule",
    "body a",
    "   ## Indented heading  ",
    "body b",
    "## ",
    "orphan line under an empty heading marker",
    "### Not a section",
    "##NoSpaceHeading",
    "body c",
    "## Delta rule",
    "body d",
  ].join("\n");

  it("counts exactly the headings the memory index renders", () => {
    const index = buildMemoryHeadingIndex({
      sectionHeader: "## Memory index",
      displayPath: ".fusion/memory/MEMORY.md",
      content: CONTENT,
      maxBytes: 100_000,
    });
    const renderedHeadings = index.split("\n").filter((line) => line.startsWith('  - "')).length;

    expect(renderedHeadings).toBeGreaterThan(0);
    expect(countMemoryEntries(CONTENT)).toBe(renderedHeadings);
  });

  it("treats an empty or unspaced heading marker as content, not a section", () => {
    const parts = parseMemoryFile(CONTENT);
    expect(parts.sections.map((section) => section.heading)).toEqual([
      "Alpha rule",
      "Indented heading",
      "Delta rule",
    ]);
  });

  it("keeps the preamble and re-renders an untouched file byte-for-byte", () => {
    expect(renderMemoryFile(parseMemoryFile(CONTENT), parseMemoryFile(CONTENT).sections)).toBe(CONTENT);
  });

  it("keeps the final line break on round-trip", () => {
    const withTrailing = "# Title\n\n## A\nalpha\n";
    expect(renderMemoryFile(parseMemoryFile(withTrailing), parseMemoryFile(withTrailing).sections)).toBe(withTrailing);
  });

  it("preserves CRLF line endings on round-trip", () => {
    const crlf = "# Title\r\n## A\r\nbody\r\n## B\r\nbody2\r\n";
    const parts = parseMemoryFile(crlf);
    expect(parts.newline).toBe("\r\n");
    expect(renderMemoryFile(parts, parts.sections)).toBe(crlf);
  });
});

describe("measureLongTermMemory", () => {
  it("measures UTF-8 bytes rather than characters or lines", () => {
    // Multibyte content is the case a `.length` shortcut gets wrong: the file costs bytes on disk and
    // in context, so the report must not understate it.
    const body = "— ünïcödé piň ✓ ".repeat(400);
    const content = `# Title\n\n## Note\n${body}\n`;
    const report = measureLongTermMemory({ content, scope: "project" });

    expect(report.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(report.bytes).toBeGreaterThan(content.length);
    expect(report.entryCount).toBe(1);
    expect(report.overBudget).toBe(false);
    expect(report.overByBytes).toBe(0);
    expect(report.budgetBytes).toBe(MEMORY_LONG_TERM_BYTE_BUDGET);
  });

  it("reports the breach as a positive overshoot and a rounded percentage", () => {
    const content = `# Title\n\n## Note\n${"x".repeat(40_000)}\n`;
    const report = measureLongTermMemory({ content, scope: "agent", agentId: "agent-xyz" });

    expect(report.overBudget).toBe(true);
    expect(report.overByBytes).toBe(report.bytes - MEMORY_LONG_TERM_BYTE_BUDGET);
    expect(report.budgetPercent).toBe(Math.round((report.bytes / MEMORY_LONG_TERM_BYTE_BUDGET) * 100));
    expect(report.agentId).toBe("agent-xyz");
  });

  it("never claims a breach at exactly the budget", () => {
    const budget = 1024;
    const content = "x".repeat(budget);
    const report = measureLongTermMemory({ content, scope: "project", budgetBytes: budget });
    expect(report.bytes).toBe(budget);
    expect(report.overBudget).toBe(false);
  });
});

describe("formatMemorySize", () => {
  /*
   * FNXC:MemoryBudget 2026-09-29-23:56 (RUFU-279): core's `MemoryBackupManager.formatBytes` is private,
   * so the parity that matters — "the size in the breach report is the size printed on the backup that
   * covers it" — is pinned by running the real backup command and comparing its receipt string. A unit
   * test against a copied formula would keep passing after core changed its formatter.
   */
  it("agrees with the byte formatter on a memory backup receipt", async () => {
    const root = await makeTempProject();
    const projectBytes = Buffer.from("# Project Memory\n\n## A\nalpha\n").byteLength;
    const agentBytes = Buffer.from("# Agent Memory\n\n## B\nbeta\n").byteLength;
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await mkdir(join(root, ".fusion", "agent-memory", "agent-parity"), { recursive: true });
    await writeFile(join(root, ".fusion", "memory", "MEMORY.md"), "# Project Memory\n\n## A\nalpha\n");
    await writeFile(join(root, ".fusion", "agent-memory", "agent-parity", "MEMORY.md"), "# Agent Memory\n\n## B\nbeta\n");

    const result = await runMemoryBackupCommand(join(root, ".fusion"), { memoryBackupScope: "all" } as ProjectSettings);
    expect(result.success).toBe(true);
    // The receipt archives both memory trees, so its size is exactly their combined bytes.
    expect(result.output).toContain(`(${formatMemorySize(projectBytes + agentBytes)})`);
  });

  it("renders binary units with trailing zeros dropped", () => {
    expect(formatMemorySize(0)).toBe("0 B");
    expect(formatMemorySize(512)).toBe("512 B");
    expect(formatMemorySize(32_768)).toBe("32 KB");
    expect(formatMemorySize(594_273)).toBe("580.34 KB");
    expect(formatMemorySize(2 * 1024 * 1024)).toBe("2 MB");
  });
});

describe("budget report wording", () => {
  // A realistic 306-entry file: each note carries enough prose to push the file past the 32 KiB bound.
  const report = measureLongTermMemory({
    content: `# Title\n\n${Array.from(
      { length: 306 },
      (_, i) => `## Entry ${i}\nDurable note ${i}: ${"the pipeline must stay deterministic ".repeat(3)}`,
    ).join("\n")}`,
    scope: "project",
  });

  it("renders the measured breach compactly", () => {
    expect(report.overBudget).toBe(true);
    const status = formatMemoryBudgetStatus(report);
    expect(report.bytes).toBeGreaterThan(MEMORY_LONG_TERM_BYTE_BUDGET);
    expect(status).toMatch(/^[\d.]+ [KM]B of 32 KB budget \(\d+%, 306 entries\)$/);
  });

  it("stays factual and promises no maintenance while under budget", () => {
    const text = formatLongTermMemoryAppendReport({
      scopeLabel: "long-term",
      appendedBytes: 128,
      report: measureLongTermMemory({ content: "# T\n\n## A\nalpha\n", scope: "project" }),
    });
    expect(text).toMatch(/^Appended to long-term memory \(128 B appended; /);
    expect(text).not.toContain("maintenance");
    expect(text).not.toContain("Over budget");
  });

  it("names both halves of the remedy once over budget", () => {
    const text = formatLongTermMemoryAppendReport({ scopeLabel: "agent long-term", appendedBytes: 256, report });
    expect(text).toContain("Appended to agent long-term memory");
    expect(text).toContain("Over budget by");
    expect(text).toContain("back up the file and collapse exactly duplicated entries");
    // The sentence an author must not misread: maintenance will never shorten their prose.
    expect(text).toContain("will not shorten or drop entries you wrote");
  });
});
