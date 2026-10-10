// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/*
FNXC:WorkspaceDocs 2026-08-15-04:31:
Workspace mode shipped without an operator guide. This contract preserves the required lifecycle
sections, entry-point links, and source names so the guide cannot silently drift or disappear.

FNXC:WorkspaceDocs 2026-10-09-12:44 (RUFU-327):
FN-295 retired the task-archiving lifecycle, so docs/workspaces.md renamed its archiving-era cleanup
section to "## Completion cleanup", whose body states there is no separate archive lifecycle. The
expected-heading list below therefore names the successor sections (Completion cleanup, Task Reset);
restoring retired archiving wording into the guide to make a red run here go green is a defect, not a
fix — the guide is the correct artifact and this assertion is the one that was stale. The list stays a
subset contract over the lifecycle spine, deliberately not an inventory of every heading in the guide,
so broadening it to all headings is a separate decision. This note describes the retired heading in
prose instead of quoting it: RUFU-327's acceptance proof greps packages/, docs/ and scripts/ for zero
hits of that heading text, so a quoted literal here would make the proof unsatisfiable by construction.
*/
describe("workspace documentation contract", () => {
  it("includes the canonical guide structure and required cross-references", () => {
    const workspaceGuide = readDoc("docs/workspaces.md");
    const docsIndex = readDoc("docs/README.md");
    const settingsReference = readDoc("docs/settings-reference.md");
    const gettingStarted = readDoc("docs/getting-started.md");

    expect(workspaceGuide).toContain("# Workspaces (Multi-Repository Projects)");
    for (const heading of [
      "## Overview",
      "## Setup and detection",
      "## The workspace config file",
      "## The workspaceMode setting",
      "## How a workspace task executes",
      "## Review and verification",
      "## Merging: the per-repo land loop",
      "## landedSha idempotency",
      "## Partial-land recovery and self-healing",
      "## Reverting a workspace task",
      "## Completion cleanup",
      "## Task Reset",
      "## Limitations and known sharp edges",
      "## Troubleshooting",
    ]) {
      expect(workspaceGuide).toContain(heading);
    }

    expect(docsIndex).toContain("](./workspaces.md)");
    expect(settingsReference).toContain("](./workspaces.md)");
    expect(gettingStarted).toContain("](./workspaces.md)");
    expect(settingsReference).toContain("workspaceMode");
  });

  it("keeps documented workspace surfaces aligned with source", () => {
    const workspaceGuide = readDoc("docs/workspaces.md");
    const repositorySource = readDoc("packages/core/src/git/git-repository.ts");
    const agentToolsSource = readDoc("packages/engine/src/agent-tools.ts");
    const mergerSource = readDoc("packages/engine/src/merge/merger-ai.ts");
    const predicateSource = readDoc("packages/engine/src/merge/workspace-land-predicate.ts");
    const selfHealingSource = readDoc("packages/engine/src/self-healing.ts");
    const projectRoutesSource = readDoc("packages/dashboard/src/routes/register-project-routes.ts");
    const settingsScopeSource = readDoc("packages/core/src/types/settings/settings-scope.ts");

    for (const [surface, source] of [
      ["detectWorkspaceRepos", repositorySource],
      ["workspace.json", repositorySource],
      ["fn_install_worktree_dependencies", agentToolsSource],
      ["landWorkspaceTask", mergerSource],
      ["isRepoLanded", predicateSource],
      ["task:reconcile-workspace-partial-land", selfHealingSource],
      ["/projects/detect-workspace", projectRoutesSource],
      ["workspaceMode", settingsScopeSource],
    ]) {
      expect(workspaceGuide).toContain(surface);
      expect(source).toContain(surface);
    }
  });
});
