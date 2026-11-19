/**
 * FNXC:SchemaAssetPairing 2026-11-17-16:10 (RUFU-548):
 * Shared, dependency-free evaluator for the built-artifact schema-ceiling invariant:
 * for every migration version a package's EMITTED (dist/bundle) code declares at or
 * below its SCHEMA_BASELINE_VERSION ceiling, the matching `NNNN_*.sql` asset must
 * exist in that SAME package's emitted asset directory. The runtime reads migrations
 * from `join(__dirname, "migrations", ...)` next to the COMPILED applier
 * (packages/core/src/postgres/schema-applier.ts), so the half of the ceiling contract
 * that actually runs in the field lives in the build output — and `@fusion/core`
 * builds with bare `tsc`, which never copies `.sql`, making stale or absent built
 * migration assets the default state rather than the exception. Measured 2026-10-04:
 * two same-named core dists declared ceilings (0089, 0087) their own
 * `dist/postgres/migrations` directories could not honor, and the only guard at the
 * time (packages/core/src/__tests__/migration-wiring-integrity.test.ts) compares the
 * ceiling against the SRC directory, so it could not see this class at all.
 *
 * Hard requirements encoded here:
 * - Per-package AND per-worktree: the migration registry is materialized per build
 *   output, so a pass in another worktree or under another package is NOT coverage.
 *   Every verdict names the package directory it evaluated.
 * - NEVER read a `src` directory. The evaluator only ever sees emitted claim files
 *   and an emitted asset directory; the source tree must be able to disagree with
 *   dist without changing a verdict (reading src is the exact false-positive this
 *   module exists to remove).
 * - The `missing` set is exactly the versions the emitted registry REFERENCES, never
 *   a numeric sweep `0000..ceiling`. Slot numbering is non-contiguous BY DESIGN:
 *   slots are claimed, renumbered, and abandoned (FNXC:MigrationVersionCollision /
 *   FNXC:MigrationRestack in schema-applier.ts record e.g. the ledger moving
 *   0082 -> 0084 -> 0091, and this repository contains NO 0084/0085 files), so a
 *   range check would report two false failures against a correct build.
 * - Value-agnostic: no ceiling value may be hardcoded here; SCHEMA_BASELINE_VERSION
 *   advances on every migration landing.
 *
 * Filesystem reads only; no process.exit (exit-code policy belongs to the caller).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

/*
Emitted ceiling declaration. Two real shapes must parse (verified against the live
build output): tsc emits `export const SCHEMA_BASELINE_VERSION = "0097";` and the
esbuild bundles emit `SCHEMA_BASELINE_VERSION = "0097";` — the literal-tolerant
pattern below matches both because it anchors on the identifier + `=` + quoted
4-digit value and ignores whatever precedes it. `(?!=)` refuses `==`/`===`
comparisons: the naive tolerant pattern would parse `SCHEMA_BASELINE_VERSION ===
"0096"` as a declaration of 0096, letting a comparison site fabricate a ceiling
(measured: no such comparison site exists in today's emitted output, so the guard
is cheap insurance, not a live workaround).
*/
const CEILING_DECLARATION = /SCHEMA_BASELINE_VERSION\s*=(?!=)\s*"(\d{4})"/g;

/*
Assignment-shaped mention used only for the `unreadable-claim` verdict: the token is
assigned something the ceiling pattern refused to parse. `(?!=)` excludes `==`/`===`
comparisons, and the leading class excludes property access (`x.SCHEMA_BASELINE_VERSION`)
so ordinary importers/re-exporters never look like declarations.
*/
const CEILING_ASSIGNMENT_SHAPED = /(^|[^\w.])SCHEMA_BASELINE_VERSION\s*=(?!=)/;

/*
Emitted registry references are path CONSTANTS, not a filename array:
`const X_MIGRATION_PATH = join(MIGRATIONS_DIR, "NNNN_name.sql")` survives tsc and
esbuild bundling as the quoted `"NNNN_name.sql"` basename literal, which is what the
runtime `readFile`s. Slashes are excluded so only basenames qualify.
*/
const REGISTRY_BASENAME = /"(\d{4}_[^"/\\\n]*\.sql)"/g;

/** An asset file is `NNNN_*.sql`; `meta/` and `local_repair_*` rows are not versioned assets. */
const ASSET_BASENAME = /^(\d{4})_[^/\\]*\.sql$/;

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Read the emitted ceiling declarations from a set of emitted claim files.
 *
 * @param {string[]} claimFiles paths of emitted JS files (missing files are skipped)
 * @returns {string[]} sorted unique 4-digit ceiling values declared across the files
 */
export function readEmittedCeilings(claimFiles) {
  return sortedUnique(scanClaimFiles(claimFiles).flatMap((scan) => scan.ceilings));
}

/**
 * Read the 4-digit migration versions the emitted registry references (from the
 * quoted `"NNNN_name.sql"` path-constant literals), NOT a numeric range.
 *
 * @param {string[]} claimFiles
 * @returns {string[]} sorted unique referenced versions
 */
export function readEmittedRegistryVersions(claimFiles) {
  return sortedUnique(scanClaimFiles(claimFiles).flatMap((scan) => scan.references.map((r) => r.version)));
}

/**
 * List versioned `.sql` assets present in an asset directory.
 *
 * A missing directory is a distinguishable EMPTY result (`exists: false`) rather
 * than a throw: "assets dir absent" needs its own actionable message downstream,
 * and it must not masquerade as "dir present but empty" or vice versa.
 *
 * @param {string} assetsDir
 * @returns {{ exists: boolean, versions: string[], basenames: string[] }}
 */
export function listAssetVersions(assetsDir) {
  let entries;
  try {
    entries = readdirSync(assetsDir, { withFileTypes: true });
  } catch {
    return { exists: false, versions: [], basenames: [] };
  }
  const basenames = [];
  const versions = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ASSET_BASENAME.exec(entry.name);
    if (!match) continue;
    basenames.push(entry.name);
    versions.push(match[1]);
  }
  basenames.sort();
  return { exists: true, versions: sortedUnique(versions), basenames };
}

/**
 * Read every emitted claim file once and extract, per file, the ceilings it
 * declares, the registry basenames it references, and whether it carries an
 * unparseable assignment-shaped ceiling. Internal shared scan for the exported
 * readers and the verdict below (files are small; no caching needed).
 */
function scanClaimFiles(claimFiles) {
  const scans = [];
  for (const file of claimFiles) {
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      scans.push({ file, ceilings: [], references: [], unreadable: true, readError: String(error?.code ?? error) });
      continue;
    }
    const ceilings = [];
    for (const match of text.matchAll(CEILING_DECLARATION)) ceilings.push(match[1]);
    const references = [];
    for (const match of text.matchAll(REGISTRY_BASENAME)) references.push({ version: match[1].slice(0, 4), basename: match[1] });
    const declared = ceilings.length > 0;
    const assignmentShaped = CEILING_ASSIGNMENT_SHAPED.test(text);
    scans.push({
      file,
      ceilings: sortedUnique(ceilings),
      references,
      // A file that ASSIGNS the ceiling token but yields no parseable 4-digit
      // literal is an unparseable claim — refuse rather than silently treat the
      // package as having no ceiling.
      unreadable: assignmentShaped && !declared,
    });
  }
  return scans;
}

/**
 * Evaluate one package's built-artifact ceiling contract.
 *
 * @param {object} options
 * @param {string} options.packageDir repo-relative package directory, for attribution only
 * @param {string[]} options.claimFiles emitted JS files that may carry the ceiling claim / registry
 * @param {string} options.assetsDir emitted asset directory that must honor the claim
 * @returns {{
 *   packageDir: string, assetsDir: string,
 *   status: "ok" | "drift" | "unreadable-claim" | "not-built",
 *   claimFileCount: number, ceilings: string[], ceiling: string|null,
 *   registryVersions: string[], registryRefCount: number,
 *   assetsExist: boolean, assetVersions: string[], highestAsset: string|null, assetCount: number,
 *   ceilingHonored: boolean,
 *   missing: Array<{ version: string, basename: string, referencedBy: string, kind: "absent-version" | "stale-basename" }>,
 *   unreadableClaims: Array<{ file: string, reason: string }>,
 * }} structured verdict (never throws for drift-shaped trees)
 */
export function evaluatePackageContract({ packageDir, claimFiles, assetsDir }) {
  const scans = scanClaimFiles(claimFiles);
  const ceilings = sortedUnique(scans.flatMap((scan) => scan.ceilings));
  const registryVersions = sortedUnique(scans.flatMap((scan) => scan.references.map((r) => r.version)));
  const assetScan = listAssetVersions(assetsDir);
  const assetBasenames = new Set(assetScan.basenames);
  const assetVersionSet = new Set(assetScan.versions);
  const highestAsset = assetScan.versions.length > 0 ? assetScan.versions[assetScan.versions.length - 1] : null;
  // Highest ceiling governs: the stale-binary guard compares against the ceiling the
  // runtime actually presents, and a bundle set could carry divergent literals (max is
  // the honest promise to keep). Ceiling values are fixed-width numeric strings, so
  // lexicographic order equals numeric order.
  const ceiling = ceilings.length > 0 ? ceilings[ceilings.length - 1] : null;

  // Per-reference missing set: every registry-referenced basename at or below the
  // ceiling that the SAME package's emitted assets do not provide. Two kinds:
  //  - absent-version: no `NNNN_*.sql` at all for that version;
  //  - stale-basename: an asset for that version exists but under a different
  //    basename, which ENOENTs the runtime's exact-basename readFile just the same.
  const missing = [];
  const seenBasenames = new Set();
  if (ceiling !== null) {
    for (const scan of scans) {
      for (const reference of scan.references) {
        if (reference.version > ceiling) continue; // assets ABOVE the ceiling are legal future rows; only <= is promised.
        if (assetBasenames.has(reference.basename) || seenBasenames.has(reference.basename)) continue;
        seenBasenames.add(reference.basename);
        missing.push({
          version: reference.version,
          basename: reference.basename,
          referencedBy: scan.file,
          kind: assetVersionSet.has(reference.version) ? "stale-basename" : "absent-version",
        });
      }
    }
  }
  missing.sort((a, b) => a.version.localeCompare(b.version) || a.basename.localeCompare(b.basename));

  const ceilingHonored = ceiling === null ? true : highestAsset !== null && highestAsset >= ceiling;

  let status = "ok";
  if (scans.length === 0) {
    // Nothing emitted: this is a SKIP with a printed note downstream, never a silent pass.
    status = "not-built";
  } else if (scans.some((scan) => scan.unreadable)) {
    status = "unreadable-claim";
  } else if (missing.length > 0 || !ceilingHonored) {
    status = "drift";
  }

  return {
    packageDir,
    assetsDir,
    status,
    claimFileCount: scans.length,
    ceilings,
    ceiling,
    registryVersions,
    registryRefCount: scans.reduce((sum, scan) => sum + scan.references.length, 0),
    assetsExist: assetScan.exists,
    assetVersions: assetScan.versions,
    highestAsset,
    assetCount: assetScan.basenames.length,
    ceilingHonored,
    missing,
    unreadableClaims: scans
      .filter((scan) => scan.unreadable)
      .map((scan) => ({ file: scan.file, reason: scan.readError ?? "SCHEMA_BASELINE_VERSION assigned a value the ceiling pattern cannot parse" })),
  };
}
