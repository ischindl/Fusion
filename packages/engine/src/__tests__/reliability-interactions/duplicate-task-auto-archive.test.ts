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
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("archives later near-duplicate from same agent", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    const a = await fx.store.createTask({
      title: "fix: secrets sync typecheck",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });
    const b = await fx.store.createTask({
      title: "fix: secrets sync typecheck regression",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(a.id)).column).toBe("triage");
    expect((await fx.store.getTask(b.id)).column).toBe("archived");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-duplicate", limit: 10 });
    const entry = activity.find((item) => item.taskId === b.id);
    expect(entry).toBeTruthy();
    expect((entry?.metadata as { siblingTaskIds?: string[] } | null)?.siblingTaskIds).toEqual([a.id]);
  });

  it("does not archive similar tasks from different agents", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    const a = await fx.store.createTask({
      title: "fix: secrets sync typecheck",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });
    const b = await fx.store.createTask({
      title: "fix: secrets sync typecheck regression",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-y" },
    });

    expect((await fx.store.getTask(a.id)).column).toBe("triage");
    expect((await fx.store.getTask(b.id)).column).toBe("triage");
  });

  it("does not archive unrelated tasks", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    const a = await fx.store.createTask({
      title: "fix: api timeout",
      description: "network timeout issue",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });
    const b = await fx.store.createTask({
      title: "feat: add mission detail panel",
      description: "new dashboard ui",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(a.id)).column).toBe("triage");
    expect((await fx.store.getTask(b.id)).column).toBe("triage");
  });

  it("does not archive similar tasks outside the 24h window", async () => {
    const fx = await createStore();
    fixtures.push(fx);

    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const a = await fx.store.createTask({
      title: "fix: secrets sync typecheck",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });
    vi.setSystemTime(new Date(start.getTime() + 25 * 60 * 60 * 1000));
    const b = await fx.store.createTask({
      title: "fix: secrets sync typecheck regression",
      description: "typecheck error in secrets-sync",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
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
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });

    const originalListTasks = fx.store.listTasks.bind(fx.store);
    vi.spyOn(fx.store, "listTasks").mockImplementation(async (options) => {
      if (options?.slim === true && options?.includeArchived === false) {
        throw new Error("boom");
      }
      return originalListTasks(options);
    });

    const b = await fx.store.createTask({
      title: "fix: baseline clone",
      description: "desc",
      source: { sourceType: "agent_heartbeat", sourceAgentId: "agent-x" },
    });

    expect((await fx.store.getTask(b.id)).column).toBe("triage");
  });
});
