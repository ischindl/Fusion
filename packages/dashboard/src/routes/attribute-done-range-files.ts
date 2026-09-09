type AttributionSource = "trailer" | "subject-prefix" | "bracketed-prefix" | "none";

/*
FNXC:TaskDiffAttribution 2026-09-09-22:05:
RUFU-207 batched per-commit file resolution. Cost driver (measured in production
2026-09-09; dashboard live RSS 2.07 GB, 24 cores, load 9.7→16.4): one subprocess spawn costs
1.15 ms main-thread CPU at 0.06 GB live RSS but 31.7 ms at 2.02 GB live RSS with the default
heap cap (28-48 ms under NODE_OPTIONS=--max-old-space-size=16384; only 1.35 ms at that cap
with an idle heap — so the parent's LIVE RESIDENT PAGES drive spawn cost, not the V8 heap cap;
GC was 11.9% of CPU). The old serial `diff-tree` loop paid that ~30 ms tax once per own commit:
a 20-commit done range cost ~0.6 s of serialized event-loop stall per request, paid again by
/file-diffs. The batch below makes the whole own-commit set cost ONE name-resolution call.
*/

/**
 * Max own shas per batched invocation. 500 keeps argv far below ARG_MAX and one chunk's
 * output below runGitCommand's 10 MB maxBuffer; only pathologically large ranges (>500 own
 * commits) add a second batched call beyond the 1-log + 1-batch target.
 */
const OWN_FILES_BATCH_CHUNK_SIZE = 500;

/** Block headers are `%x00%H` — a NUL byte (impossible inside a git path) then the full sha. */
const OWN_SHA_BATCH_HEADER_RE = /^\x00([0-9a-f]{40})$/;

/*
FNXC:TaskDiffAttribution 2026-09-09-22:35:
Content-addressed attribution cache, mirroring the house TaskLaneCache idiom (plain Map,
insertion-order eviction, injectable clock — packages/core/src/task-lane-cache.ts). The key is
worktreePath + baseRef + the SORTED own-commit sha list, so a landed commit that changes the
range changes the key by itself: no time-based invalidation is required for correctness and the
TTL only bounds memory. TTL is capped at 10 s to match sessionFilesCache/fileDiffsCache
(register-session-diff-routes.ts:46/:47), so attribution can never hold a newer-truth answer
longer than the payload caches already mask — the two layers never compound staleness.

Because the key contains the own shas, the shas must be known before the key can be formed:
a sequential re-ask always costs exactly the one enumeration `git log` (zero name-resolution
spawns), never zero. The zero-spawn reading of "re-ask spawns nothing" is delivered by the
in-flight coalescing map below, which is keyed worktreePath + baseRef + taskId and covers the
WHOLE function: a concurrent /diff + /file-diffs pair for one card shares a single attribution
promise (one enumeration + one batch between them, not two). The flight entry is deleted on
settle — including rejection — so a transient git failure is never cached nor coalesced past
its own lifetime; settled failures never enter the value cache either (only successes write).
*/
export const DONE_RANGE_ATTRIBUTION_TTL_MS = 10_000;
const OWN_FILES_CACHE_MAX = 256;

interface OwnFilesCacheEntry {
  files: string[];
  at: number;
}

const ownFilesByCommitSet = new Map<string, OwnFilesCacheEntry>();
const inFlightAttribution = new Map<string, Promise<DoneRangeAttributionResult>>();
let attributionClock: () => number = Date.now;

/** Test hook: clears both caches and swaps in a fake clock so TTL paths need no sleeping. */
export function __resetDoneRangeAttributionForTests(now?: () => number): void {
  ownFilesByCommitSet.clear();
  inFlightAttribution.clear();
  attributionClock = now ?? Date.now;
}

function readOwnFilesCache(key: string): string[] | undefined {
  const entry = ownFilesByCommitSet.get(key);
  if (!entry) return undefined;
  if (attributionClock() - entry.at >= DONE_RANGE_ATTRIBUTION_TTL_MS) {
    ownFilesByCommitSet.delete(key);
    return undefined;
  }
  // Refresh insertion order without changing the recorded cache time (TaskLaneCache idiom).
  ownFilesByCommitSet.delete(key);
  ownFilesByCommitSet.set(key, entry);
  return entry.files;
}

function writeOwnFilesCache(key: string, files: string[]): void {
  ownFilesByCommitSet.delete(key);
  ownFilesByCommitSet.set(key, { files, at: attributionClock() });
  while (ownFilesByCommitSet.size > OWN_FILES_CACHE_MAX) {
    ownFilesByCommitSet.delete(ownFilesByCommitSet.keys().next().value!);
  }
}

export interface DoneRangeAttributionOptions {
  worktreePath: string;
  baseRef: string;
  taskId: string;
  runGit: (args: string[]) => Promise<string>;
}

export interface DoneRangeAttributionResult {
  files: string[];
  ownCommitShas: string[];
  foreignCommitCount: number;
}

function extractAttributedTaskId(body: string): string | null {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return last?.[1] ?? null;
}

function extractTaskIdFromSubject(subject: string): {
  attributedTaskId: string | null;
  source: Extract<AttributionSource, "subject-prefix" | "bracketed-prefix" | "none">;
} {
  if (!subject) {
    return { attributedTaskId: null, source: "none" };
  }

  const conventional =
    /^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\s*\(([A-Z]+-\d+)\)!?:/i.exec(subject);
  if (conventional?.[1]) {
    return { attributedTaskId: conventional[1].toUpperCase(), source: "subject-prefix" };
  }

  const bracketed = /^\s*\[([A-Z]+-\d+)\]/i.exec(subject);
  if (bracketed?.[1]) {
    return { attributedTaskId: bracketed[1].toUpperCase(), source: "bracketed-prefix" };
  }

  const colon = /^\s*([A-Z]+-\d+):/i.exec(subject);
  if (colon?.[1]) {
    return { attributedTaskId: colon[1].toUpperCase(), source: "subject-prefix" };
  }

  return { attributedTaskId: null, source: "none" };
}

function taskIdsMatch(a: string | null, b: string): boolean {
  return a !== null && a.toUpperCase() === b.toUpperCase();
}

/*
FNXC:TaskDiffAttribution 2026-09-09-22:05:
Why the batch rides `git log --no-walk` and not the multi-sha `git diff-tree` the task spec
also suggested (measured on git 2.55, the version this host ships):

- `git diff-tree --name-only -r <sha1> <sha2> ...` prints NOTHING for multiple shas — plumbing
  treats extra tree-ish args as a tree-vs-tree comparison, which is precisely the "file list
  merged across commits" answer the spec forbids. The batching alternative named in the
  Original Description (`git log ... --name-only` over the own-commit set) is what lands here.
- Flag parity, measured shape-for-shape against `diff-tree --no-commit-id --name-only -r`:
  - `--no-renames`: porcelain `log` applies rename detection by default and collapses a rename
    to the new path, while plumbing `diff-tree` ignores `diff.renames` and always prints BOTH
    paths. `--no-renames` forces the porcelain walk to the plumbing contract, config-drift-proof.
  - `--min-parents=1 --max-parents=1`: exactly-single-parent commits are exactly today's
    contributing set. A root commit contributes no files today (`diff-tree -r <root>` prints
    nothing, while plain `log --no-walk <root>` would show them) and merges contribute none
    (`diff-tree -r` without `-m` prints nothing); pinning parent-count filters roots and merges
    out of the displayed set instead of relying on `--diff-merges` config defaults. No `--root`,
    no `-m` — either would invent files today's loop never returned.
  - `--no-show-signature`: a user's `log.showSignature` would otherwise inject GPG payload
    lines that parse as filenames; an unattributable line would trip the fail-closed fallback
    anyway, so suppressing signatures keeps the fast path fast.
  - Header sentinel `%x00%H` instead of a bare 40-hex line: a file can be legitimately named a
    40-hex string, but no path can contain NUL, so block attribution is unambiguous.
- Quoting parity: both forms honor `core.quotePath`, so octal-escaped non-ASCII paths render
  byte-identically; `runGitCommand`'s 10 MB maxBuffer and timeout now bound the batched output
  the same way they bound the log enumeration.
- Exec failures propagate (the routes' catch/fall-through semantics are unchanged); ONLY a
  parse anomaly fails closed to the correct-but-slow per-sha loop for the whole range.
*/
function parseOwnFilesBatch(output: string, requestedShas: Set<string>): Set<string> | null {
  const files = new Set<string>();
  let sawHeader = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // git separates the header from the name list with a blank line
    if (trimmed.startsWith("\x00")) {
      const header = OWN_SHA_BATCH_HEADER_RE.exec(trimmed);
      if (!header || !requestedShas.has(header[1]!)) return null; // unattributable block
      sawHeader = true;
      continue;
    }
    if (!sawHeader) return null; // file line before any block header
    files.add(trimmed);
  }
  return files;
}

/** Today's contract verbatim: serial per-sha plumbing, correct at any commit count, O(n) spawns. */
async function listFilesPerSha(shas: string[], runGit: (args: string[]) => Promise<string>): Promise<Set<string>> {
  const fileSet = new Set<string>();
  for (const sha of shas) {
    const diffTreeOutput = await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    for (const file of diffTreeOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      fileSet.add(file);
    }
  }
  return fileSet;
}

/**
 * Resolve every own commit's files in ceil(n / 500) `git log --no-walk` calls. Returns null
 * only when the batched output cannot be attributed (unknown/unrequested block); callers then
 * fall back to `listFilesPerSha` for the WHOLE range — fail closed to correct-but-slow, never
 * guess ownership.
 */
async function listFilesBatched(
  sortedShas: string[],
  runGit: (args: string[]) => Promise<string>,
): Promise<Set<string> | null> {
  const fileSet = new Set<string>();
  for (let offset = 0; offset < sortedShas.length; offset += OWN_FILES_BATCH_CHUNK_SIZE) {
    const chunk = sortedShas.slice(offset, offset + OWN_FILES_BATCH_CHUNK_SIZE);
    const output = await runGit([
      "log",
      "--no-walk",
      "--no-show-signature",
      "--min-parents=1",
      "--max-parents=1",
      "--no-renames",
      "--format=%x00%H",
      "--name-only",
      ...chunk,
    ]);
    const parsed = parseOwnFilesBatch(output, new Set(chunk));
    if (!parsed) return null;
    for (const file of parsed) fileSet.add(file);
  }
  return fileSet;
}

async function collectFilesForOwnCommits(
  ownCommitShas: string[],
  runGit: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const sortedShas = [...ownCommitShas].sort();
  const batched = await listFilesBatched(sortedShas, runGit);
  if (batched) return batched;
  return listFilesPerSha(sortedShas, runGit);
}

export async function filterFilesToOwnTaskCommits(opts: DoneRangeAttributionOptions): Promise<DoneRangeAttributionResult> {
  const flightKey = [opts.worktreePath, opts.baseRef, opts.taskId].join("\u0000");
  const activeFlight = inFlightAttribution.get(flightKey);
  if (activeFlight) return activeFlight;
  const flight = runAttribution(opts).finally(() => {
    inFlightAttribution.delete(flightKey);
  });
  inFlightAttribution.set(flightKey, flight);
  return flight;
}

async function runAttribution(opts: DoneRangeAttributionOptions): Promise<DoneRangeAttributionResult> {
  const logOutput = await opts.runGit(["log", "--format=%H%x00%s%x00%B%x1e", `${opts.baseRef}..HEAD`]);

  if (!logOutput.trim()) {
    return { files: [], ownCommitShas: [], foreignCommitCount: 0 };
  }

  const ownCommitShas: string[] = [];
  let foreignCommitCount = 0;

  const records = logOutput
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);

  for (const record of records) {
    const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
    if (!sha) continue;
    const body = bodyParts.join("\x00");

    const trailerAttributedTaskId = extractAttributedTaskId(body);
    const subjectAttribution = trailerAttributedTaskId
      ? { attributedTaskId: null, source: "none" as const }
      : extractTaskIdFromSubject(subject);
    const attributedTaskId = trailerAttributedTaskId ?? subjectAttribution.attributedTaskId;

    if (taskIdsMatch(attributedTaskId, opts.taskId)) {
      ownCommitShas.push(sha);
    } else {
      foreignCommitCount += 1;
    }
  }

  if (ownCommitShas.length === 0) {
    // Foreign-only range: today's loop body never runs, so this short-circuit keeps the
    // exact old call pattern — one enumeration call, zero name-resolution calls. It also
    // skips the value cache: the answer re-reads live foreign counts on every re-ask.
    return { files: [], ownCommitShas, foreignCommitCount };
  }

  // Content-addressed value cache: a re-ask of the SAME own-sha set returns cached files
  // (the set only changes when the range changes), so the only unavoidable cost of a
  // sequential re-ask is the enumeration call that just learned the sha set.
  const cacheKey = [opts.worktreePath, opts.baseRef, ...[...ownCommitShas].sort()].join("\u0000");
  const cached = readOwnFilesCache(cacheKey);
  if (cached) {
    return { files: [...cached], ownCommitShas, foreignCommitCount };
  }

  const fileSet = await collectFilesForOwnCommits(ownCommitShas, opts.runGit);
  const files = [...fileSet].sort((a, b) => a.localeCompare(b));
  writeOwnFilesCache(cacheKey, files);

  return { files, ownCommitShas, foreignCommitCount };
}
