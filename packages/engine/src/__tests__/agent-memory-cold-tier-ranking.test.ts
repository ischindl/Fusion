/**
 * RUFU-665: a retired memory section must still be retrievable by the agent that wrote it, and the
 * agent's own scope must stop winning every ranking by construction.
 *
 * Two claims are tested here, and they are the two halves of the same change:
 *
 * 1. RETRIEVAL. Budget maintenance moves an over-budget `MEMORY.md`'s oldest `## ` sections verbatim
 *    into `ARCHIVE-YYYY-MM-DD.md` in the same folder. If `fn_memory_search` / `fn_memory_get` cannot
 *    reach that file, the move is a deletion from the author's point of view and the byte budget was
 *    paid for with the note. The end-to-end case below runs the real maintenance pass and then asks the
 *    real tool the question the retired section answers.
 *
 * 2. RANKING. Every agent-memory hit used to carry `+ 1000` while both lanes score a window by its
 *    DISTINCT MATCHED QUERY WORDS, so an agent line matching one word scored 1001 and beat a project
 *    line matching five. The offset is now `AGENT_MEMORY_SCOPE_TIEBREAK`, strictly under one word: an
 *    exact tie still prefers the agent's own note (a stated preference), one extra matched word on the
 *    project side outranks it (relevance is what is being ranked).
 *
 * FNXC:MemoryBudget 2026-11-20-12:05 (RUFU-665).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySearchTool, createMemoryGetTool } from "../agent-tools.js";
import * as core from "@fusion/core";
import * as engineBudget from "../memory/memory-budget.js";
import { runLongTermMemoryMaintenance } from "../memory/long-term-consolidation.js";

const AGENT_ID = "agent-cold-tier-ranking";
const ARCHIVE_NAME = "ARCHIVE-2026-09-30.md";
const CLOCK_2026_09_30 = () => Date.UTC(2026, 8, 30);
const SETTINGS = { memoryBackendType: "file" } as const;

let rootDir = "";

interface Hit {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
}

function useTempRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), "rufu-665-tool-"));
  return rootDir;
}

function writeAgentMemory(content: string): string {
  const dir = join(rootDir, ".fusion", "agent-memory", AGENT_ID);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeAgentArchive(content: string): string {
  const dir = join(rootDir, ".fusion", "agent-memory", AGENT_ID);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ARCHIVE_NAME);
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeProjectMemory(content: string): string {
  const dir = join(rootDir, ".fusion", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), content, "utf-8");
}

function writeProjectArchive(content: string): string {
  const dir = join(rootDir, ".fusion", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ARCHIVE_NAME), content, "utf-8");
}

async function search(query: string, limit = 10): Promise<Hit[]> {
  const tool = createMemorySearchTool(rootDir, SETTINGS, {
    agentMemory: { agentId: AGENT_ID, agentName: "Cold Tier" },
  });
  const result = await tool.execute("call-1", { query, limit });
  return (result as { details?: { results?: Hit[] } }).details?.results ?? [];
}

async function get(path: string, startLine = 1, lineCount = 40): Promise<{ path: string; content: string }> {
  const tool = createMemoryGetTool(rootDir, SETTINGS, {
    agentMemory: { agentId: AGENT_ID, agentName: "Cold Tier" },
  });
  const result = await tool.execute("call-2", { path, startLine, lineCount });
  return (result as { details: { path: string; content: string } }).details;
}

async function listAgentMemoryDir(): Promise<string[]> {
  return (await readdir(join(rootDir, ".fusion", "agent-memory", AGENT_ID))).sort();
}

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("cold tier: the agent's own tools still reach a retired section", () => {
  it("fn_memory_search returns the retired section from the agent's ARCHIVE file", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Live note\n- nothing about lockfiles here\n");
    writeAgentArchive([
      "# Archived long-term memory",
      "",
      "## Lockfile drift in plugin workspaces",
      "- regenerate the lockfile inside the workspace, never by hand",
      "",
    ].join("\n"));

    const hits = await search("lockfile drift regenerate");

    const hit = hits.find((h) => h.path.endsWith(ARCHIVE_NAME));
    expect(hit, "a retired note the author can no longer search for is a deleted note").toBeDefined();
    expect(hit?.snippet).toContain("regenerate the lockfile inside the workspace");
    expect(hit?.backend).toBe("agent-memory");
  });

  it("fn_memory_get reads the agent's ARCHIVE file by the path search published", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Live note\n- hot\n");
    writeAgentArchive("# Archived long-term memory\n\n## Retained recipe\n- the exact line worth keeping\n");

    const read = await get(`.fusion/agent-memory/${AGENT_ID}/${ARCHIVE_NAME}`);

    expect(read.path).toBe(`.fusion/agent-memory/${AGENT_ID}/${ARCHIVE_NAME}`);
    expect(read.content).toContain("the exact line worth keeping");
  });

  it("fn_memory_get reads a project ARCHIVE file through the same tool", async () => {
    useTempRoot();
    writeProjectMemory("# Project Memory\n\n## Live\n- hot project note\n");
    writeProjectArchive("# Archived long-term memory\n\n## Retired convention\n- the project retires this section verbatim\n");

    const read = await get(`.fusion/memory/${ARCHIVE_NAME}`);

    expect(read.content).toContain("the project retires this section verbatim");
  });

  it("end to end: maintenance retires the oldest section, and the author still finds it", async () => {
    useTempRoot();
    // One hot section plus the oldest one, sized so the file breaches the budget and the roll-up has a
    // section to move. The retired heading is the only text answering the query below.
    const oldest = ["## Oldest recipe: pg-gated harness", `- ${"x".repeat(60)}`].join("\n");
    const filler = Array.from({ length: 12 }, (_, i) => `## Filler ${i}\n- ${"y".repeat(200)}`).join("\n");
    const path = writeAgentMemory(`# Agent Memory\n\n${oldest}\n\n${filler}\n`);

    const before = await readFile(path, "utf-8");
    expect(before).toContain("pg-gated harness");

    const maintenance = await runLongTermMemoryMaintenance({
      rootDir,
      budgetBytes: 2_000,
      audit: async () => {},
      now: CLOCK_2026_09_30,
      createBackup: async () => ({ scope: "all" }),
    });
    expect(maintenance.rolledUpSections).toBeGreaterThan(0);

    const after = await readFile(path, "utf-8");
    expect(after).not.toContain("pg-gated harness");
    expect(await listAgentMemoryDir()).toContain(ARCHIVE_NAME);

    // The claim this card exists for: the section left the injected file and stayed in the search lane.
    const hits = await search("pg-gated harness recipe");
    const hit = hits.find((h) => h.path.endsWith(ARCHIVE_NAME));
    expect(hit, "the retired section vanished from the author's reach — the roll-up deleted it").toBeDefined();
    expect(hit?.snippet).toContain("pg-gated harness");
  });
});

describe("cross-scope ranking: relevance decides, scope only breaks ties", () => {
  it("a project line matching more words outranks the agent's own line matching one", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Own note\n- a harness mention with nothing else here\n");
    writeProjectMemory([
      "# Project Memory",
      "",
      "## Harness contract",
      "- the harness is pg-gated, deterministic, and runs the gate suite only",
      "",
    ].join("\n"));

    const hits = await search("harness pg-gated deterministic suite");

    expect(hits.length).toBeGreaterThan(1);
    // Pre-fix this asserted nothing and hid the defect: the agent line carried `+ 1000` and sat first
    // while matching one of four words.
    expect(hits[0].path).toContain("/memory/MEMORY.md");
    expect(hits[0].backend).not.toBe("agent-memory");
  });

  it("an exact tie still prefers the agent's own note, which is the stated preference", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Own\n- worktrunk merge gate recipe\n");
    writeProjectMemory("# Project Memory\n\n## Project\n- worktrunk merge gate notes\n");

    const hits = await search("worktrunk merge gate");

    const agentHit = hits.find((h) => h.backend === "agent-memory");
    const projectHit = hits.find((h) => h.backend !== "agent-memory");
    expect(agentHit).toBeDefined();
    expect(projectHit).toBeDefined();
    // Same word count on both sides: the sub-one tie-break must decide it, and it must decide it for
    // the agent's own file without ever outweighing one more matched word.
    expect(agentHit!.score).toBeGreaterThan(projectHit!.score);
    expect(agentHit!.score - projectHit!.score).toBeLessThan(1);
  });

  it("no agent-memory hit carries the flat 1000-point scope offset any more", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Own\n- lockfile drift regenerate workspace recipe\n");

    const hits = await search("lockfile drift regenerate recipe");

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits.filter((h) => h.backend === "agent-memory")) {
      // The score is a distinct-word count plus a fraction; a value of 1000 or more can only be the
      // old offset, which made every agent line win regardless of what it said.
      expect(hit.score).toBeLessThan(100);
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("fn_memory_search still reaches a PROJECT archive through the tool merge", async () => {
    useTempRoot();
    writeProjectMemory("# Project Memory\n\n## Live\n- nothing about retention here\n");
    writeProjectArchive([
      "# Archived long-term memory",
      "",
      "## Retention decision: keep cold notes flat",
      "- the cold tier is a dated sibling file, never a subdirectory or a daily note",
      "",
    ].join("\n"));

    const hits = await search("retention cold tier dated sibling");

    const hit = hits.find((h) => h.path === `.fusion/memory/${ARCHIVE_NAME}`);
    expect(hit, "the project's retired sections must be as findable as the agent's").toBeDefined();
    expect(hit?.snippet).toContain("never a subdirectory or a daily note");
  });

  it("a store whose ONLY content is retired is reported as no-token-match, never as empty", async () => {
    useTempRoot();
    writeProjectArchive("# Archived long-term memory\n\n## Only note\n- the sole surviving convention\n");

    const tool = createMemorySearchTool(rootDir, SETTINGS, {
      agentMemory: { agentId: AGENT_ID, agentName: "Cold Tier" },
    });
    const miss = await tool.execute("call-3", { query: "unrelated fragment lookup" });
    const reason = (miss as { details?: { emptyReason?: string } }).details?.emptyReason;

    // `no-memory-content` would tell the author their memory is empty when maintenance only moved it.
    expect(reason).toBe("no-token-match");
  });

  it("the same query ranks identically on repeated calls (deterministic ordering)", async () => {
    useTempRoot();
    writeAgentMemory("# Agent Memory\n\n## Own\n- lockfile drift regenerate workspace recipe\n");
    writeProjectMemory("# Project Memory\n\n## Project\n- lockfile drift regenerate gate notes\n");

    const first = (await search("lockfile drift regenerate")).map((h) => `${h.path}:${h.lineStart}:${h.score}`);
    const second = (await search("lockfile drift regenerate")).map((h) => `${h.path}:${h.lineStart}:${h.score}`);

    expect(first.length).toBeGreaterThan(1);
    expect(second).toEqual(first);
  });

  it("the engine tool surface and core share ONE archive filename authority", () => {
    // Drift guard: the engine lane writes the file and core decides whether a reader may open it. Two
    // definitions of the name is the failure this card introduced, so the re-export must be identical.
    // Static imports only — a dynamic `import("@fusion/core")` is not statically analyzable.
    expect(engineBudget.archiveMemoryFileName).toBe(core.archiveMemoryFileName);
    expect(engineBudget.isArchiveMemoryFileName).toBe(core.isArchiveMemoryFileName);
    expect(engineBudget.ARCHIVE_MEMORY_FILENAME_PREFIX).toBe(core.MEMORY_ARCHIVE_FILENAME_PREFIX);
  });
});
