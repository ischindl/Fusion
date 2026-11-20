import { describe, expect, it } from "vitest";
import {
  archiveMemoryPreamble,
  mergeSectionsIntoArchive,
  movedSectionsMissingFromArchive,
  planLongTermMemoryRollup,
} from "../long-term-consolidation.js";
import {
  MEMORY_LONG_TERM_BYTE_BUDGET,
  MEMORY_LONG_TERM_HOT_TARGET_BYTES,
  parseMemoryFile,
  renderMemoryFile,
} from "../memory-budget.js";

/**
 * RUFU-665: RUFU-279 could only collapse exact duplicates, so a long-term memory file whose sections
 * are all distinct had no legal path back under its budget — the maintenance pass could only report it
 * forever. These tests own the roll-up planner that closes that gap: whole oldest sections leave the hot
 * file unchanged, and nothing may be lost, reordered, shortened, or quietly un-counted.
 */

/** `count` distinct sections, each carrying enough prose to breach a small injected target. */
function uniqueSections(count: number, pad = 40): string {
  const lines = ["# Project Memory", ""];
  for (let i = 0; i < count; i += 1) {
    lines.push(`## Entry ${i}`, `Body ${i}: ${"a durable lesson the author wrote once ".repeat(pad)}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function bytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

describe("planLongTermMemoryRollup", () => {
  it("converges an all-unique over-budget file under the hot target", () => {
    const content = uniqueSections(40);
    expect(bytes(content)).toBeGreaterThan(MEMORY_LONG_TERM_HOT_TARGET_BYTES);

    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });

    expect(plan.changed).toBe(true);
    expect(plan.converged).toBe(true);
    expect(bytes(plan.content)).toBeLessThanOrEqual(MEMORY_LONG_TERM_HOT_TARGET_BYTES);
    expect(plan.rolledUpSections).toBeGreaterThan(0);
    expect(plan.rolledUpBytes).toBe(plan.bytesBefore - plan.bytesAfter);
    expect(plan.archivedContent).not.toBeNull();
  });

  it("converges at the code-owned budget too, not only at the hot target", () => {
    const content = uniqueSections(40);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_BYTE_BUDGET });
    expect(plan.converged).toBe(true);
    expect(bytes(plan.content)).toBeLessThanOrEqual(MEMORY_LONG_TERM_BYTE_BUDGET);
  });

  it("moves the oldest whole sections and leaves the newest content hot, in file order", () => {
    const content = uniqueSections(40);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    const moved = parseMemoryFile(plan.archivedContent!);
    const hot = parseMemoryFile(plan.content);

    // File order is preserved on both sides (the memory contract is append-only, so order IS age).
    const headings = (parsed: ReturnType<typeof parseMemoryFile>) => parsed.sections.map((s) => s.heading);
    expect(headings(moved)).toEqual([...headings(moved)].sort(byEntryNumber));
    expect(headings(hot)).toEqual([...headings(hot)].sort(byEntryNumber));
    // Cold holds the OLDEST, hot holds the NEWEST, and the newest author note is never moved.
    expect(Number(headings(moved)[0]!.replace("Entry ", ""))).toBe(0);
    expect(headings(hot)).toContain("Entry 39");
    // No overlap and no gap: every entry exists on exactly one side.
    const all = [...headings(moved), ...headings(hot)].sort(byEntryNumber);
    expect(all).toEqual(headings(parseMemoryFile(content)));
  });

  it("keeps every author byte verbatim across the two outputs", () => {
    const content = uniqueSections(40);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    const combined = plan.content + plan.archivedContent!;
    for (const section of parseMemoryFile(content).sections) {
      expect(combined).toContain(section.lines.join("\n"));
    }
  });

  it("preserves the preamble on the hot side and starts the archive with its own preamble", () => {
    const content = uniqueSections(30);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.content.startsWith("# Project Memory\n")).toBe(true);
    expect(plan.archivedContent).toBe(`${archiveMemoryPreamble()}${plan.archivedContent!.slice(archiveMemoryPreamble().length)}`);
    // The archive body carries no clock: the date lives in the filename, so re-planning is reproducible.
    expect(plan.archivedContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("is deterministic: the same bytes plan to the same bytes", () => {
    const content = uniqueSections(40);
    const first = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    const second = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(second.content).toBe(first.content);
    expect(second.archivedContent).toBe(first.archivedContent);
    expect(second.rolledUpSections).toBe(first.rolledUpSections);
    expect(second.rolledUpBytes).toBe(first.rolledUpBytes);
  });

  it("archives nothing when the content is already within the target", () => {
    const content = uniqueSections(2);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.changed).toBe(false);
    expect(plan.converged).toBe(true);
    expect(plan.content).toBe(content);
    expect(plan.archivedContent).toBeNull();
    expect(plan.rolledUpSections).toBe(0);
  });

  it("archives nothing when re-run on already-converged hot content", () => {
    const content = uniqueSections(40);
    const first = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    const second = planLongTermMemoryRollup({ content: first.content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(second.changed).toBe(false);
    expect(second.archivedContent).toBeNull();
    expect(second.rolledUpSections).toBe(0);
  });

  it("leaves a file with a single section untouched rather than emptying it", () => {
    const content = `# Project Memory\n\n## Only entry\n${"x".repeat(MEMORY_LONG_TERM_HOT_TARGET_BYTES * 2)}\n`;
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.changed).toBe(false);
    expect(plan.converged).toBe(false);
    expect(plan.content).toBe(content);
    expect(plan.archivedContent).toBeNull();
  });

  it("leaves a preamble-only file untouched and reports not-converged", () => {
    const content = `# Project Memory\n\n${"front matter with no section at all ".repeat(2000)}\n`;
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.changed).toBe(false);
    expect(plan.converged).toBe(false);
    expect(plan.sectionsBefore).toBe(0);
    expect(plan.archivedContent).toBeNull();
  });

  it("keeps at least the newest section when it alone exceeds the target, and says it did not converge", () => {
    const small = uniqueSections(6, 2);
    const oversized = `## Huge entry\n${"y".repeat(MEMORY_LONG_TERM_HOT_TARGET_BYTES * 2)}\n`;
    const content = `# Project Memory\n\n${small}\n${oversized}\n`;
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });

    expect(plan.changed).toBe(true);
    // Honest reporting: the file shrank, but the bound is still not met, so it is not "converged".
    expect(plan.converged).toBe(false);
    expect(parseMemoryFile(plan.content).sections).toHaveLength(1);
    expect(plan.content).toContain("## Huge entry");
    // The oversized section was never split: it is present byte-for-byte.
    expect(plan.content).toContain(oversized.trimEnd());
    // Nothing was moved into the archive on top of the entry that had to stay.
    expect(plan.rolledUpSections).toBe(6);
  });

  it("round-trips CRLF, a missing trailing newline, and a leading title", () => {
    const lf = uniqueSections(30);
    const crlf = lf.replace(/\n/g, "\r\n");
    const crlfPlan = planLongTermMemoryRollup({ content: crlf, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(crlfPlan.content).toContain("\r\n");
    expect(crlfPlan.content).not.toMatch(/(?<!\r)\n/);
    expect(crlfPlan.archivedContent).toContain("\r\n");

    const noFinalNewline = lf.replace(/\n$/, "");
    const plan = planLongTermMemoryRollup({ content: noFinalNewline, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.changed).toBe(true);
    expect(plan.content.startsWith("# Project Memory")).toBe(true);
    // The shape that must survive is the file's own: parse → keep-all → render is the identity, and the
    // rolled-up hot file reports the same trailing-newline state the source had.
    const sourceParts = parseMemoryFile(noFinalNewline);
    expect(renderMemoryFile(sourceParts, sourceParts.sections)).toBe(noFinalNewline);
    expect(parseMemoryFile(plan.content).trailingNewline).toBe(sourceParts.trailingNewline);
    expect(parseMemoryFile(plan.content).newline).toBe("\n");

    // And the same identity holds for a file that DOES end in a line break.
    const lfParts = parseMemoryFile(lf);
    expect(renderMemoryFile(lfParts, lfParts.sections)).toBe(lf);
  });

  it("counts sections and bytes against the real shapes rather than an estimate", () => {
    const content = uniqueSections(40);
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    expect(plan.bytesBefore).toBe(bytes(content));
    expect(plan.bytesAfter).toBe(bytes(plan.content));
    expect(plan.sectionsBefore).toBe(40);
    expect(plan.sectionsAfter + plan.rolledUpSections).toBe(40);
  });

  /*
   * FNXC:MemoryBudget 2026-11-20-13:40 (RUFU-665):
   * SCALE, measured not imagined. The instance that motivated this card is one agent's own `MEMORY.md` at
   * 3 257 515 bytes over 1 224 sections (9 941% of the budget, still under the 8 MiB maintenance ceiling,
   * so the inline clamp admitted 1,53% of it and the sweep was the only authority left). The benchmark
   * RUFU-279 pinned was 594 273 bytes over 306 entries — 5,5x smaller and 4x shallower — and a planner
   * that is linear at 306 sections is not thereby linear at 1 224. So the live shape is pinned here in
   * both axes, with one pass allowed to do the whole job, and loss-freedom checked as an exact set
   * comparison rather than 1 224 substring searches over 3 MB.
   */
  it("converges the measured live instance shape (1 224 sections / above 3 MB) in one pass, losslessly", () => {
    const lineCounts = 1_224;
    // Sized so the fixture is at least as large as the instance that was actually measured.
    const content = uniqueSections(lineCounts, 80);
    const bytesBefore = bytes(content);
    expect(bytesBefore).toBeGreaterThan(3_257_515);

    const startedAt = performance.now();
    const plan = planLongTermMemoryRollup({ content, targetBytes: MEMORY_LONG_TERM_HOT_TARGET_BYTES });
    const elapsedMs = performance.now() - startedAt;

    // One pass converges: no re-plan loop, and the hot file lands under the working-set target.
    expect(plan.archivedContent).toBeTruthy();
    expect(plan.converged).toBe(true);
    expect(plan.bytesAfter).toBeLessThanOrEqual(MEMORY_LONG_TERM_HOT_TARGET_BYTES);
    expect(plan.rolledUpSections).toBeGreaterThan(lineCounts - 40);
    expect(plan.sectionsAfter + plan.rolledUpSections).toBe(lineCounts);

    // Nothing lost, nothing duplicated: the author's lines are the same SET on both sides together.
    const before = new Set(content.split("\n").filter((line) => line.startsWith("Body ")));
    const after = new Set(
      `${plan.content}\n${plan.archivedContent}`.split("\n").filter((line) => line.startsWith("Body ")),
    );
    expect(before.size).toBe(lineCounts);
    expect([...after].sort()).toEqual([...before].sort());

    // The bound is a ratchet against an accidental quadratic, not a performance claim.
    expect(elapsedMs, `planning ${bytesBefore} bytes took ${Math.round(elapsedMs)}ms`).toBeLessThan(1_500);
  });
});

describe("mergeSectionsIntoArchive", () => {
  it("creates a cold file with the deterministic preamble when none exists", () => {
    const sections = parseMemoryFile(uniqueSections(3)).sections;
    const merged = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" });
    expect(merged.appended).toBe(3);
    expect(merged.skippedDuplicates).toBe(0);
    expect(merged.content.startsWith(archiveMemoryPreamble())).toBe(true);
    for (const section of sections) expect(merged.content).toContain(section.lines.join("\n"));
  });

  it("appends only what is not already archived, so a re-run after a partial failure cannot duplicate text", () => {
    const sections = parseMemoryFile(uniqueSections(4)).sections;
    const first = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections.slice(0, 2), newline: "\n" });
    const second = mergeSectionsIntoArchive({ existing: first.content, sectionsToAppend: sections, newline: "\n" });

    expect(second.appended).toBe(2);
    expect(second.skippedDuplicates).toBe(2);
    // The bytes already cold were not rewritten.
    expect(second.content.startsWith(first.content)).toBe(true);
    for (const section of sections) {
      const occurrences = second.content.split(section.lines.join("\n")).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("appends nothing and returns the existing bytes unchanged when every section is already cold", () => {
    const sections = parseMemoryFile(uniqueSections(2)).sections;
    const first = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" });
    const again = mergeSectionsIntoArchive({ existing: first.content, sectionsToAppend: sections, newline: "\n" });
    expect(again.appended).toBe(0);
    expect(again.skippedDuplicates).toBe(2);
    expect(again.content).toBe(first.content);
  });

  it("never returns an empty archive body for a non-empty append", () => {
    const sections = parseMemoryFile(uniqueSections(1)).sections;
    const merged = mergeSectionsIntoArchive({ existing: "", sectionsToAppend: sections, newline: "\n" });
    expect(merged.content.startsWith(archiveMemoryPreamble())).toBe(true);
  });

  /*
   * FNXC:MemoryBudget 2026-11-20-12:45 (RUFU-665):
   * The identity of an entry is its heading AND its body together, never the heading alone. Append-only
   * memory reuses headings constantly ("## Tick notes" recurs every tick with a different body), so a
   * heading-only key is a silent data-loss machine: the second body is dropped from the append, the hot
   * shrink still removes it, and the post-verify reports the heading as present — so the loss is invisible
   * AND every later sweep re-plans the same section, re-wedging the sweep that exists to converge.
   */
  it("keeps two sections that share a heading when their bodies differ", () => {
    const content = [
      "# Project Memory",
      "",
      "## Tick notes", `- first tick: the lockfile drifted in the plugin workspace ${"x".repeat(60)}`,
      "",
      "## Tick notes", `- second tick: the gate failed on the hash, not the lint ${"y".repeat(60)}`,
      "",
    ].join("\n");
    const sections = parseMemoryFile(content).sections;
    expect(sections).toHaveLength(2);

    const merged = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" });

    expect(merged.appended).toBe(2);
    expect(merged.skippedDuplicates).toBe(0);
    for (const section of sections) expect(merged.content).toContain(section.lines.join("\n"));
  });

  it("still treats a cosmetically restated same-heading entry as the one entry it is", () => {
    const body = "- the same lesson, re-appended verbatim";
    const sections = parseMemoryFile(`# Project Memory\n\n## Rule\n${body}\n\n## RULE  \n${body}\n`).sections;
    const merged = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" });

    // Dedupe on heading+body still collapses a case/whitespace restatement; that is the collapse this
    // module has always performed, and this pins that the stricter key did not widen it away.
    expect(merged.appended).toBe(1);
    expect(merged.skippedDuplicates).toBe(1);
  });
});

describe("movedSectionsMissingFromArchive", () => {
  /*
   * FNXC:MemoryBudget 2026-11-20-12:45 (RUFU-665):
   * This is the check that turns "the archive write returned" into "the moved bytes are on disk". It is
   * exported as a pure predicate so the refusal it controls is testable without staging a partial write
   * against a real filesystem.
   */
  it("answers nothing-missing for an archive that really carries every moved section", () => {
    const sections = parseMemoryFile(uniqueSections(3)).sections;
    const archive = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" }).content;
    expect(movedSectionsMissingFromArchive(archive, sections, "\n")).toEqual([]);
  });

  it("names a section that is absent, including when the file merely begins with it", () => {
    const sections = parseMemoryFile(uniqueSections(3)).sections;
    const truncated = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\n" }).content;
    const last = sections[sections.length - 1];
    const doctored = truncated.replace(last.lines.join("\n"), "");

    const missing = movedSectionsMissingFromArchive(doctored, sections, "\n");

    expect(missing.map((section) => section.heading)).toEqual([last.heading]);
  });

  it("checks against the file's own newline shape, so a CRLF section is not judged missing", () => {
    const crlf = uniqueSections(2).replace(/\n/g, "\r\n");
    const sections = parseMemoryFile(crlf).sections;
    const archive = mergeSectionsIntoArchive({ existing: null, sectionsToAppend: sections, newline: "\r\n" }).content;

    expect(movedSectionsMissingFromArchive(archive, sections, "\r\n")).toEqual([]);
    // The same sections judged against LF are absent: the newline is part of the text being proven.
    expect(movedSectionsMissingFromArchive(archive.replace(/\r\n/g, "\n"), sections, "\r\n").length).toBeGreaterThan(0);
  });
});

function byEntryNumber(a: string, b: string): number {
  return Number(a.replace("Entry ", "")) - Number(b.replace("Entry ", ""));
}
