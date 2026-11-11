import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKnowledgeGraph } from "../graph-builder.js";
import { addInferredEdges } from "../inferred-edge-writer.js";
import { loadArtifacts } from "../graph-store.js";
import { extractFile as realExtractFile } from "../extract-file.js";
import { extractTypeScript as realTypeScript } from "../extract-typescript.js";
const roots:string[]=[];
const discovery = { sourceRoots: ["src"], markdownRoots: [] };
async function fixture(){ const root=await mkdtemp(join(tmpdir(), "kg-fixture-")); roots.push(root); await mkdir(join(root,"src")); await writeFile(join(root,"src","a.ts"),"import { b } from './b'; export const a = b;"); await writeFile(join(root,"src","b.ts"),"export const b = 1;"); return root; }
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
describe("incremental graph builder", () => {
  it("writes deterministic artifacts and only reparses changed files", async () => {
    const root=await fixture(), dir=join(root,".fusion-knowledge/graph");
    await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    const before=await Promise.all(["nodes.json","edges.json","manifest.json"].map(file=>readFile(join(dir,file),"utf8")));
    const typeScript=vi.fn(realTypeScript), extract=vi.fn(realExtractFile);
    const noChange=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,deps:{typescript:typeScript},discovery});
    expect(noChange.changed).toBe(false); expect(noChange.stats).toMatchObject({ recoveryReason: null, reusedFiles: 2 }); expect(extract).not.toHaveBeenCalled();
    await writeFile(join(root,"src","b.ts"),"export const b = 2;");
    const changed=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,deps:{typescript:typeScript},discovery});
    expect(changed.stats).toMatchObject({parsedFiles:1,reusedFiles:1}); expect(extract).toHaveBeenCalledTimes(1); expect(typeScript).toHaveBeenCalledTimes(1);
    await writeFile(join(root,"src","b.ts"),"export const b = 1;");
    await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    const after=await Promise.all(["nodes.json","edges.json","manifest.json"].map(file=>readFile(join(dir,file),"utf8")));
    expect(after).toEqual(before);
  });
  it("uses the tracked graph directory when callers omit graphDir", async () => {
    const root=await fixture();
    await buildKnowledgeGraph({projectRoot:root,discovery});
    await expect(readFile(join(root,".fusion-knowledge/graph/nodes.json"),"utf8")).resolves.toContain("file:src/a.ts");
  });
  it("prunes deleted files and dangling import edges without reparsing importers", async () => {
    const root=await fixture(), dir=join(root,".fusion-knowledge/graph"); await buildKnowledgeGraph({projectRoot:root,graphDir:dir,discovery});
    await rm(join(root,"src","b.ts")); const extract=vi.fn(realExtractFile); const result=await buildKnowledgeGraph({projectRoot:root,graphDir:dir,extractFile:extract,discovery});
    expect(extract).not.toHaveBeenCalled(); expect(result.graph.nodes.some(node=>node.id==="file:src/b.ts")).toBe(false); expect(result.graph.edges.some(edge=>edge.kind==="imports")).toBe(false);
  });
  it("re-anchors retained inferred edges when a source anchor moves", async () => {
    const root = await fixture(), dir = join(root, ".fusion-knowledge/graph");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "concepts.md"), "# First concept\n\n# Second concept\n");
    const documentationDiscovery = { sourceRoots: ["src"], markdownRoots: ["docs"] };
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: documentationDiscovery });
    const initial = await loadArtifacts(dir);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const [from, to] = initial.graph.nodes.filter(node => node.kind === "doc-concept");
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();
    await addInferredEdges(dir, [{ kind: "relates-to", from: from!.id, to: to!.id }]);

    await writeFile(join(root, "docs", "concepts.md"), "\n# First concept\n\n# Second concept\n");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: documentationDiscovery });

    const rebuilt = await loadArtifacts(dir);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    const currentAnchor = rebuilt.graph.nodes.find(node => node.id === from.id)!;
    const inferred = rebuilt.graph.edges.find(edge => edge.provenance === "inferred")!;
    expect(inferred.source).toEqual(currentAnchor.source);
    expect(inferred.ownerPath).toBe(currentAnchor.ownerPath);
  });

  it("fully rebuilds artifacts after exact-shape and import-reference cache corruption", async () => {
    const root = await fixture(), dir = join(root, ".fusion-knowledge/graph");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    const graphDiscovery = { sourceRoots: ["src"], markdownRoots: ["docs"] };
    const artifactBytes = () => Promise.all(["nodes.json", "edges.json", "manifest.json"].map(file => readFile(join(dir, file), "utf8")));
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: graphDiscovery });

    const nodesPath = join(dir, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as { nodes: Array<Record<string, unknown>> };
    nodes.nodes[0]!.foreign = "tampered";
    await writeFile(nodesPath, `${JSON.stringify(nodes)}\n`);
    const shapeRecovery = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: graphDiscovery });
    expect(shapeRecovery.stats.recoveryReason).toBe("invalid-artifact");
    expect(await artifactBytes()).toEqual(await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: graphDiscovery, force: true }).then(artifactBytes));
    expect((await artifactBytes()).join("")).not.toContain("tampered");

    const manifestPath = join(dir, "manifest.json");
    const artifactManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { importRefs?: unknown[] }> };
    artifactManifest.files["docs/guide.md"]!.importRefs = [{ kind: "imports", specifier: "./a", candidates: ["src/a.ts"], line: 1, column: 1, typeOnly: false }];
    await writeFile(manifestPath, `${JSON.stringify(artifactManifest)}\n`);
    const consistencyRecovery = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: graphDiscovery });
    expect(consistencyRecovery.stats.recoveryReason).toBe("inconsistent-artifact");
    expect(await artifactBytes()).toEqual(await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: graphDiscovery, force: true }).then(artifactBytes));
    expect((JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { importRefs?: unknown[] }> }).files["docs/guide.md"]!.importRefs).toBeUndefined();
  });

  /*
  FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
  The per-file full-array scans were replaced by one batched pass over the retained arrays. Green on the
  single-file cases above would not prove that: the rewrite only engages when MANY files change at once, which
  is the post-upstream-merge shape that produced the profile. So this test drives a wide change set and demands
  that the batched path prune correctly, retain semantic conclusions, and converge on the same artifact bytes a
  from-scratch rebuild produces for the same tree.
  */
  it("converges on a from-scratch rebuild after a wide batched change set", async () => {
    const root = await fixture(), dir = join(root, ".fusion-knowledge/graph");
    for (let index = 0; index < 12; index++) await writeFile(join(root, "src", `w${index}.ts`), `export const w${index} = ${index};\n`);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "concepts.md"), "# First concept\n\n# Second concept\n");
    const docDiscovery = { sourceRoots: ["src"], markdownRoots: ["docs"] };
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: docDiscovery });
    const initial = await loadArtifacts(dir);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const [from, to] = initial.graph.nodes.filter(node => node.kind === "doc-concept");
    expect(from && to).toBeTruthy();
    if (from && to) await addInferredEdges(dir, [{ kind: "relates-to", from: from.id, to: to.id }]);

    // Touch most of the tree, drop one file, and add a new one: every branch of the batched pass at once.
    for (let index = 0; index < 10; index++) await writeFile(join(root, "src", `w${index}.ts`), `export const w${index} = ${index * 7};\nexport const tail${index} = 1;\n`);
    await rm(join(root, "src", "b.ts"));
    await writeFile(join(root, "src", "w12.ts"), "export const w12 = 12;\n");

    const extract = vi.fn(realExtractFile);
    const batched = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, extractFile: extract, discovery: docDiscovery });
    const batchedBytes = await Promise.all(["nodes.json", "edges.json", "manifest.json"].map(file => readFile(join(dir, file), "utf8")));
    expect(batched.stats.parsedFiles).toBe(11);
    expect(batched.stats.deletedFiles).toBe(1);
    expect(extract).toHaveBeenCalledTimes(11);
    expect(batched.graph.nodes.some(node => node.ownerPath === "src/b.ts")).toBe(false);
    expect(batched.graph.edges.some(edge => edge.ownerPath === "src/b.ts" || edge.from === "file:src/b.ts" || edge.to === "file:src/b.ts")).toBe(false);
    expect(batched.graph.edges.filter(edge => edge.provenance === "inferred")).toHaveLength(1);

    // Same tree rebuilt from scratch must agree on every node and every structural edge. A forced pass is a
    // full rebuild from source and therefore drops durable inferred edges by pre-existing design, so the
    // comparison excludes them rather than pretending they survive.
    const forced = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: docDiscovery, force: true });
    const forcedBytes = await Promise.all(["nodes.json", "edges.json", "manifest.json"].map(file => readFile(join(dir, file), "utf8")));
    expect(forced.graph.nodes.map(node => node.id)).toEqual(batched.graph.nodes.map(node => node.id));
    const structural = (edges: typeof batched.graph.edges) => edges.filter(edge => edge.provenance !== "inferred").map(edge => edge.id).sort();
    expect(structural(forced.graph.edges)).toEqual(structural(batched.graph.edges));
    expect(forced.stats.deletedFiles).toBe(0);
    expect(batchedBytes[0]).toBe(forcedBytes[0]);
    expect(batchedBytes[2]).toBe(forcedBytes[2]);
    // A further pass over the now-current tree must not move a byte: the batched path is idempotent.
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery: docDiscovery });
    expect(await Promise.all(["nodes.json", "edges.json", "manifest.json"].map(file => readFile(join(dir, file), "utf8")))).toEqual(forcedBytes);
  });

  it("rebuilds rather than reusing a cache with forged synthetic file provenance", async () => {
    const root = await fixture(), dir = join(root, ".fusion-knowledge/graph");
    await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, discovery });
    const nodesPath = join(dir, "nodes.json");
    const artifact = JSON.parse(await readFile(nodesPath, "utf8")) as { nodes: Array<{ id: string; source: { line: number } }> };
    artifact.nodes.find(node => node.id === "file:src/a.ts")!.source.line = 2;
    await writeFile(nodesPath, `${JSON.stringify(artifact)}\n`);

    const extract = vi.fn(realExtractFile);
    const result = await buildKnowledgeGraph({ projectRoot: root, graphDir: dir, extractFile: extract, discovery });
    expect(result.stats.recoveryReason).toBe("inconsistent-artifact");
    expect(extract).toHaveBeenCalledTimes(2);
    expect(result.graph.nodes.find(node => node.id === "file:src/a.ts")?.source).toMatchObject({ line: 1, column: 1 });
  });
});
