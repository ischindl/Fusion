import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateGitlabIssueAnalytics } from "../gitlab-issue-analytics.js";

function insertTrackedItem(
  db: Database,
  id: string,
  item: Record<string, unknown>,
  updatedAt = "2026-07-01T00:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, gitlabTracking)
     VALUES (?, 'desc', 'todo', ?, ?, ?)`,
  ).run(id, updatedAt, updatedAt, JSON.stringify({ item }));
}

function insertRawTracking(db: Database, id: string, gitlabTracking: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, gitlabTracking)
     VALUES (?, 'desc', 'todo', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', ?)`,
  ).run(id, gitlabTracking);
}

function insertGithubTrackedIssue(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, githubTracking)
     VALUES (?, 'desc', 'todo', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z', ?)`,
  ).run(id, JSON.stringify({ issue: { owner: "octo", repo: "repo", number: 1, createdAt: "2026-07-02T00:00:00.000Z" } }));
}

function insertSourceIssueTask(
  db: Database,
  id: string,
  opts: {
    provider: string;
    repository: string | null;
    column: string;
    updatedAt: string;
    closedAt?: string | null;
    issueNumber?: number | null;
    url?: string | null;
    title?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (
       id, title, description, "column", createdAt, updatedAt,
       sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId,
       sourceIssueNumber, sourceIssueUrl, sourceIssueClosedAt
     ) VALUES (?, ?, 'desc', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.title ?? null,
    opts.column,
    opts.updatedAt,
    opts.updatedAt,
    opts.provider,
    opts.repository,
    String(opts.issueNumber ?? 1),
    opts.issueNumber === undefined ? 1 : opts.issueNumber,
    opts.url === undefined ? `https://gitlab.example.test/${id}` : opts.url,
    opts.closedAt ?? null,
  );
}

describe("gitlab-issue-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-gitlab-issue-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aggregates filed/fixed GitLab totals, daily buckets, projects, and provider isolation", () => {
    insertTrackedItem(db, "filed-project", {
      kind: "project_issue",
      iid: 10,
      projectPath: "acme/alpha",
      createdAt: "2026-07-01T12:00:00.000Z",
    });
    insertTrackedItem(db, "filed-group", {
      kind: "group_issue",
      iid: 11,
      groupPath: "platform/group",
      createdAt: "2026-07-02T12:00:00.000Z",
    });
    insertTrackedItem(db, "filed-mr", {
      kind: "merge_request",
      iid: 12,
      projectPath: "acme/alpha",
      createdAt: "2026-07-02T13:00:00.000Z",
    });
    insertTrackedItem(db, "filed-old", {
      kind: "project_issue",
      iid: 9,
      projectPath: "acme/old",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    insertGithubTrackedIssue(db, "github-filed");

    insertSourceIssueTask(db, "fixed-project", {
      provider: "gitlab",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-07-02T20:00:00.000Z",
      issueNumber: 20,
    });
    insertSourceIssueTask(db, "fixed-mr", {
      provider: "gitlab",
      repository: "acme/beta",
      column: "done",
      updatedAt: "2026-07-03T20:00:00.000Z",
      closedAt: "2026-07-03T21:00:00.000Z",
      issueNumber: 21,
    });
    insertSourceIssueTask(db, "not-done", {
      provider: "gitlab",
      repository: "acme/alpha",
      column: "todo",
      updatedAt: "2026-07-02T20:00:00.000Z",
      issueNumber: 22,
    });
    insertSourceIssueTask(db, "not-gitlab", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-07-02T20:00:00.000Z",
      issueNumber: 23,
    });

    const result = aggregateGitlabIssueAnalytics(db, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-03T23:59:59.999Z",
    });

    expect(result.filed).toBe(3);
    expect(result.fixed).toBe(2);
    expect(result.net).toBe(1);
    expect(result.daily).toEqual([
      { date: "2026-07-01", filed: 1, fixed: 0 },
      { date: "2026-07-02", filed: 2, fixed: 1 },
      { date: "2026-07-03", filed: 0, fixed: 1 },
    ]);
    expect(result.byProject).toEqual([
      { project: "acme/alpha", filed: 2, fixed: 1 },
      { project: "acme/beta", filed: 0, fixed: 1 },
      { project: "platform/group", filed: 1, fixed: 0 },
    ]);
    expect(result.resolved).toHaveLength(result.fixed);
  });

  it("returns resolved rows using exact closedAt before updatedAt fallback", () => {
    insertSourceIssueTask(db, "resolved-exact-later", {
      provider: "gitlab",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-07-01T00:00:00.000Z",
      closedAt: "2026-07-03T10:00:00.000Z",
      issueNumber: 42,
      url: "https://gitlab.example.test/acme/alpha/-/issues/42",
      title: "Fix alpha crash",
    });
    insertSourceIssueTask(db, "resolved-fallback", {
      provider: "gitlab",
      repository: null,
      column: "done",
      updatedAt: "2026-07-02T10:00:00.000Z",
      closedAt: null,
      issueNumber: null,
      url: null,
      title: "Resolve historical import",
    });
    insertSourceIssueTask(db, "closed-out-of-range", {
      provider: "gitlab",
      repository: "acme/old",
      column: "done",
      updatedAt: "2026-07-02T10:00:00.000Z",
      closedAt: "2026-06-30T23:59:59.999Z",
      issueNumber: 44,
    });
    insertSourceIssueTask(db, "not-gitlab-source", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-07-03T10:00:00.000Z",
      issueNumber: 46,
    });

    const result = aggregateGitlabIssueAnalytics(db, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-03T23:59:59.999Z",
    });

    expect(result.fixed).toBe(2);
    expect(result.resolved).toEqual([
      {
        taskId: "resolved-exact-later",
        taskTitle: "Fix alpha crash",
        project: "acme/alpha",
        issueNumber: 42,
        url: "https://gitlab.example.test/acme/alpha/-/issues/42",
        resolvedAt: "2026-07-03T10:00:00.000Z",
        resolvedAtExact: true,
      },
      {
        taskId: "resolved-fallback",
        taskTitle: "Resolve historical import",
        project: "(unknown)",
        issueNumber: null,
        url: null,
        resolvedAt: "2026-07-02T10:00:00.000Z",
        resolvedAtExact: false,
      },
    ]);
  });

  it("ignores malformed and non-item GitLab tracking rows without fabricating dates", () => {
    insertRawTracking(db, "malformed", "{nope");
    insertRawTracking(db, "missing-item", JSON.stringify({ item: { projectPath: "acme/missing-iid" } }));
    insertTrackedItem(db, "undated", { kind: "project_issue", iid: 77, projectPath: "acme/undated" });

    const result = aggregateGitlabIssueAnalytics(db, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-03T23:59:59.999Z",
    });

    expect(result.filed).toBe(1);
    expect(result.daily).toEqual([]);
    expect(result.byProject).toEqual([{ project: "acme/undated", filed: 1, fixed: 0 }]);
  });
});
