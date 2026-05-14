import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { AutoClaimSnapshotManager, extractDescriptionFirstLine } from "../auto-claim-snapshot.js";

function makeTask(overrides: Partial<TaskDetail> & Pick<TaskDetail, "id">): TaskDetail {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    description: overrides.description ?? "desc",
    status: overrides.status ?? "open",
    column: overrides.column ?? "todo",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    dependencies: overrides.dependencies ?? [],
    labels: overrides.labels ?? [],
    comments: overrides.comments ?? [],
    activityLog: overrides.activityLog ?? [],
    metadata: overrides.metadata ?? {},
    assignedAgentId: overrides.assignedAgentId,
    checkedOutBy: overrides.checkedOutBy,
    paused: overrides.paused,
    columnMovedAt: overrides.columnMovedAt,
  } as TaskDetail;
}

describe("AutoClaimSnapshotManager", () => {
  it("shares one listTasks call across concurrent getSnapshot calls", async () => {
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, now: () => Date.parse("2026-01-03T00:00:00.000Z") });

    await Promise.all([manager.getSnapshot(), manager.getSnapshot(), manager.getSnapshot()]);

    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after TTL expiry", async () => {
    let now = Date.parse("2026-01-03T00:00:00.000Z");
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, ttlMs: 10, now: () => now });

    await manager.getSnapshot();
    now += 20;
    await manager.getSnapshot();

    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after explicit invalidation", async () => {
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });

    await manager.getSnapshot();
    manager.invalidate("test");
    await manager.getSnapshot();

    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("filters paused/assigned/checked-out/blocked tasks", async () => {
    const tasks = [
      makeTask({ id: "FN-1", dependencies: ["FN-done"] }),
      makeTask({ id: "FN-paused", paused: true }),
      makeTask({ id: "FN-assigned", assignedAgentId: "agent-1" }),
      makeTask({ id: "FN-checked", checkedOutBy: "agent-2" }),
      makeTask({ id: "FN-blocked", dependencies: ["FN-open"] }),
      makeTask({ id: "FN-done", column: "done" }),
      makeTask({ id: "FN-open", column: "in-progress" }),
    ];
    const listTasks = vi.fn(async () => tasks);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((t) => t.id)).toEqual(["FN-1"]);
  });

  it("sorts by columnMovedAt then createdAt ascending", async () => {
    const tasks = [
      makeTask({ id: "FN-3", createdAt: "2026-01-03T00:00:00.000Z" }),
      makeTask({ id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-2", createdAt: "2026-01-02T00:00:00.000Z", columnMovedAt: "2026-01-01T12:00:00.000Z" }),
    ];
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks: vi.fn(async () => tasks) } });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((t) => t.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });

  it("extracts first non-empty description line and caps length", () => {
    expect(extractDescriptionFirstLine("\n\nfirst line\nsecond line")).toBe("first line");
    expect(extractDescriptionFirstLine("   \n\t\n")).toBe("");
    expect(extractDescriptionFirstLine("x".repeat(400))).toHaveLength(160);
  });
});
