/** FNXC:CodeOrganization 2026-08-10-10:00: Public deterministic knowledge-graph domain barrel. */
export * from "./graph-types.js";
export * from "./graph-serialization.js";
export * from "./graph-store.js";
export * from "./graph-manifest.js";
export * from "./file-discovery.js";
export * from "./extract-file.js";
export * from "./extract-typescript.js";
export * from "./extract-markdown.js";
export * from "./extract-fnxc.js";
export * from "./resolve-imports.js";
export * from "./derive-modules.js";
export * from "./graph-builder.js";
/*
FNXC:KnowledgeGraph 2026-10-02-14:05:
`build-offloader.js` is exported but `build-worker.js` is deliberately NOT: the worker registers a
`process.on("message")` handler and is only ever entered as a forked entry point. Pulling it into the barrel
would put a message listener on every importer of `@fusion/core`.
*/
export * from "./build-offloader.js";
export * from "./graph-query.js";
export * from "./inferred-edge-writer.js";
