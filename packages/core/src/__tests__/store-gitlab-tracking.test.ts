import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TaskGitLabTrackedItem } from "../types.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-gitlab-tracking-test-"));
}

const projectIssue: TaskGitLabTrackedItem = {
  kind: "project_issue",
  url: "https://gitlab.com/acme/app/-/issues/42",
  instanceUrl: "https://gitlab.com",
  host: "gitlab.com",
  iid: 42,
  id: 1001,
  projectId: 7,
  projectPath: "acme/app",
  title: "Project issue",
  state: "opened",
  createdAt: "2026-07-02T00:00:00.000Z",
  linkedAt: "2026-07-02T00:00:01.000Z",
  lastSyncedAt: "2026-07-02T00:00:02.000Z",
};

const staleGroupIssue: TaskGitLabTrackedItem = {
  kind: "group_issue",
  url: "https://git.example.test/groups/platform/-/issues/9",
  instanceUrl: "https://git.example.test",
  host: "git.example.test",
  iid: 9,
  groupPath: "platform",
  title: "Group issue",
  state: "opened",
  createdAt: "2026-07-02T00:00:00.000Z",
  staleAt: "2026-07-02T01:00:00.000Z",
  staleReason: "GitLab sync failed",
};

const mergeRequest: TaskGitLabTrackedItem = {
  kind: "merge_request",
  url: "https://gitlab.example.org/acme/app/-/merge_requests/5",
  instanceUrl: "https://gitlab.example.org",
  host: "gitlab.example.org",
  iid: 5,
  projectPath: "acme/app",
  title: "Merge request",
  state: "merged",
  createdAt: "2026-07-02T00:00:00.000Z",
};

describe("TaskStore gitlab tracking", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("persists gitlabTracking through create, update, detail, slim, search, and modified-since paths", async () => {
    const task = await store.createTask({ description: "Track GitLab", gitlabTracking: { item: projectIssue } });
    expect((await store.getTask(task.id)).gitlabTracking?.item).toEqual(projectIssue);

    await store.updateTask(task.id, { gitlabTracking: { item: staleGroupIssue } });
    expect((await store.getTask(task.id)).gitlabTracking?.item).toEqual(staleGroupIssue);

    const slim = await store.listTasks({ slim: true });
    expect(slim.find((entry) => entry.id === task.id)?.gitlabTracking?.item).toEqual(staleGroupIssue);
    expect((await store.searchTasks("Track GitLab", { slim: true })).find((entry) => entry.id === task.id)?.gitlabTracking?.item).toEqual(staleGroupIssue);
    expect((await store.listTasksModifiedSince("1970-01-01T00:00:00.000Z")).tasks.find((entry) => entry.id === task.id)?.gitlabTracking?.item).toEqual(staleGroupIssue);
  });

  it("links, unlinks, and clears gitlabTracking without touching github/source metadata", async () => {
    const task = await store.createTask({
      description: "Coexist",
      sourceIssue: { provider: "github", repository: "octo/repo", externalIssueId: "1", issueNumber: 1, url: "https://github.com/octo/repo/issues/1" },
      githubTracking: { enabled: true, repoOverride: "octo/repo" },
    });

    await store.linkGitLabItem(task.id, mergeRequest);
    let updated = await store.getTask(task.id);
    expect(updated.gitlabTracking?.item).toEqual(mergeRequest);
    expect(updated.githubTracking).toEqual({ enabled: true, repoOverride: "octo/repo" });
    expect(updated.sourceIssue?.provider).toBe("github");

    await store.unlinkGitLabItem(task.id);
    updated = await store.getTask(task.id);
    expect(updated.gitlabTracking?.item).toBeUndefined();
    expect(updated.gitlabTracking?.unlinkedAt).toBeTruthy();
    expect(updated.githubTracking?.repoOverride).toBe("octo/repo");

    await store.updateTask(task.id, { gitlabTracking: null });
    updated = await store.getTask(task.id);
    expect(updated.gitlabTracking).toBeUndefined();
    expect(updated.githubTracking?.repoOverride).toBe("octo/repo");
  });

  it("round-trips gitlabTracking across disk restart and archive restore", async () => {
    const diskRoot = makeTmpDir();
    const diskGlobal = makeTmpDir();
    try {
      const first = new TaskStore(diskRoot, diskGlobal);
      await first.init();
      const created = await first.createTask({ description: "Restart GitLab" });
      await first.updateGitLabTracking(created.id, { item: projectIssue });
      first.close();

      const second = new TaskStore(diskRoot, diskGlobal);
      await second.init();
      const reloaded = (await second.listTasks()).find((entry) => entry.description === "Restart GitLab");
      expect(reloaded?.gitlabTracking?.item).toEqual(projectIssue);
      await second.moveTask(reloaded!.id, "todo");
      await second.moveTask(reloaded!.id, "in-progress");
      await second.moveTask(reloaded!.id, "done");
      await second.archiveTask(reloaded!.id, false);
      const restored = await second.unarchiveTask(reloaded!.id);
      expect(restored.gitlabTracking?.item).toEqual(projectIssue);
      second.close();
    } finally {
      await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(diskGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
