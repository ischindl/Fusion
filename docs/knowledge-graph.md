[← Docs index](./README.md)

# Knowledge graph

`fn knowledge-graph build` creates the deterministic structure graph for the FN-8920 memory epic. Memory Keeper may subsequently add clearly provenance-tagged inferred semantic relationships; deterministic extraction itself remains LLM-free.

## Artifact and configuration

The default `knowledgeGraphDir` is `.fusion-knowledge/graph`, deliberately outside ignored `.fusion/`. It contains `nodes.json`, `edges.json`, and `manifest.json`; all use sorted, LF JSON. Nodes and edges are written before the manifest so a torn write safely triggers a full rebuild. The manifest records SHA-256 fingerprints and import references, enabling changed files only to be re-extracted and deleted file ownership to be pruned.

The artifact is not committed. As of 2026-08-10 `.fusion-knowledge/` is gitignored: the graph is deterministic and fully regenerable from source (the manifest's SHA-256 fingerprints drive incremental rebuilds), so tracking it preserves nothing a rebuild cannot reproduce, while costing ~85MB of irreversible, compounding history bloat on every clone and CI checkout — `edges.json` alone is 43MB, past GitHub's 50MB warning threshold. Regenerate it with `fn knowledge-graph build` rather than pulling it.

An operator who explicitly wants a snapshot in history can still force one with `git add -f .fusion-knowledge/graph`; prefer a rebuild.

The graph directory also holds `stat-cache.json`, a regenerable sidecar described under [Incremental reuse](#incremental-reuse-and-discovery-limits). It is cache, not artifact: deleting it costs one full pass and changes no artifact byte.

## Where a build runs

A rebuild triggered **inside the long-lived board process** runs in a forked child: the dashboard's `POST /api/knowledge/graph/build` (the **Memory → Knowledge Graph** rebuild button) and the Memory Keeper consolidation pass. At most **one build child exists per graph directory**: a second request for the same directory joins the running build instead of forking another, while another project's directory is unaffected.

The child carries the CPU and a 4 GB heap ceiling, deliberately below the parent's, so an offloaded build cannot create an out-of-memory the board did not already have. It reports back counts and a work summary rather than the graph object, and the artifacts are read back from disk afterwards. One build may run up to 15 minutes before it is killed as a hang; that is a hang guard, not a throttle.

The placement matters because the dashboard server and the engine are one Node process: a build that saturates that process is indistinguishable from a frozen board. Before the child existed this was measured directly — a rebuild held 84.8% of the whole dashboard process for minutes while the health endpoint took 3.5 seconds to answer.

Three cases stay **in-process**, each deliberate:

- **`fn knowledge-graph build`.** The CLI builds in its own short-lived process, which has no board event loop to starve, and that process is where the work summary is printed.
- **A source checkout.** Run from TypeScript, the worker sibling is a `.ts` file that cannot be forked, and bundling a second copy of the tree-sitter wasm for development machines would be the larger risk. The lane logs `[knowledge-graph] offload refused, building in-process (...)` when it falls back.
- **A degraded child.** If the child cannot start at all, the caller builds in-process rather than reporting no graph — placement is an optimisation, not a new dependency. A build that *fails* is not degraded: the error propagates, so a broken repository is never rebuilt a second time in the process that asked for it.

## Incremental reuse and discovery limits

Each pass records a file's size and modification time next to its content hash in `stat-cache.json`. Where size and mtime still match and the committed manifest agrees, the file body is **not read at all** and the file is reused. Touching 2 files in a 430-file tree re-reads 2 files, where the same pass used to read all 431.

Because reuse keys on modification time, **a content change written back to the same size within the filesystem's mtime resolution can be missed.** When a pass must be trusted absolutely, run it with `--force`, which ignores the sidecar and rebuilds every file from its bytes; deleting `stat-cache.json` has the same effect for the next pass.

File discovery stops at **25,000 files** (a code default, adjustable by callers, not an operator setting). The ceiling bounds the *walk*: reaching it stops descending rather than enumerating files the build would never read, so a mistyped root or a stray vendored tree cannot make a pass unbounded. The graph is then **incomplete**, which the summary reports as `cappedFiles` — a lower bound on the paths the walk refused, which `fn knowledge-graph build` prints as `capped N` only when it is non-zero. It sits far above any legitimate first-party tree (this repository discovers roughly 8,500 files), so an ordinary run prints nothing about truncation. A file larger than 2 MB is truncated before parsing and yields a file node with no symbols, so one generated bundle cannot dominate a pass.

## Model

Nodes are `file`, `module`, `symbol`, `doc-concept`, or `rationale`. Structural edges are `contains`, `imports`, and `re-exports`; semantic edges are `relates-to` and `rationale-supports`. Every edge includes source, owner (`file` or `derived`), and provenance (`extracted` or `inferred`). IDs are path-derived (`file:path`, `module:dir`, `symbol:path#name`, `doc:path#slug~index`, and `rationale:path#area@stamp~index`) with reserved separators percent-escaped.

TypeScript/TSX parsing is parser-only. Exported declarations become symbols; duplicate exports collapse to one earliest-position node with `declarationCount`, including invalid source. Syntax errors remain best-effort. `export *` records a re-export relationship but cannot expand names without a checker. Relative imports are resolved lexically using `.ts`, `.tsx`, and index candidates; package and tsconfig aliases are out of scope.

Discovery includes package `src`, package scripts, `scripts`, plugins, docs, root policy documents, and `packages/dashboard/app`, whose UI is outside `src`. Modules are derived from direct TypeScript files every build. `queryNodes`, `neighbors`, and `shortestPath` expose the in-process API and retain complete edge provenance.

FNXC rationale comes from TypeScript parser comment ranges and markdown HTML comments. Markdown fenced/indented code cannot open a rationale comment; once opened, a comment continues through indentation. Multiple stamped headers in one comment produce separate rationale nodes.

## Extraction and recovery contract

The dispatcher creates exactly one file node per discovered file. TypeScript and TSX are parsed with the TypeScript parser only; malformed source remains best-effort and never blocks a build. Symbol identity uses the exported name. Legal declaration merges and invalid redeclarations use the same deterministic collapse: the first source location and attributes win, while `declarationCount` and (when needed) `symbolKinds` preserve the fact of the collision. The only graph errors are invalid caller paths, an impossible internal cross-kind/owner collision, and artifact I/O failures.

File-owned facts are replaced only when that file hash changes. Module nodes and module containment are derived from the final file set every build. Import references are persisted in the manifest and import/re-export edges are synthesized every build, so adding or deleting a target never requires parsing an unchanged importer. Relative resolution tries `.ts`, `.tsx`, then index candidates; it intentionally does not resolve aliases, packages, or expand `export *` names.

Every real source position is recorded as a repository-relative path, line, and column. File and module-derived items use a `syntheticSource: "true"` attribute and a 1:1 anchor. Artifact payloads contain only content-derived values (including source FNXC stamps and hashes), never build time, host, or process metadata. Before reuse, persisted nodes, edges, source locations, manifest entries, and import references must be complete, exactly-shaped records; an unknown key is rejected rather than retained. Import references must also be usable extractor output: only TypeScript/TSX owners may carry them, candidates are non-empty and unique, and references cannot duplicate an extractor identity. Shape violations report `invalid-artifact`; cross-record contradictions report `inconsistent-artifact`. Either recovery reason discards the entire artifact set and triggers a complete rebuild, never partial trust. Artifacts are written nodes, edges, then manifest so a torn write cannot validate incomplete output.

## FNXC and query behavior

FNXC rationale is first-class data. TypeScript-family comment ranges come from the parsed tree, not a raw scanner, which prevents strings, regexes, template text, and JSX text from becoming rationale. Markdown recognizes HTML comments outside fenced or narrowly defined indented code; code state gates the comment opener only, so an already-open multi-header comment is not truncated by indentation. Each stamped header starts a separate rationale node and runs to the next header in its comment.

`queryNodes(filter)`, `neighbors(id, options)`, and `shortestPath(from, to)` are deterministic in-process APIs. Neighbor and path results retain complete edge objects, including source, ownership, and provenance. The sole inferred-edge writer stamps `inferred` unconditionally and accepts an input type with no provenance field, so model output can never masquerade as deterministic extraction.

## Automatic recall capture

Memory capture is optional and detached. `RecallCaptureWriter.capture()` returns `void`, so task completion, research finalization/promotion, and insight upsert cannot await recall persistence. Completed tasks and research findings capture `solution` records with task-completion/deep-research provenance; insights capture `decision` records with the available `other` provenance. Live writers are composed at the in-process reflection runtime, research orchestrator construction, research-promotion callers, and the lazy async insight-store factory; absent memory falls back to a shared no-op writer.

## Non-goals

This layer has no LLM calls, embeddings, vector recall, MCP tools, source-validity diagnostics, language support beyond TypeScript/TSX symbols, CommonMark parser, cross-rename identity, or capability-fabric bundle. The FR-29/FR-34 bundle format is deferred.

## Dashboard navigation

The dashboard's **Memory → Knowledge Graph** tab provides list-and-detail navigation without transferring the full artifact or rendering a whole-graph canvas. It shows graph status, counts, directory and provenance data; operators can rebuild the artifact explicitly (including force rebuild). That rebuild goes to a build child, so the board keeps its event loop while the graph is regenerated; in a source checkout it runs in-process, where a rebuild can stall the dashboard for the length of the pass. Reads use a small manifest-validated artifact cache and never rebuild the graph.

The tab queries capped node pages (200 nodes), node edges (200 per direction), and neighbors with direction, edge-kind, and depth controls. Node IDs are query parameters, so IDs containing `/`, `#`, `@`, or `~` remain safe to navigate. It also supports node filters for kind, path/id prefix, regular-expression name, FNXC area, symbol kind, and owner.

The HTTP surface is `GET /api/knowledge/graph/status`, `/nodes`, `/node`, `/neighbors`, and `/path`, plus `POST /api/knowledge/graph/build`. Missing artifacts are a recoverable status state; query endpoints report them as 404 rather than silently returning empty results.

Dashboard shortest paths use a bounded undirected BFS, not the core unbounded helper. The default is six hops, the maximum is ten hops, and at most 20,000 nodes are expanded. Results are `found`, exhaustive `not-found`, or `limit-reached`; the latter has `truncated: true` and is intentionally distinct from no path. Unknown node IDs return 404. Whole-graph force-directed/canvas rendering remains an explicit non-goal.
