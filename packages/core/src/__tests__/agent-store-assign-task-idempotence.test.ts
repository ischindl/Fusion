import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import type { Agent } from "../types/agents/agents.js";

/*
FNXC:AssignmentWakeDedup 2026-11-04-21:07 (RUFU-411):
`agent:assigned` is the assignment WAKE trigger for every durable agent — `HeartbeatTriggerScheduler
.watchAssignments` turns each emission into a heartbeat session. The store emitted it on every
`assignTask(agentId, taskId)` call, including a call that changed nothing, so a no-op re-bind announced a
hand-off that never happened and bought the agent a full model session with zero new state (measured: 109
identical-delta wakes against one card in 18 minutes).

Invariant under test: `agent:assigned` means "the bound task changed", matching the `assignmentChanged`
gate `updateTask` already applies to `task:assignee-changed`. Persisted linkage and `agent:updated` must NOT
change behavior — a redundant bind stays a real (idempotent) write, only the wake announcement is withheld.

Harness: the fake-method AgentStore shape used by `agents/__tests__/memory-agent-provisioning.test.ts`, so
this stays a fast unit test with no PostgreSQL partition and no real sessions.
*/

const agentFixture = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agent-exec-1",
  name: "Executor",
  role: "executor",
  roles: ["executor"],
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  metadata: {},
  runtimeConfig: { enabled: true },
  ...overrides,
} as Agent);

/** AgentStore with its storage methods replaced by an in-memory array; events stay real. */
function fakeAgentStore(initial: Agent[]) {
  const store = new AgentStore({ rootDir: process.cwd() });
  const self = store as unknown as Record<string, unknown>;
  self.getAgent = vi.fn(async (id: string) => initial.find((a) => a.id === id) ?? null);
  self.writeAgent = vi.fn(async (updated: Agent) => {
    const index = initial.findIndex((a) => a.id === updated.id);
    if (index >= 0) initial[index] = updated;
  });
  return {
    store,
    agents: initial,
    getAgent: self.getAgent as ReturnType<typeof vi.fn>,
    writeAgent: self.writeAgent as ReturnType<typeof vi.fn>,
  };
}

function recordEvents(store: AgentStore) {
  const assigned: Array<{ agentId: string; taskId: string }> = [];
  const updated: string[] = [];
  store.on("agent:assigned", (agent, taskId) => assigned.push({ agentId: agent.id, taskId }));
  store.on("agent:updated", (agent) => updated.push(agent.id));
  return { assigned, updated };
}

describe("AgentStore.assignTask assignment-event idempotence (RUFU-411)", () => {
  it("emits agent:assigned exactly once when the same task is bound twice", async () => {
    const { store, agents } = fakeAgentStore([agentFixture()]);
    const { assigned } = recordEvents(store);

    await store.assignTask("agent-exec-1", "RUFU-409");
    await store.assignTask("agent-exec-1", "RUFU-409");

    expect(assigned).toEqual([{ agentId: "agent-exec-1", taskId: "RUFU-409" }]);
    // The redundant call is still an idempotent write, not a silent skip of state.
    expect(agents[0].taskId).toBe("RUFU-409");
  });

  it("emits again when the bound task actually changes", async () => {
    const { store } = fakeAgentStore([agentFixture()]);
    const { assigned } = recordEvents(store);

    await store.assignTask("agent-exec-1", "RUFU-409");
    await store.assignTask("agent-exec-1", "RUFU-410");

    expect(assigned.map((e) => e.taskId)).toEqual(["RUFU-409", "RUFU-410"]);
  });

  it("emits on a re-bind that follows a clear", async () => {
    const { store } = fakeAgentStore([agentFixture({ taskId: "RUFU-409" })]);
    const { assigned } = recordEvents(store);

    await store.assignTask("agent-exec-1", undefined);
    await store.assignTask("agent-exec-1", "RUFU-409");

    expect(assigned.map((e) => e.taskId)).toEqual(["RUFU-409"]);
  });

  it("never emits agent:assigned for a clear, including an already-unbound agent", async () => {
    const { store, agents } = fakeAgentStore([agentFixture()]);
    const { assigned, updated } = recordEvents(store);

    await store.assignTask("agent-exec-1", undefined);
    await store.assignTask("agent-exec-1", undefined);

    expect(assigned).toEqual([]);
    // The clear path still writes and still announces the state change it does make.
    expect(updated).toHaveLength(2);
    expect(agents[0].taskId).toBeUndefined();
  });

  it("keeps agent:updated and persisted linkage unchanged for a no-op re-bind", async () => {
    const { store, agents, writeAgent } = fakeAgentStore([agentFixture({ taskId: "RUFU-409" })]);
    const { updated } = recordEvents(store);

    await store.assignTask("agent-exec-1", "RUFU-409");

    expect(updated).toEqual(["agent-exec-1"]);
    expect(writeAgent).toHaveBeenCalledTimes(1);
    expect(agents[0].taskId).toBe("RUFU-409");
  });

  it("still refuses a bind the routing policy denies before deciding anything", async () => {
    // No taskStore on this host: assignTask stays fail-open for display-only linkage, which is the
    // pre-existing contract this task must not narrow.
    const { store } = fakeAgentStore([agentFixture()]);
    const { assigned } = recordEvents(store);

    await expect(store.assignTask("missing-agent", "RUFU-409")).rejects.toThrow(/not found/);
    expect(assigned).toEqual([]);
  });
});
