import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:AssigneeTransferAtomicity 2026-09-21-20:36 (RUFU-260):
An ownership transfer must be ONE typed announcement so the engine can tear down the previous
owner's in-flight session. Before this event the engine could not distinguish a transfer from any
other `task:updated`, so a transferred card kept its old owner's session writing while the new
owner's heartbeat woke — two writers on one worktree.

Two layers, following `lifecycle-move-provenance-emit.test.ts`:
  1. CODE-CONSTRUCT guards on the sole emitter (`updateTask`), runnable on the thin merge gate:
     the emit is guarded by `assignmentChanged`, carries both owner ids, and isolates a throwing
     listener so a subscriber can never resurrect a committed write.
  2. BEHAVIOURAL payload assertions over the real update path (PostgreSQL-gated): every durable
     transfer surface funnels through `updateTask`, so asserting the pairs here covers all of them.
     A source scan proves no surface writes `assignedAgentId` around `updateTask` with its own
     emitter (the event must not gain a second write path).
*/

/* Resolved from THIS file, not `process.cwd()`: the core suite runs workers from a sandboxed temp cwd. */
const EMITTER_FILE = fileURLToPath(new URL("../task-store/task-update.ts", import.meta.url));

function assigneeEmitBody(): string {
  const source = readFileSync(EMITTER_FILE, "utf8");
  const start = source.indexOf('if (assignmentChanged) {\n        const assigneeEvent');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("return task;", start));
}

describe("task:assignee-changed sole emitter (code construct)", () => {
  it("emits only when the assignment actually changed", () => {
    const body = assigneeEmitBody();
    expect(body).toContain('store.emit("task:assignee-changed"');
    // Guarded, not unconditional: same-value writes and creation paths stay silent.
    const source = readFileSync(EMITTER_FILE, "utf8");
    const guardIdx = source.lastIndexOf("if (assignmentChanged)", source.indexOf('store.emit("task:assignee-changed"'));
    expect(guardIdx).toBeGreaterThan(-1);
  });

  it("carries exactly taskId, previousOwnerId and newOwnerId", () => {
    const body = assigneeEmitBody();
    expect(body).toContain("taskId: task.id");
    expect(body).toContain("previousOwnerId: previousAssignedAgentId");
    expect(body).toContain("newOwnerId: task.assignedAgentId");
  });

  it("isolates a throwing listener so the committed write survives", () => {
    const body = assigneeEmitBody();
    expect(body).toContain("try {");
    expect(body).toContain("catch (err)");
  });

  it("does not duplicate the announcement on any other durable write surface", () => {
    /*
     * The event may have exactly ONE emitter. Other files may LISTEN; none may emit or write
     * `assignedAgentId` through a raw path that would bypass the announcement. Creation-time
     * assignment (createTask) and raw link-sync helpers are not transfers.
     */
    const emitters = ["store", "task-update"].map((name) =>
      [name, readFileSync(fileURLToPath(new URL(`../${name === "store" ? "store.ts" : "task-store/task-update.ts"}`, import.meta.url)), "utf8")] as const,
    );
    for (const [, src] of emitters) {
      const emits = src.match(/emit\(\s*"task:assignee-changed"/g) ?? [];
      expect(emits.length).toBeLessThanOrEqual(1);
    }
  });
});

pgDescribe("task:assignee-changed payload (real update path)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_assignee_changed",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  type AssigneePayload = { taskId: string; previousOwnerId?: string; newOwnerId?: string };

  const captureAssignee = (store: ReturnType<SharedPgTaskStoreHarness["store"]>): { events: AssigneePayload[]; stop: () => void } => {
    const events: AssigneePayload[] = [];
    const listener = (data: AssigneePayload) => { events.push(data); };
    store.on("task:assignee-changed", listener as never);
    return { events, stop: () => store.off("task:assignee-changed", listener as never) };
  };

  it("announces first assignment, transfer, and unassignment with exact owner pairs", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "assignee transfer pairs" });
    const captured = captureAssignee(store);

    try {
      // Creation with an owner is NOT a transfer: the write happened before any listener existed.
      await store.updateTask(task.id, { assignedAgentId: "agent-a" });
      await store.updateTask(task.id, { assignedAgentId: "agent-a" });
      await store.updateTask(task.id, { assignedAgentId: "agent-b" });
      await store.updateTask(task.id, { assignedAgentId: null });
    } finally {
      captured.stop();
    }

    expect(captured.events).toEqual([
      { taskId: task.id, previousOwnerId: undefined, newOwnerId: "agent-a" },
      { taskId: task.id, previousOwnerId: "agent-a", newOwnerId: "agent-b" },
      { taskId: task.id, previousOwnerId: "agent-b", newOwnerId: undefined },
    ]);
  });

  it("stays silent for updates that do not move the owner", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "non-transfer updates" });
    await store.updateTask(task.id, { assignedAgentId: "agent-a" });
    const captured = captureAssignee(store);

    try {
      await store.updateTask(task.id, { title: "renamed" });
      await store.updateTask(task.id, { assignedAgentId: "agent-a" });
    } finally {
      captured.stop();
    }

    expect(captured.events).toEqual([]);
  });

  it("survives a throwing listener: the transfer commits and the update resolves", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "hostile listener" });
    const hostile = () => {
      throw new Error("listener must not resurrect a committed write");
    };
    store.on("task:assignee-changed", hostile as never);

    try {
      const updated = await store.updateTask(task.id, { assignedAgentId: "agent-a" });
      expect(updated.assignedAgentId).toBe("agent-a");
      const reread = await store.getTask(task.id);
      expect(reread?.assignedAgentId).toBe("agent-a");
    } finally {
      store.off("task:assignee-changed", hostile as never);
    }
  });
});
