import { describe, it, expect } from "vitest";
import { countPatchLines, parseNumstatOutput } from "../routes/diff-counts.js";

describe("countPatchLines", () => {
  it.each([
    ["simple add/del", "+a\n-b\n", { additions: 1, deletions: 1 }],
    ["counts ++i content", "diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n++i;\n", { additions: 1, deletions: 0 }],
    ["counts --counter content", "diff --git a/x b/x\n--- a/x\n@@ -1 +1 @@\n--counter;\n", { additions: 0, deletions: 1 }],
    ["ignores file headers", "--- a/file.ts\n+++ b/file.ts\n", { additions: 0, deletions: 0 }],
    ["counts +++ in hunk body", "@@ -1 +1 @@\n+++\n", { additions: 1, deletions: 0 }],
    ["empty patch", "", { additions: 0, deletions: 0 }],
    ["only diff headers", "diff --git a/a b/a\nindex 123..456 100644\n", { additions: 0, deletions: 0 }],
  ])("%s", (_name, patch, expected) => {
    expect(countPatchLines(patch)).toEqual(expected);
  });
});

/*
FNXC:TaskDiffStats 2026-09-10-04:03:
Parser fixtures are verbatim `git diff --numstat -z` record layouts (measured on git 2.55.0): the
ordinary `<added>\t<deleted>\t<path>\0` record, the rename `<added>\t<deleted>\0<pre>\0<post>\0` record,
and the binary `-\t-` counts. The /diff stats lane joins these onto its `--name-status` path set, and
the parity tests in routes-github.test.ts are the authority that the numbers match the per-file patch
counts `countPatchLines` produces today.
*/
describe("parseNumstatOutput", () => {
  it("returns an empty map for empty output", () => {
    expect(parseNumstatOutput("")).toEqual(new Map());
  });

  it("parses ordinary records keyed by path", () => {
    const parsed = parseNumstatOutput("12\t3\tsrc/app.ts\u00000\t1\tREADME.md\u0000");
    expect(parsed.get("src/app.ts")).toEqual({ additions: 12, deletions: 3 });
    expect(parsed.get("README.md")).toEqual({ additions: 0, deletions: 1 });
    expect(parsed.size).toBe(2);
  });

  it("maps binary `-` counts to zero instead of NaN", () => {
    const parsed = parseNumstatOutput("-\t-\tassets/logo.png\u0000");
    expect(parsed.get("assets/logo.png")).toEqual({ additions: 0, deletions: 0 });
  });

  it("keeps paths with spaces and unicode verbatim", () => {
    const parsed = parseNumstatOutput("3\t1\tui/按钮 copy.ts\u0000");
    expect(parsed.get("ui/按钮 copy.ts")).toEqual({ additions: 3, deletions: 1 });
  });

  it("keys a rename record on the post-image path and ignores the pre-image", () => {
    const parsed = parseNumstatOutput("0\t0\u0000old.ts\u0000new.ts\u00001\t0\tnext.ts\u0000");
    expect(parsed.get("new.ts")).toEqual({ additions: 0, deletions: 0 });
    expect(parsed.has("old.ts")).toBe(false);
    expect(parsed.get("next.ts")).toEqual({ additions: 1, deletions: 0 });
  });

  it("skips a field-less record, zeroes unparsable counts, and tolerates a truncated rename record", () => {
    const parsed = parseNumstatOutput("garbage\u0000x\ty\tsrc/broken.ts\u00001\t0");
    // `garbage` has no tab fields and is dropped; unparsable counts fall back to 0 so they cannot
    // poison the total; the trailing `1\t0` rename record has no post-image field and yields nothing.
    expect(parsed.size).toBe(1);
    expect(parsed.get("src/broken.ts")).toEqual({ additions: 0, deletions: 0 });
  });

  it("keeps a literal tab inside a path intact", () => {
    const parsed = parseNumstatOutput("1\t0\tdir/we\tird.ts\u0000");
    expect(parsed.get("dir/we\tird.ts")).toEqual({ additions: 1, deletions: 0 });
  });
});
