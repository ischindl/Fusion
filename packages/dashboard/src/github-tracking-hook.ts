import { setTaskCreatedHook, type TaskStore, type Task } from "@fusion/core";
import { maybeCreateTrackingIssue } from "./github-tracking.js";

/**
 * Register a post-create hook that calls `maybeCreateTrackingIssue` for every
 * new task.  Called once at process startup by the dashboard server, the CLI,
 * and the pi extension.
 *
 * Idempotent: calling this twice replaces the previous hook (no chaining).
 */
export function registerGithubTrackingHook(
  options?: { logger?: Pick<Console, "warn" | "info"> },
): void {
  const logger = options?.logger ?? console;

  setTaskCreatedHook(async (task: Task, store: TaskStore) => {
    try {
      const settings = await store.getSettings();
      const globalSettingsStore = store.getGlobalSettingsStore?.();
      const globalSettings = globalSettingsStore
        ? await globalSettingsStore.getSettings()
        : {};

      await maybeCreateTrackingIssue(task, {
        taskStore: store,
        projectSettings: settings,
        globalSettings,
        rootDir: store.getRootDir(),
        logger,
      });
    } catch (error) {
      // Best-effort: never propagate out of the hook.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[github-tracking-hook] ${task.id}: ${message}`);
    }
  });
}
