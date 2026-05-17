import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { createServer } from "../server.js";

const runGitCommandMock = vi.fn<(...args: any[]) => Promise<string>>();

vi.mock("../routes/resolve-diff-base.js", () => ({
  resolveDiffBase: vi.fn(async () => "main"),
  runGitCommand: (...args: any[]) => runGitCommandMock(...args),
}));

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  getRootDir(): string {
    return "/tmp/fn-4962";
  }

  getFusionDir(): string {
    return "/tmp/fn-4962/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()];
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }
}

async function requestSessionFiles(app: Parameters<typeof import("../test-request.js").get>[0], taskId = "FN-9999") {
  const { get } = await import("../test-request.js");
  return get(app, `/api/tasks/${taskId}/session-files`);
}

describe("session-files fallback for stale worktree + null branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses derived fusion/<id> branch hint when task.branch is null", async () => {
    const store = new MockStore();
    store.addTask({
      id: "FN-9999",
      title: "stale",
      description: "stale",
      column: "in-review",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      worktree: "/definitely/missing",
      branch: null,
      baseBranch: "main",
    } as Task);

    runGitCommandMock.mockImplementation(async (args: string[]) => {
      const cmd = args.join(" ");
      if (cmd === "rev-parse --verify --quiet fusion/fn-9999") return "abc123";
      if (cmd === "diff --name-only main..fusion/fn-9999") return "src/feature.ts\n";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestSessionFiles(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["src/feature.ts"]);
  });
});
