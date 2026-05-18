import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "@fusion/core";

async function createStore() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-duplicate-intake-"));
  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe("reliability interactions: same-agent duplicate intake", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createStore>>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("archives later near-duplicate from same agent", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    const a = await fx.store.createTask({
      title: "fix: secrets sync typecheck",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });
    const b = await fx.store.createTask({
      title: "fix: secrets sync typecheck regression",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(a.id)).column).toBe("triage");
    expect((await fx.store.getTask(b.id)).column).toBe("archived");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-duplicate", limit: 10 });
    const entry = activity.find((item) => item.taskId === b.id);
    expect(entry).toBeTruthy();
    expect((entry?.metadata as { siblingTaskIds?: string[] } | null)?.siblingTaskIds).toEqual([a.id]);
  });

  it("does not archive unrelated tasks", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    const a = await fx.store.createTask({
      title: "fix: api timeout",
      description: "network timeout issue",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });
    const b = await fx.store.createTask({
      title: "feat: add mission detail panel",
      description: "new dashboard ui",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(a.id)).column).toBe("triage");
    expect((await fx.store.getTask(b.id)).column).toBe("triage");
  });

  it("fails open when duplicate detection throws", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    await fx.store.createTask({
      title: "fix: baseline",
      description: "desc",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });

    vi.spyOn(fx.store, "listTasks").mockRejectedValueOnce(new Error("boom"));

    const b = await fx.store.createTask({
      title: "fix: baseline clone",
      description: "desc",
      source: { sourceType: "agent", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(b.id)).column).toBe("triage");
  });
});
