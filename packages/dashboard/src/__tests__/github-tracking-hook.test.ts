import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, setTaskCreatedHook } from "@fusion/core";

const { mockCreateIssue, mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

import { registerGithubTrackingHook } from "../github-tracking-hook.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-dashboard-github-tracking-hook-test-"));
}

describe("registerGithubTrackingHook", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    vi.clearAllMocks();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "tok" } });
    mockCreateIssue.mockResolvedValue({
      owner: "o",
      repo: "r",
      number: 42,
      htmlUrl: "https://github.com/o/r/issues/42",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("creates a tracking issue when githubTracking.enabled is true and repo is configured", async () => {
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const task = await store.createTask({
      description: "test task",
      title: "Test task",
      githubTracking: { enabled: true },
    });

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", title: expect.stringContaining(task.id) }),
    );
  });

  it("is a no-op when githubTracking is not enabled", async () => {
    registerGithubTrackingHook();

    await store.createTask({
      description: "no tracking",
      title: "No tracking",
    });

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("is a no-op when task already has a linked issue", async () => {
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const task = await store.createTask({
      description: "already linked",
      title: "Already linked",
      githubTracking: {
        enabled: true,
        issue: { owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/issues/1" },
      },
    });

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not propagate hook errors out of createTask", async () => {
    mockCreateIssue.mockRejectedValue(new Error("Octokit failure"));
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    // Should NOT throw — best-effort contract
    const task = await store.createTask({
      description: "will fail gracefully",
      title: "Graceful failure",
      githubTracking: { enabled: true },
    });

    expect(task.id).toMatch(/^FN-/);
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
  });
});
