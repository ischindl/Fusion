#!/usr/bin/env node
/*
FNXC:DockerBuild 2026-10-21-11:05 (RUFU-763):
`Dockerfile` installs dependencies before copying sources, so it must stage every workspace
`package.json` up front — it does that with one explicit `COPY` line per package. That list is a second,
hand-maintained copy of `pnpm-workspace.yaml`'s package list, and the two drift. Measured: adding
`plugins/fusion-plugin-antigravity-runtime` to the workspace list without adding its manifest here made
`docker build` fail 133 s in with `error TS2688: Cannot find type definition file for 'node'` — pnpm
never linked that package during the pre-install layer, so the later `COPY . .` brought in its sources
against an uninstalled dependency set. It also emitted a misleading earlier warning ("git content scan
failed… content-hash caching disabled"), so the first thing a reader sees is not the cause.

The failure is expensive in the worst place (inside a CI build that exists to run intranet-side), and
lint, typecheck, build and every test stay green because the local tree has a complete node_modules.
So the invariant is checked here, structurally and cheaply: every workspace member manifest must appear
as a COPY source in the Dockerfile.
*/
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Workspace member globs, read without a YAML dependency: the `packages:` block is a flat list. */
function readWorkspacePatterns() {
  const raw = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = raw.split("\n");
  const start = block.findIndex((line) => line.trim() === "packages:");
  if (start === -1) throw new Error("pnpm-workspace.yaml has no `packages:` block");
  const patterns = [];
  for (const line of block.slice(start + 1)) {
    if (!line.trim()) continue;
    if (!/^\s*-\s/.test(line)) break; // end of the list
    patterns.push(line.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "").trim());
  }
  return patterns;
}

/** Expand `dir/*` to the member directories that actually hold a package.json; exact paths pass through. */
function expand(pattern) {
  const hits = [];
  if (pattern.endsWith("/*")) {
    const dir = join(ROOT, pattern.slice(0, -2));
    if (!existsSync(dir)) return hits;
    for (const entry of readdirSync(dir)) {
      const member = join(dir, entry);
      if (statSync(member).isDirectory() && existsSync(join(member, "package.json"))) {
        hits.push(join(pattern.slice(0, -2), entry, "package.json"));
      }
    }
    return hits;
  }
  if (existsSync(join(ROOT, pattern, "package.json"))) hits.push(`${pattern}/package.json`);
  return hits;
}

function readCopiedManifests() {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const copied = new Set();
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY")) continue;
    for (const token of line.split(/\s+/)) {
      if (token.endsWith("package.json")) copied.add(token);
    }
  }
  return copied;
}

const expected = readWorkspacePatterns().flatMap(expand).sort();
const copied = readCopiedManifests();
const missing = expected.filter((manifest) => !copied.has(manifest));

if (missing.length > 0) {
  console.error(
    `Dockerfile does not stage ${missing.length} workspace manifest(s). ` +
      `pnpm cannot link these packages in the pre-install layer, so \`docker build\` fails later in \`pnpm build\` ` +
      `with a missing-type-definition error rather than naming this cause.\n` +
      `Add one COPY line per package, next to the other plugin COPY lines in the builder stage:`,
  );
  for (const manifest of missing) console.error(`  COPY ${manifest} ./${manifest}`);
  process.exit(1);
}

console.log(`docker workspace manifests: all ${expected.length} staged before pnpm install`);
