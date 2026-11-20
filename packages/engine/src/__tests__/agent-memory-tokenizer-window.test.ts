/**
 * RUFU-1012 symptom tests: the agent-memory retrieval lane must decide relevance on WHOLE WORDS
 * of the operator's language and must never hand back two windows that share a line.
 *
 * Every case drives the production seam — `fn_memory_search` (`createMemorySearchTool`) — over a
 * temp-dir fixture with `memoryBackendType: "file"`, so both lanes run their real deterministic
 * file scorer and no `qmd` binary, subprocess, or network is touched.
 *
 * The pre-fix column is MEASURED, not hypothetical; it is why each assertion exists:
 * - `"pamätaj systémove pravidlo"` split on `/[^a-z0-9_-]+/i` -> ["pam","taj","syst","move","pravidlo"],
 *   and `normalized.includes("syst")` is true inside the English word "system".
 * - `"PG-gated test harness recipe"` -> ["pg-gated","test","harness","recipe"], and
 *   `includes("test")` is true inside "latest" — a two-letter fragment was worth a slot.
 * - The window walk ran `index += 8` on a 12-line window, so one result set contained
 *   `97-108` beside `105-116` (= 1+8*12, 1+8*13) in the field.
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySearchTool } from "../agent-tools.js";

const AGENT_ID = "agent-tokenizer-window";
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
  rootDir = mkdtempSync(join(tmpdir(), "rufu-1012-"));
  return rootDir;
}

function writeAgentMemory(content: string): string {
  const dir = join(rootDir, ".fusion", "agent-memory", AGENT_ID);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeProjectMemory(content: string): string {
  const dir = join(rootDir, ".fusion", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), content, "utf-8");
}

async function search(query: string, limit = 10): Promise<Hit[]> {
  const tool = createMemorySearchTool(rootDir, SETTINGS, { agentMemory: { agentId: AGENT_ID, agentName: "Tokenizer" } });
  const result = await tool.execute("call-1", { query, limit });
  const details = (result as { details?: { results?: Hit[] } }).details;
  return details?.results ?? [];
}

/** The invariant: no two returned windows over the SAME path may share a single line number. */
function sharedLinePairs(hits: Hit[]): string[] {
  const offenders: string[] = [];
  for (let a = 0; a < hits.length; a += 1) {
    for (let b = a + 1; b < hits.length; b += 1) {
      if (hits[a].path !== hits[b].path) continue;
      if (hits[a].lineStart <= hits[b].lineEnd && hits[b].lineStart <= hits[a].lineEnd) {
        offenders.push(`${hits[a].path}:${hits[a].lineStart}-${hits[a].lineEnd} <> ${hits[b].path}:${hits[b].lineStart}-${hits[b].lineEnd}`);
      }
    }
  }
  return offenders;
}

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("agent-memory lane: relevance is a whole word, not a substring", () => {
  it("a Slovak query cannot surface an English block that only shares an ASCII fragment", async () => {
    useTempRoot();
    // The reported shape: a "Hard Rules" block whose overlap with the query is the fragment
    // `syst` inside "system" (pre-fix terms: pam, taj, syst, move, pravidlo).
    writeAgentMemory([
      "# Agent Memory: Tokenizer",
      "",
      "## Hard Rules",
      "- never start test servers on port 4040; the system picks a free one",
      "- the checkout keeps its route handlers stable",
      "",
    ].join("\n"));

    const hits = await search("pamätaj systémove pravidlo");

    expect(hits.map((h) => `${h.path}:${h.lineStart}-${h.lineEnd}`)).toEqual([]);
  });

  it("the reported query does not surface a block whose only share is `test` inside `latest`", async () => {
    useTempRoot();
    // The two blocks are 12+ lines apart so they land in different windows under any geometry.
    writeAgentMemory([
      "# Agent Memory: Tokenizer",
      "",
      "## Hard Rules",
      "- never start servers on port 4040; the latest results are already recorded",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "- poznámka",
      "",
      "## Harness",
      "- a pg-gated test harness recipe lives in the gate itself",
      "",
    ].join("\n"));

    const hits = await search("PG-gated test harness recipe", 5);

    const surfaced = hits.map((h) => h.snippet);
    expect(surfaced.some((snippet) => snippet.includes("latest results"))).toBe(false);
    // the block that really carries the words is the top row, and it is the only row
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("pg-gated test harness recipe");
    expect(hits[0].lineStart).toBe(13);
    /*
    FNXC:MemoryRanking 2026-11-20-11:50 (RUFU-665):
    This line read `toBe(1004)` until RUFU-665 removed the flat `+ 1000` cross-scope offset. The score IS
    four distinct matched words, so the assertion now states the property that matters and stays true at
    any tie-break value the lane chooses: the word count carries the score, and the agent-scope bonus is
    a FRACTION — strictly under one more word match — rather than a two-hundred-fold lead over a block
    that matched five words.
    */
    expect(hits[0].score).toBeGreaterThan(4);
    expect(hits[0].score).toBeLessThan(5);
  });

  it("a Slovak word present as a whole word still matches (positive control)", async () => {
    useTempRoot();
    writeAgentMemory([
      "# Agent Memory: Tokenizer",
      "",
      "## Dlhodobé pamäte",
      "- zlučovanie dlhodobej pamäte prebieha po dokončení karty",
      "",
    ].join("\n"));

    const hits = await search("pamäte");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("zlučovanie dlhodobej pamäte");
  });

  it("an English query is unaffected: hyphenated compounds still match as single tokens", async () => {
    useTempRoot();
    writeAgentMemory([
      "# Agent Memory: Tokenizer",
      "",
      "## Gate",
      "- Post-merge verification gate landed for the project-wide refactor",
      "",
    ].join("\n"));

    const hits = await search("Post-merge verification gate");
    expect(hits).toHaveLength(1);
    /*
    FNXC:MemoryRanking 2026-11-20-11:50 (RUFU-665):
    The comment beside this assertion used to read "the cross-scope offset, which this card must not
    touch" — RUFU-665 is exactly the card that owns it, and the offset is no longer 1000. Three distinct
    term matches carry the score; the agent-scope bonus must stay below one further match.
    */
    expect(hits[0].score).toBeGreaterThan(3);
    expect(hits[0].score).toBeLessThan(4);
    expect(hits[0].snippet).toContain("project-wide");
  });

  it("a query word that is only an infix of a corpus word scores nothing", async () => {
    useTempRoot();
    writeAgentMemory([
      "# Agent Memory: Tokenizer",
      "",
      "## Notes",
      "- the retrieval pipeline is unbreakable and template-driven",
      "",
    ].join("\n"));

    expect(await search("retrieve unbreakable-template")).toEqual([]);
  });
});

describe("agent-memory lane: result windows do not overlap", () => {
  it("no two hits over one path share a line, and every window stays 12 lines wide", async () => {
    useTempRoot();
    const total = 44;
    const lines = ["# Agent Memory: Tokenizer", ""];
    for (let i = 1; i <= total - 2; i += 1) lines.push(`- krok ${i}: pozorovanie`);
    writeAgentMemory(lines.join("\n"));

    const hits = await search("krok", 10);
    expect(hits.length).toBeGreaterThan(1);
    expect(sharedLinePairs(hits)).toEqual([]);
    for (const hit of hits) {
      expect(hit.lineEnd - hit.lineStart + 1).toBeLessThanOrEqual(12);
      expect(hit.lineStart).toBeGreaterThan(0);
    }
    // the walk is a plain tiling of the file, so consecutive windows meet on a boundary
    const starts = hits.map((h) => h.lineStart);
    expect(starts).toEqual([1, 13, 25, 37]);
  });

  it("the final short window reports an honest end line, never a line that does not exist", async () => {
    useTempRoot();
    const lines = ["# Agent Memory: Tokenizer", ""];
    for (let i = 1; i <= 15; i += 1) lines.push(`- zaznam ${i}`);
    writeAgentMemory(lines.join("\n"));

    const hits = await search("zaznam", 10);
    const total = lines.length;
    expect(hits.length).toBeGreaterThan(1);
    for (const hit of hits) {
      expect(hit.lineEnd).toBeLessThanOrEqual(total);
    }
    expect(sharedLinePairs(hits)).toEqual([]);
  });

  it("the result count is bounded by the requested limit (anti-appeasement)", async () => {
    useTempRoot();
    const lines = ["# Agent Memory: Tokenizer", ""];
    for (let i = 1; i <= 60; i += 1) lines.push(`- bod ${i}`);
    writeAgentMemory(lines.join("\n"));

    expect((await search("bod", 3)).length).toBeLessThanOrEqual(3);
    expect((await search("bod", 20)).length).toBeLessThanOrEqual(6);
  });
});

/*
FNXC:MemoryWindowGeometry 2026-11-19-04:35 (RUFU-1012):
The `qmd` lane of the agent-memory search cannot be driven end-to-end under vitest: the repo
intentionally declines the external binary in tests (`shouldSkipBackgroundQmdRefresh()`), and
spawning a real one here would break the no-subprocess rule. So the wiring of the overlap guard is
pinned as a code construct on the function body rather than by behaviour — the guard's BEHAVIOUR is
covered by its own unit tests in @fusion/core. This asserts structure (which call the lane must
make), never a comment.
*/
describe("agent-memory qmd lane keeps the overlap guard wired", () => {
  function qmdLaneBody(): string {
    const source = readFileSync(new URL("../agent-tools.ts", import.meta.url), "utf-8");
    const start = source.indexOf("async function searchAgentMemoryWithQmd");
    const end = source.indexOf("\nasync function ", start + 10);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, end > start ? end : source.length);
  }

  it("routes the externally authored windows through the guard before the limit", () => {
    const body = qmdLaneBody();
    expect(body).toContain("dropLineOverlappingMemoryHits(");
    expect(body.indexOf("dropLineOverlappingMemoryHits(")).toBeLessThan(body.indexOf(".slice(0, limit)"));
    // the pre-fix shape — limit first, geometry never checked — must not come back
    expect(body).not.toContain("rawResults.slice(0, limit).map(");
  });
});

describe("both lanes agree on what a word is", () => {
  it("the project lane honours the same Unicode whole-word rule", async () => {
    useTempRoot();
    // pre-fix terms for "systémové pravidlo" were [syst, mov, pravidlo], and `syst` is a
    // substring of the English word "system", so this block scored and was returned.
    writeProjectMemory(["# Project Memory", "", "## Poznamky", "- the system route keeps files stable", ""].join("\n"));

    expect(await search("systémové pravidlo")).toEqual([]);
  });

  it("the project lane matches a whole Slovak word it contains", async () => {
    useTempRoot();
    writeProjectMemory(["# Project Memory", "", "## Pravidlá", "- operatívna časť file scope je dohodnutá", ""].join("\n"));

    const hits = await search("operatívna");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toContain(".fusion/memory/MEMORY.md");
  });

  it("one result set never repeats a line across project-memory windows", async () => {
    useTempRoot();
    const lines = ["# Project Memory", ""];
    for (let i = 1; i <= 40; i += 1) lines.push(`- udaj ${i}`);
    writeProjectMemory(lines.join("\n"));

    const hits = await search("udaj", 20);
    expect(hits.length).toBeGreaterThan(1);
    expect(sharedLinePairs(hits)).toEqual([]);
  });
});

/*
FNXC:MemoryEmptyReason 2026-11-19-05:15 (RUFU-1012):
"NONE" on its own reported one fact for three different states, so an agent could not tell an empty
store from a full store whose words the query shredded against — and it stopped searching. Each code
gets its own case, and each case also pins that the human-readable line still begins with the literal
NONE and that `details.results` stays an empty array.
*/
async function searchRaw(query: string, withAgentMemory = true) {
  const tool = createMemorySearchTool(
    rootDir,
    SETTINGS,
    withAgentMemory ? { agentMemory: { agentId: AGENT_ID, agentName: "Tokenizer" } } : undefined,
  );
  return await tool.execute("call-1", { query, limit: 5 });
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((part) => part.text ?? "").join("");
}

function detailsOf(result: unknown): { results: unknown[]; emptyReason?: string; termCount?: number } {
  return (result as { details: never }).details;
}

describe("an empty answer names which of the three states it is", () => {
  it("no-query-terms: a query with no usable word token", async () => {
    useTempRoot();
    writeProjectMemory("# Project Memory\n\n- plná pamäť s pravidlami\n");

    const result = await searchRaw("... !!!");
    const details = detailsOf(result);
    expect(details.results).toEqual([]);
    expect(details.emptyReason).toBe("no-query-terms");
    expect(details.termCount).toBe(0);
    expect(textOf(result).startsWith("NONE")).toBe(true);
    expect(textOf(result)).toContain("no-query-terms");
  });

  it("no-memory-content: nothing written yet, whatever the query asks for", async () => {
    useTempRoot();

    const result = await searchRaw("pamäte", false);
    const details = detailsOf(result);
    expect(details.results).toEqual([]);
    expect(details.emptyReason).toBe("no-memory-content");
    expect(details.termCount).toBe(1);
    expect(textOf(result).startsWith("NONE")).toBe(true);
  });

  it("no-token-match: a full store whose words the query simply does not share", async () => {
    useTempRoot();
    writeProjectMemory(["# Project Memory", "", "## Pravidlá", "- operatívna časť file scope je dohodnutá", ""].join("\n"));

    const result = await searchRaw("žirafa");
    const details = detailsOf(result);
    expect(details.results).toEqual([]);
    expect(details.emptyReason).toBe("no-token-match");
    expect(details.termCount).toBe(1);
    // the code must never contradict the prose line
    expect(textOf(result)).toContain("no-token-match");
  });

  it("a non-empty answer keeps its original details shape (no reason field invented)", async () => {
    useTempRoot();
    writeProjectMemory("# Project Memory\n\n- operatívna časť file scope\n");

    const details = detailsOf(await searchRaw("operatívna"));
    expect((details.results as Hit[]).length).toBeGreaterThan(0);
    expect(details.emptyReason).toBeUndefined();
  });
});
