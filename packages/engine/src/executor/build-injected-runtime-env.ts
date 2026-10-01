/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * buildInjectedRuntimeEnv peeled from TaskExecutor (U4).
 *
 * Build task-scoped runtime env carrying plugin-injected keys plus PATH contribution.
 * Never mutates process.env globally — scoped env is threaded through taskEnv.
 *
 * FNXC:NonInteractiveGit 2026-09-11-22:40 (RUFU-210):
 * The non-interactive git floor is applied LAST — after the plugin-injected spread and the PATH
 * rebuild — so a `collectExecutorRuntimeEnv` contribution (e.g. GIT_EDITOR=vim) cannot clear it.
 * Incident evidence: a task-session `git rebase --continue` blocked on `git commit -e` → `vi`
 * for 1 day 13 hours, surviving its session as an orphan inside an already-deleted worktree.
 * `injectedKeyCount`/`pathEntryCount` intentionally keep counting the PLUGIN's contributions,
 * not the fixed floor keys, so task-log injection telemetry is unchanged.
 */
import { delimiter } from "node:path";
import { applyNonInteractiveGitEnv } from "@fusion/core";
import { createFusionBrowserLease } from "../agent-browser-lifecycle.js";

export type BuildInjectedRuntimeEnvDeps = {
  rootDir: string;
  collectExecutorRuntimeEnv?: (input: {
    taskId: string;
    worktreePath: string;
    rootDir: string;
    branch: string | undefined;
  }) => Promise<{ env?: NodeJS.ProcessEnv; pathPrepend?: string[] } | undefined | null> | undefined;
};

export async function buildInjectedRuntimeEnv(
  deps: BuildInjectedRuntimeEnvDeps,
  taskId: string,
  worktreePath: string,
  branch: string | undefined,
): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> {
  const runtimeEnvContribution = await deps.collectExecutorRuntimeEnv?.({
    taskId,
    worktreePath,
    rootDir: deps.rootDir,
    branch,
  });
  const pathPrepend = runtimeEnvContribution?.pathPrepend ?? [];
  const injectedEnv = runtimeEnvContribution?.env ?? {};
  const baseEnv = {
    ...process.env,
    ...injectedEnv,
    PATH: [...pathPrepend, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
  /*
  FNXC:AgentBrowserOwnership 2026-09-20-00:56:
  Every actual executor environment receives one opaque browser lease. The native
  daemon has no parent watchdog; this lease and its enforced positive idle timeout
  make a SIGKILL survivor attributable to Fusion recovery without affecting probes.
  */
  const browser = createFusionBrowserLease(taskId, baseEnv);
  return {
    /* FNXC:MergeRebuild0921 2026-09-21: the browser lease (FNXC:AgentBrowserOwnership) builds on the
       same baseEnv; our non-interactive git layer applies on top of the leased env. */
    env: applyNonInteractiveGitEnv(browser.env),
    injectedKeyCount: Object.keys(injectedEnv).length,
    pathEntryCount: pathPrepend.length,
  };
}
