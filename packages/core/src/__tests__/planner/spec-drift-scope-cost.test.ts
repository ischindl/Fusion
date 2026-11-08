/**
 * Spec-drift scope-matching cost harness (RUFU-871).
 *
 * FNXC:SpecDriftScopeCost 2026-11-08-02:59:
 * Twenty-five independent 25-second CDP CPU profiles taken during real event-loop stalls on the
 * production dashboard attributed the single largest product share in one window to scope matching
 * inside the drift evaluator: `stall-20261108-024514.txt` records `matchesScope` at 14 543 of
 * 37 504 samples (39 % of the whole 25 s window) UNDER `evaluateSpecDrift` (15 160) under
 * `appendSpecDriftReportWhilePlanningLocked` (15 172). A second window put the same three frames at
 * 4 643 / 4 873 / 4 878 of 40 869. The raw profile `/home/schindler/prof/slow-raw.cpuprofile`
 * holds exactly TWO `matchesScope` nodes and BOTH walk up through
 * `(anon) @ bin.js:33587 <- evaluateSpecDrift @ bin.js:33568`, i.e. the `scope.some(...)` callback
 * in `drift-report.ts`; the two same-named engine matchers (`merger-file-scope.ts`,
 * `self-healing-path-utils.ts`) appear ZERO times, so this cost is the planner's, not the merger's.
 *
 * This file exists so the hot spot is MEASURED rather than narrated:
 *
 *   FUSION_SPEC_DRIFT_BENCH=1 pnpm --filter @fusion/core exec vitest run \
 *     src/__tests__/planner/spec-drift-scope-cost.test.ts --reporter=basic
 *
 * prints inputs (scope patterns x modified files) -> us/call and pattern-compilations/call. The
 * benchmark block is gated on that env var so CI never pays for it (repo rule: no slow tests, no
 * wall-clock assertions) and it ASSERTS nothing about time — it only reports.
 *
 * The always-on half is what makes an optimisation safe:
 *  1. a golden verdict table, so a matcher refactor cannot change one drift verdict, and
 *  2. a deterministic `RegExp` CONSTRUCTION COUNT per `evaluateSpecDrift` call, which is the exact
 *     shape the profile implicated. Latency is never asserted; compilation counts are.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { evaluateSpecDrift } from "../../planner/drift-report.js";
import { createCurrentPlanEvidence, type CurrentPlanEvidence, type SpecLock } from "../../planner/spec-lock.js";

/**
 * Builds a prompt with exactly `patternCount` File Scope bullets. `normalizeList` dedupes and
 * sorts the section, so the patterns must be distinct to reach the declared cardinality.
 */
function promptWithScope(patterns: string[]): string {
  return [
    "# Task",
    "",
    "## Mission",
    "",
    "Build a safe widget.",
    "",
    "## File Scope",
    "",
    ...patterns.map((pattern) => `- ${pattern}`),
    "",
    "## Steps",
    "",
    "1. Build widget",
    "",
    "## Completion Criteria",
    "",
    "- [ ] Widget works",
    "",
    "## Do NOT",
    "",
    "- Change API",
    "",
    "## Dependencies",
    "",
    "- FN-1",
    "",
  ].join("\n");
}

function evidenceWithScope(patterns: string[], version = 1): CurrentPlanEvidence {
  return createCurrentPlanEvidence({
    version,
    sourceRevision: version,
    capturedAt: "2026-11-08T02:59:00.000Z",
    prompt: promptWithScope(patterns),
  });
}

function lockFor(current: CurrentPlanEvidence): SpecLock {
  return {
    version: 1,
    acceptedAt: "2026-11-08T02:59:00.000Z",
    approvalFingerprint: "approved",
    currentPlanVersion: current.version,
    currentPlanHash: current.plan.contentHash,
    plan: current.plan,
  };
}

/** Builds `count` distinct plain scope patterns, each a directory-glob over its own module. */
function scopePatterns(count: number): string[] {
  return Array.from({ length: count }, (_unused, i) => `packages/pkg-${i % 12}/src/mod-${i}/**`);
}

/** `fileCount` distinct modified files that match NONE of `scopePatterns` (worst-case probe). */
function unmatchedFiles(fileCount: number): string[] {
  return Array.from({ length: fileCount }, (_unused, i) => `outside/deep/nested/file-${i}.ts`);
}

/** `fileCount` distinct modified files that match the FIRST declared pattern. */
function firstPatternFiles(fileCount: number): string[] {
  return Array.from({ length: fileCount }, (_unused, i) => `packages/pkg-0/src/mod-0/file-${i}.ts`);
}

/**
 * Deterministic instrumentation: count `RegExp` CONSTRUCTIONS during a run.
 *
 * FNXC:SpecDriftScopeCost 2026-11-08-02:59:
 * The profile cannot be read as "regex work" without counting regexes, and a regex LITERAL does
 * not call this constructor (V8 caches a literal's boilerplate), so a nonzero count is unambiguously
 * a dynamically compiled pattern. This is the counter the ratchet below asserts on.
 */
function countRegExpCompilations<T>(fn: () => T): { value: T; compilations: number } {
  const original = globalThis.RegExp;
  let compilations = 0;
  const patched = new Proxy(original, {
    construct(target, args, newTarget) {
      compilations += 1;
      return Reflect.construct(target as unknown as new (...a: unknown[]) => unknown, args, newTarget);
    },
  });
  globalThis.RegExp = patched as unknown as RegExpConstructor;
  try {
    return { value: fn(), compilations };
  } finally {
    globalThis.RegExp = original;
  }
}

/*
FNXC:SpecDriftScopeCost 2026-11-08-02:59:
The verdict table is the safety property for any change to the matcher: every glob token
`matchesScope` supports, plus the two normalizations (`\` -> `/`, leading `./`), each pinned to its
observed boolean. A refactor that changes ONE cell fails here even if it is faster. The double-star
slash token admits files directly below the preceding segment, a single star never crosses a slash,
and literal dots stay literal: all three are load-bearing, because an unescaped dot would turn
`src/a.ts` into a matcher that also accepts `src/ats`.
*/
const VERDICT_CASES: Array<{ path: string; scope: string; match: boolean }> = [
  { path: "src/widget.ts", scope: "src/widget.ts", match: true },
  { path: "src/widget.ts", scope: "src/*", match: true },
  { path: "src/a/widget.ts", scope: "src/*", match: false },
  { path: "src/a/widget.ts", scope: "src/**", match: true },
  { path: "src/widget.ts", scope: "src/**", match: true },
  { path: "src/widget.ts", scope: "src/**/widget.ts", match: true },
  { path: "src/a/widget.ts", scope: "src/**/widget.ts", match: true },
  { path: "src/a/b/widget.ts", scope: "src/**/widget.ts", match: true },
  { path: "widget.ts", scope: "src/**/widget.ts", match: false },
  { path: "src/ats", scope: "src/a.ts", match: false },
  { path: "src/a.ts", scope: "src/a.ts", match: true },
  { path: "src/a+b.ts", scope: "src/a+b.ts", match: true },
  { path: "src/a(b).ts", scope: "src/a(b).ts", match: true },
  { path: "src/a{b}.ts", scope: "src/a{b}.ts", match: true },
  { path: "src/a|b.ts", scope: "src/a|b.ts", match: true },
  { path: "src/a$b.ts", scope: "src/a$b.ts", match: true },
  { path: "src/a^b.ts", scope: "src/a^b.ts", match: true },
  { path: "src/a|b.ts", scope: "src/a.b.ts", match: false },
  { path: "src/widget.ts", scope: "./src/widget.ts", match: true },
  { path: "src/widget.ts", scope: "src\\widget.ts", match: true },
  { path: "src/widget.tsx", scope: "src/widget.ts", match: false },
  { path: "src/widget.ts", scope: "src/**", match: true },
  { path: "other/widget.ts", scope: "src/**", match: false },
  { path: "src/a/b/c/d.ts", scope: "src/**/c/*.ts", match: true },
  { path: "src/a/c/d.ts", scope: "src/**/c/*.ts", match: true },
  { path: "src/c/d.ts", scope: "src/**/c/*.ts", match: true },
];

describe("spec drift scope matcher — verdict golden table", () => {
  it.each(VERDICT_CASES)("classifies $path against $scope as $match", ({ path, scope, match }) => {
    const current = evidenceWithScope([scope]);
    const report = evaluateSpecDrift({ latestLock: lockFor(current), currentPlan: current, modifiedFiles: [path] });
    const creep = report.findings.filter((finding) => finding.kind === "scope-creep");
    expect({ path, scope, scopeCreep: creep.length > 0 }).toEqual({ path, scope, scopeCreep: !match });
  });

  it("keeps the whole scope-creep finding set stable for a mixed modified-file batch", () => {
    /*
    FNXC:SpecDriftScopeCost 2026-11-08-02:59:
    Committed digest (not `*.snap`, which is gitignored repo-wide) over the reported findings for a
    batch that mixes in-scope, out-of-scope, duplicate, Windows-separated, and `./`-prefixed paths.
    Any matcher change that alters a verdict — or their order, which the sort controls — fails here.
    The value below was captured from `evaluateSpecDrift` on `main` BEFORE the compile-once refactor
    and is byte-identical to the value after it, which is the evidence that removing the per-path
    RegExp compilation changed the cost and not one drift verdict.
    */
    const patterns = ["src/widget.ts", "src/generated/**", "packages/core/**", "docs/*.md"];
    const current = evidenceWithScope(patterns);
    const report = evaluateSpecDrift({
      latestLock: lockFor(current),
      currentPlan: current,
      modifiedFiles: [
        "src/widget.ts",
        "./src/widget.ts",
        "src/generated/a/b.ts",
        "src/generated/x.ts",
        "src/other.ts",
        "docs\\guide.md",
        "docs/a/nested.md",
        "packages/core/src/planner/drift-report.ts",
        "outside.ts",
      ],
    });
    const serialized = JSON.stringify({
      alignment: report.alignment,
      executionHash: report.executionHash,
      findings: report.findings,
    });
    const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 32);
    // Recompute the constant above if a deliberate behavior change alters these findings.
    expect({ digest, findings: report.findings.length }).toEqual({
      digest: GOLDEN_SCOPE_FINDINGS_SHA256_32,
      findings: 3,
    });
  });
});

/**
 * Golden digest of the reported findings for the mixed batch above, captured from the pre-change
 * `evaluateSpecDrift` on `main`. Deliberately a literal: an env-var override would let the check
 * pass against any value it was pointed at.
 */
const GOLDEN_SCOPE_FINDINGS_SHA256_32 = "4a73935a143cd034777174d5b933f78a";

describe("spec drift scope matcher — pattern-compilation budget (ratchet)", () => {
  /*
  FNXC:SpecDriftScopeCost 2026-11-08-02:59 (RUFU-871):
  This is the measurement, not a wish. The profile named `matchesScope` as 14 543 / 37 504 samples,
  and the loop that reaches it is
  `for (const path of execution) if (!scope.some((entry) => matchesScope(path, entry))) ...`
  — one dynamically compiled RegExp per (file x pattern) pair. The invariant that removes the cost
  without touching a verdict: patterns are a property of the LOCK, so one `evaluateSpecDrift` call
  compiles each declared pattern exactly once and reuses it for every path.
  Asserting `compilations === patterns` for two different file counts is what makes a reintroduced
  per-path compile fail, and asserting the count is independent of file count is what makes the
  ratchet about the loop shape rather than about a constant.
  */
  it("compiles one RegExp per declared scope pattern, not one per file x pattern pair", () => {
    const patterns = scopePatterns(20);
    const current = evidenceWithScope(patterns);
    const latestLock = lockFor(current);

    const outOfScope = countRegExpCompilations(() =>
      evaluateSpecDrift({ latestLock, currentPlan: current, modifiedFiles: unmatchedFiles(50) }),
    );
    // Worst case: every path probes every pattern (no `.some` early-out ever fires).
    expect(outOfScope.compilations).toBe(20);

    const inScope = countRegExpCompilations(() =>
      evaluateSpecDrift({ latestLock, currentPlan: current, modifiedFiles: firstPatternFiles(50) }),
    );
    expect(inScope.compilations).toBe(20);
  });

  it("does not scale pattern compilation with modified-file count", () => {
    const patterns = scopePatterns(12);
    const current = evidenceWithScope(patterns);
    const latestLock = lockFor(current);
    const counts = [1, 5, 40].map((files) =>
      countRegExpCompilations(() =>
        evaluateSpecDrift({ latestLock, currentPlan: current, modifiedFiles: unmatchedFiles(files) }),
      ).compilations,
    );
    expect(counts).toEqual([12, 12, 12]);
  });

  it("compiles nothing when the approved plan declares no file scope", () => {
    const current = evidenceWithScope(["src/widget.ts"]);
    // A lock whose file-scope section is empty has nothing to match against.
    const emptyScopeLock: SpecLock = {
      ...lockFor(current),
      plan: {
        ...current.plan,
        sections: { ...current.plan.sections, "file-scope": { status: "available", canonical: "" } },
      },
    };
    const { compilations } = countRegExpCompilations(() =>
      evaluateSpecDrift({ latestLock: emptyScopeLock, currentPlan: current, modifiedFiles: unmatchedFiles(30) }),
    );
    expect(compilations).toBe(0);
  });

  it("reports the measured scope-creep count for a production-like batch", () => {
    const patterns = scopePatterns(20);
    const current = evidenceWithScope(patterns);
    const report = evaluateSpecDrift({
      latestLock: lockFor(current),
      currentPlan: current,
      modifiedFiles: unmatchedFiles(120),
    });
    expect(report.findings.filter((f) => f.kind === "scope-creep")).toHaveLength(120);
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

describe.skipIf(!process.env.FUSION_SPEC_DRIFT_BENCH)(
  "spec drift scope matcher — cost shape (report-only, FUSION_SPEC_DRIFT_BENCH=1)",
  () => {
    it("reports us/call and pattern-compilations/call across cardinalities", () => {
      const REPEATS = 7;
      const shapes = [
        { patterns: 5, files: 10 },
        { patterns: 5, files: 100 },
        { patterns: 5, files: 500 },
        { patterns: 20, files: 10 },
        { patterns: 20, files: 100 },
        { patterns: 20, files: 500 },
        { patterns: 80, files: 10 },
        { patterns: 80, files: 100 },
        { patterns: 80, files: 500 },
      ];
      const lines: string[] = ["", `=== SPEC DRIFT SCOPE COST (median of ${REPEATS} passes) ===`];
      lines.push(
        "patterns  files  probes(worst)  compiles/call  us/call   us/probe   1k-card sweep ms",
      );
      for (const shape of shapes) {
        const patterns = scopePatterns(shape.patterns);
        const current = evidenceWithScope(patterns);
        const latestLock = lockFor(current);
        // Worst case, matching the profile: nothing is in scope, so every pair is probed.
        const modifiedFiles = unmatchedFiles(shape.files);
        const run = () => evaluateSpecDrift({ latestLock, currentPlan: current, modifiedFiles });
        run();
        const timings: number[] = [];
        for (let r = 0; r < REPEATS; r += 1) {
          const t0 = performance.now();
          run();
          timings.push(performance.now() - t0);
        }
        const us = median(timings) * 1000;
        const { compilations } = countRegExpCompilations(run);
        lines.push(
          [
            String(shape.patterns).padStart(8),
            String(shape.files).padStart(6),
            String(shape.patterns * shape.files).padStart(13),
            String(compilations).padStart(14),
            String(round(us)).padStart(9),
            String(round(us / (shape.patterns * shape.files), 3)).padStart(10),
            String(round(us * 1000, 0)).padStart(16),
          ].join("  "),
        );
      }
      lines.push("");
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
      expect(shapes.length).toBeGreaterThan(0);
    });
  },
);
