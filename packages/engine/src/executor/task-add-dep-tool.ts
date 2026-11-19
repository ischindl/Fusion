/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * createTaskAddDepTool peeled from TaskExecutor (U4). Mid-execution dependency
 * declaration tool; confirm=true aborts the active session for re-planning.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import { isTaskNotFoundError, type Task, type TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";
/*
FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
See create-task-update-tool.ts for the full requirement. This boundary additionally owns the abort
side effects: the write used to be the line before `deps.depAborted.add` and `session.dispose()`, so a
store refusal threw out having aborted nothing while killing the agent turn. The refusal now returns
before any of that runs.
*/
import { dependencyDomainRefusal, dependencyRefusalResult, recordDependencyRefusal, storeErrorResult, storeWriteFailure } from "../tool-store-errors.js";

const taskAddDepParams = Type.Object({
  task_id: Type.String({ description: "The ID of the task to depend on (e.g. \"KB-001\")" }),
  confirm: Type.Optional(Type.Boolean({ description: "Set to true to confirm adding the dependency. Required because adding a dep to an in-progress task will stop execution and discard current work." })),
});

export type TaskAddDepToolDeps = {
  store: TaskStore;
  depAborted: Set<string>;
  getActiveSession: (taskId: string) => { session: { dispose: () => void } } | undefined;
  getActiveStepExecutor: (taskId: string) => { terminateAllSessions: () => Promise<unknown> } | undefined;
};

export function createTaskAddDepTool(deps: TaskAddDepToolDeps, taskId: string): ToolDefinition {
  const store = deps.store;
  return {
    name: "fn_task_add_dep",
    label: "Add Dependency",
    description:
      "Declare a dependency on an existing task. Use when you discover " +
      "mid-execution that another task must be completed first. " +
      "Adding a dependency to an in-progress task will stop execution " +
      "and discard current work, so confirm=true is required. " +
      "Without confirm=true, a warning is returned first.",
    parameters: taskAddDepParams,
    execute: async (_id: string, params: Static<typeof taskAddDepParams>) => {
      const targetId = params.task_id;

      // Prevent self-dependency
      if (targetId === taskId) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
          }],
          details: {},
        };
      }

      // Validate target task exists
      let targetTask: Task;
      try {
        targetTask = await store.getTask(targetId);
      } catch (error) {
        /* FNXC:ReadFailureSurfacing 2026-09-25-05:45: STAS-259. A bare catch used to turn every failed lookup —
        boot stall, closed pool, timeout — into "Task X not found", reporting a dependency the agent just created
        as gone. Only the store's typed not-found may name a missing card; the outage half answers in the shared
        shape, as the engine lane's add-dependency catch already does. */
        if (!isTaskNotFoundError(error)) {
          return storeErrorResult(`dependency target ${targetId}`, error);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Task ${targetId} not found. Cannot add dependency on a non-existent task.`,
          }],
          details: {},
        };
      }

      // Read current task to get existing dependencies
      const currentTask = await store.getTask(taskId);
      const existing = currentTask.dependencies;
      if (targetTask.sourceParentTaskId === taskId) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot depend on self-spawned task ${targetId}; implement required work directly in ${taskId}.`,
          }],
          details: { code: "SELF_SPAWNED_DEPENDENCY", dependencyId: targetId },
        };
      }

      // Dedup check
      if (existing.includes(targetId)) {
        return {
          content: [{
            type: "text" as const,
            text: `${targetId} is already a dependency of ${taskId}. No changes made.`,
          }],
          details: {},
        };
      }

      // Confirmation gate — destructive action for in-progress tasks
      if (!params.confirm) {
        return {
          content: [{
            type: "text" as const,
            text: `Warning: adding a dependency to an in-progress task will stop execution and discard current work. Call with confirm=true to proceed.`,
          }],
          details: {},
        };
      }

      /*
      FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
      The store's cycle guard refuses before it writes, and everything below this line is destructive:
      the success History line, `depAborted`, and the active session's disposal. Returning the refusal
      here is what makes a cyclic edge proposal a plain "no" instead of either a dead run or a dead turn.
      */
      try {
        await store.updateTask(taskId, { dependencies: [...existing, targetId] });
      } catch (error) {
        const refused = dependencyRefusalResult(`dependency declaration adding ${targetId}`, error);
        if (refused) {
          const facts = dependencyDomainRefusal(error);
          if (facts) {
            await recordDependencyRefusal(facts, {
              taskId,
              log: (id, action) => store.logEntry(id, action),
              note: `Nothing was added and this run was not aborted, so no re-planning was triggered.`,
              warn: (message) => executorLog.warn(message),
            });
          }
          refused.content[0].text += ` ${targetId} was not added to ${taskId} and this run was not aborted.`;
          return refused;
        }
        return storeWriteFailure(`dependency declaration adding ${targetId}`, error);
      }
      await store.logEntry(taskId, `Added dependency on ${targetId} — stopping execution for re-planning`);

      // Trigger abort flow (same pattern as pausedAborted)
      deps.depAborted.add(taskId);
      const activeSession = deps.getActiveSession(taskId);
      activeSession?.session.dispose();

      // Also terminate step sessions if active
      const stepExecutor = deps.getActiveStepExecutor(taskId);
      if (stepExecutor) {
        stepExecutor.terminateAllSessions().catch(err =>
          executorLog.warn(`Failed to terminate step sessions for dep-abort ${taskId}: ${err}`)
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: `Added dependency on ${targetId}. Stopping execution — task will move to triage for re-planning.`,
        }],
        details: {},
      };
    },
  };
}
