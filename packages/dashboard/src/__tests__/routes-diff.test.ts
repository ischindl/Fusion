import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskCommitAssociation } from "@fusion/core";
import * as fs from "node:fs";

const runGitCommandMock = vi.fn<(...args: any[]) => Promise<string>>();

vi.mock("../routes/resolve-diff-base.js", () => ({
  resolveDiffBase: vi.fn(async () => "origin/main"),
  runGitCommand: (...args: any[]) => runGitCommandMock(...args),
}));

import { createServer } from "../server.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();
  private associations = new Map<string, TaskCommitAssociation[]>();

  getRootDir(): string {
    return "/tmp/fn-679";
  }

  getFusionDir(): string {
    return "/tmp/fn-679/.fusion";
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
    return Array.from(this.tasks.values());
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  setAssociations(lineageId: string, associations: TaskCommitAssociation[]): void {
    this.associations.set(lineageId, associations);
  }

  async getTaskCommitAssociationsByLineageId(lineageId: string): Promise<TaskCommitAssociation[]> {
    return this.associations.get(lineageId) ?? [];
  }
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-679",
    title: "Test task",
    description: "Test description",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    columnMovedAt: "2026-04-01T00:00:00.000Z",
    worktree: "/tmp/fn-679",
    baseBranch: "main",
    ...overrides,
  };
}

async function requestDiff(app: Parameters<typeof import("../test-request.js").get>[0], taskId = "FN-679"): Promise<{ status: number; body: any }> {
  const { get } = await import("../test-request.js");
  return get(app, `/api/tasks/${taskId}/diff`);
}

async function requestFileDiffs(app: Parameters<typeof import("../test-request.js").get>[0], taskId = "FN-679"): Promise<{ status: number; body: any }> {
  const { get } = await import("../test-request.js");
  return get(app, `/api/tasks/${taskId}/file-diffs`);
}

function gitResponses(entries: Record<string, string>) {
  runGitCommandMock.mockImplementation(async (args: string[]) => {
    const key = args.join(" ");
    if (key in entries) return entries[key] ?? "";
    throw new Error(`Unexpected git command: ${key}`);
  });
}

function makeAssociation(sha: string, authoredAt: string): TaskCommitAssociation {
  return {
    lineageId: "lin-1",
    commitSha: sha,
    commitSubject: sha,
    authoredAt,
    matchedBy: "manual",
    confidence: 1,
    taskIdSnapshot: "FN-679",
    note: null,
    createdAt: authoredAt,
    updatedAt: authoredAt,
  };
}

describe("FN-4308 multi-commit done task aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aggregates union of files for /diff and /file-diffs", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "c3" } }));
    store.setAssociations("lin-1", [makeAssociation("c1", "2026-04-01T00:00:00.000Z"), makeAssociation("c2", "2026-04-01T00:01:00.000Z"), makeAssociation("c3", "2026-04-01T00:02:00.000Z")]);

    gitResponses({
      "merge-base --is-ancestor c1 HEAD": "",
      "merge-base --is-ancestor c2 HEAD": "",
      "merge-base --is-ancestor c3 HEAD": "",
      "rev-list --parents -n 1 c1": "c1 p1",
      "diff --name-status -M p1..c1": "A\ta.txt\nM\tb.txt",
      "diff -M p1..c1 -- a.txt": "+a\n",
      "diff -M p1..c1 -- b.txt": "+b\n",
      "rev-list --parents -n 1 c2": "c2 p2",
      "diff --name-status -M p2..c2": "M\tb.txt\nA\tc.txt",
      "diff -M p2..c2 -- b.txt": "+bb\n-b\n",
      "diff -M p2..c2 -- c.txt": "+c\n",
      "rev-list --parents -n 1 c3": "c3 p3",
      "diff --name-status -M p3..c3": "A\td.txt",
      "diff -M p3..c3 -- d.txt": "+d\n",
      "rev-parse c1^": "p1",
      "diff --name-status -M p1..c3": "A\ta.txt\nM\tb.txt\nA\tc.txt\nA\td.txt",
      "diff -M p1..c3 -- a.txt": "+a\n",
      "diff -M p1..c3 -- b.txt": "+bb\n-b\n",
      "diff -M p1..c3 -- c.txt": "+c\n",
      "diff -M p1..c3 -- d.txt": "+d\n",
    });

    const app = createServer(store as any);
    const diffResponse = await requestDiff(app);
    expect(diffResponse.status).toBe(200);
    expect(diffResponse.body.stats.filesChanged).toBe(4);
    expect(diffResponse.body.files.map((f: any) => f.path).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);

    const fileDiffsResponse = await requestFileDiffs(app);
    expect(fileDiffsResponse.status).toBe(200);
    expect(fileDiffsResponse.body.map((f: any) => f.path).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
  });

  it("single-commit lineage matches existing behavior", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "c1" } }));
    store.setAssociations("lin-1", [makeAssociation("c1", "2026-04-01T00:00:00.000Z")]);

    gitResponses({
      "merge-base --is-ancestor c1 HEAD": "",
      "rev-list --parents -n 1 c1": "c1 p1",
      "diff --name-status -M p1..c1": "A\tone.txt",
      "diff -M p1..c1 -- one.txt": "+one\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.stats.filesChanged).toBe(1);
    expect(response.body.files).toHaveLength(1);
  });

  it("falls back to merge commit range when lineage associations are empty", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "m1" } }));
    store.setAssociations("lin-1", []);

    gitResponses({
      "merge-base --is-ancestor m1 HEAD": "",
      "rev-list --parents -n 1 m1": "m1 pm1",
      "diff --name-status -M pm1..m1": "M\tx.txt",
      "diff -M pm1..m1 -- x.txt": "+x\n-y\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("x.txt");
    expect(response.body.stats.filesChanged).toBe(1);
  });

  it("skips unreachable lineage SHAs and still aggregates reachable commits", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "good" } }));
    store.setAssociations("lin-1", [makeAssociation("bad", "2026-04-01T00:00:00.000Z"), makeAssociation("good", "2026-04-01T00:01:00.000Z")]);

    runGitCommandMock.mockImplementation(async (args: string[]) => {
      const key = args.join(" ");
      if (key === "merge-base --is-ancestor bad HEAD") throw new Error("unreachable");
      if (key === "merge-base --is-ancestor good HEAD") return "";
      if (key === "rev-list --parents -n 1 good") return "good p";
      if (key === "diff --name-status -M p..good") return "A\treachable.txt";
      if (key === "diff -M p..good -- reachable.txt") return "+ok\n";
      throw new Error(`Unexpected git command: ${key}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.stats.filesChanged).toBe(1);
    expect(response.body.files[0].path).toBe("reachable.txt");
  });

  it("aggregates revised done tasks that gained additional lineage commits", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "rev-2" } }));
    store.setAssociations("lin-1", [makeAssociation("rev-1", "2026-04-01T00:00:00.000Z"), makeAssociation("rev-2", "2026-04-02T00:00:00.000Z")]);

    gitResponses({
      "merge-base --is-ancestor rev-1 HEAD": "",
      "merge-base --is-ancestor rev-2 HEAD": "",
      "rev-list --parents -n 1 rev-1": "rev-1 p1",
      "diff --name-status -M p1..rev-1": "A\tinitial.ts",
      "diff -M p1..rev-1 -- initial.ts": "+i\n",
      "rev-list --parents -n 1 rev-2": "rev-2 p2",
      "diff --name-status -M p2..rev-2": "A\trevision.ts",
      "diff -M p2..rev-2 -- revision.ts": "+r\n",
      "rev-parse rev-1^": "p1",
      "diff --name-status -M p1..rev-2": "A\tinitial.ts\nA\trevision.ts",
      "diff -M p1..rev-2 -- initial.ts": "+i\n",
      "diff -M p1..rev-2 -- revision.ts": "+r\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.stats.filesChanged).toBe(2);
    expect(response.body.files.map((f: any) => f.path).sort()).toEqual(["initial.ts", "revision.ts"]);
  });

  it("uses legacy single-commit behavior when only mergeDetails.commitSha exists", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", mergeDetails: { commitSha: "healed" } }));

    gitResponses({
      "merge-base --is-ancestor healed HEAD": "",
      "rev-list --parents -n 1 healed": "healed ph",
      "diff --name-status -M ph..healed": "A\thealed.ts",
      "diff -M ph..healed -- healed.ts": "+h\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.stats.filesChanged).toBe(1);
    expect(response.body.files[0].path).toBe("healed.ts");
  });

  it("uses parent-to-parent range for merge commits", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", mergeDetails: { commitSha: "merge-sha" } }));

    gitResponses({
      "merge-base --is-ancestor merge-sha HEAD": "",
      "rev-list --parents -n 1 merge-sha": "merge-sha p1 p2",
      "diff --name-status -M merge-sha^1...merge-sha^2": "A\tfeature-a.ts\nM\tfeature-b.ts",
      "diff -M merge-sha^1...merge-sha^2 -- feature-a.ts": "+a\n",
      "diff -M merge-sha^1...merge-sha^2 -- feature-b.ts": "+b\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files.map((f: any) => f.path).sort()).toEqual(["feature-a.ts", "feature-b.ts"]);
    expect(response.body.stats.filesChanged).toBe(2);
  });

  it("falls back to commitSha enumeration when aggregation under-counts mergeDetails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "merge", filesChanged: 3 } }));
    store.setAssociations("lin-1", [makeAssociation("assoc", "2026-04-01T00:00:00.000Z")]);

    let mergeNameStatusCalls = 0;
    runGitCommandMock.mockImplementation(async (args: string[]) => {
      const key = args.join(" ");
      if (key === "merge-base --is-ancestor assoc HEAD") return "";
      if (key === "merge-base --is-ancestor merge HEAD") return "";
      if (key === "rev-list --parents -n 1 assoc") return "assoc pa";
      if (key === "diff --name-status -M pa..assoc") return "M\ta.txt";
      if (key === "diff -M pa..assoc -- a.txt") return "+a\n";
      if (key === "rev-list --parents -n 1 merge") return "merge pm";
      if (key === "diff --name-status -M pm..merge") {
        mergeNameStatusCalls += 1;
        return mergeNameStatusCalls === 1 ? "M\tb.txt" : "A\tone.ts\nA\ttwo.ts\nA\tthree.ts";
      }
      if (key === "diff -M pm..merge -- b.txt") return "+b\n";
      if (key === "rev-parse assoc^") return "pa";
      if (key === "diff --name-status -M pa..merge") return "M\ta.txt";
      if (key === "diff -M pa..merge -- a.txt") return "+a\n";
      if (key === "diff -M pm..merge -- one.ts") return "+1\n";
      if (key === "diff -M pm..merge -- two.ts") return "+2\n";
      if (key === "diff -M pm..merge -- three.ts") return "+3\n";
      throw new Error(`Unexpected git command: ${key}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files.map((f: any) => f.path).sort()).toEqual(["one.ts", "three.ts", "two.ts"]);
    expect(response.body.files.length).toBe(response.body.stats.filesChanged);
  });

  it("enumerates done commitSha even when commit is unreachable from HEAD", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", mergeDetails: { commitSha: "orphaned", filesChanged: 2 } }));

    runGitCommandMock.mockImplementation(async (args: string[]) => {
      const key = args.join(" ");
      if (key === "merge-base --is-ancestor orphaned HEAD") throw new Error("unreachable");
      if (key === "rev-list --parents -n 1 orphaned") return "orphaned porphan";
      if (key === "diff --name-status -M porphan..orphaned") return "A\tone.ts\nA\ttwo.ts";
      if (key === "diff -M porphan..orphaned -- one.ts") return "+1\n";
      if (key === "diff -M porphan..orphaned -- two.ts") return "+2\n";
      throw new Error(`Unexpected git command: ${key}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files.map((f: any) => f.path).sort()).toEqual(["one.ts", "two.ts"]);
    expect(response.body.files.length).toBe(response.body.stats.filesChanged);
  });

  it("uses empty tree fallback for root commit done tasks", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", mergeDetails: { commitSha: "root" } }));

    gitResponses({
      "merge-base --is-ancestor root HEAD": "",
      "rev-list --parents -n 1 root": "root",
      "diff --name-status -M 4b825dc642cb6eb9a060e54bf8d69288fbee4904..root": "A\tinitial.ts",
      "diff -M 4b825dc642cb6eb9a060e54bf8d69288fbee4904..root -- initial.ts": "+init\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files[0].path).toBe("initial.ts");
    expect(response.body.files.length).toBe(response.body.stats.filesChanged);
  });

  it("uses renamed path when done task includes rename status", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", mergeDetails: { commitSha: "rename-sha" } }));

    gitResponses({
      "merge-base --is-ancestor rename-sha HEAD": "",
      "rev-list --parents -n 1 rename-sha": "rename-sha p0",
      "diff --name-status -M p0..rename-sha": "R100\tfoo.ts\tbar.ts",
      "diff -M p0..rename-sha -- bar.ts": "rename from foo.ts\nrename to bar.ts\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("bar.ts");
    expect(response.body.files[0].patch.length).toBeGreaterThan(0);
    expect(response.body.files.length).toBe(response.body.stats.filesChanged);
  });

  it("uses diffBase-to-worktree patching for in-progress committed/staged/unstaged files", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "in-progress", worktree: process.cwd() }));

    gitResponses({
      "diff --name-status origin/main..HEAD": "M\tcommitted.ts",
      "diff --cached --name-status": "A\tstaged.ts",
      "diff --name-status": "M\tunstaged.ts",
      "diff origin/main -- committed.ts": "+c\n",
      "diff origin/main -- staged.ts": "+s\n",
      "diff origin/main -- unstaged.ts": "+u\n",
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(3);
    for (const file of response.body.files) {
      expect(file.patch.length).toBeGreaterThan(0);
      expect(file.additions + file.deletions).toBeGreaterThan(0);
    }
    expect(response.body.files.length).toBe(response.body.stats.filesChanged);
  });

  it("includes mergeDetails.commitSha even when missing from associations", async () => {
    const store = new MockStore();
    store.addTask(createTask({ column: "done", lineageId: "lin-1", mergeDetails: { commitSha: "merge-only" } }));
    store.setAssociations("lin-1", [makeAssociation("assoc-1", "2026-04-01T00:00:00.000Z")]);

    runGitCommandMock.mockImplementation(async (args: string[]) => {
      const key = args.join(" ");
      if (key === "merge-base --is-ancestor assoc-1 HEAD") throw new Error("unreachable");
      if (key === "merge-base --is-ancestor merge-only HEAD") return "";
      if (key === "rev-list --parents -n 1 merge-only") return "merge-only p";
      if (key === "diff --name-status -M p..merge-only") return "A\tmerged.txt";
      if (key === "diff -M p..merge-only -- merged.txt") return "+ok\n";
      throw new Error(`Unexpected git command: ${key}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);
    expect(response.status).toBe(200);
    expect(response.body.stats.filesChanged).toBe(1);
    expect(response.body.files[0].path).toBe("merged.txt");
  });
});
