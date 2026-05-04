#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const rootDir = process.env.FUSION_PROJECT_DIR
  ? path.resolve(process.env.FUSION_PROJECT_DIR)
  : process.cwd();

/** @type {string} Cache format version — bump when the shape or hash inputs change. */
const CACHE_FORMAT_VERSION = 1;

/** @type {string} Constant mixed into every content hash so format rev busts all entries. */
const HASH_VERSION_PREFIX = "v1";

/** @type {number} Max age (ms) for a cache entry to count as a pass. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitOutput(gitArgs) {
  const result = spawnSync("git", gitArgs, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function getBaseBranch() {
  const changesetConfigPath = path.join(rootDir, ".changeset", "config.json");
  const changesetConfig = JSON.parse(readFileSync(changesetConfigPath, "utf8"));
  return changesetConfig.baseBranch || "main";
}

function listWorkspacePackages() {
  const packagesDir = path.join(rootDir, "packages");
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const packageNameByDir = new Map();
  for (const dir of packageDirs) {
    try {
      const packageJsonPath = path.join(packagesDir, dir, "package.json");
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (typeof pkg.name === "string") {
        packageNameByDir.set(dir, pkg.name);
      }
    } catch {
      // ignore directories without package.json
    }
  }

  return packageNameByDir;
}

export function shouldForceFullSuite(changedFiles) {
  const fullSuitePaths = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".changeset/config.json",
    "vitest.workspace.ts",
    "eslint.config.mjs",
    "tsconfig.base.json",
    "scripts/test-with-lock.mjs",
    "scripts/test-changed.mjs",
  ];

  return changedFiles.some((file) => {
    if (fullSuitePaths.includes(file)) {
      return true;
    }

    if (file.startsWith(".github/workflows/") || file.startsWith("scripts/test-") || file.startsWith("scripts/check-test-")) {
      return true;
    }

    if (file.startsWith("packages/") && /vitest|test/.test(path.basename(file))) {
      return false;
    }

    if (!file.startsWith("packages/") && !file.startsWith("docs/")) {
      return true;
    }

    return false;
  });
}

function detectComparisonBase(baseBranch) {
  const candidates = [
    `origin/${baseBranch}`,
    `refs/remotes/origin/${baseBranch}`,
    baseBranch,
  ];

  for (const candidate of candidates) {
    const mergeBase = gitOutput(["merge-base", "HEAD", candidate]);
    if (mergeBase) {
      return mergeBase;
    }
  }

  return null;
}

function changedFilesSince(baseSha) {
  const diff = gitOutput(["diff", "--name-only", `${baseSha}...HEAD`]);
  if (diff === null) {
    return null;
  }
  if (!diff) {
    return [];
  }
  return diff.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

export function resolveAffectedPackages(changedFiles, packageNameByDir) {
  const affected = new Set();

  for (const file of changedFiles) {
    if (!file.startsWith("packages/")) {
      continue;
    }

    const [, dir] = file.split("/");
    const packageName = packageNameByDir.get(dir);
    if (!packageName) {
      return null;
    }
    affected.add(packageName);
  }

  return [...affected];
}

// ---------------------------------------------------------------------------
// Content-hash cache
// ---------------------------------------------------------------------------

/**
 * @typedef {{ hash: string; passedAt: string; command: string }} CacheEntry
 * @typedef {{ version: number; entries: Record<string, CacheEntry> }} CacheFile
 */

/**
 * Return the path to the per-project test-cache JSON file.
 * Honours FUSION_PROJECT_DIR (already reflected in rootDir).
 *
 * @returns {string}
 */
export function cacheFilePath() {
  return path.join(rootDir, ".fusion", "test-cache.json");
}

/**
 * Read and parse the cache file. Returns an empty cache structure on any
 * read/parse failure (corruption, missing file, etc.) and logs a warning.
 *
 * @param {string} filePath
 * @returns {CacheFile}
 */
export function readCache(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === CACHE_FORMAT_VERSION &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return parsed;
    }
    console.warn("[test-changed] cache file has unexpected shape; treating as empty.");
    return { version: CACHE_FORMAT_VERSION, entries: {} };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[test-changed] could not read cache (${err.message}); treating as empty.`);
    }
    return { version: CACHE_FORMAT_VERSION, entries: {} };
  }
}

/**
 * Atomically write the cache file (write to temp then rename).
 *
 * @param {string} filePath
 * @param {CacheFile} cache
 */
export function writeCache(filePath, cache) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, filePath);
}

/**
 * Compute a stable content hash for a package directory.
 *
 * The hash is SHA-256 over:
 *   - The constant version prefix HASH_VERSION_PREFIX
 *   - The blob SHA of pnpm-lock.yaml at HEAD
 *   - The blob SHA of tsconfig.base.json at HEAD
 *   - Every (relativePath, blobSha) pair from `git ls-files -s <pkgDir>`,
 *     sorted lexicographically by path for stability.
 *
 * Using git blob SHAs means we never read file contents ourselves — git
 * already hashes them, so this is fast even for large packages.
 *
 * @param {string} packageDir  Relative path to the package dir (e.g. "packages/engine")
 * @param {(args: string[]) => string|null} gitFn  Injectable git runner (for tests)
 * @returns {string} 64-char hex SHA-256
 */
export function computePackageHash(packageDir, gitFn = gitOutput) {
  const hash = createHash("sha256");
  hash.update(HASH_VERSION_PREFIX);
  hash.update("\0");

  // Bust when lock file or shared TS config changes.
  for (const rootFile of ["pnpm-lock.yaml", "tsconfig.base.json"]) {
    // `git ls-files -s <path>` → "<mode> <blobSha> <stage>\t<path>"
    const out = gitFn(["ls-files", "-s", rootFile]);
    const blobSha = out ? out.split(/\s+/)[1] ?? "" : "";
    hash.update(rootFile);
    hash.update("=");
    hash.update(blobSha);
    hash.update("\0");
  }

  // All tracked files inside the package directory.
  const lsOut = gitFn(["ls-files", "-s", packageDir]);
  const entries = [];
  if (lsOut) {
    for (const line of lsOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: <mode> SP <object> SP <stage> TAB <file>
      const tabIdx = trimmed.indexOf("\t");
      if (tabIdx === -1) continue;
      const fields = trimmed.slice(0, tabIdx).split(/\s+/);
      const blobSha = fields[1] ?? "";
      const filePath = trimmed.slice(tabIdx + 1);
      entries.push({ filePath, blobSha });
    }
  }

  // Sort for determinism (git output is usually sorted, but let's be explicit).
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
  for (const { filePath, blobSha } of entries) {
    hash.update(filePath);
    hash.update("=");
    hash.update(blobSha);
    hash.update("\0");
  }

  return hash.digest("hex");
}

/**
 * Return a human-readable relative time string like "3h ago" or "2d ago".
 *
 * @param {string} isoTimestamp
 * @returns {string}
 */
function relativeTime(isoTimestamp) {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * @typedef {Object} CacheOptions
 * @property {boolean} [noCache]       When true, bypass cache reads AND writes.
 * @property {(args: string[]) => string|null} [gitFn]  Injectable git runner.
 * @property {() => CacheFile} [readCacheFn]            Injectable cache reader.
 * @property {(cache: CacheFile) => void} [writeCacheFn] Injectable cache writer.
 * @property {Map<string, string>} [packageDirByName]   pkg-name → relative dir.
 */

/**
 * Apply the content-hash cache to an execution plan.
 *
 * This is a SEPARATE function from decideExecutionPlan so it can be tested
 * independently (decideExecutionPlan remains pure / I/O-free).
 *
 * For "full" plans, cache lookups are always skipped (running full means full).
 * For "changed" plans, any package whose hash matches a fresh cache entry is
 * removed from the run set. If all packages are cached, returns a synthetic
 * "all-cached" result so the caller can skip the pnpm invocation entirely.
 *
 * @param {{ mode: string; packages?: string[]; reason?: string }} plan
 * @param {CacheOptions} [options]
 * @returns {{ plan: typeof plan; cachedPackages: string[]; activePackages: string[] }}
 */
export function applyCacheToPlan(plan, options = {}) {
  const {
    noCache = false,
    gitFn = gitOutput,
    readCacheFn,
    writeCacheFn,
    packageDirByName = new Map(),
  } = options;

  // Full suite runs always bypass cache (full means full).
  if (plan.mode !== "changed" || noCache) {
    return { plan, cachedPackages: [], activePackages: plan.packages ?? [] };
  }

  const filePath = cacheFilePath();
  const cache = readCacheFn ? readCacheFn() : readCache(filePath);
  const now = Date.now();

  const cachedPackages = [];
  const activePackages = [];

  for (const pkg of plan.packages ?? []) {
    const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
    const computedHash = computePackageHash(pkgDir, gitFn);
    const entry = cache.entries[pkg];

    const isHit =
      entry &&
      entry.hash === computedHash &&
      now - new Date(entry.passedAt).getTime() < CACHE_MAX_AGE_MS;

    if (isHit) {
      const sha7 = computedHash.slice(0, 7);
      const when = relativeTime(entry.passedAt);
      console.log(`[test-changed] cache HIT  for ${pkg} (hash ${sha7}, passed ${when})`);
      cachedPackages.push(pkg);
    } else {
      activePackages.push(pkg);
    }
  }

  return { plan, cachedPackages, activePackages };
}

/**
 * Persist passing results for the given packages into the cache.
 *
 * @param {string[]} packages
 * @param {Map<string, string>} packageDirByName
 * @param {CacheOptions} [options]
 */
export function recordCachePass(packages, packageDirByName, options = {}) {
  const {
    noCache = false,
    gitFn = gitOutput,
    readCacheFn,
    writeCacheFn,
  } = options;

  if (noCache || packages.length === 0) return;

  const filePath = cacheFilePath();
  const cache = readCacheFn ? readCacheFn() : readCache(filePath);
  const now = new Date().toISOString();

  for (const pkg of packages) {
    const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
    const hash = computePackageHash(pkgDir, gitFn);
    cache.entries[pkg] = { hash, passedAt: now, command: "test" };
  }

  if (writeCacheFn) {
    writeCacheFn(cache);
  } else {
    writeCache(filePath, cache);
  }
}

// ---------------------------------------------------------------------------
// Execution plan
// ---------------------------------------------------------------------------

const workspaceConcurrency =
  process.env.FUSION_TEST_WORKSPACE_CONCURRENCY || "2";

const fullSuiteEnv = {
  ...process.env,
  FUSION_TEST_TOTAL_WORKERS: process.env.FUSION_TEST_TOTAL_WORKERS || "4",
  FUSION_TEST_CONCURRENCY: process.env.FUSION_TEST_CONCURRENCY || "2",
};

function runFullSuite(forwardedArgs) {
  run("pnpm", [`-r`, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs], { env: fullSuiteEnv });
}

export function decideExecutionPlan({
  forceFullSuite,
  comparisonBase,
  changedFiles,
  packageNameByDir,
}) {
  if (forceFullSuite) return { mode: "full", reason: "forced" };
  if (!comparisonBase) return { mode: "full", reason: "missing-comparison-base" };
  if (!changedFiles) return { mode: "full", reason: "diff-failed" };
  if (changedFiles.length === 0) return { mode: "full", reason: "no-changes" };
  if (shouldForceFullSuite(changedFiles)) return { mode: "full", reason: "shared-infra-changed" };

  const affectedPackages = resolveAffectedPackages(changedFiles, packageNameByDir);
  if (!affectedPackages || affectedPackages.length === 0) return { mode: "full", reason: "no-affected-package" };

  return { mode: "changed", packages: affectedPackages };
}

export function main(argv = process.argv.slice(2)) {
  const forceFullSuite =
    process.env.CI === "true" ||
    process.env.FUSION_TEST_FULL === "1" ||
    argv.includes("--full");

  const noCache =
    process.env.FUSION_TEST_NO_CACHE === "1" ||
    argv.includes("--no-cache");

  const forwardedArgs = argv.filter((arg) => arg !== "--full" && arg !== "--no-cache");

  run("pnpm", ["sync:fusion-skill:check"]);

  const baseBranch = getBaseBranch();
  const comparisonBase = detectComparisonBase(baseBranch);
  const changedFiles = comparisonBase ? changedFilesSince(comparisonBase) : null;
  const packageNameByDir = listWorkspacePackages();

  // Build reverse map: pkg-name → relative dir (e.g. "packages/engine")
  const packageDirByName = new Map();
  for (const [dir, name] of packageNameByDir) {
    packageDirByName.set(name, `packages/${dir}`);
  }

  const plan = decideExecutionPlan({
    forceFullSuite,
    comparisonBase,
    changedFiles,
    packageNameByDir,
  });

  if (plan.mode === "full") {
    if (plan.reason === "missing-comparison-base") {
      console.log(`[test-changed] could not resolve merge-base with ${baseBranch}; running full suite.`);
    } else if (plan.reason === "diff-failed") {
      console.log("[test-changed] failed to read git diff; running full suite.");
    } else if (plan.reason === "no-changes") {
      console.log("[test-changed] no changes detected against base; running full suite.");
    } else if (plan.reason === "shared-infra-changed") {
      console.log("[test-changed] shared/root test infrastructure changed; running full suite.");
    } else if (plan.reason === "no-affected-package") {
      console.log("[test-changed] no affected workspace package resolved; running full suite.");
    }

    runFullSuite(forwardedArgs);
    return;
  }

  // Apply the content-hash cache to prune already-passing packages.
  const { cachedPackages, activePackages } = applyCacheToPlan(plan, {
    noCache: noCache || forceFullSuite,
    packageDirByName,
  });

  if (activePackages.length === 0) {
    console.log(
      `[test-changed] all changed packages are cache-fresh (${cachedPackages.join(", ")}); nothing to run.`,
    );
    return;
  }

  const filterArgs = activePackages.flatMap((pkg) => ["--filter", pkg]);
  console.log(`[test-changed] running tests for changed packages: ${activePackages.join(", ")}`);
  if (cachedPackages.length > 0) {
    console.log(`[test-changed] skipping cached packages: ${cachedPackages.join(", ")}`);
  }

  run("pnpm", [...filterArgs, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs], { env: fullSuiteEnv });

  // Tests passed — record in cache (never cache failures; process.exit on failure above).
  recordCachePass(activePackages, packageDirByName, { noCache });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
