import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { LANE_CAPABILITY_DECLINE_CODE, TaskStore } from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../core/src/postgres/schema/index.js";
import { reconcileLaneCapabilityMisbinds } from "../self-healing/lane-capability-reconciliation.js";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:LaneCapabilityReconciliation 2026-09-26-19:40 (RUFU-272 Step 4):
PG-backed proof for the lane-capability misbind sweep. The rebind's durable halves —
`tasks.assignedAgentId` (the owner) and `agents.taskId` (the mirror owned by the TaskStore
assignment seam) — are only observable against a real PostgreSQL store, exactly like
`task-assignee-link.pg.test.ts`. This file lives in packages/engine (not the spec-named core
path) because the sweep imports engine internals and `@fusion/core` must never import
`@fusion/engine`; the harness reaches across via the same relative test-utils path the other
engine `.pg.test.ts` files use.
*/

async function seedAgent(store: TaskStore, id: string, roles: string[], taskId: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await store.asyncLayer!.db.insert(schema.project.agents).values({
    projectId: "",
    id,
    name: id,
    role: roles[0] ?? "executor",
    roles,
    state: "idle",
    taskId,
    createdAt: now,
    updatedAt: now,
  });
}

// Raw reads instead of drizzle selects: `drizzle-orm` is not a declared engine dependency, and
// the harness's `adminSql()` is the sanctioned raw client (schema `project`, snake_case columns).
// Bound once per file from the live harness so the helpers keep a plain (store, id) signature.
type SqlClient = ReturnType<SharedPgTaskStoreHarness["adminSql"]>;
let adminSqlRef: SqlClient | null = null;

async function readLinkedTaskId(_store: TaskStore, agentId: string): Promise<string | null | undefined> {
  const rows = await adminSqlRef!<Array<{ task_id: string | null }>>`SELECT task_id FROM project.agents WHERE id = ${agentId}`;
  return rows[0]?.task_id;
}

async function countAgentsHolding(_store: TaskStore, taskId: string): Promise<number> {
  const rows = await adminSqlRef!<Array<{ id: string }>>`SELECT id FROM project.agents WHERE task_id = ${taskId}`;
  return rows.length;
}

function fakeAgentStore(agents: Array<{ id: string; role: string; roles: string[]; state?: string; taskId?: string; runtimeConfig?: Record<string, unknown> }>) {
  // Plain lanes plus the mirror/sweep surface `SelfHealingManager` neighbors call, mutating the
  // same fixtures — PG `agents` rows stay the authoritative mirror half under test.
  const lanes = agents.map((agent) => ({ ...agent, state: agent.state ?? "idle", runtimeConfig: agent.runtimeConfig ?? {} })) as Array<{
    id: string; role: string; roles: string[]; state: string; taskId?: string; runtimeConfig?: Record<string, unknown>;
  }>;
  return {
    listAgents: async () => lanes.map((agent) => ({ ...agent })),
    getAgent: async (id: string) => lanes.find((agent) => agent.id === id) ?? null,
    getActiveHeartbeatRun: async () => null,
    updateAgentState: async (id: string, state: string) => {
      const lane = lanes.find((agent) => agent.id === id);
      if (lane) lane.state = state;
    },
    syncExecutionTaskLink: async (id: string, taskId?: string) => {
      const lane = lanes.find((agent) => agent.id === id);
      if (lane) lane.taskId = taskId;
    },
  } as never;
}

const auditOnlyLane = { id: "lane-audit-only", role: "reviewer", roles: ["reviewer"] };
const autoExecutorLane = { id: "lane-auto-exec", role: "executor", roles: ["executor"] };

pgDescribe("lane-capability misbind reconciliation (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lane_cap_reconcile",
    poolMax: 4,
  });

  beforeAll(h.beforeAll);
  beforeAll(() => {
    adminSqlRef = h.adminSql();
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function strandedCard(store: TaskStore, overrides: Record<string, unknown> = {}) {
    const task = await store.createTask({ description: `lane-capability card ${Math.random()}` });
    await store.updateTask(task.id, {
      assignedAgentId: auditOnlyLane.id,
      branch: `fusion/${task.id}`,
      branchWriteOrigin: "engine",
      worktree: `/wt/${task.id}`,
      currentStep: 2,
      ...overrides,
    });
    return (await store.getTask(task.id))!;
  }

  it("rebinds both durable halves and preserves branch, worktree, and step progress", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const card = await strandedCard(store);

    const count = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false);

    expect(count).toBe(1);
    const after = await store.getTask(card.id);
    expect(after?.assignedAgentId).toBe("lane-auto-exec");
    // Both durable halves moved, exactly one holder — the RUFU-260 assignment-seam contract.
    expect(await readLinkedTaskId(store, auditOnlyLane.id)).toBeNull();
    expect(await readLinkedTaskId(store, autoExecutorLane.id)).toBe(card.id);
    expect(await countAgentsHolding(store, card.id)).toBe(1);
    // Execution context untouched: the repair changed the owner, nothing else.
    expect(after?.branch).toBe(`fusion/${card.id}`);
    expect(after?.worktree).toBe(`/wt/${card.id}`);
    expect(after?.currentStep).toBe(2);
    expect(after?.column).toBe(card.column);
  });

  it("leaves a previous owner whose mirror already points at a different card alone", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const card = await strandedCard(store);
    // The audit lane's mirror points at a card it no longer owns: `other` is owned by the auto
    // lane (an ALLOWED bind, so the sweep leaves it alone) while the audit lane's `agents.task_id`
    // was left out-of-band on that newer card. That link is not `card`'s to clear.
    const other = await store.createTask({ description: "audit lane's newer card" });
    await store.updateTask(other.id, { assignedAgentId: autoExecutorLane.id });
    await adminSqlRef!`UPDATE project.agents SET task_id = ${other.id} WHERE id = ${auditOnlyLane.id}`;

    const count = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false);

    expect(count).toBe(1);
    expect(await readLinkedTaskId(store, auditOnlyLane.id)).toBe(other.id);
    expect(await readLinkedTaskId(store, autoExecutorLane.id)).toBe(card.id);
    expect(await countAgentsHolding(store, card.id)).toBe(1);
    expect(await countAgentsHolding(store, other.id)).toBe(1);
  });

  it("never touches a card carried by a live session", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const card = await strandedCard(store);

    const count = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), (task) => task.id === card.id);

    expect(count).toBe(0);
    const after = await store.getTask(card.id);
    expect(after?.assignedAgentId).toBe(auditOnlyLane.id);
    expect(await readLinkedTaskId(store, auditOnlyLane.id)).toBe(card.id);
  });

  it("never touches paused or user-paused cards (no auto-unpause fired)", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const pausedCard = await strandedCard(store);
    // Pause applied in its own seam write (owner already stable), as production does.
    await store.updateTask(pausedCard.id, { paused: true, pausedReason: "agent-paused", pausedByAgentId: auditOnlyLane.id });
    // `userPaused` is not an updateTask-writable field (it is set by the hold-park move seam),
    // so it is seeded out-of-band exactly as the operator drag would leave it.
    const userPausedCard = await strandedCard(store);
    await adminSqlRef!`UPDATE project.tasks SET user_paused = 1 WHERE id = ${userPausedCard.id}`;

    const count = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false);

    expect(count).toBe(0);
    const pausedAfter = await store.getTask(pausedCard.id);
    expect(pausedAfter?.paused).toBe(true);
    expect(pausedAfter?.pausedByAgentId).toBe(auditOnlyLane.id);
    const userAfter = await store.getTask(userPausedCard.id);
    expect(userAfter?.userPaused).toBe(true);
    expect(userAfter?.assignedAgentId).toBe(auditOnlyLane.id);
  });

  it("freezes a stranded card exactly once when no eligible lane exists, and stays frozen across passes", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    const card = await strandedCard(store);

    const firstPass = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane]), () => false);
    expect(firstPass).toBe(1);

    const frozen = await store.getTask(card.id);
    expect(frozen?.assignedAgentId).toBe(auditOnlyLane.id); // keeps the named owner
    expect(frozen?.paused).toBe(true);
    expect(frozen?.pausedReason).toBe("external-block");
    expect(frozen?.externalBlock?.code).toBe(LANE_CAPABILITY_DECLINE_CODE);
    expect(frozen?.externalBlock?.resume?.column).toBe(card.column);
    expect(frozen?.branch).toBe(`fusion/${card.id}`);
    const blockedAt = frozen?.externalBlock?.blockedAt;

    const secondPass = await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane]), () => false);
    expect(secondPass).toBe(0);
    const stillFrozen = await store.getTask(card.id);
    expect(stillFrozen?.externalBlock?.blockedAt).toBe(blockedAt); // not re-stamped
  });

  it("is idempotent across consecutive passes after a rebind", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const card = await strandedCard(store);

    expect(await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false)).toBe(1);
    expect(await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false)).toBe(0);
    const after = await store.getTask(card.id);
    expect(after?.assignedAgentId).toBe("lane-auto-exec");
    expect(await countAgentsHolding(store, card.id)).toBe(1);
  });

  it("survives the drift-recovery sweep: the repaired owner and its mirror are stable (no ping-pong)", async () => {
    const store = h.store();
    await seedAgent(store, auditOnlyLane.id, ["reviewer"]);
    await seedAgent(store, autoExecutorLane.id, ["executor"]);
    const card = await strandedCard(store);
    // WIP lane seeded out-of-band (`updateTask` does not move columns): the parked-link rules must
    // not be what keeps this link alive.
    await adminSqlRef!`UPDATE project.tasks SET "column" = 'in-progress' WHERE id = ${card.id}`;

    expect(await reconcileLaneCapabilityMisbinds(store, fakeAgentStore([auditOnlyLane, autoExecutorLane]), () => false)).toBe(1);

    // Run the REAL neighboring sweeps over the post-repair topology (audit lane unlinked, new
    // owner linked). `recoverDriftedAgentTaskLinks` may re-shape the agent-side mirror — it must
    // never move the owner back or drop the repaired PG-side holder.
    const agentStore = fakeAgentStore([
      { ...auditOnlyLane, taskId: undefined },
      { ...autoExecutorLane, taskId: card.id },
    ]);
    const manager = new SelfHealingManager(store, { rootDir: h.rootDir(), agentStore });
    await manager.recoverDriftedAgentTaskLinks();
    await manager.reattachOrphanedAssignedExecutions();
    manager.stop();

    const after = await store.getTask(card.id);
    expect(after?.assignedAgentId).toBe("lane-auto-exec");
    expect(after?.column).toBe("in-progress");
    expect(await readLinkedTaskId(store, auditOnlyLane.id)).toBeNull();
    expect(await readLinkedTaskId(store, autoExecutorLane.id)).toBe(card.id);
    expect(await countAgentsHolding(store, card.id)).toBe(1);
  });
});
