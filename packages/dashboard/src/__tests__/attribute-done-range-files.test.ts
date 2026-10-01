// @vitest-environment node
/*
FNXC:TaskDiffAttribution 2026-09-09-21:21:
RUFU-207 differential-oracle suite for done-range git attribution. The per-sha `git diff-tree` loop
inside filterFilesToOwnTaskCommits cost one subprocess per own commit (O(n) panel latency on
rebase-heavy cards). Batching changes HOW files are enumerated, so the acceptance contract is that
the observable result — files, ownCommitShas, foreignCommitCount — stays byte-identical. This file
pins the pre-batching behavior as an oracle (referenceFilterFilesToOwnTaskCommits is copied verbatim
from the implementation at RUFU-207 Step 1, including its private attribution helpers) and compares
the live module against it on real git fixtures covering every shape the batched parser must not
drift on: merge commits (contribute no files), root commits (contribute no files — measured on git
2.55: `diff-tree -r <root>` prints nothing), rename commits (`diff-tree --name-only -r` renders BOTH
old and new path — it does NOT detect renames), deletions, empty commits (header, zero files), the
same path touched by two commits (dedupes to one entry), unicode/space paths (git's quoted octal
rendering), and foreign-only/empty ranges (short-circuit without any file-enumeration call).

Measured on git 2.55 while designing the batch: `git diff-tree --name-only -r sha1 sha2 ...` prints
NOTHING for multiple shas (it is not a per-commit batching tool), so the batch must ride
`git log --no-walk` per-commit blocks instead.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DONE_RANGE_ATTRIBUTION_TTL_MS,
  __resetDoneRangeAttributionForTests,
  filterFilesToOwnTaskCommits,
} from "../routes/attribute-done-range-files.js";
import { runGitCommand } from "../routes/resolve-diff-base.js";

type AttributionOptions = Parameters<typeof filterFilesToOwnTaskCommits>[0];
type AttributionResult = Awaited<ReturnType<typeof filterFilesToOwnTaskCommits>>;

const openRepos: string[] = [];

// Module caches persist across tests in a file; reset them (and install a fake clock for the
// TTL tests below) so every test starts from a cold cache and time never advances by itself.
let fakeNow = 0;
beforeEach(() => {
  fakeNow = 1_000;
  __resetDoneRangeAttributionForTests(() => fakeNow);
});

afterEach(() => {
  while (openRepos.length > 0) {
    const dir = openRepos.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-attribution-"));
  openRepos.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "kb-tests@example.com"]);
  git(dir, ["config", "user.name", "KB Tests"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
  git(dir, ["add", "base.ts"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

function commitFiles(dir: string, subject: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    const parent = dirname(abs);
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content);
    git(dir, ["add", "--", rel]);
  }
  git(dir, ["commit", "-qm", subject]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function emptyCommit(dir: string, subject: string): string {
  git(dir, ["commit", "-q", "--allow-empty", "-m", subject]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Records every git call the attribution module makes against the fixture dir. */
function makeRecordingRunner(dir: string): { calls: string[][]; runGit: AttributionOptions["runGit"] } {
  const calls: string[][] = [];
  return {
    calls,
    runGit: async (args: string[]) => {
      calls.push([...args]);
      return runGitCommand(args, dir);
    },
  };
}

function attributionOpts(dir: string, runGit: AttributionOptions["runGit"], baseRef: string): AttributionOptions {
  return { worktreePath: dir, baseRef, taskId: "T-7", runGit };
}

function baseRefOf(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]);
}

/*
 * Oracle: verbatim copy of filterFilesToOwnTaskCommits as implemented at RUFU-207 Step 1
 * (single `git log` enumeration + serial per-sha `git diff-tree --no-commit-id --name-only -r`).
 * The live module must keep returning exactly what this returns for every fixture below.
 * Do not "fix" anything here — it encodes the pre-batching contract byte-for-byte.
 */
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
  source: "subject-prefix" | "bracketed-prefix" | "none";
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

async function referenceFilterFilesToOwnTaskCommits(opts: AttributionOptions): Promise<AttributionResult> {
  const logOutput = await opts.runGit(["log", "--format=%H%x00%s%x00%B%x1e", `${opts.baseRef}..HEAD`]);

  if (!logOutput.trim()) {
    return { files: [], ownCommitShas: [], foreignCommitCount: 0 };
  }

  const fileSet = new Set<string>();
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

  for (const sha of ownCommitShas) {
    const diffTreeOutput = await opts.runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    for (const file of diffTreeOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      fileSet.add(file);
    }
  }

  return {
    files: [...fileSet].sort((a, b) => a.localeCompare(b)),
    ownCommitShas,
    foreignCommitCount,
  };
}

async function expectMatchesOracle(dir: string, baseRef: string): Promise<AttributionResult> {
  const oracleRunner = makeRecordingRunner(dir);
  const moduleRunner = makeRecordingRunner(dir);
  const expected = await referenceFilterFilesToOwnTaskCommits(attributionOpts(dir, oracleRunner.runGit, baseRef));
  const actual = await filterFilesToOwnTaskCommits(attributionOpts(dir, moduleRunner.runGit, baseRef));
  expect(actual).toEqual(expected);
  return actual;
}

describe("filterFilesToOwnTaskCommits differential oracle (RUFU-207)", () => {
  it("matches the oracle for a single own commit", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): add feature", { "feature.ts": "export const f = 1;\n" });
    const result = await expectMatchesOracle(dir, baseRef);
    expect(result.files).toEqual(["feature.ts"]);
    expect(result.ownCommitShas).toHaveLength(1);
    expect(result.foreignCommitCount).toBe(0);
  });

  it("matches the oracle across merge/rename/delete/empty/unicode own-commit shapes", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "chore(T-7): add temp and alpha", {
      "temp.ts": "export const temp = 1;\n",
      "alpha.ts": "export const alpha = 1;\n",
    });
    commitFiles(dir, "vendor update from upstream", { "vendor.ts": "export const v = 1;\n" });
    git(dir, ["mv", "alpha.ts", "beta.ts"]);
    git(dir, ["commit", "-qm", "fix(T-7): rename alpha to beta"]);
    git(dir, ["rm", "-q", "temp.ts"]);
    git(dir, ["commit", "-qm", "fix(T-7): remove temp"]);
    emptyCommit(dir, "test(T-7): no-op checkpoint");
    git(dir, ["checkout", "-qb", "side"]);
    commitFiles(dir, "vendor side work", { "side.ts": "export const s = 1;\n" });
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "--no-ff", "-q", "-m", "feat(T-7): merge vendor side", "side"]);
    commitFiles(dir, "docs(T-7): unicode notes", { "sp ace/unié.md": "# notes\n" });

    const result = await expectMatchesOracle(dir, baseRef);
    // Rename renders BOTH paths (measured: `diff-tree --name-only -r` does not detect renames).
    expect(result.files).toContain("alpha.ts");
    expect(result.files).toContain("beta.ts");
    expect(result.files).toContain("temp.ts");
    // git renders non-ASCII paths quoted-octal by default (core.quotePath); accept either
    // rendering — the point is both sides of the oracle produce the same string.
    expect(result.files.some((f) => f === "sp ace/unié.md" || f.startsWith('"sp ace/uni'))).toBe(true);
    // Foreign commits contribute nothing.
    expect(result.files).not.toContain("vendor.ts");
    expect(result.files).not.toContain("side.ts");
    expect(result.foreignCommitCount).toBe(2);
  });

  it("matches the oracle when a merge commit in the own set has a single-parent sibling with the same file", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): seed shared", { "shared.ts": "export const shared = 1;\n" });
    git(dir, ["checkout", "-qb", "side"]);
    commitFiles(dir, "side branch work", { "side-only.ts": "export const s = 1;\n" });
    git(dir, ["checkout", "-q", "main"]);
    commitFiles(dir, "feat(T-7): touch shared again", { "shared.ts": "export const shared = 2;\n" });
    git(dir, ["merge", "--no-ff", "-q", "-m", "feat(T-7): absorb side", "side"]);
    const result = await expectMatchesOracle(dir, baseRef);
    expect(result.files).toEqual(["shared.ts"]);
  });

  it("matches the oracle when a root commit appears in the own range (orphan branch absorbed by merge)", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    // An orphan branch's tip is a root commit (0 parents); merging it with
    // --allow-unrelated-histories pulls that root into `baseRef..HEAD`.
    git(dir, ["checkout", "-q", "--orphan", "orphan"]);
    git(dir, ["rm", "-q", "-r", "--cached", "."]);
    git(dir, ["clean", "-qfd"]);
    writeFileSync(join(dir, "orphan.ts"), "export const o = 1;\n");
    git(dir, ["add", "orphan.ts"]);
    git(dir, ["commit", "-qm", "feat(T-7): orphan root"]);
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "--allow-unrelated-histories", "--no-ff", "-q", "-m", "feat(T-7): absorb orphan", "orphan"]);

    const result = await expectMatchesOracle(dir, baseRef);
    // Today `diff-tree -r <root>` prints nothing, so the orphan's file is invisible to
    // attribution on both sides of the oracle comparison.
    expect(result.files).toEqual([]);
    expect(result.ownCommitShas).toHaveLength(2);
    expect(result.foreignCommitCount).toBe(0);
  });

  it("matches the oracle when the same file is touched by two own commits", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): first touch", { "dupe.ts": "1\n" });
    commitFiles(dir, "fix(T-7): second touch", { "dupe.ts": "2\n", "other.ts": "x\n" });
    const result = await expectMatchesOracle(dir, baseRef);
    expect(result.files).toEqual(["dupe.ts", "other.ts"]);
  });

  it("short-circuits a foreign-only range with one call and no file enumeration", async () => {
    const dir = makeRepo();
    commitFiles(dir, "unrelated upstream commit", { "foreign.ts": "1\n" });
    const runner = makeRecordingRunner(dir);
    const result = await filterFilesToOwnTaskCommits({
      worktreePath: dir,
      baseRef: "HEAD~1",
      taskId: "T-7",
      runGit: runner.runGit,
    });
    expect(result).toEqual({ files: [], ownCommitShas: [], foreignCommitCount: 1 });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls.some((args) => args.includes("--name-only"))).toBe(false);
  });

  it("short-circuits an empty range with one call", async () => {
    const dir = makeRepo();
    const runner = makeRecordingRunner(dir);
    const result = await filterFilesToOwnTaskCommits({
      worktreePath: dir,
      baseRef: "HEAD",
      taskId: "T-7",
      runGit: runner.runGit,
    });
    expect(result).toEqual({ files: [], ownCommitShas: [], foreignCommitCount: 0 });
    expect(runner.calls).toHaveLength(1);
  });

  it("enumerates a 20-own-commit range in at most two git calls with zero per-sha diff-tree calls", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 20; i += 1) {
      commitFiles(dir, `feat(T-7): change ${String(i).padStart(2, "0")}`, {
        [`file${String(i).padStart(2, "0")}.ts`]: `export const n = ${i};\n`,
      });
    }
    const runner = makeRecordingRunner(dir);
    const result = await filterFilesToOwnTaskCommits({
      worktreePath: dir,
      baseRef: "HEAD~20",
      taskId: "T-7",
      runGit: runner.runGit,
    });
    expect(result.ownCommitShas).toHaveLength(20);
    expect(result.files).toHaveLength(20);
    // RUFU-207 economy contract: one call enumerates commits, ONE call resolves every file.
    // Red on main: the per-sha loop makes this 1 + 20 calls, all 20 via diff-tree.
    expect(runner.calls.length).toBeLessThanOrEqual(2);
    expect(runner.calls.filter((args) => args[0] === "diff-tree")).toHaveLength(0);
  });

  it("keeps oracle parity for a 20-own-commit range", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    for (let i = 0; i < 20; i += 1) {
      commitFiles(dir, `feat(T-7): change ${String(i).padStart(2, "0")}`, {
        [`file${String(i).padStart(2, "0")}.ts`]: `export const n = ${i};\n`,
        "shared.ts": `round ${i}\n`,
      });
    }
    const result = await expectMatchesOracle(dir, baseRef);
    expect(result.ownCommitShas).toHaveLength(20);
    expect(result.files).toHaveLength(21); // 20 unique files + one deduped shared path
  });
});

/*
FNXC:TaskDiffAttribution 2026-09-09-22:05:
Step-2 fast-path tests. Both assert a batch call (args carrying "--no-walk" + "--name-only")
was ATTEMPTED — the pre-batching module never issues such a call, so these assertions are red
against old code by construction: they prove the two-call economy runs through the batch, not
by vacuously surviving a silent fallback.
*/
describe("filterFilesToOwnTaskCommits batched fast path (RUFU-207 Step 2)", () => {
  function batchCalls(calls: string[][]): string[][] {
    return calls.filter((args) => args[0] === "log" && args.includes("--no-walk") && args.includes("--name-only"));
  }

  it("issues one batched call carrying every own sha and the plumbing-parity flags", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): first", { "a.txt": "a\n" });
    commitFiles(dir, "feat(T-7): seed b", { "b.txt": "original\n" });
    git(dir, ["checkout", "-qb", "side"]);
    commitFiles(dir, "feat(T-7): touch b on side", { "b.txt": "moved\n" });
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "--no-ff", "-q", "-m", "feat(T-7): merge side", "side"]);

    const runner = makeRecordingRunner(dir);
    const result = await filterFilesToOwnTaskCommits(attributionOpts(dir, runner.runGit, baseRef));

    // The answer must match the pure per-sha oracle...
    const oracleRunner = makeRecordingRunner(dir);
    const expected = await referenceFilterFilesToOwnTaskCommits(attributionOpts(dir, oracleRunner.runGit, baseRef));
    expect(result).toEqual(expected);
    // ...but arrive through exactly one batched call and zero per-sha diff-trees.
    const batches = batchCalls(runner.calls);
    expect(batches).toHaveLength(1);
    expect(runner.calls.some((args) => args.includes("diff-tree"))).toBe(false);
    const batch = batches[0]!;
    expect(batch).toContain("--no-renames"); // plumbing rename contract (both paths rendered)
    expect(batch).toContain("--min-parents=1"); // root commits contribute nothing
    expect(batch).toContain("--max-parents=1"); // merge commits contribute nothing
    expect(batch).toContain("--no-show-signature"); // GPG payload lines can never masquerade as paths
    expect(batch).toContain("--format=%x00%H"); // NUL-sentinel block headers
    for (const sha of result.ownCommitShas) expect(batch).toContain(sha);
  });

  it("fails closed to the per-sha loop when batch output cannot be attributed", async () => {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): one", { "a.txt": "a\n" });
    commitFiles(dir, "feat(T-7): two", { "b.txt": "b\n" });

    const passThrough = makeRecordingRunner(dir);
    const reference = await referenceFilterFilesToOwnTaskCommits(attributionOpts(dir, passThrough.runGit, baseRef));
    expect(reference.ownCommitShas).toHaveLength(2);

    // Poison variant 1: a file line before any block header (unattributable structure).
    const strayCalls: string[][] = [];
    const stray = await filterFilesToOwnTaskCommits(
      attributionOpts(dir, async (args) => {
        strayCalls.push([...args]);
        if (args[0] === "log" && args.includes("--no-walk")) return "stray-line\nfake.txt\n";
        return runGitCommand(args, dir);
      }, baseRef),
    );
    expect(batchCalls(strayCalls)).toHaveLength(1); // the batch WAS attempted
    expect(stray).toEqual(reference); // ...and the answer stayed correct via fallback
    expect(strayCalls.filter((args) => args.includes("diff-tree"))).toHaveLength(reference.ownCommitShas.length);

    // Poison variant 2: a block header whose sha was never requested (never guess ownership).
    // The successful variant-1 fallback wrote a cache entry for this exact key; drop it so
    // variant 2 provably re-attempts the batch instead of short-circuiting on the cached answer.
    __resetDoneRangeAttributionForTests(() => fakeNow);
    const phantomCalls: string[][] = [];
    const phantom = await filterFilesToOwnTaskCommits(
      attributionOpts(dir, async (args) => {
        phantomCalls.push([...args]);
        if (args[0] === "log" && args.includes("--no-walk")) return `\x00${"f".repeat(40)}\nphantom.txt\n`;
        return runGitCommand(args, dir);
      }, baseRef),
    );
    expect(batchCalls(phantomCalls)).toHaveLength(1);
    expect(phantom).toEqual(reference);
  });
});

/*
FNXC:TaskDiffAttribution 2026-09-09-22:35:
Step-3 cache tests. All time behavior runs through the injected fake clock — no sleeping,
no real timers (Standing Rule: no slow tests). "Re-ask spawns nothing" is asserted in its
content-addressed form: the sha-keyed value cache cannot answer before the enumeration call
learns the sha set, so a sequential re-ask costs exactly ONE enumeration call and ZERO
name-resolution calls; the literal zero-spawn case is the concurrent pair sharing one
in-flight attribution, asserted separately.
*/
describe("filterFilesToOwnTaskCommits attribution cache (RUFU-207 Step 3)", () => {
  function ownTwoCommitRepo(): { dir: string; baseRef: string } {
    const dir = makeRepo();
    const baseRef = baseRefOf(dir);
    commitFiles(dir, "feat(T-7): one", { "a.txt": "a\n" });
    commitFiles(dir, "feat(T-7): two", { "b.txt": "b\n" });
    return { dir, baseRef };
  }

  it("caps the attribution TTL at the payload-cache window", () => {
    expect(DONE_RANGE_ATTRIBUTION_TTL_MS).toBeLessThanOrEqual(10_000);
  });

  it("answers a sequential re-ask with enumeration only — zero name-resolution spawns", async () => {
    const { dir, baseRef } = ownTwoCommitRepo();
    const firstRunner = makeRecordingRunner(dir);
    const first = await filterFilesToOwnTaskCommits(attributionOpts(dir, firstRunner.runGit, baseRef));
    expect(firstRunner.calls).toHaveLength(2); // enumeration + batch

    const reAskRunner = makeRecordingRunner(dir);
    const second = await filterFilesToOwnTaskCommits(attributionOpts(dir, reAskRunner.runGit, baseRef));
    expect(reAskRunner.calls).toHaveLength(1);
    expect(reAskRunner.calls[0]).toEqual(["log", "--format=%H%x00%s%x00%B%x1e", `${baseRef}..HEAD`]);
    expect(second).toEqual(first);
  });

  it("re-spawns the batch when a newly landed own commit changes the key", async () => {
    const { dir, baseRef } = ownTwoCommitRepo();
    const firstRunner = makeRecordingRunner(dir);
    const first = await filterFilesToOwnTaskCommits(attributionOpts(dir, firstRunner.runGit, baseRef));
    expect(first.files).toEqual(["a.txt", "b.txt"]);

    commitFiles(dir, "feat(T-7): three", { "c.txt": "c\n" });
    const landedRunner = makeRecordingRunner(dir);
    const second = await filterFilesToOwnTaskCommits(attributionOpts(dir, landedRunner.runGit, baseRef));
    expect(landedRunner.calls.filter((args) => args.includes("--no-walk"))).toHaveLength(1);
    expect(second.files).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(second.ownCommitShas).toHaveLength(3);
  });

  it("re-spawns only after the TTL window fully elapses", async () => {
    const { dir, baseRef } = ownTwoCommitRepo();
    const firstRunner = makeRecordingRunner(dir);
    await filterFilesToOwnTaskCommits(attributionOpts(dir, firstRunner.runGit, baseRef));

    fakeNow += DONE_RANGE_ATTRIBUTION_TTL_MS - 1; // still inside the window
    const insideRunner = makeRecordingRunner(dir);
    await filterFilesToOwnTaskCommits(attributionOpts(dir, insideRunner.runGit, baseRef));
    expect(insideRunner.calls).toHaveLength(1);

    fakeNow += 1; // window fully elapsed (>= TTL expires)
    const afterRunner = makeRecordingRunner(dir);
    await filterFilesToOwnTaskCommits(attributionOpts(dir, afterRunner.runGit, baseRef));
    expect(afterRunner.calls.filter((args) => args.includes("--no-walk"))).toHaveLength(1);
  });

  it("never caches a rejection and never coalesces past its settle", async () => {
    const { dir, baseRef } = ownTwoCommitRepo();
    await expect(
      filterFilesToOwnTaskCommits({
        worktreePath: dir,
        baseRef,
        taskId: "T-7",
        runGit: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    const retryRunner = makeRecordingRunner(dir);
    const retry = await filterFilesToOwnTaskCommits(attributionOpts(dir, retryRunner.runGit, baseRef));
    expect(retryRunner.calls).toHaveLength(2); // full re-spawn, nothing cached or shared
    expect(retry.files).toEqual(["a.txt", "b.txt"]);
  });

  it("shares one in-flight attribution across a concurrent identical pair", async () => {
    const { dir, baseRef } = ownTwoCommitRepo();
    const pairRunner = makeRecordingRunner(dir);
    const opts = attributionOpts(dir, pairRunner.runGit, baseRef);
    const [first, second] = await Promise.all([
      filterFilesToOwnTaskCommits(opts),
      filterFilesToOwnTaskCommits(opts),
    ]);
    expect(first).toEqual(second);
    // Coalescing: the PAIR costs one enumeration + one batch total, not two each.
    expect(pairRunner.calls).toHaveLength(2);
    const oracleRunner = makeRecordingRunner(dir);
    expect(first).toEqual(await referenceFilterFilesToOwnTaskCommits(attributionOpts(dir, oracleRunner.runGit, baseRef)));
  });
});
