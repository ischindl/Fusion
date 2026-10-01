import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAppendTool } from "../agent-tools.js";

/**
 * RUFU-279: `fn_memory_append` used to answer every write with the same number-free sentence, so a
 * long-term memory file could reach 594,273 bytes / 306 entries without a single author being told the
 * cost of their own write. The confirmation text is now the operator-visible budget surface.
 */

const tempDirs: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-append-budget-"));
  tempDirs.push(root);
  await mkdir(join(root, ".fusion"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function append(
  root: string,
  params: { scope?: "project" | "agent"; layer: "long-term" | "daily"; content: string },
  options?: { agentMemory?: { agentId: string; agentName?: string; memory?: string } },
): Promise<string> {
  const tool = createMemoryAppendTool(root, undefined, options);
  const result = await tool.execute("call-1", params as never);
  return (result.content[0] as { text: string }).text;
}

/** Padding that pushes a long-term file past the code-owned 32 KiB budget. */
function overBudgetMemory(): string {
  const lines = ["# Project Memory", ""];
  for (let i = 0; i < 400; i++) {
    lines.push(`## Entry ${i}`, `Note ${i}: ${"a durable convention that must survive ".repeat(4)}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("fn_memory_append long-term reporting", () => {
  it("reports the measured file against the code-owned budget", async () => {
    const root = await tempProject();

    const text = await append(root, { layer: "long-term", content: "## Rule\nkeep the merge gate thin" });

    expect(text).toMatch(/^Appended to long-term memory \(\d+ B appended; /);
    expect(text).toContain("of 32 KB budget");
    // The scaffold ships four `## ` sections, so one appended note reads as five entries.
    expect(text).toContain("5 entries");
    expect(text).not.toContain("Over budget");
    expect(text).not.toContain("maintenance");
  });

  it("counts appended UTF-8 bytes rather than characters", async () => {
    const root = await tempProject();
    const content = "## Ünïcödé\nünïcödé piň ✓ — multibyte copy";

    const text = await append(root, { layer: "long-term", content });

    // The append writes `\n${content.trim()}\n`, so the honest number is that string's byte length.
    const expected = Buffer.byteLength(`\n${content.trim()}\n`, "utf8");
    expect(expected).toBeGreaterThan(content.length);
    expect(text).toContain(`${expected} B appended`);
  });

  it("names the overshoot and both halves of the remedy once the file is over budget", async () => {
    const root = await tempProject();
    const memoryPath = join(root, ".fusion", "memory", "MEMORY.md");
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(memoryPath, overBudgetMemory());

    const text = await append(root, { layer: "long-term", content: "## One more rule\nstill appending" });

    expect(text).toContain("Over budget by");
    expect(text).toContain("of 32 KB budget");
    expect(text).toContain("401 entries");
    expect(text).toContain("back up the file and collapse exactly duplicated entries");
    expect(text).toContain("will not shorten or drop entries you wrote");
    // The append still succeeded: reporting a breach never refuses the write.
    expect(await readFile(memoryPath, "utf8")).toContain("## One more rule");
  });

  it("reports an agent-scope long-term write against the same budget", async () => {
    const root = await tempProject();
    const memoryPath = join(root, ".fusion", "agent-memory", "agent-t", "MEMORY.md");

    const text = await append(
      root,
      { scope: "agent", layer: "long-term", content: "## Pitfall\ncommit at step boundaries" },
      { agentMemory: { agentId: "agent-t", agentName: "Tester", memory: "" } },
    );

    expect(text).toMatch(/^Appended to agent long-term memory \(\d+ B appended; /);
    expect(text).toContain("of 32 KB budget");
    expect(await readFile(memoryPath, "utf8")).toContain("## Pitfall");
  });
});

describe("fn_memory_append daily reporting", () => {
  /*
   * FNXC:MemoryBudget 2026-09-29-23:56 (RUFU-279): the budget is a long-term policy, so the daily lane's
   * confirmation is byte-for-byte the sentence it has always been. A test that pins the untouched wording
   * is what keeps a later "consistency" pass from silently editorializing a message nobody asked about.
   */
  it("keeps the project daily sentence unchanged", async () => {
    const root = await tempProject();
    expect(await append(root, { layer: "daily", content: "## Loop\nfix the flake" })).toBe("Appended to daily memory.");
  });

  it("keeps the agent daily sentence unchanged", async () => {
    const root = await tempProject();
    const text = await append(
      root,
      { scope: "agent", layer: "daily", content: "## Loop\nfix the flake" },
      { agentMemory: { agentId: "agent-t", agentName: "Tester", memory: "" } },
    );
    expect(text).toBe("Appended to agent daily memory.");
  });
});
