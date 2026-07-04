import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "../store.js";
import type { TaskGitLabTrackedItem } from "../types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-gitlab-reconcile-test-"));
}

const gitlabItem: TaskGitLabTrackedItem = {
  kind: "project_issue",
  url: "https://gitlab.com/acme/app/-/issues/42",
  instanceUrl: "https://gitlab.com",
  host: "gitlab.com",
  iid: 42,
  projectPath: "acme/app",
  title: "Tracked GitLab issue",
  state: "opened",
};

describe("TaskStore.listTasksForGitlabTrackingReconcile", () => {
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

  it("returns soft-deleted and archived tasks with GitLab tracking only", async () => {
    const softDeleted = await store.createTask({ description: "soft deleted", gitlabTracking: { item: gitlabItem } });
    await store.deleteTask(softDeleted.id);

    const archivedDone = await store.createTask({ description: "archived done", gitlabTracking: { item: gitlabItem } });
    await store.moveTask(archivedDone.id, "todo");
    await store.moveTask(archivedDone.id, "in-progress");
    await store.moveTask(archivedDone.id, "in-review");
    await store.moveTask(archivedDone.id, "done");
    await store.archiveTask(archivedDone.id);

    const archivedTodo = await store.createTask({ description: "archived todo", gitlabTracking: { item: gitlabItem } });
    await store.moveTask(archivedTodo.id, "todo");
    await store.moveTask(archivedTodo.id, "in-progress");
    await store.moveTask(archivedTodo.id, "in-review");
    await store.moveTask(archivedTodo.id, "done");
    await store.archiveTask(archivedTodo.id);

    const archivedTodoEntry = (store as unknown as {
      archiveDb: { get: (id: string) => { executionCompletedAt?: string } | undefined; upsert: (entry: Record<string, unknown>) => void };
    }).archiveDb.get(archivedTodo.id);
    if (archivedTodoEntry) {
      (store as unknown as { archiveDb: { upsert: (entry: Record<string, unknown>) => void } }).archiveDb.upsert({
        ...archivedTodoEntry,
        executionCompletedAt: undefined,
      });
    }

    const activeTracked = await store.createTask({ description: "active tracked", gitlabTracking: { item: gitlabItem } });
    const githubOnly = await store.createTask({
      description: "github deleted",
      githubTracking: { enabled: true, issue: { owner: "octo", repo: "repo", number: 1, url: "https://github.com/octo/repo/issues/1" } },
    });
    await store.deleteTask(githubOnly.id);

    const { tasks, hasMore } = await store.listTasksForGitlabTrackingReconcile();
    const byId = new Map(tasks.map((task) => [task.id, task]));

    expect(byId.has(softDeleted.id)).toBe(true);
    expect(byId.has(archivedDone.id)).toBe(true);
    expect(byId.has(archivedTodo.id)).toBe(true);
    expect(byId.get(archivedDone.id)?.executionCompletedAt).toBeTruthy();
    expect(byId.get(archivedTodo.id)?.executionCompletedAt).toBeFalsy();
    expect(byId.has(activeTracked.id)).toBe(false);
    expect(byId.has(githubOnly.id)).toBe(false);
    expect(hasMore).toBe(false);
  });

  it("returns empty results when nothing matches", async () => {
    const task = await store.createTask({ description: "no gitlab tracking" });
    await store.moveTask(task.id, "todo");

    await expect(store.listTasksForGitlabTrackingReconcile()).resolves.toEqual({ tasks: [], hasMore: false });
  });

  it("paginates across soft-deleted and archived GitLab tracked entries", async () => {
    for (let i = 0; i < 3; i += 1) {
      const task = await store.createTask({ description: `deleted ${i}`, gitlabTracking: { item: { ...gitlabItem, iid: 100 + i } } });
      await store.deleteTask(task.id);
    }

    for (let i = 0; i < 3; i += 1) {
      const task = await store.createTask({ description: `archived ${i}`, gitlabTracking: { item: { ...gitlabItem, iid: 200 + i } } });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
    }

    const page1 = await store.listTasksForGitlabTrackingReconcile({ offset: 0, limit: 2 });
    const page2 = await store.listTasksForGitlabTrackingReconcile({ offset: 2, limit: 2 });
    const page3 = await store.listTasksForGitlabTrackingReconcile({ offset: 4, limit: 2 });

    expect(page1.tasks).toHaveLength(2);
    expect(page2.tasks).toHaveLength(2);
    expect(page3.tasks).toHaveLength(2);
    expect(new Set([...page1.tasks, ...page2.tasks, ...page3.tasks].map((task) => task.id)).size).toBe(6);
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(true);
    expect(page3.hasMore).toBe(false);
  });
});
