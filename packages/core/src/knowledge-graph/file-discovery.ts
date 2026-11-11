import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizeRelPath } from "./graph-types.js";

export const DEFAULT_EXCLUDED_DIRECTORIES = ["node_modules", "dist", "dist-electron", "coverage", ".git", ".fusion", ".fusion-knowledge", ".worktrees", ".pi", ".history", ".gate-bundle", "build", "android", "public", "locales"];
export const DEFAULT_SOURCE_ROOTS = ["packages/*/src", "packages/dashboard/app", "packages/*/scripts", "scripts", "plugins"];
export const DEFAULT_MARKDOWN_ROOTS = ["docs", "AGENTS.md", "CONCEPTS.md"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js"]);
const markdownExtensions = new Set([".md"]);

/*
FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
Discovery used to be an unbounded recursive walk, so a repository that grew into a pathological tree (a
vendored checkout, a generated-source directory nobody excluded) made every build pay for it, and the walk
feeds the read/hash loop that the dashboard's CPU profile named. The ceiling bounds the WALK: reaching it
stops descending instead of enumerating what it will not use. It sits far above any legitimate first-party
tree -- this repository discovers roughly 8.5k files -- so the ordinary case is `cappedFiles: 0` and the
committable artifact is never quietly truncated. Raise it with `maxFiles` (or `Number.POSITIVE_INFINITY` to
restore the unbounded walk) rather than by lowering the default.
*/
export const DEFAULT_MAX_DISCOVERED_FILES = 25_000;

/*
FNXC:KnowledgeGraph 2026-08-10-11:15:
Discovery is rooted in the explicit source-root contract rather than the repository root. The
Dashboard keeps first-party React source in packages/dashboard/app, outside src; omitting it would
silently lose that component and FNXC-rationale surface from the deterministic graph.
*/
export interface FileDiscoveryOptions {
  excludedDirectories?: string[];
  sourceRoots?: string[];
  markdownRoots?: string[];
  /**
   * Ceiling on returned paths. Defaults to `DEFAULT_MAX_DISCOVERED_FILES`; pass
   * `Number.POSITIVE_INFINITY` for the old unbounded walk.
   */
  maxFiles?: number;
}

/** What one walk actually did: the returned paths plus what the ceiling refused. */
export type FileDiscoveryResult = {
  files: string[];
  /**
   * Lower bound on refused paths. The walk stops descending at the ceiling rather than enumerating the rest,
   * so this answers "did the cap bite, and by at least how much", never "exactly how many files exist".
   * `0` means the walk completed and nothing was refused.
   */
  cappedFiles: number;
  truncated: boolean;
};

async function existingDirectories(root: string, patterns: readonly string[]): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      try { if ((await stat(join(root, pattern))).isDirectory()) results.add(join(root, pattern)); } catch { /* Optional roots are absent in small fixture repositories. */ }
      continue;
    }
    const [prefix, suffix] = pattern.split("*");
    const container = join(root, prefix ?? "");
    try {
      for (const entry of await readdir(container, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(container, entry.name, suffix ?? "");
        try { if ((await stat(candidate)).isDirectory()) results.add(candidate); } catch { /* Pattern entry has no matching child root. */ }
      }
    } catch { /* Optional root container is absent. */ }
  }
  return [...results].sort();
}

async function packageEntryFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for (const pkg of await readdir(join(root, "packages"), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const packageRoot = join(root, "packages", pkg.name);
      for (const name of await readdir(packageRoot)) {
        if (name === "index.ts" || name === "bin.mjs" || name === "build.ts" || name.endsWith(".config.ts")) {
          const candidate = join(packageRoot, name);
          try { if ((await stat(candidate)).isFile()) entries.push(candidate); } catch { /* Directory entries can race a fixture mutation. */ }
        }
      }
    }
  } catch { /* A fixture may intentionally omit packages. */ }
  return entries.sort();
}

/**
 * Deterministically discover only the documented graph inputs, never generated or unrelated files.
 *
 * FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
 * TRUNCATION ORDER, stated because a test asserts it and callers must be able to predict what a capped graph
 * contains: source roots are walked in the sorted order `existingDirectories` already returns; inside a
 * directory, entries are visited in sorted name order and a subdirectory is descended where it is met; then
 * markdown roots, then root policy documents, then package entry files. The first `maxFiles` accepted paths
 * of that enumeration are returned. Below the ceiling the result is identical to the pre-cap walk, so the
 * committable artifact cannot change; sorting entries per directory is what makes a capped result repeatable
 * across filesystems instead of dependent on `readdir` order.
 */
export async function discoverFilesDetailed(root: string, options: FileDiscoveryOptions = {}): Promise<FileDiscoveryResult> {
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const maxFiles = typeof options.maxFiles === "number" && Number.isFinite(options.maxFiles)
    ? Math.max(0, Math.trunc(options.maxFiles))
    : DEFAULT_MAX_DISCOVERED_FILES;
  const output = new Set<string>();
  let skipped = 0;
  const capped = () => output.size >= maxFiles;
  const add = (absolute: string): boolean => {
    const rel = normalizeRelPath(relative(root, absolute));
    if (output.has(rel)) return true;
    if (capped()) return false;
    output.add(rel);
    return true;
  };
  const walk = async (absolute: string, allowedExtensions: Set<string>): Promise<void> => {
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    for (let index = 0; index < ordered.length; index++) {
      if (capped()) {
        // Unconsumed siblings exist but the ceiling is reached: record the refusal and stop descending.
        skipped++;
        return;
      }
      const entry = ordered[index]!;
      const candidate = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await walk(candidate, allowedExtensions);
      } else if (entry.isFile() && allowedExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) && !entry.name.endsWith(".d.ts")) {
        add(candidate);
      }
    }
  };

  for (const directory of await existingDirectories(root, options.sourceRoots ?? DEFAULT_SOURCE_ROOTS)) await walk(directory, sourceExtensions);
  for (const directory of await existingDirectories(root, options.markdownRoots ?? DEFAULT_MARKDOWN_ROOTS.filter(path => path === "docs"))) await walk(directory, markdownExtensions);
  for (const file of options.markdownRoots ?? DEFAULT_MARKDOWN_ROOTS.filter(path => path !== "docs")) {
    if (capped()) { skipped++; continue; }
    try { if ((await stat(join(root, file))).isFile()) add(join(root, file)); } catch { /* Optional root document is absent. */ }
  }
  for (const file of await packageEntryFiles(root)) {
    if (capped() && !output.has(normalizeRelPath(relative(root, file)))) skipped++;
    else add(file);
  }
  return { files: [...output].sort(), cappedFiles: skipped, truncated: skipped > 0 };
}

/** Deterministically discover only the documented graph inputs, never generated or unrelated files. */
export async function discoverFiles(root: string, options: FileDiscoveryOptions = {}): Promise<string[]> {
  return (await discoverFilesDetailed(root, options)).files;
}
