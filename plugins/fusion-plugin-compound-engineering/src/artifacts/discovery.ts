import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * CE artifact discovery (U3).
 *
 * Scans a fixed allowlist of conventional CE artifact locations relative to a
 * project root and returns artifacts grouped by stage. The allowlist is the
 * ONLY filesystem surface this module touches — it never recurses outside a
 * conventional location and never reads a file that does not live under one of
 * them. An artifact that cannot be read or is malformed is represented as an
 * `error` entry rather than crashing the scan or being silently dropped.
 *
 * Locations (per the plan): STRATEGY.md, docs/ideation/, docs/brainstorms/,
 * docs/plans/, docs/solutions/, CONCEPTS.md.
 */

export type CeArtifactStage =
  | "strategy"
  | "ideation"
  | "brainstorm"
  | "plan"
  | "solution"
  | "concepts";

/** Whether a conventional location is a single file or a directory of files. */
type LocationKind = "file" | "directory";

interface ConventionalLocation {
  stage: CeArtifactStage;
  /** Human label for the stage group. */
  label: string;
  /** Project-root-relative path. */
  path: string;
  kind: LocationKind;
}

/**
 * The conventional CE artifact locations. This is the discovery allowlist — the
 * scanner reads ONLY these paths (and, for directories, their immediate `.md`
 * children). Nothing outside this list is opened.
 */
export const CONVENTIONAL_LOCATIONS: readonly ConventionalLocation[] = [
  { stage: "strategy", label: "Strategy", path: "STRATEGY.md", kind: "file" },
  { stage: "ideation", label: "Ideation", path: "docs/ideation", kind: "directory" },
  { stage: "brainstorm", label: "Brainstorms", path: "docs/brainstorms", kind: "directory" },
  { stage: "plan", label: "Plans", path: "docs/plans", kind: "directory" },
  { stage: "solution", label: "Solutions", path: "docs/solutions", kind: "directory" },
  { stage: "concepts", label: "Concepts", path: "CONCEPTS.md", kind: "file" },
];

/** A discovered, readable artifact. */
export interface CeArtifact {
  /** Stable id: `${stage}:${relativePath}`. Safe to use as a route param after encoding. */
  id: string;
  stage: CeArtifactStage;
  /** Project-root-relative path with forward slashes. */
  path: string;
  /** Filename (basename). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified epoch ms — used for `(stage, updatedAt DESC)` ordering. */
  updatedAt: number;
  /** Discriminator. */
  kind: "artifact";
}

/** An artifact location that exists but could not be read / was malformed. */
export interface CeArtifactError {
  id: string;
  stage: CeArtifactStage;
  path: string;
  name: string;
  /** Discriminator. */
  kind: "error";
  /** Human-readable reason the artifact could not be surfaced. */
  error: string;
}

export type CeArtifactEntry = CeArtifact | CeArtifactError;

/** Artifacts (and error entries) grouped by stage. */
export interface CeArtifactGroup {
  stage: CeArtifactStage;
  label: string;
  /** True when the conventional location for this stage exists on disk. */
  present: boolean;
  /** Entries, ordered by `updatedAt DESC` (errors sort last, keyed by name). */
  entries: CeArtifactEntry[];
}

export interface DiscoveryResult {
  groups: CeArtifactGroup[];
  /** Convenience flags for the hub's empty / partial states. */
  totalArtifacts: number;
  totalErrors: number;
}

const MAX_ARTIFACT_BYTES = 2_000_000;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Guard: a resolved path must stay within the project root AND under the
 * specific conventional location it was discovered through. This is the
 * concrete enforcement of "do not read outside the conventional locations".
 */
function isWithin(root: string, locationAbs: string, candidate: string): boolean {
  const relToLocation = relative(locationAbs, candidate);
  if (relToLocation.startsWith("..") || isAbsolute(relToLocation)) return false;
  const relToRoot = relative(root, candidate);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) return false;
  return true;
}

function makeId(stage: CeArtifactStage, relPath: string): string {
  return `${stage}:${relPath}`;
}

/** Build a uniform `error` entry, deriving `id`/`name` from `(stage, relPath)`. */
function makeError(stage: CeArtifactStage, relPath: string, message: string): CeArtifactError {
  return {
    id: makeId(stage, relPath),
    stage,
    path: relPath,
    name: relPath.split("/").pop() ?? relPath,
    kind: "error",
    error: message,
  };
}

function readArtifactEntry(
  stage: CeArtifactStage,
  root: string,
  locationAbs: string,
  abs: string,
  relPath: string,
): CeArtifactEntry {
  const name = relPath.split("/").pop() ?? relPath;
  // Defense in depth: refuse anything that escaped the conventional location.
  if (!isWithin(root, locationAbs, abs)) {
    return makeError(stage, relPath, "Path is outside its conventional location");
  }
  try {
    const st = statSync(abs);
    if (st.size > MAX_ARTIFACT_BYTES) {
      return makeError(stage, relPath, `Artifact too large to read (${st.size} bytes)`);
    }
    // Probe READ PERMISSION only (no bytes transferred) so an unreadable file is
    // surfaced now as an error entry rather than crashing later at render time.
    // NOTE: this is a permission probe, NOT a content check — malformed/corrupt
    // file CONTENT is only detected at read time (readCeArtifact), not here.
    accessSync(abs, constants.R_OK);
    return {
      id: makeId(stage, relPath),
      stage,
      path: relPath,
      name,
      size: st.size,
      updatedAt: st.mtimeMs,
      kind: "artifact",
    };
  } catch (err) {
    return makeError(stage, relPath, err instanceof Error ? err.message : String(err));
  }
}

function sortEntries(entries: CeArtifactEntry[]): CeArtifactEntry[] {
  // Composite ordering analogue: artifacts by updatedAt DESC; errors last,
  // stable by name. (See docs/performance/dashboard-load.md — the persisted
  // equivalent is a `(type, updatedAt DESC)` index.)
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "artifact" ? -1 : 1;
    if (a.kind === "artifact" && b.kind === "artifact") return b.updatedAt - a.updatedAt;
    return a.name.localeCompare(b.name);
  });
}

function discoverLocation(root: string, loc: ConventionalLocation): CeArtifactGroup {
  const locationAbs = join(root, loc.path);
  const entries: CeArtifactEntry[] = [];
  let present = false;

  let st: ReturnType<typeof statSync> | undefined;
  try {
    st = statSync(locationAbs);
    present = true;
  } catch {
    // Location simply does not exist — an empty (but valid) category.
    return { stage: loc.stage, label: loc.label, present: false, entries: [] };
  }

  if (loc.kind === "file") {
    if (st.isFile()) {
      entries.push(readArtifactEntry(loc.stage, root, locationAbs, locationAbs, toPosix(loc.path)));
    } else {
      // A conventional file path that is actually a directory is malformed.
      entries.push(
        makeError(
          loc.stage,
          toPosix(loc.path),
          "Expected a file at the conventional location but found a directory",
        ),
      );
    }
    return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
  }

  // Directory location: read ONLY immediate children, only Markdown files.
  // Non-recursive on purpose — we never descend into unrelated subtrees.
  let names: string[] = [];
  try {
    if (!st.isDirectory()) {
      entries.push(
        makeError(
          loc.stage,
          toPosix(loc.path),
          "Expected a directory at the conventional location but found a file",
        ),
      );
      return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
    }
    names = readdirSync(locationAbs);
  } catch (err) {
    entries.push(makeError(loc.stage, toPosix(loc.path), err instanceof Error ? err.message : String(err)));
    return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
  }

  for (const childName of names) {
    // Ignore unrelated files: only Markdown artifacts count. Dotfiles and any
    // non-.md file are skipped outright (not read).
    if (childName.startsWith(".")) continue;
    if (!childName.toLowerCase().endsWith(".md")) continue;
    const abs = join(locationAbs, childName);
    const relPath = toPosix(join(loc.path, childName));
    // Skip nested directories named *.md — only regular files are artifacts.
    let childStat: ReturnType<typeof statSync>;
    try {
      childStat = statSync(abs);
    } catch (err) {
      entries.push(makeError(loc.stage, relPath, err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (!childStat.isFile()) continue;
    entries.push(readArtifactEntry(loc.stage, root, locationAbs, abs, relPath));
  }

  return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
}

/**
 * Discover CE artifacts under `projectRoot`, grouped by stage. Never throws for
 * per-artifact problems — those become `error` entries. Always returns one
 * group per conventional location (empty groups included so the hub can render
 * a partial-discovery state).
 */
export function discoverArtifacts(projectRoot: string): DiscoveryResult {
  const root = projectRoot;
  const groups = CONVENTIONAL_LOCATIONS.map((loc) => discoverLocation(root, loc));
  let totalArtifacts = 0;
  let totalErrors = 0;
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.kind === "artifact") totalArtifacts += 1;
      else totalErrors += 1;
    }
  }
  return { groups, totalArtifacts, totalErrors };
}

/**
 * Resolve a single artifact by its `stage:relativePath` id and return its raw
 * content. Re-validates the path against the conventional-location allowlist so
 * a forged id can never read an arbitrary file. Returns `undefined` if the id
 * does not map to a known conventional location or the file is missing.
 */
export function readArtifactById(
  projectRoot: string,
  id: string,
): { artifact: CeArtifact; content: string } | { error: string } | undefined {
  const sepIdx = id.indexOf(":");
  if (sepIdx <= 0) return undefined;
  const stage = id.slice(0, sepIdx) as CeArtifactStage;
  const relPath = id.slice(sepIdx + 1);
  const loc = CONVENTIONAL_LOCATIONS.find((l) => l.stage === stage);
  if (!loc) return undefined;

  const locationAbs = join(projectRoot, loc.path);
  const abs = join(projectRoot, relPath);

  // The requested path must live under the stage's conventional location.
  // For file locations, the path must equal the location itself.
  if (loc.kind === "file") {
    if (toPosix(relPath) !== toPosix(loc.path)) return undefined;
  } else if (!isWithin(projectRoot, locationAbs, abs)) {
    return undefined;
  }
  // Directory artifacts must be immediate Markdown children.
  if (loc.kind === "directory") {
    const rel = relative(locationAbs, abs);
    if (rel.includes(sep) || rel.startsWith("..") || !rel.toLowerCase().endsWith(".md")) {
      return undefined;
    }
  }

  let content: string;
  let mtimeMs: number;
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { error: "Artifact is not a readable file" };
    if (st.size > MAX_ARTIFACT_BYTES) return { error: `Artifact too large to read (${st.size} bytes)` };
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    // A missing file is "not found" (404), not a malformed-artifact error (422).
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const name = relPath.split("/").pop() ?? relPath;
  return {
    artifact: {
      id,
      stage,
      path: toPosix(relPath),
      name,
      size,
      updatedAt: mtimeMs,
      kind: "artifact",
    },
    content,
  };
}
