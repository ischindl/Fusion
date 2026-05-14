import type { Agent, AgentMemoryInclusionMode, GlobalSettings, ProjectSettings } from "./types.js";

export type AgentMemoryInclusionModeSource = "agent" | "project" | "global" | "default";

export interface ResolveAgentMemoryInclusionModeInput {
  agent?: Agent | null;
  projectSettings?: ProjectSettings | null;
  globalSettings?: GlobalSettings | null;
}

export interface ResolvedAgentMemoryInclusionMode {
  mode: AgentMemoryInclusionMode;
  source: AgentMemoryInclusionModeSource;
}

function isAgentMemoryInclusionMode(value: unknown): value is AgentMemoryInclusionMode {
  return value === "full" || value === "index" || value === "off";
}

export function resolveAgentMemoryInclusionMode({
  agent,
  projectSettings,
  globalSettings,
}: ResolveAgentMemoryInclusionModeInput): ResolvedAgentMemoryInclusionMode {
  const agentMode = agent?.runtimeConfig && typeof agent.runtimeConfig === "object"
    ? (agent.runtimeConfig as Record<string, unknown>).agentMemoryInclusionMode
    : undefined;
  if (isAgentMemoryInclusionMode(agentMode)) {
    return { mode: agentMode, source: "agent" };
  }

  const projectMode = projectSettings?.agentMemoryInclusionMode;
  if (isAgentMemoryInclusionMode(projectMode)) {
    return { mode: projectMode, source: "project" };
  }

  const globalMode = globalSettings?.agentMemoryInclusionMode;
  if (isAgentMemoryInclusionMode(globalMode)) {
    return { mode: globalMode, source: "global" };
  }

  return { mode: "full", source: "default" };
}
