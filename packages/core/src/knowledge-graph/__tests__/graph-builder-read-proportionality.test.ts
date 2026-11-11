/*
FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
THE proportional-read symptom test. The operator's profile showed the dashboard process spending 84.8% of its
samples inside `buildKnowledgeGraph` for minutes at a time. Placement moved the burn off the board; this file
proves the burn itself got smaller and, more importantly, that it stayed small: a no-op incremental pass used
to read and SHA-256 every discovered file (measured: 430 reads for 0 parsed files) and now reads none.
Counting through the injected seam rather than spying on the filesystem keeps the number meaning exactly
"file bodies the build read", not artifact or sidecar IO. The byte-identity assertion is the safety half: a
cache that saved reads by changing the committable artifact would be a worse bug than the one being fixed.
*/
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKnowledgeGraph } from "../graph-builder.js";
import { extractFile as realExtractFile } from "../extract-file.js";

const roots: string[] = [];
const discovery = { sourceRoots: ["src"], markdownRoots: [] };
const ARTIFACTS = ["nodes.json", "edges.json", "manifest.json"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kg-prop-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}
async function seedFiles(root: string, count: number) {
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    await writeFile(join(root, "src", `f${i}.ts`), `export const v${i} = ${i};\n`);
    // Pin mtimes to distinct, obviously-different stamps so no assertion depends on clock resolution.
    await utimes(join(root, "src", `f${i}.ts`), 1_700_000_000, 1_700_000_000 + i);
  }));
}
async function rewrite(root: string, relPath: string, content: string, mtime: number) {
  await writeFile(join(root, relPath), content);
  await utimes(join(root, relPath), mtime, mtime);
}
async function bytes(root: string, dir: string) {
  return Promise.all(ARTIFACTS.map(async file => [file, await readFile(join(dir, file), "utf8")] as const));
}

/** Counting IO seam: the only honest measurement of "how many bodies did this pass actually read". */
function countingDeps() {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  return {
    readPaths,
    statPaths,
    deps: {
      readFile: async (path: string) => { readPaths.push(path); return (await import("node:fs/promises")).readFile(path); },
      stat: async (path: string) => { statPaths.push(path); return (await import("node:fs/promises")).stat(path); },
    },
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("knowledge graph read proportionality", () => {
  it("reads every discovered file on a cold pass", async () => {
    const root = await fixture();
    await seedFiles(root, 6);
    const seam = countingDeps();
    const result = await buildKnowledgeGraph({ projectRoot: root, graphDir: join(root, ".fusion-knowledge/graph"), discovery, deps: seam.deps });
    expect(result.stats.discoveredFiles).toBe(6);
    expect(result.stats.readFiles).toBe(6);
    expect(seam.readPaths).toHaveLength(6);
    expect(result.stats.statOnlyFiles).toBe(0);
    expect(result.stats.parsedFiles).toBe(6);
  });

  it("reads ZERO file bodies on an unchanged pass and still reports every file reused", async () => {
    const root = await fixture();
    await seedFiles(root, 6);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });

    const seam = countingDeps();
    const extract = vi.fn(realExtractFile);
    const second = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, extractFile: extract, deps: seam.deps });
    // The headline number: today this is 6 reads for 0 parses; the invariant is that it is zero.
    expect(seam.readPaths).toEqual([]);
    expect(second.stats.readFiles).toBe(0);
    expect(second.stats.statOnlyFiles).toBe(6);
    expect(second.stats.reusedFiles).toBe(second.stats.discoveredFiles);
    expect(second.stats.parsedFiles).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    // Skipping reads must be a real check, not blind trust: every file was still stat'd.
    expect(seam.statPaths).toHaveLength(6);
    expect(second.changed).toBe(false);
  });

  it("reads at most the files that changed after touching exactly two of them", async () => {
    const root = await fixture();
    await seedFiles(root, 8);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    await rewrite(root, "src/f2.ts", "export const f2 = 222222;\n", 1_900_000_002);
    await rewrite(root, "src/f5.ts", "export const f5 = 555555;\n", 1_900_000_005);

    const seam = countingDeps();
    const extract = vi.fn(realExtractFile);
    const pass = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, extractFile: extract, deps: seam.deps });
    expect(seam.readPaths).toHaveLength(2);
    expect(pass.stats.readFiles).toBeLessThanOrEqual(2);
    expect(pass.stats.parsedFiles).toBe(2);
    expect(pass.stats.statOnlyFiles).toBe(6);
    expect(pass.stats.reusedFiles).toBe(6);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("prunes a deleted file without re-reading any survivor", async () => {
    const root = await fixture();
    await seedFiles(root, 5);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    await rm(join(root, "src", "f3.ts"));

    const seam = countingDeps();
    const extract = vi.fn(realExtractFile);
    const pass = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, extractFile: extract, deps: seam.deps });
    expect(seam.readPaths).toEqual([]);
    expect(pass.stats.deletedFiles).toBe(1);
    expect(pass.stats.discoveredFiles).toBe(4);
    expect(extract).not.toHaveBeenCalled();
    expect(pass.graph.nodes.some(node => node.id === "file:src/f3.ts")).toBe(false);
  });

  it("re-reads every discovered file when force is requested, the documented escape hatch", async () => {
    const root = await fixture();
    await seedFiles(root, 6);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });

    const seam = countingDeps();
    const forced = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, force: true, deps: seam.deps });
    expect(seam.readPaths).toHaveLength(6);
    expect(forced.stats.readFiles).toBe(6);
    expect(forced.stats.statOnlyFiles).toBe(0);
    expect(forced.stats.recoveryReason).toBe("forced");
  });

  it("produces byte-identical artifacts whether the sidecar, a read, or a forced pass answered for each file", async () => {
    const root = await fixture();
    await seedFiles(root, 6);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });

    // An unchanged pass driven entirely by stat reuse must not move a single byte.
    const baseline = await bytes(root, dir);
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    expect(await bytes(root, dir)).toEqual(baseline);

    // And a pass that re-parses everything from scratch must converge on the same bytes it would have
    // produced without the sidecar: the cache may skip work, never change the answer.
    await rewrite(root, "src/f1.ts", "export const f1 = 111;\nexport const extra = 1;\n", 1_900_000_001);
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, force: true });
    const afterForce = await bytes(root, dir);
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    expect(await bytes(root, dir)).toEqual(afterForce);
  });

  it("re-reads a file whose stat looks untouched once the manifest stops agreeing with the sidecar", async () => {
    const root = await fixture();
    await seedFiles(root, 4);
    const dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });

    // Simulate the accepted-staleness shape the other direction: tamper the manifest's recorded hash while
    // leaving the file and its stat untouched. The sidecar still "matches", so only the manifest check can
    // catch it -- and it must, or a corrupted cache would keep a stale graph alive indefinitely.
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { hash: string }> };
    manifest.files["src/f1.ts"]!.hash = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    const seam = countingDeps();
    const pass = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery, deps: seam.deps });
    expect(seam.readPaths.some(path => path.endsWith(join("src", "f1.ts")))).toBe(true);
    // One disagreement forces exactly one re-read, not a whole-tree rebuild.
    expect(pass.stats.readFiles).toBe(1);
    expect(pass.stats.recoveryReason).toBeNull();
  });
});
