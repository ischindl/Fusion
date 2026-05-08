import { taskToCard, type GlassesCard } from "./cards.js";
import type { FusionApiClient } from "./fusion-api-client.js";

export async function startWork(
  taskId: string,
  deps: { apiClient: FusionApiClient; enableAgentActions: boolean; logger: Pick<Console, "warn"> },
): Promise<GlassesCard | undefined> {
  if (!deps.enableAgentActions) {
    deps.logger.warn("Agent actions are disabled; skipping start-work action");
    return undefined;
  }
  const task = await deps.apiClient.moveTask(taskId, "in-progress");
  return taskToCard(task as never);
}

export async function requestReview(
  taskId: string,
  deps: { apiClient: FusionApiClient; enableAgentActions: boolean; logger: Pick<Console, "warn"> },
): Promise<GlassesCard | undefined> {
  if (!deps.enableAgentActions) {
    deps.logger.warn("Agent actions are disabled; skipping request-review action");
    return undefined;
  }
  const task = await deps.apiClient.moveTask(taskId, "in-review");
  return taskToCard(task as never);
}
