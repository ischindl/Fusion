/**
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * Regression for root-level File Scope files with extensions. GitHub issue import
 * embeds the issue body into PROMPT.md; when that body declares `## File Scope`
 * with paths like global.json / Directory.Packages.props / MyApp.slnx, createTask
 * must not throw InvalidFileScopeError, and extractEffectiveWriteScopeFromPrompt
 * must keep all four write targets (not only nested src/... entries).
 *
 * FNXC:FileScopeClassification 2026-07-21-18:05:
 * Also covers fenced repro snippets (GitHub #2389) whose escaped backticks produced
 * tokens like `global.json\` and blocked import via InvalidFileScopeError.
 *
 * FNXC:FileScopeClassification 2026-07-21-19:00:
 * The regression invariant covers ecosystem-neutral root files, not only the four-path
 * .NET repro. Classification, create/update validation, and the public store re-export
 * must agree while duplicate, read-only, and invalid tokens remain excluded from writes.
 */
import { describe, expect, it } from "vitest";
import {
  classifyFileScopeFromPrompt,
  extractEffectiveWriteScopeFromPrompt,
  extractFileScopeTokens,
  isValidFileScopeEntry,
} from "../tasks/file-scope-classification.js";
import {
  isValidFileScopeEntry as storeFileScopeIsValidFileScopeEntry,
  sanitizeFileScopeInPromptContent,
  validateFileScopeInPromptContent,
} from "../task-store/file-scope.js";
import { isValidFileScopeEntry as storeIsValidFileScopeEntry } from "../store.js";
import { buildBootstrapPrompt } from "../mesh/mesh-task-replication.js";

describe("isValidFileScopeEntry", () => {
  it("accepts root-level repo files with letter-leading extensions", () => {
    const roots = [
      "global.json",
      "Directory.Build.props",
      "Directory.Build.targets",
      "Directory.Packages.props",
      "nuget.config",
      "NuGet.config",
      ".editorconfig",
      "MyApp.slnx",
      "MyApp.sln",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "tsconfig.json",
      "package.json",
      "pnpm-lock.yaml",
      "README.md",
      ".env",
      "AGENTS.md",
    ];
    for (const path of roots) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
      expect(storeFileScopeIsValidFileScopeEntry(path), `task-store:${path}`).toBe(true);
      expect(storeIsValidFileScopeEntry(path), `store:${path}`).toBe(true);
    }
  });

  it("accepts nested files, globs, and known extensionless roots", () => {
    const samples = [
      "src/MyApp/Program.cs",
      "packages/core/src/store.ts",
      "packages/engine/src/**/*.ts",
      "packages/dashboard/app/**",
      "Makefile",
      "Dockerfile",
      "foo/Dockerfile",
    ];
    for (const path of samples) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
    }
  });

  it("rejects git refs, absolute paths, bare identifiers, and version-like tokens", () => {
    const rejects = [
      "origin/main",
      "upstream/main",
      "refs/heads/main",
      "https://example.com/repo",
      "git@github.com:org/repo.git",
      "ssh://git@host/repo",
      "feature/fn-123",
      "abc1234",
      "deadbeef",
      "main",
      "todo",
      "v1.2.3",
      "/abs/path.ts",
      "../escape.ts",
      "packages/../secret.ts",
      "",
      "   ",
    ];
    for (const path of rejects) {
      expect(isValidFileScopeEntry(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("keeps create/update validation and store exports on the same function", () => {
    expect(storeFileScopeIsValidFileScopeEntry).toBe(isValidFileScopeEntry);
    expect(storeIsValidFileScopeEntry).toBe(isValidFileScopeEntry);
  });
});

describe("extractEffectiveWriteScopeFromPrompt / validateFileScopeInPromptContent", () => {
  const prompt = `# Task: FN-8459

## File Scope
- \`global.json\`
- \`Directory.Packages.props\`
- \`MyApp.slnx\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Implement
`;

  it("includes all four FN-8459-style File Scope entries in effective write scope", () => {
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("retains the broader .NET root set in effective scope", () => {
    const rootPaths = [
      ".editorconfig",
      "Directory.Build.props",
      "Directory.Build.targets",
      "Directory.Packages.props",
      "global.json",
      "nuget.config",
      "MyApp.slnx",
    ];
    const broaderPrompt = `## File Scope
${rootPaths.map((path) => `- \`${path}\` (new)`).join("\n")}
- \`src/MyApp/Program.cs\` (new)
`;

    expect(extractEffectiveWriteScopeFromPrompt(broaderPrompt)).toEqual([
      ...rootPaths,
      "src/MyApp/Program.cs",
    ]);
    expect(validateFileScopeInPromptContent(broaderPrompt).invalid).toEqual([]);
  });

  it("passes create/update File Scope validation for root-level extension paths", () => {
    const { valid, invalid } = validateFileScopeInPromptContent(prompt);
    expect(invalid).toEqual([]);
    expect(valid).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("omits duplicate, read-only, conditional, and invalid tokens from write scope", () => {
    const classified = `## File Scope
- \`global.json\`
- \`global.json\`

Read-only context:
- \`Directory.Build.props\`

Files changed:
- \`src/MyApp/Program.cs\`

Only if changed:
- \`.changeset/fix.md\`

## Steps
`;
    expect(extractEffectiveWriteScopeFromPrompt(classified)).toEqual([
      "global.json",
      "src/MyApp/Program.cs",
    ]);
  });

  it("still rejects git-ref tokens inside File Scope on create/update validation", () => {
    const bad = `## File Scope
- \`packages/core/src/store.ts\`
- \`origin/main\`
`;
    const { valid, invalid } = validateFileScopeInPromptContent(bad);
    expect(valid).toEqual(["packages/core/src/store.ts"]);
    expect(invalid).toEqual(["origin/main"]);
  });

  it("ignores ## File Scope headings inside fenced code blocks (GitHub #2389 repro shape)", () => {
    // Mirrors issue body: fenced TS sample with escaped markdown backticks around paths.
    const issueBody = `## Summary

Root-level File Scope files are dropped.

## Repro (unit-level)

\`\`\`ts
import { extractEffectiveWriteScopeFromPrompt } from "packages/core/src/tasks/file-scope-classification";

const prompt = \`
## File Scope

- \\\`global.json\\\` (new)
- \\\`Directory.Packages.props\\\` (new)
- \\\`MyApp.slnx\\\` (new)
- \\\`src/MyApp/Program.cs\\\` (new)
\`;

extractEffectiveWriteScopeFromPrompt(prompt);
// actual:   ["src/MyApp/Program.cs"]
// expected: all four entries
\`\`\`
`;

    expect(extractFileScopeTokens(issueBody)).toEqual([]);
    expect(extractEffectiveWriteScopeFromPrompt(issueBody)).toEqual([]);
    expect(validateFileScopeInPromptContent(issueBody)).toEqual({ valid: [], invalid: [] });

    const bootstrap = buildBootstrapPrompt(
      "FN-8460",
      "File-Scope classifier silently drops .NET root-level files",
      `${issueBody}\n\nSource: https://github.com/Runfusion/Fusion/issues/2389`,
    );
    expect(validateFileScopeInPromptContent(bootstrap)).toEqual({ valid: [], invalid: [] });
  });

  it("still reads a real File Scope section after a fenced sample that also mentions File Scope", () => {
    const prompt = `# Task: FN-1

## Context

Example only:

\`\`\`md
## File Scope
- \\\`bogus/path\\\`
\`\`\`

## File Scope
- \`global.json\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Go
`;
    expect(extractFileScopeTokens(prompt)).toEqual(["global.json", "src/MyApp/Program.cs"]);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "src/MyApp/Program.cs",
    ]);
  });
});

/*
FNXC:FileScopeClassification 2026-11-11-16:03 (RUFU-494):
An inline backticked annotation inside a `## File Scope` bullet is commentary, not a declared path.
The harvest takes at most the LEADING backticked token of a line, so an annotated bullet - the shape
repo spec hygiene actively encourages - stops being hard-rejected by the only path the planner has to
repair a spec. RUFU-490 lost one of three planning passes to exactly the bullet below at
2026-10-02 10:01:11.762Z, and refine/duplicate/archive-restore silently deleted annotated bullets
through sanitize's whole-line filter.

Conservatism is deliberately not widened: an invalid LEADING candidate (`origin/main`, `HEAD`, a bare
`rerouted`, a bare `todo`) still lands in the `invalid` list, still classifies `invalid-entry`, and
still refuses on all three throwing call sites. These cases pin both halves - narrowed harvest,
undropped guard.
*/
const RUFU_490_BULLET =
  "- `packages/engine/src/merge/workspace-review-reroute.ts` (returns an object literal with a `rerouted` false branch and a reason string at L51)";
const RUFU_490_TARGET = "packages/engine/src/merge/workspace-review-reroute.ts";
const annotatedPrompt = `# Task: RUFU-490\n\n## File Scope\n\n${RUFU_490_BULLET}\n\n## Steps\n- [ ] Go\n`;

describe("leading-candidate harvest: inline annotations are commentary (RUFU-494)", () => {
  it("accepts the exact RUFU-490 annotated bullet through validation and classification", () => {
    expect(validateFileScopeInPromptContent(annotatedPrompt)).toEqual({
      valid: [RUFU_490_TARGET],
      invalid: [],
    });
    expect(extractFileScopeTokens(annotatedPrompt)).toEqual([RUFU_490_TARGET]);
    expect(extractEffectiveWriteScopeFromPrompt(annotatedPrompt)).toEqual([RUFU_490_TARGET]);

    const { entries } = classifyFileScopeFromPrompt(annotatedPrompt);
    expect(entries.map((entry) => entry.token)).toEqual([RUFU_490_TARGET]);
    expect(entries.some((entry) => entry.token === "rerouted")).toBe(false);
    expect(entries.some((entry) => entry.token === "false")).toBe(false);
    expect(entries.some((entry) => entry.reason === "invalid-entry")).toBe(false);
  });

  it("harvests nothing from a prose line whose backtick is not the leading content", () => {
    const prompt = "## File Scope\n\n- `packages/core/src/task-store/file-scope.ts`\n\nNote: returns `rerouted` only when the slot is held.\n\n## Steps\n";
    expect(extractFileScopeTokens(prompt)).toEqual(["packages/core/src/task-store/file-scope.ts"]);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({
      valid: ["packages/core/src/task-store/file-scope.ts"],
      invalid: [],
    });
  });

  it("keeps only the first path of a two-path bullet (deliberate narrowing)", () => {
    const prompt = "## File Scope\n\n- `packages/core/src/a.ts` and `packages/core/src/b.ts`\n";
    expect(extractFileScopeTokens(prompt)).toEqual(["packages/core/src/a.ts"]);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(["packages/core/src/a.ts"]);
    expect(validateFileScopeInPromptContent(prompt).invalid).toEqual([]);
  });

  it("does not harvest candidates from a fenced block inside the File Scope section", () => {
    const prompt = [
      "## File Scope",
      "",
      "- `packages/core/src/a.ts`",
      "",
      "```md",
      "- `origin/main`",
      "- `rerouted`",
      "```",
      "",
      "## Steps",
      "",
    ].join("\n");
    expect(extractFileScopeTokens(prompt)).toEqual(["packages/core/src/a.ts"]);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({
      valid: ["packages/core/src/a.ts"],
      invalid: [],
    });
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(["packages/core/src/a.ts"]);
  });

  it("still refuses an invalid leading candidate and names only that candidate", () => {
    const prompt = "## File Scope\n\n- `origin/main` (the base branch for the diff and a `rerouted` note)\n";
    expect(validateFileScopeInPromptContent(prompt)).toEqual({ valid: [], invalid: ["origin/main"] });

    const { entries, effectiveWriteScope } = classifyFileScopeFromPrompt(prompt);
    expect(effectiveWriteScope).toEqual([]);
    expect(entries.filter((entry) => entry.reason === "invalid-entry").map((entry) => entry.token)).toEqual([
      "origin/main",
    ]);
  });

  it("still refuses a bare word, HEAD, and a bare column name used as the leading entry", () => {
    for (const token of ["rerouted", "HEAD", "todo"]) {
      const prompt = `## File Scope\n\n- \`${token}\` (annotated)\n`;
      expect(validateFileScopeInPromptContent(prompt).invalid, token).toEqual([token]);
      expect(extractEffectiveWriteScopeFromPrompt(prompt), token).toEqual([]);
    }
  });

  it("keeps an annotated valid bullet byte-for-byte through sanitize", () => {
    /*
    sanitizeFileScopeInPromptContent backs refineTask, duplicateTask, and archive restore. Its
    whole-line `tokens.every(...)` filter used to delete the annotated bullet outright, so a copied
    spec silently lost the file it was about to edit.
    */
    const { sanitized, dropped } = sanitizeFileScopeInPromptContent(annotatedPrompt);
    expect(sanitized).toBe(annotatedPrompt);
    expect(dropped).toEqual([]);
  });

  it("drops only the line whose leading candidate is invalid and reports only that candidate", () => {
    const prompt = [
      "# Task",
      "",
      "## File Scope",
      "",
      "- `packages/core/src/a.ts` (carries a `rerouted` annotation)",
      "- `origin/main` (annotated)",
      "",
      "## Steps",
      "",
    ].join("\n");

    const { sanitized, dropped, kept } = sanitizeFileScopeInPromptContent(prompt);
    expect(dropped).toEqual(["origin/main"]);
    expect(kept).toEqual(["packages/core/src/a.ts"]);
    expect(sanitized).toContain("- `packages/core/src/a.ts` (carries a `rerouted` annotation)");
    expect(sanitized).not.toContain("origin/main");
  });
});
