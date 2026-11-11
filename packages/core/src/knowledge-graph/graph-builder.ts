import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveModules } from "./derive-modules.js";
import { discoverFilesDetailed, type FileDiscoveryOptions } from "./file-discovery.js";
import { extractFile } from "./extract-file.js";
import { fingerprintContent } from "./graph-manifest.js";
import { loadStatCache, statCacheMayReuse, writeStatCache, type KnowledgeGraphStatCache, type KnowledgeGraphStatEntry } from "./graph-stat-cache.js";
import {
  assertNoInternalDuplicateNodes,
  edgeId,
  fileNodeId,
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  KNOWLEDGE_GRAPH_EXTRACTOR_VERSION,
  type ExtractorDependencies,
  type GraphEdge,
  type GraphManifest,
  type GraphNode,
  type ImportRef,
  type KnowledgeGraph,
} from "./graph-types.js";
import { selectImportTarget } from "./resolve-imports.js";
import { loadArtifacts, resolveKnowledgeGraphDir, writeArtifacts, type RecoveryReason } from "./graph-store.js";

/**
 * IO seam for the build's per-file pass (RUFU-500).
 *
 * FNXC:KnowledgeGraph 2026-11-11-18:53:
 * The read/hash loop is the hot path the operator's CPU profile named, and its whole point is now that it
 * reads *fewer* files. A count of bodies read is therefore the only honest evidence that the pass was
 * proportional, and counting it from outside would require a filesystem spy that also counts artifact and
 * sidecar IO. Declaring the two calls the build makes lets a test assert "an unchanged pass reads 0 bodies"
 * directly. `stat` is here for the same reason: a pass that skips reads must still be shown to have stat'd.
 */
export interface KnowledgeGraphIoDependencies {
  readFile?: (filePath: string) => Promise<Uint8Array>;
  stat?: (filePath: string) => Promise<{ size: number; mtimeMs: number }>;
}

export interface BuildKnowledgeGraphOptions {
  projectRoot: string;
  /** Defaults to the tracked artifact location under projectRoot. */
  graphDir?: string;
  force?: boolean;
  deps?: ExtractorDependencies & KnowledgeGraphIoDependencies;
  extractFile?: typeof extractFile;
  logger?: (message: string) => void;
  discovery?: FileDiscoveryOptions;
}

/** Everything one rebuilt file contributes back to the graph and the manifest. */
type ReparsedFile = { relPath: string; nodes: GraphNode[]; edges: GraphEdge[]; importRefs: ImportRef[] };

/**
 * Rebuild the content-pure file layer incrementally, then regenerate cross-file and derived facts.
 * Import edges are deliberately synthesized from persisted references on every run: an added or
 * removed target must not require parsing an otherwise unchanged importer.
 */
/*
FNXC:KnowledgeGraph 2026-08-10-11:07:
The programmatic builder defaults to the tracked graph location just like the CLI. Callers may
supply another contained directory for tests or project policy, but an omitted option must not
turn a normal build into an undefined-path I/O failure.
*/
export async function buildKnowledgeGraph(options: BuildKnowledgeGraphOptions) {
  const graphDir = resolveKnowledgeGraphDir(options.projectRoot, options.graphDir);
  const discovery = await discoverFilesDetailed(options.projectRoot, options.discovery);
  const files = discovery.files;
  const discoveredSet = new Set(files);
  const prior = options.force
    ? { ok: false as const, recoveryReason: "forced" as RecoveryReason }
    : await loadArtifacts(graphDir, options.logger);
  const seeded: KnowledgeGraph = prior.ok
    ? { schemaVersion: prior.graph.schemaVersion, nodes: [], edges: [] }
    : { schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, nodes: [], edges: [] };
  if (prior.ok) {
    // Seed the working graph with everything an incremental pass is allowed to retain. A for-loop rather
    // than a filter chain is deliberate: see the RUFU-500 linearity note below.
    for (const node of prior.graph.nodes) if (node.owner !== "derived") seeded.nodes.push(node);
    for (const edge of prior.graph.edges) {
      if (edge.provenance === "inferred" || (edge.owner !== "derived" && edge.kind !== "imports" && edge.kind !== "re-exports")) seeded.edges.push(edge);
    }
  }
  const manifest: GraphManifest = prior.ok
    ? { ...prior.manifest, files: { ...prior.manifest.files } }
    : { schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, extractorVersion: KNOWLEDGE_GRAPH_EXTRACTOR_VERSION, files: {} };
  const oldPaths = Object.keys(manifest.files);
  /*
  FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
  Reuse used to require reading the file, because the only reuse signal was the manifest's SHA-256 and a hash
  needs bytes: a no-op pass over a 430-file repository read and hashed all 430 to conclude that 0 had changed.
  The machine-local stat sidecar decides unchanged-ness from `size` + `mtimeMs` first, and reuses the manifest
  hash only when the sidecar agrees AND the manifest still records that exact hash. `force`, a missing
  sidecar entry, an unreadable sidecar, or an artifact recovery (which drops the manifest, so there is no hash
  to agree with) each fall back to today's read + hash. Skipping a read can only ever skip work; it cannot
  change artifact bytes, because the bytes it would have produced hash to the value already in the manifest.
  */
  const statCache: KnowledgeGraphStatCache = prior.ok && !options.force ? await loadStatCache(graphDir) : {};
  const nextStatCache: KnowledgeGraphStatCache = {};
  const readFile = options.deps?.readFile ?? ((path: string) => nodeReadFile(path));
  const statFile = options.deps?.stat ?? ((path: string) => nodeStat(path));
  let parsedFiles = 0;
  let reusedFiles = 0;
  let addedFiles = 0;
  let readFiles = 0;
  let statOnlyFiles = 0;
  /**
   * Paths whose prior file-owned facts must be dropped. Collected during the pass and applied once at the
   * end; see the linearity note where it is applied.
   */
  const touched = new Set<string>();
  const reparsed: ReparsedFile[] = [];

  for (const relPath of files) {
    const absolute = resolve(options.projectRoot, relPath);
    const live = await statFile(absolute);
    const previous = manifest.files[relPath];
    const sidecar = statCache[relPath];
    if (statCacheMayReuse(sidecar, live, previous?.hash)) {
      reusedFiles++;
      statOnlyFiles++;
      // Carry the record forward: a reused file is still present, so its entry must survive the rewrite.
      nextStatCache[relPath] = sidecar as KnowledgeGraphStatEntry;
      continue;
    }
    readFiles++;
    const bytes = await readFile(absolute);
    const content = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : new TextDecoder("utf8").decode(bytes);
    const hash = fingerprintContent(bytes);
    nextStatCache[relPath] = { size: live.size, mtimeMs: live.mtimeMs, hash };
    if (prior.ok && previous?.hash === hash) {
      reusedFiles++;
      continue;
    }
    if (!previous) addedFiles++;
    parsedFiles++;
    touched.add(relPath);
    const result = (options.extractFile ?? extractFile)({ relPath, content }, options.deps);
    reparsed.push({ relPath, nodes: result.nodes, edges: result.edges, importRefs: result.importRefs });
    manifest.files[relPath] = { hash, ...(result.importRefs.length > 0 ? { importRefs: result.importRefs } : {}) };
  }

  let deletedFiles = 0;
  for (const relPath of oldPaths) {
    if (discoveredSet.has(relPath)) continue;
    deletedFiles++;
    delete manifest.files[relPath];
    touched.add(relPath);
  }

  /*
  FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
  Pruning used to run inside the per-file loop, so every changed file re-scanned the whole retained node and
  edge arrays: O(changed files x graph size), which on this repository is the dominant per-pass cost --
  `edges.json` alone is around 43 MB and a post-merge pass legitimately changes hundreds of files. The same
  result is now computed in ONE linear pass over the retained arrays keyed by the `touched` set, with the
  reparsed files appended afterwards. Ordering is unchanged because the arrays are sorted by id before they
  are written, so the only observable contract is the final sorted bytes, which the tests assert identical.
  Inferred edges stay exempt from pruning exactly as before: they are durable semantic conclusions.
  */
  const graph: KnowledgeGraph = { schemaVersion: seeded.schemaVersion, nodes: [], edges: [] };
  for (const node of seeded.nodes) if (!touched.has(node.ownerPath)) graph.nodes.push(node);
  for (const edge of seeded.edges) if (edge.provenance === "inferred" || !touched.has(edge.ownerPath)) graph.edges.push(edge);
  for (const file of reparsed) {
    for (const node of file.nodes) graph.nodes.push(node);
    for (const edge of file.edges) graph.edges.push(edge);
  }

  /*
  FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
  Import-edge dedupe used to call `graph.edges.some(...)` per reference, another full-array scan per file.
  One id set seeded from the surviving plus freshly parsed edges, extended as edges are appended, preserves
  the original "first write wins" dedupe exactly.
  */
  const knownEdgeIds = new Set<string>(graph.edges.map(edge => edge.id));
  for (const relPath of files) {
    for (const reference of manifest.files[relPath]?.importRefs ?? []) {
      const target = selectImportTarget(reference.candidates, discoveredSet);
      if (!target) continue;
      const id = edgeId(reference.kind, fileNodeId(relPath), fileNodeId(target));
      if (knownEdgeIds.has(id)) continue;
      knownEdgeIds.add(id);
      graph.edges.push({
        id,
        kind: reference.kind,
        from: fileNodeId(relPath),
        to: fileNodeId(target),
        provenance: "extracted",
        owner: "file",
        ownerPath: relPath,
        source: { path: relPath, line: reference.line, column: reference.column },
        attributes: { specifier: reference.specifier, ...(reference.typeOnly ? { typeOnly: "true" } : {}) },
      });
    }
  }

  const derived = deriveModules(graph.nodes);
  for (const node of derived.nodes) graph.nodes.push(node);
  for (const edge of derived.edges) graph.edges.push(edge);
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  /*
  FNXC:KnowledgeGraphInferredEdges 2026-08-11-11:53:
  An incremental structural rebuild replaces parsed node anchors while retaining inferred semantic
  edges by stable endpoint id. Re-anchor each retained inferred edge to its current `from` node so
  the persisted artifact remains self-consistent after a heading, rationale, or symbol moves lines.
  */
  graph.edges = graph.edges.map(edge => {
    if (edge.provenance !== "inferred") return edge;
    const anchor = nodesById.get(edge.from);
    return anchor ? {
      ...edge,
      owner: anchor.owner,
      ownerPath: anchor.ownerPath,
      source: { ...anchor.source },
    } : edge;
  });
  const nodeIds = new Set(nodesById.keys());
  // One explicit linear compaction rather than a filter assignment: the pass is necessary (an edge whose
  // endpoints no longer exist cannot be persisted), and spelling it as a loop is what lets
  // `graph-builder-complexity.test.ts` forbid the repeated-scan shape outright instead of approximating it.
  const attachedEdges: GraphEdge[] = [];
  for (const edge of graph.edges) if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) attachedEdges.push(edge);
  graph.edges = attachedEdges;

  // Validate the deliberately narrow internal-invariant throw surface before any defensive
  // normalization can hide a cross-kind or cross-owner collision. Same-owner symbol duplicates
  // are collapsed by extractFile, so source content cannot reach this check as a build failure.
  assertNoInternalDuplicateNodes(graph.nodes);
  graph.nodes.sort((left, right) => left.id.localeCompare(right.id));
  graph.edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const written = await writeArtifacts(graphDir, graph, manifest);
  // Written last and never consulted by artifact loading: a lost or corrupt sidecar costs one full pass.
  await writeStatCache(graphDir, nextStatCache);

  let synthesizedImportEdges = 0;
  for (const edge of graph.edges) if (edge.kind === "imports" || edge.kind === "re-exports") synthesizedImportEdges++;

  return {
    graph,
    manifest,
    changed: written.changed,
    stats: {
      parsedFiles,
      reusedFiles,
      prunedFiles: deletedFiles,
      addedFiles,
      deletedFiles,
      /** Files the walk found before any reuse decision, capped by the discovery ceiling if it applied. */
      discoveredFiles: files.length,
      /** File bodies actually read and hashed. Proportional to what changed once the sidecar is warm. */
      readFiles,
      /** Files whose body read was skipped on a stat-plus-manifest agreement. */
      statOnlyFiles,
      /** Files the walk did not return because the discovery ceiling truncated it. `0` normally. */
      cappedFiles: discovery.cappedFiles,
      synthesizedImportEdges,
      derivedModuleCount: derived.nodes.length,
      recoveryReason: prior.ok ? null : prior.recoveryReason,
    },
  };
}
