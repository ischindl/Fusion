/**
 * RUFU-1088 — the `fn_memory_search` surface proof.
 *
 * This is the fourth surface named by the card's Surface Enumeration, and the one an agent actually
 * reads: `createMemorySearchTool` renders whatever the Stash lane delivers. The three core-side
 * surfaces (the lane itself, the per-turn recall cue, the proactive cue block) are proven in
 * `packages/core/src/memory/__tests__/stash-result-hygiene.test.ts`.
 *
 * The producer and the renderer are driven in ONE process: `resolveMemoryBackend` is spied to return a
 * REAL `StashMemoryBackend` whose HTTP seam is a recorder answering with the measured page, so
 * `searchProjectMemory` → hygiene → scoring → this renderer all run unmocked. A test that mocked
 * `searchProjectMemory` instead could only ever prove the renderer's reading of a shape the producer
 * might not produce — and producer/reader disagreement is the defect this card removes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Static namespace import so Vite resolves core's memory-backend module to the SAME instance the
// @fusion/core barrel loads internally — spying `resolveMemoryBackend` here honors the live binding
// `project-memory.ts` uses (the pattern `memory-focus-recalling.test.ts` established).
import * as coreMemoryBackend from "../../../core/src/memory/memory-backend.js";
import { StashMemoryBackend, stashPageOrderNote, stashProjectIdentityFor } from "@fusion/core";
import type { StashHttpClient } from "../../../core/src/memory/memory-backend-stash.js";
import { createMemorySearchTool } from "../agent-tools.js";

/** The constant the deployed image sends, from the reported page. */
const CONSTANT_SCORE = 0.18558138608932495;

type Row = {
  id: string;
  content: string;
  session_id: string;
  event_type: string;
  score?: number;
  rank?: number;
  metadata: Record<string, unknown>;
};

function ownRow(discriminator: string, session: string, content: string, extra: Partial<Row> = {}): Row {
  return {
    id: extra.id ?? `${session}-${content.slice(0, 6)}`,
    content,
    session_id: session,
    event_type: extra.event_type ?? "memory",
    ...(extra.score !== undefined ? { score: extra.score } : {}),
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
    metadata: { discriminator },
  };
}

function bashRow(discriminator: string, session: string, index: number): Row {
  return ownRow(discriminator, session, "bash", {
    id: `${session}-${index}`,
    event_type: "tool_use",
    score: CONSTANT_SCORE,
  });
}

/** The measured page: nine `bash` slots from one session, their one sibling, two real notes. */
function measuredPage(discriminator: string): Row[] {
  return [
    ...Array.from({ length: 9 }, (_, i) => bashRow(discriminator, "fusion-task-SANE-367", i)),
    bashRow(discriminator, "fusion-task-RUFU-180", 0),
    ownRow(discriminator, "ses-beta", "blanking pouziva ten isty predikatel", { score: CONSTANT_SCORE }),
    ownRow(discriminator, "ses-alpha", "predikatel sa resetuje pred blanking oknom", { score: CONSTANT_SCORE }),
  ];
}

let root: string | null = null;
const requests: string[] = [];

/** Runs the REAL tool over a REAL Stash backend whose transport answers with `rowsFor(root)`. */
async function runTool(rowsFor: (discriminator: string) => Row[], query: string, limit = 5) {
  root = mkdtempSync(join(tmpdir(), "rufu1088-engine-"));
  const discriminator = stashProjectIdentityFor(root).discriminator;
  const rows = rowsFor(discriminator);
  const http: StashHttpClient = async (path) => {
    requests.push(path);
    const limitParam = Number(new URL(`http://x${path}`).searchParams.get("limit") ?? "50");
    return { results: rows.slice(0, limitParam) };
  };
  const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", apiKey: "k", httpClient: http });
  const spy = vi.spyOn(coreMemoryBackend, "resolveMemoryBackend").mockReturnValue(backend);
  const tool = createMemorySearchTool(root, {
    memoryEnabled: true,
    memoryBackendType: "stash",
  } as never);
  const result = (await tool.execute("call-1", { query, limit }, undefined, undefined, undefined)) as {
    content: Array<{ type: string; text?: string }>;
    details: { results: Array<Record<string, unknown>>; emptyReason?: string };
  };
  return {
    text: result.content[0]?.text ?? "",
    results: result.details.results ?? [],
    requests,
    discriminator,
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  requests.length = 0;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("RUFU-1088 fn_memory_search delivers a usable page", () => {
  it("renders neither the `bash` rows nor a session's nine slots", async () => {
    const run = await runTool(measuredPage, "blanking predikatel");
    const text = run.text;
    try {
      expect(text).not.toBe("");
      expect(text).not.toContain("bash");
      // One row per session: the page is a survey of sessions, not one session's monologue.
      const renderedSessions = [...text.matchAll(/stash:\/\/session\/([^\s:]+)/g)].map((m) => m[1]);
      expect(renderedSessions.length).toBeGreaterThan(0);
      expect(new Set(renderedSessions).size).toBe(renderedSessions.length);
      expect(text).toContain("blanking pouziva ten isty predikatel");
    } finally {
      run.restore();
    }
  });

  it("prints no `(score N)` on a constant-score page and says where the order came from", async () => {
    const run = await runTool(measuredPage, "blanking predikatel");
    try {
      // The measured page would have printed `(score 0.18558138608932495, stash)` ten times.
      expect(run.text).not.toContain(`(score ${CONSTANT_SCORE}`);
      expect(run.text).not.toContain("(score ");
      const note = stashPageOrderNote(
        run.results as unknown as Parameters<typeof stashPageOrderNote>[0],
      );
      expect(note).not.toBe("");
      expect(run.text.startsWith(note.trimEnd().split("\n")[0]!)).toBe(true);
      expect(run.results.every((r) => r.rankingSource === "positional")).toBe(true);
    } finally {
      run.restore();
    }
  });

  it("keeps the server's order on a positional page instead of re-sorting it alphabetically", async () => {
    // The store answers `ses-beta` before `ses-alpha`. An alphabetical tie-break would print alpha
    // first and then the honesty note would be describing an order this tool invented.
    const run = await runTool(
      (disc) => [
        ownRow(disc, "ses-beta", "beta note about blanking", { score: CONSTANT_SCORE }),
        ownRow(disc, "ses-alpha", "alpha note about blanking", { score: CONSTANT_SCORE }),
      ],
      "blanking",
    );
    try {
      const betaAt = run.text.indexOf("ses-beta");
      const alphaAt = run.text.indexOf("ses-alpha");
      expect(betaAt).toBeGreaterThanOrEqual(0);
      expect(alphaAt).toBeGreaterThanOrEqual(0);
      expect(betaAt).toBeLessThan(alphaAt);
    } finally {
      run.restore();
    }
  });

  it("keeps printing real scores, and no ordering note, on a page that HAS a relevance signal", async () => {
    const run = await runTool(
      (disc) => [
        ownRow(disc, "ses-one", "first ranked note", { score: 0.9 }),
        ownRow(disc, "ses-two", "second ranked note", { score: 0.4 }),
      ],
      "ranked note",
    );
    try {
      expect(run.text).toContain("(score 0.9, stash)");
      expect(run.text).not.toContain("Order below");
      expect(run.results.every((r) => r.rankingSource === undefined)).toBe(true);
    } finally {
      run.restore();
    }
  });

  it("re-scores a constant-score page from the rank tier when the server sent distinct ranks", async () => {
    const run = await runTool(
      (disc) => [
        ownRow(disc, "ses-a", "ranked first note", { score: CONSTANT_SCORE, rank: 0.2 }),
        ownRow(disc, "ses-b", "ranked second note", { score: CONSTANT_SCORE, rank: 0.1 }),
      ],
      "ranked note",
    );
    try {
      expect(run.results.map((r) => r.score)).toEqual([1, 0.5]);
      expect(run.results.every((r) => r.rankingSource === "server-rank-fallback")).toBe(true);
      expect(run.text).not.toContain("(score ");
      expect(run.text).toContain("rank values");
    } finally {
      run.restore();
    }
  });
});
