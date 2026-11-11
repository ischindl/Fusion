/*
FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
A code-construct guard, permitted under the repo rule because it asserts structure rather than prose: these
five expressions are scans over the WHOLE retained node/edge array performed once PER CHANGED FILE, which on
this repository (roughly 43 MB of `edges.json`, hundreds of legitimately-changed files after an upstream
merge) is quadratic-in-practice and was a measured share of the 84.8% profile. Re-adding any of them puts the
starvation back while every behavioral test still passes, so the shape has to be pinned structurally and the
behavior it replaced is pinned in `graph-builder-incremental.test.ts`.
*/
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = await readFile(fileURLToPath(new URL("../graph-builder.ts", import.meta.url)), "utf8");
/** Strip block and line comments so the guard reads code, never the FNXC prose that explains the deletion. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("graph builder complexity guard", () => {
  it.each([
    ["per-file node rescan", "graph.nodes.filter("],
    ["per-file edge rescan", "graph.edges.filter("],
    ["per-reference edge dedupe scan", "graph.edges.some("],
    ["per-file owner scan", "graph.nodes.some(node => node.ownerPath ==="],
    ["linear deletion lookup", "files.includes("],
  ])("contains no %s construct: %s", (_name, forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("keeps the set-based replacements it swapped them for", () => {
    // The guard is only meaningful if the linear replacements are actually present, not merely absent.
    expect(code).toContain("discoveredSet.has(");
    expect(code).toContain("knownEdgeIds.has(");
    expect(code).toContain("touched.has(");
  });
});
