/**
 * CLI command for exporting agents to Agent Companies packages.
 *
 * Usage:
 *   fn agent export <dir> [--company-name <name>] [--company-slug <slug>] [--project <name>]
 *
 * @module agent-export
 */

import { resolve } from "node:path";

import { AgentStore, exportAgentsToDirectory } from "@fusion/core";

import { resolveAgentStoreBase } from "../project-context.js";

function printSummary(result: {
  outputDir: string;
  agentsExported: number;
  skillsExported: number;
  filesWritten: string[];
  errors: Array<{ agentId: string; error: string }>;
}): void {
  console.log();
  console.log(`  Output directory: ${result.outputDir}`);
  console.log(`  Agents exported: ${result.agentsExported}`);
  console.log(`  Skills exported: ${result.skillsExported}`);
  console.log(`  Files written: ${result.filesWritten.length}`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors) {
      console.log(`    ✗ ${err.agentId}: ${err.error}`);
    }
  }

  console.log();
}

/**
 * Run the agent export command.
 */
export async function runAgentExport(
  outputDir: string,
  options?: {
    project?: string;
    companyName?: string;
    companySlug?: string;
    agentIds?: string[];
  },
): Promise<void> {
  // FNXC:PostgresCutover 2026-07-04: construct AgentStore in backend mode by
  // borrowing the asyncLayer from the resolved project store (SQLite runtime
  // removed under VAL-REMOVAL-005), mirroring extension.ts getAgentStore.
  const { rootDir, asyncLayer } = await resolveAgentStoreBase(options?.project);
  const agentStore = new AgentStore({ rootDir: rootDir + "/.fusion", asyncLayer: asyncLayer ?? undefined });
  await agentStore.init();

  const allAgents = await agentStore.listAgents();
  const filterIds = options?.agentIds?.filter((id) => id.trim().length > 0);
  const agents = filterIds && filterIds.length > 0
    ? allAgents.filter((agent) => filterIds.includes(agent.id))
    : allAgents;

  if (agents.length === 0) {
    console.error("No agents found to export");
    process.exit(1);
  }

  const result = await exportAgentsToDirectory(agents, resolve(outputDir), {
    companyName: options?.companyName,
    companySlug: options?.companySlug,
  });

  printSummary(result);
}
