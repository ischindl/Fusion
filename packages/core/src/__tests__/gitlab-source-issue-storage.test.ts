import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TaskSourceIssue } from "../types.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-gitlab-source-storage-test-"));
}

const projectIssue: TaskSourceIssue = {
  provider: "gitlab",
  repository: "group/subgroup/project",
  externalIssueId: "987654",
  issueNumber: 42,
  url: "https://gitlab.com/group/subgroup/project/-/issues/42",
  closedAt: "2026-07-02T10:00:00.000Z",
};

const groupIssue: TaskSourceIssue = {
  provider: "gitlab",
  repository: "platform/team-service",
  externalIssueId: "123456",
  issueNumber: 7,
  url: "https://gitlab.example.test/platform/team-service/-/issues/7",
};

const mergeRequest: TaskSourceIssue = {
  provider: "gitlab",
  repository: "backend/api",
  externalIssueId: "555001",
  issueNumber: 99,
  url: "https://gitlab.example.test/backend/api/-/merge_requests/99",
  closedAt: "2026-07-02T11:00:00.000Z",
};

/*
FNXC:GitLabStorage 2026-07-02-00:00:
GitLab imports share the generic sourceIssue columns with GitHub, but provider rows must stay isolated. These tests preserve GitLab project/group/MR identity, self-managed URLs, IID-vs-global-id fields, and optional close timestamps without rewriting GitHub metadata.
*/
describe("TaskStore GitLab source issue storage", () => {
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

  it("round-trips GitLab project issues, group-backed issues, and merge requests", async () => {
    const projectTask = await store.createTask({ description: "Project import", sourceIssue: projectIssue });
    const groupTask = await store.createTask({ description: "Group import", sourceIssue: groupIssue });
    const mrTask = await store.createTask({ description: "MR review", sourceIssue: mergeRequest });

    expect((await store.getTask(projectTask.id)).sourceIssue).toEqual(projectIssue);
    expect((await store.getTask(groupTask.id)).sourceIssue).toEqual(groupIssue);
    expect((await store.getTask(mrTask.id)).sourceIssue).toEqual(mergeRequest);

    const allTasks = await store.listTasks();
    expect(allTasks.find((task) => task.id === projectTask.id)?.sourceIssue).toEqual(projectIssue);
    expect(allTasks.find((task) => task.id === groupTask.id)?.sourceIssue).toEqual(groupIssue);
    expect(allTasks.find((task) => task.id === mrTask.id)?.sourceIssue).toEqual(mergeRequest);
  });

  it("preserves encoded project paths, IID/global id split, and optional closedAt through updates", async () => {
    const task = await store.createTask({
      description: "Encoded GitLab import",
      sourceIssue: {
        provider: "gitlab",
        repository: "group%2Fsubgroup%2Fencoded-project",
        externalIssueId: "444555666",
        issueNumber: 101,
        url: "https://gitlab.example.test/group/subgroup/encoded-project/-/issues/101",
      },
    });

    await store.updateTask(task.id, { sourceIssue: { ...projectIssue, closedAt: undefined } });
    expect((await store.getTask(task.id)).sourceIssue).toEqual({ ...projectIssue, closedAt: undefined });

    await store.updateTask(task.id, { sourceIssue: mergeRequest });
    expect((await store.getTask(task.id)).sourceIssue).toEqual(mergeRequest);

    await store.updateTask(task.id, { sourceIssue: null });
    expect((await store.getTask(task.id)).sourceIssue).toBeUndefined();
  });

  it("persists GitLab source metadata across disk-backed reopen, done, reopen, archive, and restore flows", async () => {
    const diskRoot = makeTmpDir();
    const diskGlobal = makeTmpDir();
    try {
      const first = new TaskStore(diskRoot, diskGlobal);
      await first.init();
      const created = await first.createTask({ description: "Disk GitLab", sourceIssue: groupIssue });
      await first.moveTask(created.id, "todo");
      await first.moveTask(created.id, "in-progress");
      await first.moveTask(created.id, "done");
      first.close();

      const second = new TaskStore(diskRoot, diskGlobal);
      await second.init();
      const reopened = (await second.listTasks()).find((task) => task.description === "Disk GitLab");
      expect(reopened?.sourceIssue).toEqual(groupIssue);

      await second.moveTask(reopened!.id, "todo");
      expect((await second.getTask(reopened!.id)).sourceIssue).toEqual(groupIssue);

      await second.archiveTask(reopened!.id, false);
      const restored = await second.unarchiveTask(reopened!.id);
      expect(restored.sourceIssue).toEqual(groupIssue);
      second.close();
    } finally {
      await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(diskGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
