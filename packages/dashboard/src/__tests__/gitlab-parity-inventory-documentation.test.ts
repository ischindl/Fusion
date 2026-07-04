// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/*
FNXC:GitLabParity 2026-07-02-00:00:
This documentation contract exists so downstream GitLab implementation tasks cannot silently drop required included surfaces or explicit non-goals while converting the inventory into runtime routes, settings, tools, and Command Center analytics.
*/
describe("gitlab parity inventory documentation contract", () => {
  it("keeps required GitHub-to-GitLab parity surfaces inventoried", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    for (const required of [
      "issue import",
      "linked issue tracking",
      "completion comments",
      "auto-close",
      "auth/settings",
      "CLI issue import",
      "Agent/extension issue import tools",
      "Command Center GitLab analytics",
      "GitLab webhook/system-hook signals",
      "GitLab.com",
      "self-managed GitLab",
      "base REST API URL",
      "Personal, project, and group access tokens",
      "project issues",
      "group issues",
      "merge requests",
    ]) {
      expect(inventory).toContain(required);
    }
  });

  it("documents GitLab token, resource, and metadata assumptions", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    expect(inventory).toContain("`read_api` grants read API access");
    expect(inventory).toContain("`api` grants complete read/write API access");
    expect(inventory).toContain("Project access tokens are scoped to one project");
    expect(inventory).toContain("Group access tokens are scoped to a group and its projects");
    expect(inventory).toContain("GitLab distinguishes global `id` from project-scoped or group-scoped `iid`");
    expect(inventory).toContain("`sourceIssue.provider = \"gitlab\"`");
    expect(inventory).toContain("mergeRequestIid");
  });

  it("keeps explicit exclusions documented", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    expect(inventory).toContain("no GitLab research/search provider parity");
    expect(inventory).toContain("must not add GitLab research provider support");
    expect(inventory).toContain("no GitLab-star prompt");
    expect(inventory).toContain("no GitLab-star prompt or GitHub-star-equivalent prompt");
    expect(inventory).toContain("`glab` CLI dependency");
  });

  it("links the inventory from existing docs surfaces", () => {
    expect(readDoc("docs/task-management.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
    expect(readDoc("docs/settings-reference.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
    expect(readDoc("docs/signals-connectors.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
  });
});
