import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { TaskStore } from "../../store.js";

/*
FNXC:AssigneeTransferAtomicity 2026-09-15-05:40 (RUFU-260):
The assignment write has two durable halves, and the second one is the one the board actually routes
on: `tasks.assignedAgentId` (the card's owner) and `agents.taskId` (the owner-link mirror that
`syncAgentTaskLinkOnReassignment` maintains). A transfer that updates only the first leaves an orphan
link on the previous owner — which is how a transferred card keeps waking its old agent — and a
transfer that writes both without the previous-owner guard duplicates ownership across two agents.

These assertions run against a real PostgreSQL store because the mirror is a PG-only write: the
SQLite branch of the same helper updates JSON, so the guardrails below (single holder, no orphan,
no clobber of an unrelated link) are only observable here.
*/

type AssigneePayload = { taskId: string; previousOwnerId?: string; newOwnerId?: string };

async function seedAgent(store: TaskStore, id: string, taskId: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await store.asyncLayer!.db.insert(schema.project.agents).values({
    projectId: "",
    id,
    name: id,
    role: "executor",
    roles: ["executor"],
    state: "idle",
    taskId,
    createdAt: now,
    updatedAt: now,
  });
}

async function readLinkedTaskId(store: TaskStore, agentId: string): Promise<string | null | undefined> {
  const rows = await store.asyncLayer!.db
    .select({ taskId: schema.project.agents.taskId })
    .from(schema.project.agents)
    .where(eq(schema.project.agents.id, agentId));
  return rows[0]?.taskId;
}

async function countAgentsHolding(store: TaskStore, taskId: string): Promise<number> {
  const rows = await store.asyncLayer!.db
    .select({ id: schema.project.agents.id })
    .from(schema.project.agents)
    .where(eq(schema.project.agents.taskId, taskId));
  return rows.length;
}

function captureAssigneeEvents(store: TaskStore): { events: AssigneePayload[]; stop: () => void } {
  const events: AssigneePayload[] = [];
  const listener = (data: AssigneePayload) => { events.push(data); };
  store.on("task:assignee-changed", listener as never);
  return { events, stop: () => store.off("task:assignee-changed", listener as never) };
}

pgDescribe("task assignee link mirror (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_assignee_link",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("moves the owner link on a transfer: exactly one holder, previous owner cleared", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "assignee link transfer" });
    await seedAgent(store, "agent-link-a");
    await seedAgent(store, "agent-link-b");

    await store.updateTask(task.id, { assignedAgentId: "agent-link-a" });
    expect(await readLinkedTaskId(store, "agent-link-a")).toBe(task.id);
    expect(await countAgentsHolding(store, task.id)).toBe(1);

    await store.updateTask(task.id, { assignedAgentId: "agent-link-b" });

    expect(await readLinkedTaskId(store, "agent-link-a")).toBeNull();
    expect(await readLinkedTaskId(store, "agent-link-b")).toBe(task.id);
    // No duplicate ownership: the card is held by exactly one agent row after the move.
    expect(await countAgentsHolding(store, task.id)).toBe(1);
  });

  it("clears the link on unassignment so no orphan owner row survives", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "assignee link unassignment" });
    await seedAgent(store, "agent-link-unassign");

    await store.updateTask(task.id, { assignedAgentId: "agent-link-unassign" });
    expect(await readLinkedTaskId(store, "agent-link-unassign")).toBe(task.id);

    await store.updateTask(task.id, { assignedAgentId: null });

    expect(await readLinkedTaskId(store, "agent-link-unassign")).toBeNull();
    expect(await countAgentsHolding(store, task.id)).toBe(0);
    const stored = await store.getTask(task.id);
    expect(stored?.assignedAgentId).toBeUndefined();
  });

  it("leaves a previous owner's newer link alone when this card is transferred away", async () => {
    /*
    The clear-side write is guarded on `agents.task_id = <this task>`. Without that guard a transfer
    would orphan an unrelated link: between the two assignments the previous owner may have been
    pointed at another card, and that link is not this card's to clear. This asserts the guard, not
    the set-side behavior — naming an agent as the NEW owner still claims it for this card, which is
    the pre-existing link-sync contract this task deliberately leaves alone.
    */
    const store = h.store();
    const card = await store.createTask({ description: "assignee link clear guard" });
    const other = await store.createTask({ description: "assignee link other card" });
    await seedAgent(store, "agent-link-previous");
    await seedAgent(store, "agent-link-successor");

    await store.updateTask(card.id, { assignedAgentId: "agent-link-previous" });
    expect(await readLinkedTaskId(store, "agent-link-previous")).toBe(card.id);

    // The previous owner moves on to another card out-of-band (a later assignment elsewhere).
    await store.updateTask(other.id, { assignedAgentId: "agent-link-previous" });
    expect(await readLinkedTaskId(store, "agent-link-previous")).toBe(other.id);

    await store.updateTask(card.id, { assignedAgentId: "agent-link-successor" });

    // The newer link survives; the successor holds the card; the card has exactly one holder.
    expect(await readLinkedTaskId(store, "agent-link-previous")).toBe(other.id);
    expect(await readLinkedTaskId(store, "agent-link-successor")).toBe(card.id);
    expect(await countAgentsHolding(store, card.id)).toBe(1);
    expect(await countAgentsHolding(store, other.id)).toBe(1);
  });

  it("leaves the mirror and the announcement untouched for a same-value or unrelated write", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "assignee link idempotence" });
    await seedAgent(store, "agent-link-same");
    await store.updateTask(task.id, { assignedAgentId: "agent-link-same" });

    const captured = captureAssigneeEvents(store);
    try {
      await store.updateTask(task.id, { assignedAgentId: "agent-link-same" });
      await store.updateTask(task.id, { title: "renamed without moving the owner" });
    } finally {
      captured.stop();
    }

    expect(captured.events).toEqual([]);
    // A no-op re-assign must not clear the link it is nominally re-stating.
    expect(await readLinkedTaskId(store, "agent-link-same")).toBe(task.id);
    expect(await countAgentsHolding(store, task.id)).toBe(1);
  });

  it("announces each mirror move exactly once, pairing previous and new owner", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "assignee link announcement" });
    await seedAgent(store, "agent-link-pair-a");
    await seedAgent(store, "agent-link-pair-b");

    const captured = captureAssigneeEvents(store);
    try {
      await store.updateTask(task.id, { assignedAgentId: "agent-link-pair-a" });
      await store.updateTask(task.id, { assignedAgentId: "agent-link-pair-b" });
    } finally {
      captured.stop();
    }

    expect(captured.events).toEqual([
      { taskId: task.id, previousOwnerId: undefined, newOwnerId: "agent-link-pair-a" },
      { taskId: task.id, previousOwnerId: "agent-link-pair-a", newOwnerId: "agent-link-pair-b" },
    ]);
    expect(await countAgentsHolding(store, task.id)).toBe(1);
  });

  it("keeps the cleared-owner row selectable by the null-link query the scheduler uses", async () => {
    /*
    A freed agent must become visible again to the idle-agent queries. A stale non-null link would
    keep it looking busy forever, which is the mirror-image of the orphan this task removes.
    */
    const store = h.store();
    const task = await store.createTask({ description: "assignee link idle visibility" });
    await seedAgent(store, "agent-link-idle");
    await store.updateTask(task.id, { assignedAgentId: "agent-link-idle" });

    await store.updateTask(task.id, { assignedAgentId: null });

    const idle = await store.asyncLayer!.db
      .select({ id: schema.project.agents.id })
      .from(schema.project.agents)
      .where(and(isNull(schema.project.agents.taskId), eq(schema.project.agents.id, "agent-link-idle")));
    expect(idle.map((row) => row.id)).toEqual(["agent-link-idle"]);
  });
});
