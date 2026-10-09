import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/*
FNXC:WorktreeAuditAttribution 2026-10-09-14:08:
RUFU-298 removed a literal `content-preservation` placeholder from an acquisition-side preserve record, but the
prose describing that fix (this repo's architecture doc, the RUFU-298 changeset, and a solutions write-up) named
the WRONG audit event: it claimed the placeholder had sat on `worktree:removal-preserved`. Both emitters of that
event have always derived a real content class (`packages/engine/src/worktree/worktree-backend.ts`: the refusal
branch reports `unverifiable`/`deliverable`, the ignored-only branch reports `ignored-only`), so the correction
changed attribution and literal content not one character of behavior. Three shipped surfaces therefore carried a
claim that no code backs, and nothing failed.

The predicate half of the defect was structural. Acquisition used to answer "would removal refuse?" through a
derived boolean, `defensiveRemovalWouldPreserve()`, that no production code called — the acquisition branch and
the backend tests each re-implemented the `assertCleanForDefensiveRemoval()` check inline (the OD's two-scan rule:
the audit literal and the dead symbol are the SAME defect, a helper plus prose that drifted from the door they
described). RUFU-329 deleted it rather than resurrect it, so `worktree:removal-preserved`'s meaning — the concrete
class a REFUSAL preserved — is unchanged, and the predicate stays gone.

This guard is the missing scan. It runs BOTH directions, because either one alone was defeated before:
1. a *re-introduction* scan (allowlists, so an over-clearer also fails), and
2. a *rot* scan (every guard `## Pinned by` cites must exist, and a symbol that no longer exists must not be
   cited there).
It asserts observable text and symbol surface only: no test here asserts that an `FNXC:` comment exists, per the
standing "tests assert behavior, never source text or comments" rule. Doc prose is in scope because a doc claim
about code IS the observable surface of a documentation-accuracy defect, and it is checked against the code
construct it describes.
*/

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Prose whose attribution RUFU-329 corrected. */
const ARCHITECTURE_DOC = "docs/architecture.md";
const RUFU298_CHANGESET = ".changeset/rufu-298-acquisition-ignored-only.md";

/** The one doc whose defect history legitimately names both literals (Mechanism, not `## Pinned by`). */
const SOLUTIONS_DOC =
  "docs/solutions/reliability/pinned-worktree-ignored-only-acquisition-reclaim.md";

/** Acquisition's own preserve record: the placeholder's true home, frozen by this task. */
const ACQUISITION_SOURCE = "packages/engine/src/worktree/worktree-acquisition.ts";
const ACQUISITION_TEST = "packages/engine/src/__tests__/worktree-acquisition-pinned.test.ts";
/** The removal-side event whose attribution was wrongly blamed; both emitters stay untouched. */
const REMOVAL_BACKEND = "packages/engine/src/worktree/worktree-backend.ts";

const PLACEHOLDER = "content-preservation";
const DEAD_PREDICATE = "defensiveRemovalWouldPreserve";
/** The acquisition preserve row that RUFU-298 actually corrected, and its task-log sentence. */
const ACQUISITION_REASON = "task-pinned-content-preserved";

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count += 1;
  return count;
}

/** Walk a tree for scannable files, skipping installed/built output like the tombstone sweep does. */
function collectFiles(dir: string, extensions: string[], out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, extensions, out);
      continue;
    }
    if (extensions.some((ext) => entry.endsWith(ext))) out.push(full);
  }
}

/**
 * Mirror of the tombstone sweep's comment stripper (kept local rather than imported from another test file).
 * Explanatory notes may recount a deleted symbol; executable code may not reference it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every markdown file under a repo-relative directory, as repo-relative paths. */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  collectFiles(join(REPO_ROOT, dir), [".md"], out);
  return out.map((file) => relative(REPO_ROOT, file).split(sep).join("/"));
}

/** Markdown files under a repo-relative directory whose text contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const rel of collectMarkdown(dir)) {
    if (read(rel).includes(needle)) hits.push(rel);
  }
  return hits.sort();
}

/**
 * Code-carrying files under one repo-relative root whose comment-stripped text contains `needle`.
 * Per-root so a violation names the tree it came from.
 *
 * EXEMPTION: exactly this guard's own file, by resolved path. A scan has to name its subject (`DEAD_PREDICATE`
 * below is the search term), and the alternative — exempting `__tests__` wholesale — is what let the original
 * defect survive: the boolean's only surviving callers WERE tests. Skipping one known path keeps the sweep
 * non-vacuous, because a re-introduction lands in some *other* file and is still reported.
 */
const SELF = fileURLToPath(import.meta.url);

function filesContainingInCode(root: string, needle: string): string[] {
  const files: string[] = [];
  collectFiles(join(REPO_ROOT, root), [".ts", ".tsx", ".mjs", ".cjs", ".js"], files);
  const hits: string[] = [];
  for (const file of files) {
    if (resolve(file) === SELF) continue;
    if (stripComments(readFileSync(file, "utf8")).includes(needle)) {
      hits.push(relative(REPO_ROOT, file).split(sep).join("/"));
    }
  }
  return hits.sort();
}

/** Code-carrying trees: workspace packages, repo scripts, and plugins. */
const CODE_ROOTS = ["packages", "scripts", "plugins"];

/** Slice one markdown section out by heading, up to the next `## ` heading or EOF. */
function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) return "";
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Repo-relative paths cited in a markdown section's bullets, as `path` inside backticks. */
function citedPaths(section: string): string[] {
  return [...section.matchAll(/`([^`\s]+\.[a-z]+)`/g)].map((m) => m[1] as string);
}

describe("worktree audit attribution prose (RUFU-329)", () => {
  describe("corrected prose carries no false attribution", () => {
    it.each([[ARCHITECTURE_DOC], [RUFU298_CHANGESET]])(
      "%s states no `content-preservation` claim for `worktree:removal-preserved`",
      (relativePath) => {
        const text = read(relativePath);
        // The false claim was this event's metadata "holding" the placeholder. It held no such thing, so the
        // literal may not appear in the corrected prose at all (the fix replaced it with "the fixed placeholder").
        expect(countOccurrences(text, PLACEHOLDER)).toBe(0);
      },
    );

    it("the corrected architecture sentence names the record that actually carried the placeholder", () => {
      const text = read(ARCHITECTURE_DOC);
      // Attribution is only fixed if it lands on the real record: acquisition's `file:write` preserve row and the
      // task-log line. Both identifiers are asserted against the code that emits them, not just against the doc.
      expect(text).toContain(ACQUISITION_REASON);
      expect(text).toContain("holds ignored-only content");
      expect(text).toContain("holds deliverable content");
      expect(read(ACQUISITION_SOURCE)).toContain(`"${ACQUISITION_REASON}"`);
    });
  });

  describe("prose allowlist (a re-introduction and an over-clearing both fail)", () => {
    // A file allowlist rather than a "zero hits anywhere" rule, because the solutions doc's Mechanism section is
    // the DEFECT history: RUFU-298 really did remove that placeholder from an acquisition record, so the tag line
    // and the Mechanism paragraph must keep naming it. Over-clearing that history is the failure mode RUFU-329's
    // remediation flagged, so the census must be exact in both directions.
    it("`content-preservation` appears in exactly the history doc that records the fix", () => {
      expect(filesContaining("docs", PLACEHOLDER)).toEqual([SOLUTIONS_DOC]);
    });

    it("`defensiveRemovalWouldPreserve` appears in exactly the history doc that records the deletion", () => {
      expect(filesContaining("docs", DEAD_PREDICATE)).toEqual([SOLUTIONS_DOC]);
    });

    it("the history doc keeps both mentions in its Mechanism, not in its live-guard list", () => {
      const text = read(SOLUTIONS_DOC);
      const pinnedBy = markdownSection(text, "## Pinned by");
      expect(pinnedBy.length).toBeGreaterThan(0);
      // Both literals belong to the frontmatter tag / Mechanism history. Anything still in `## Pinned by` after
      // RUFU-329 would be claiming a live guard that does not exist.
      expect(pinnedBy).not.toContain(PLACEHOLDER);
      expect(pinnedBy).not.toContain(DEAD_PREDICATE);
      // Mechanism must still tell the truth about what was removed.
      expect(markdownSection(text, "## Mechanism")).toContain(PLACEHOLDER);
      expect(markdownSection(text, "## Mechanism")).toContain(DEAD_PREDICATE);
    });

    it("the RUFU-298 changeset is the only changeset naming the deleted predicate", () => {
      const files: string[] = [];
      collectFiles(join(REPO_ROOT, ".changeset"), [".md"], files);
      const hits = files
        .filter((file) => readFileSync(file, "utf8").includes(DEAD_PREDICATE))
        .map((file) => relative(REPO_ROOT, file).split(sep).join("/"))
        .sort();
      // Option A: the pending RUFU-278 changeset was amended so its "how" line describes the predicate without
      // naming it, because advertising a predicate that no longer exists is its own false claim.
      expect(hits).toEqual([RUFU298_CHANGESET]);
    });
  });

  describe("no shipped text claims a guard that does not exist", () => {
    it("every guard cited by the solutions doc's `## Pinned by` exists", () => {
      const pinnedBy = markdownSection(read(SOLUTIONS_DOC), "## Pinned by");
      const cited = citedPaths(pinnedBy);
      expect(cited.length).toBeGreaterThan(0);
      const missing = cited.filter((relativePath) => !existsSync(join(REPO_ROOT, relativePath)));
      expect(missing).toEqual([]);
    });
  });

  describe("symbol surface (Option A: the boolean stays deleted)", () => {
    // Scanned comment-free, the same way the tombstone sweep does: an explanatory note may recount the deletion,
    // executable code may not reference it. Covers tests too, unlike the tombstone sweep — the boolean had no
    // production caller to begin with, so a surviving reference would only ever be a test re-implementing the door.
    it.each(CODE_ROOTS)("`%s` carries no `defensiveRemovalWouldPreserve` reference", (root) => {
      expect(filesContainingInCode(root, DEAD_PREDICATE)).toEqual([]);
    });

    it("the deletion did not disturb the removal-side event it must not rename", () => {
      const backend = read(REMOVAL_BACKEND);
      expect(countOccurrences(backend, "worktree:removal-preserved")).toBeGreaterThanOrEqual(2);
      // Both emitters still derive a real class, which is why the corrected prose is true.
      expect(backend).toContain("unverifiable");
      expect(backend).toContain("ignored-only");
    });

    it("acquisition's own placeholder history was not cleaned out either", () => {
      // The frozen surface: the placeholder's real home. Erasing it would "fix" the doc by destroying the record.
      expect(read(ACQUISITION_SOURCE)).toContain(`?? "${PLACEHOLDER}"`);
      expect(read(ACQUISITION_TEST)).toContain(PLACEHOLDER);
    });
  });
});
