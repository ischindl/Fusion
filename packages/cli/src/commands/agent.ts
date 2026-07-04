import { AgentStore, AGENT_VALID_TRANSITIONS } from "@fusion/core";
import type { AgentState } from "@fusion/core";
import { resolveAgentStoreBase } from "../project-context.js";

/**
 * Create an initialized AgentStore for the given project.
 *
 * FNXC:PostgresCutover 2026-07-04: borrow the PostgreSQL AsyncDataLayer from
 * the resolved project store so AgentStore runs in backend mode (the SQLite
 * runtime was removed under VAL-REMOVAL-005), mirroring extension.ts getAgentStore.
 */
async function createAgentStore(projectName?: string): Promise<AgentStore> {
  const { rootDir, asyncLayer } = await resolveAgentStoreBase(projectName);
  const agentStore = new AgentStore({ rootDir: rootDir + "/.fusion", asyncLayer: asyncLayer ?? undefined });
  await agentStore.init();
  return agentStore;
}

/**
 * Stop (pause) a running agent.
 * Transitions state from running/active to paused.
 *
 * Note: Agent `metadata.skills` (array of skill names) controls which skills
 * are injected into the agent session at execution time when the agent is
 * assigned to a task. Skills are resolved by `buildSessionSkillContext`.
 */
export async function runAgentStop(id: string, projectName?: string): Promise<void> {
  const agentStore = await createAgentStore(projectName);

  const agent = await agentStore.getAgent(id);
  if (!agent) {
    console.error(`Agent ${id} not found`);
    process.exit(1);
  }

  // Already paused — nothing to do
  if (agent.state === "paused") {
    console.log();
    console.log(`  Agent ${id} is already paused`);
    console.log();
    return;
  }

  // Validate transition locally
  const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
  if (!validTargets || !validTargets.includes("paused")) {
    console.error(`Cannot stop agent ${id} — current state '${agent.state}' cannot transition to 'paused'`);
    process.exit(1);
  }

  await agentStore.updateAgentState(id, "paused");

  console.log();
  console.log(`  ✓ Agent ${id} stopped`);
  console.log();
}

/**
 * Start (resume) a stopped/paused agent.
 * Transitions state from paused to active.
 */
export async function runAgentStart(id: string, projectName?: string): Promise<void> {
  const agentStore = await createAgentStore(projectName);

  const agent = await agentStore.getAgent(id);
  if (!agent) {
    console.error(`Agent ${id} not found`);
    process.exit(1);
  }

  // Already active/running — nothing to do
  if (agent.state === "active" || agent.state === "running") {
    console.log();
    console.log(`  Agent ${id} is already running (${agent.state})`);
    console.log();
    return;
  }

  // Validate transition locally
  const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
  if (!validTargets || !validTargets.includes("active")) {
    console.error(`Cannot start agent ${id} — current state '${agent.state}' cannot transition to 'active'`);
    process.exit(1);
  }

  await agentStore.updateAgentState(id, "active");

  console.log();
  console.log(`  ✓ Agent ${id} started`);
  console.log();
}
