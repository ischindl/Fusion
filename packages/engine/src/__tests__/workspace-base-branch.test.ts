import { describe, expect, it } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  recordTaskBaseResolution,
  recordWorkspaceBaseBranchDecision,
  resolveWorkspaceRepoBaseBranch,
} from "../worktree/workspace-base-branch.js";
import { resolveLocalIntegrationBase } from "../worktree/task-base-resolution.js";

const task = (baseBranch?: string) => ({ id: "FN-9164", baseBranch } as Pick<Task, "id" | "baseBranch">);

function execFor(refs: string[], commands: string[] = []) {
  return (async (command: string) => {
    commands.push(command);
    if (refs.some((ref) => command.includes(`${ref}^{commit}`))) return { stdout: "abc123\n", stderr: "" };
    throw new Error("missing ref");
  }) as never;
}

describe("resolveWorkspaceRepoBaseBranch", () => {
  it("uses a verified requested base and shell-quotes it", async () => {
    const commands: string[] = [];
    const resolution = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire",
      repoRootDir: "/missing-repo",
      repoRelPath: "repo-a",
      task: task("release/needle-9164; echo nope"),
      settings: {},
      execImpl: execFor(["release/needle-9164; echo nope"], commands),
    });
    expect(resolution).toMatchObject({ branch: "release/needle-9164; echo nope", source: "task-base-branch" });
    expect(commands[0]).toContain("'release/needle-9164; echo nope^{commit}'");
  });

  it("normalizes a remote-tracking-only base into a local lifecycle target", async () => {
    const commands: string[] = [];
    let localCreated = false;
    const execImpl = (async (command: string) => {
      commands.push(command);
      if (command.includes("origin/release/remote-only^{commit}")) return { stdout: "abc123\n", stderr: "" };
      if (command.includes("release/remote-only^{commit}") && localCreated) return { stdout: "abc123\n", stderr: "" };
      if (command.includes("git branch -- 'release/remote-only' 'origin/release/remote-only'")) {
        localCreated = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error("missing ref");
    }) as never;

    const resolution = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/remote-only"), settings: {}, execImpl,
    });

    expect(resolution).toMatchObject({ branch: "release/remote-only", requested: "release/remote-only", source: "task-base-branch" });
    expect(commands).toContain("git branch -- 'release/remote-only' 'origin/release/remote-only'");
  });

  it("falls back without failing acquisition for unresolvable and sibling task refs", async () => {
    const unresolved = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/missing"), settings: {}, execImpl: execFor([]),
    });
    const sibling = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("fusion/fn-123"), settings: {}, execImpl: execFor([]),
    });
    expect(unresolved).toMatchObject({ branch: "main", source: "repo-integration", fallbackReason: "unresolvable-in-repo" });
    expect(sibling).toMatchObject({ branch: "main", source: "repo-integration", fallbackReason: "sibling-task-branch" });
  });

  it("keeps legacy and recorded entries independent of task.baseBranch", async () => {
    const legacy = await resolveWorkspaceRepoBaseBranch({
      mode: "recorded", recordedBaseBranch: undefined, repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/new"), settings: {}, execImpl: execFor(["release/new"]),
    });
    const recorded = await resolveWorkspaceRepoBaseBranch({
      mode: "recorded", recordedBaseBranch: "release/old", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/new"), settings: {}, execImpl: execFor(["release/old"]),
    });
    expect(legacy).toEqual({ branch: "main", source: "legacy-entry" });
    expect(recorded).toMatchObject({ branch: "release/old", requested: "release/old", source: "recorded-base" });
  });

  it("emits no ref names to audit while retaining human-readable logs", async () => {
    const events: Array<{ target: string; metadata: Record<string, unknown> }> = [];
    const logs: string[] = [];
    await recordWorkspaceBaseBranchDecision({
      store: { logEntry: async (_id: string, message: string) => { logs.push(message); } } as Pick<TaskStore, "logEntry">,
      audit: { git: async (event: never) => { events.push(event as unknown as { target: string; metadata: Record<string, unknown> }); } },
      task: task("release/needle-9164"), repoRelPath: "repo-a", repoAbsPath: "/workspace/repo-a", stage: "acquire",
      resolution: { branch: "main", requested: "release/needle-9164", source: "repo-integration", fallbackReason: "unresolvable-in-repo" },
    });
    expect(logs[0]).toContain("release/needle-9164");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: "/workspace/repo-a", metadata: { taskId: "FN-9164", repoRelPath: "repo-a", stage: "acquire", source: "repo-integration", outcome: "fallback", fallbackReason: "unresolvable-in-repo" } });
    expect(Object.keys(events[0].metadata).sort()).toEqual(["fallbackReason", "outcome", "repoRelPath", "source", "stage", "taskId"]);
    expect(JSON.stringify(events[0].metadata)).not.toContain("release/needle-9164");
    expect(events[0].target).not.toContain("release/needle-9164");
  });
});

/*
FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
Fresh-creation base verdicts ride the existing base-resolution event, so these cases pin the new
recorded shape: the documented key set only, `source: "local-integration"` to separate the rows
from the requested-base rows, and zero ref names or SHAs in metadata or target.
*/
describe("recordTaskBaseResolution", () => {
  type AuditEvent = { type: string; target: string; metadata: Record<string, unknown> };

  function auditor(events: AuditEvent[]) {
    return {
      git: async (event: AuditEvent) => {
        events.push(event);
      },
    };
  }

  it("records a refusal verdict with ids/outcomes-only metadata", async () => {
    const events: AuditEvent[] = [];
    await recordTaskBaseResolution({
      audit: auditor(events) as never,
      task: { id: "FN-245" } as Pick<Task, "id">,
      rootDir: "/repo",
      outcome: "refused-diverged",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("worktree:workspace-repo-base-branch");
    expect(events[0].metadata).toEqual({
      taskId: "FN-245",
      stage: "acquire",
      source: "local-integration",
      outcome: "refused-diverged",
    });
    expect(Object.keys(events[0].metadata).sort()).toEqual(["outcome", "source", "stage", "taskId"]);
    expect(events[0].target).toBe("/repo");
  });

  it("names the sub-repository and fallback reason for a skipped comparison without leaking refs", async () => {
    const events: AuditEvent[] = [];
    await recordTaskBaseResolution({
      audit: auditor(events) as never,
      task: { id: "FN-245" } as Pick<Task, "id">,
      rootDir: "/workspace/services/api",
      repoRelPath: "services/api",
      outcome: "skipped-remote-rebase-disabled",
      fallbackReason: "remote-rebase-disabled",
    });

    expect(events[0].metadata).toEqual({
      taskId: "FN-245",
      repoRelPath: "services/api",
      stage: "acquire",
      source: "local-integration",
      outcome: "skipped-remote-rebase-disabled",
      fallbackReason: "remote-rebase-disabled",
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toMatch(/origin\//);
    expect(serialized).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it("swallows a hostile audit sink so telemetry cannot gate acquisition", async () => {
    await expect(recordTaskBaseResolution({
      audit: { git: async () => { throw new Error("sink down"); } } as never,
      task: { id: "FN-245" } as Pick<Task, "id">,
      rootDir: "/repo",
      outcome: "resolved-local-base",
    })).resolves.toBeUndefined();
  });
});

/*
FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
The local-only base helper is the single seam the squash-import planner and the outer createWorktree
use to name the ref a branch is cut from. These cases pin that it resolves a ref, and degrades to a
null SHA (caller falls back) instead of throwing when the ref is absent.
*/
describe("resolveLocalIntegrationBase", () => {
  it("resolves the configured integration ref to a commit SHA", async () => {
    const commands: string[] = [];
    const base = await resolveLocalIntegrationBase({
      rootDir: "/repo",
      settings: { integrationBranch: "trunk" },
      execImpl: async (command) => {
        commands.push(command);
        if (command.includes("'trunk^{commit}'")) return { stdout: "  deadbeef\n" };
        throw new Error("unexpected git read");
      },
    });

    expect(base).toEqual({ integrationBranch: "trunk", localSha: "deadbeef" });
    expect(commands).toEqual(["git rev-parse --verify 'trunk^{commit}'"]);
  });

  it("returns a null SHA rather than throwing when the integration ref does not exist", async () => {
    const base = await resolveLocalIntegrationBase({
      rootDir: "/repo",
      settings: { integrationBranch: "main" },
      execImpl: async () => { throw new Error("unknown revision"); },
    });

    expect(base).toEqual({ integrationBranch: "main", localSha: null });
  });
});
