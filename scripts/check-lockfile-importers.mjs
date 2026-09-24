#!/usr/bin/env node
/*
FNXC:LockfileDriftGate 2026-09-22-19:20:
RUFU-266. A committed `pnpm-lock.yaml` that no longer matches the tracked manifests is not a
cosmetic problem: the engine's dependency auto-heal (`merge-dependency-sync` retry with
`--no-frozen-lockfile`, plus `run-verification-tool`'s non-frozen prepend) makes the worktree
install SUCCEED by rewriting the tracked lockfile locally. So every fresh task worktree goes
dirty at bootstrap (` M pnpm-lock.yaml`) before the card does anything, that generated diff is
outside every card's `## File Scope`, and the squash-merge File Scope guard then fails an innocent
card with `FileScopeViolationError` / `AiMergeBlockedError`. CI cannot catch it either: cards land
through Fusion's local squash-merge lane rather than GitHub PRs, and `full-suite.yml` (push-to-main
frozen install) is non-blocking information by design. Measured introducer: merge 2c09516986 kept
one lineage's `package.json` declarations and the other lineage's lockfile.
This validator closes the gap at the chain that ships the drift: it cross-checks every workspace
importer's declared dependencies against that importer's `pnpm-lock.yaml` block, in both
directions, and runs in `pretest` / `pretest:full` / `test:gate:static`.
*/
import { globSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
/*
FNXC:WorkspaceBootstrap 2026-09-22-19:20:
Reuse the sibling validator's glob matcher instead of duplicating it, so the two workspace-glob
consumers can never disagree about which directory a glob covers.
*/
import { matchesWorkspaceGlob } from "./check-workspace-package-graph.mjs";

/*
FNXC:LockfileDriftGate 2026-09-22-19:20:
`peerDependencies` are never required in the forward direction — pnpm records a peer only when it
actually resolves one for the importer (see the reverse-direction note), so requiring them would
false-fire. They ARE part of the declared set for the reverse direction: for a peer declared as
`"@scope/x": "*"`, pnpm writes the entry into the importer's `dependencies` block with the resolved
version as its `specifier` (measured: `packages/droid-cli` peers `@earendil-works/pi-ai` /
`pi-coding-agent` are recorded at `specifier: 0.86.1`). Treating those as stale lockfile entries
would report 15 violations on a perfectly healthy lockfile.
*/
export const LOCKFILE_DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies"];
export const MANIFEST_DECLARED_BLOCKS = [...LOCKFILE_DEPENDENCY_BLOCKS, "peerDependencies"];

/*
FNXC:WorkspaceBootstrap 2026-09-22-19:20:
Mirrors `check-workspace-package-graph.mjs`'s exclusion set: build-artifact directories
(`packages/desktop/deploy/` is gitignored electron-builder staging produced by `pnpm deploy`) exist
only on machines that ran a packaging build, are absent from the isolated worktree this gate guards,
and therefore must not be demanded as lockfile importers. Keep both lists aligned.
*/
const EXCLUDED_PACKAGE_PATHS = ["**/node_modules/**", "**/dist/**", "packages/desktop/deploy/**"];
const ROOT_IMPORTER_DIRECTORY = ".";

/*
FNXC:LockfileDriftGate 2026-09-22-19:20:
`pnpm-workspace.yaml` `overrides:` rewrite the recorded `specifier`, so an overridden name legitimately
records something other than the manifest range (measured live: `@types/node` declared `^22.0.0` /
`^25.5.0` records specifier `^25.5.2`; peer-protocol `*` records the resolved `0.86.1`). Collect every
value an override can put in front of a name so the specifier comparison accepts either side instead
of failing a synchronized lockfile. Scoped override keys (`name@range`, `name>child`) still target the
base name.
*/
function overrideTargetName(key) {
  const target = key.split(">").pop() ?? key;
  const scopeAwareAt = target.startsWith("@") ? target.indexOf("@", 1) : target.indexOf("@");
  return scopeAwareAt === -1 ? target : target.slice(0, scopeAwareAt);
}

export function collectOverrideSpecifiers({ overrides = [] } = {}) {
  const specifiers = new Map();
  for (const entry of overrides) {
    if (!entry || typeof entry !== "object") continue;
    for (const [key, value] of Object.entries(entry)) {
      if (typeof key !== "string") continue;
      const name = overrideTargetName(key);
      if (!name) continue;
      if (!specifiers.has(name)) specifiers.set(name, new Set());
      if (typeof value === "string") specifiers.get(name).add(value);
      else if (value && typeof value === "object") for (const nested of Object.values(value)) if (typeof nested === "string") specifiers.get(name).add(nested);
    }
  }
  return specifiers;
}

/**
 * Cross-check in-memory manifests against an in-memory lockfile importer map so the policy is
 * testable with fixtures and against the live repository without spawning the CLI.
 *
 * @param {{ workspaceGlobs?: string[], lockfileImporters?: Record<string, unknown>, manifests?: Array<{filePath: string, manifest: unknown, isRoot?: boolean}>, overrideSpecifiers?: Map<string, Set<string>> }} input
 * @returns {string[]} human-readable violations, empty when manifests and lockfile agree
 */
export function validateLockfileImporters({ workspaceGlobs = [], lockfileImporters = {}, manifests = [], overrideSpecifiers = new Map() } = {}) {
  const violations = [];

  const directoryOf = (filePath) => (filePath === "package.json" ? ROOT_IMPORTER_DIRECTORY : dirname(filePath).replaceAll("\\", "/"));
  const isGlobMatched = (filePath) => workspaceGlobs.some((workspaceGlob) => matchesWorkspaceGlob(directoryOf(filePath), workspaceGlob));

  const expectedDirectories = new Set([ROOT_IMPORTER_DIRECTORY]);
  const manifestsByDirectory = new Map();
  for (const { filePath, manifest, isRoot = false } of manifests) {
    if (!isRoot && !isGlobMatched(filePath)) continue;
    const directory = directoryOf(filePath);
    expectedDirectories.add(directory);
    manifestsByDirectory.set(directory, manifest ?? {});
  }

  for (const directory of expectedDirectories) {
    if (!Object.hasOwn(lockfileImporters, directory)) {
      violations.push(`${directory}: workspace package has no importer block in pnpm-lock.yaml (run \`pnpm install\` and commit the refreshed lockfile in the same change)`);
    }
  }
  for (const directory of Object.keys(lockfileImporters)) {
    if (!expectedDirectories.has(directory)) {
      violations.push(`${directory}: pnpm-lock.yaml keeps an importer block but no glob-covered workspace package declares it (run \`pnpm install\` and commit the refreshed lockfile)`);
    }
  }

  for (const [directory, manifest] of manifestsByDirectory) {
    const importer = lockfileImporters[directory];
    if (!importer || typeof importer !== "object") continue;

    const recorded = new Map();
    for (const blockName of LOCKFILE_DEPENDENCY_BLOCKS) {
      for (const [name, entry] of Object.entries(importer[blockName] ?? {})) {
        recorded.set(name, typeof entry?.specifier === "string" ? entry.specifier : String(entry?.specifier ?? ""));
      }
    }

    const declared = new Map();
    for (const blockName of MANIFEST_DECLARED_BLOCKS) {
      for (const [name, range] of Object.entries(manifest[blockName] ?? {})) {
        if (!declared.has(name) && typeof range === "string") declared.set(name, range);
      }
    }

    for (const blockName of LOCKFILE_DEPENDENCY_BLOCKS) {
      for (const [name, range] of Object.entries(manifest[blockName] ?? {})) {
        if (typeof range !== "string") continue;
        const specifier = recorded.get(name);
        if (specifier === undefined) {
          violations.push(`${directory}: ${blockName}.${name} declares ${range} but pnpm-lock.yaml records no entry for it`);
          continue;
        }
        const allowed = overrideSpecifiers.get(name);
        if (specifier !== range && !(allowed?.has(range) || allowed?.has(specifier))) {
          violations.push(`${directory}: ${name} declares ${range} but pnpm-lock.yaml records specifier ${specifier}`);
        }
      }
    }

    for (const [name, specifier] of recorded) {
      if (!declared.has(name)) {
        violations.push(`${directory}: pnpm-lock.yaml records ${name} (specifier ${specifier}) but the manifest no longer declares it`);
      }
    }
  }

  return violations;
}

/**
 * Read the repository's workspace globs, manifests, overrides, and lockfile importers.
 *
 * @param {{ root?: string, readFile?: typeof readFileSync, glob?: typeof globSync, parseYamlImpl?: typeof parseYaml }} [options]
 * @returns {Promise<{ workspaceGlobs: string[], manifests: Array<{filePath: string, manifest: unknown, isRoot: boolean}>, overrideSpecifiers: Map<string, Set<string>>, lockfileImporters: Record<string, unknown>, violations: string[] }>}
 */
export async function readLockfileImporterState({ root = process.cwd(), readFile = readFileSync, glob = globSync, parseYamlImpl = parseYaml } = {}) {
  const violations = [];

  let workspaceConfig;
  try {
    workspaceConfig = parseYamlImpl(readFile(`${root}/pnpm-workspace.yaml`, "utf8"));
  } catch (error) {
    return { workspaceGlobs: [], manifests: [], overrideSpecifiers: new Map(), lockfileImporters: {}, violations: [`pnpm-workspace.yaml: invalid YAML (${error instanceof Error ? error.message : String(error)})`] };
  }
  const workspaceGlobs = Array.isArray(workspaceConfig?.packages) ? workspaceConfig.packages.filter((value) => typeof value === "string") : [];

  let lockfileDocument;
  try {
    lockfileDocument = parseYamlImpl(readFile(`${root}/pnpm-lock.yaml`, "utf8"));
  } catch (error) {
    return { workspaceGlobs, manifests: [], overrideSpecifiers: new Map(), lockfileImporters: {}, violations: [`pnpm-lock.yaml: invalid YAML (${error instanceof Error ? error.message : String(error)})`] };
  }
  const lockfileImporters = lockfileDocument?.importers && typeof lockfileDocument.importers === "object" ? lockfileDocument.importers : {};

  const manifestPaths = new Set(["package.json"]);
  for (const workspaceGlob of workspaceGlobs) {
    for (const filePath of glob(`${workspaceGlob}/package.json`, { cwd: root, exclude: EXCLUDED_PACKAGE_PATHS })) manifestPaths.add(filePath);
  }

  const manifests = [];
  const overrideEntries = [workspaceConfig?.overrides];
  for (const filePath of [...manifestPaths].sort()) {
    try {
      const manifest = JSON.parse(readFile(`${root}/${filePath}`, "utf8"));
      manifests.push({ filePath, manifest, isRoot: filePath === "package.json" });
      if (filePath === "package.json") overrideEntries.push(manifest?.pnpm?.overrides, manifest?.overrides);
    } catch (error) {
      violations.push(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const overrideSpecifiers = collectOverrideSpecifiers({ overrides: overrideEntries.filter(Boolean) });
  return { workspaceGlobs, manifests, overrideSpecifiers, lockfileImporters, violations };
}

/**
 * Convenience entry point returning only the violation list.
 *
 * @param {Parameters<typeof readLockfileImporterState>[0]} [options]
 * @returns {Promise<string[]>}
 */
export async function scanLockfileImporters(options = {}) {
  const state = await readLockfileImporterState(options);
  return [...state.violations, ...validateLockfileImporters(state)];
}

export function formatFailureMessage(violations) {
  return [
    "[check-lockfile-importers] pnpm-lock.yaml importers must match the tracked workspace manifests.",
    "A drifted committed lockfile dirties every fresh worktree through the dependency auto-heal and",
    "fails unrelated cards' squash merges on the File Scope guard. Fix: run `pnpm install` and commit",
    "the refreshed pnpm-lock.yaml together with the package.json change that introduced the drift.",
    ...violations.map((violation) => `- ${violation}`),
  ].join("\n");
}

export async function main(options = {}) {
  const state = await readLockfileImporterState(options);
  const violations = [...state.violations, ...validateLockfileImporters(state)];
  if (violations.length) {
    console.error(formatFailureMessage(violations));
    return 1;
  }
  let records = 0;
  for (const importer of Object.values(state.lockfileImporters)) {
    for (const blockName of LOCKFILE_DEPENDENCY_BLOCKS) records += Object.keys(importer?.[blockName] ?? {}).length;
  }
  console.log(`[check-lockfile-importers] ${Object.keys(state.lockfileImporters).length} lockfile importers, ${state.manifests.length} manifests, ${records} dependency records in sync`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
