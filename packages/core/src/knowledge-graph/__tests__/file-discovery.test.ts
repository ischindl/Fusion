import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  DEFAULT_MARKDOWN_ROOTS,
  DEFAULT_MAX_DISCOVERED_FILES,
  DEFAULT_SOURCE_ROOTS,
  discoverFiles,
  discoverFilesDetailed,
} from "../file-discovery.js";
import { buildKnowledgeGraph } from "../graph-builder.js";
import { loadArtifacts } from "../graph-store.js";

describe("knowledge graph file discovery", () => {
  it("covers every required repository source surface without generated paths", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    expect(DEFAULT_SOURCE_ROOTS).toContain("packages/dashboard/app");
    expect(DEFAULT_MARKDOWN_ROOTS).toEqual(expect.arrayContaining(["docs", "AGENTS.md", "CONCEPTS.md"]));
    const paths = await discoverFiles(root);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/^packages\/dashboard\/app\/.+\.(ts|tsx)$/),
      expect.stringMatching(/^packages\/core\/src\/.+\.ts$/),
      expect.stringMatching(/^packages\/engine\/src\/.+\.ts$/),
      expect.stringMatching(/^packages\/cli\/src\/.+\.ts$/),
      "scripts/check-fnxc-future-dates.mjs",
      "AGENTS.md",
      "CONCEPTS.md",
    ]));
    expect(paths.some(path => path.startsWith("docs/") && path.endsWith(".md"))).toBe(true);
    expect(paths.some(path => path.endsWith(".d.ts"))).toBe(false);
    for (const directory of DEFAULT_EXCLUDED_DIRECTORIES) expect(paths.some(path => path.split("/").includes(directory))).toBe(false);
  });

  /*
  FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
  The default ceiling exists to bound a pathological walk, so on THIS repository it must never bite: a cap
  that truncated the real tree would silently shrink the committable artifact and read as a normal build.
  */
  it("refuses nothing on the real repository at the default ceiling", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const result = await discoverFilesDetailed(root);
    expect(result.cappedFiles).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThan(DEFAULT_MAX_DISCOVERED_FILES);
  });
});

describe("knowledge graph discovery ceiling", () => {
  const roots: string[] = [];
  async function fixture(count: number) {
    const root = await mkdtemp(join(tmpdir(), "kg-cap-"));
    roots.push(root);
    await mkdir(join(root, "src", "nested"), { recursive: true });
    for (let i = 0; i < count; i++) {
      const rel = i % 2 === 0 ? join("src", `f${i}.ts`) : join("src", "nested", `g${i}.ts`);
      await writeFile(join(root, rel), `export const v${i} = ${i};\n`);
      await utimes(join(root, rel), 1_700_000_000, 1_700_000_000);
    }
    return root;
  }
  const discovery = { sourceRoots: ["src"], markdownRoots: [] };
  const afterEach_ = async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); };

  it("drops nothing and reports zero capped files while under the ceiling", async () => {
    const root = await fixture(6);
    try {
      const uncapped = await discoverFilesDetailed(root, discovery);
      const roomy = await discoverFilesDetailed(root, { ...discovery, maxFiles: 50 });
      expect(uncapped.cappedFiles).toBe(0);
      expect(uncapped.truncated).toBe(false);
      expect(roomy.files).toEqual(uncapped.files);
      expect(roomy.cappedFiles).toBe(0);
      expect(await discoverFiles(root, { ...discovery, maxFiles: Number.POSITIVE_INFINITY })).toEqual(uncapped.files);
    } finally { await afterEach_(); }
  });

  it("returns the documented sorted prefix and reports truncation over the ceiling", async () => {
    const root = await fixture(6);
    try {
      const first = await discoverFilesDetailed(root, { ...discovery, maxFiles: 2 });
      const again = await discoverFilesDetailed(root, { ...discovery, maxFiles: 2 });
      // Truncation order is the documented enumeration: sorted entries inside each walked root.
      expect(first.files).toEqual(["src/f0.ts", "src/f2.ts"]);
      // Same ceiling, same subset: a capped graph must be reproducible, not readdir-order dependent.
      expect(again.files).toEqual(first.files);
      expect(first.cappedFiles).toBeGreaterThan(0);
      expect(first.truncated).toBe(true);
      const zero = await discoverFilesDetailed(root, { ...discovery, maxFiles: 0 });
      expect(zero.files).toEqual([]);
      expect(zero.truncated).toBe(true);
    } finally { await afterEach_(); }
  });

  it("still yields a self-consistent artifact triple when the walk was capped", async () => {
    const root = await fixture(6);
    try {
      const dir = join(root, ".fusion-knowledge/graph");
      const built = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: { ...discovery, maxFiles: 2 } });
      expect(built.stats.cappedFiles).toBeGreaterThan(0);
      expect(built.stats.discoveredFiles).toBe(2);
      // A capped graph covers fewer files but must satisfy every structural invariant, or a capped build
      // would leave the next incremental pass reasoning over an artifact `loadArtifacts` refuses.
      await expect(loadArtifacts(dir)).resolves.toMatchObject({ ok: true });
      expect(built.graph.nodes.filter(node => node.kind === "file")).toHaveLength(2);
    } finally { await afterEach_(); }
  });
});
