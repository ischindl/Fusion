/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * trackTaskDisposal peeled from TaskExecutor (U4).
 *
 * FN-5256: register an in-flight disposal so a subsequent dispatch can await it
 * before acquiring/creating a worktree. Errors are swallowed into the executor log.
 */
import { executorLog } from "../logger.js";
import { registerTaskDisposal } from "./task-disposal-barrier.js";

export type TrackTaskDisposalDeps = {
  pendingTaskDisposals: Map<string, Promise<void>>;
};

export function trackTaskDisposal(
  deps: TrackTaskDisposalDeps,
  taskId: string,
  disposal: Promise<void>,
): void {
  const wrapped = disposal
    .catch((err) => {
      executorLog.warn(`${taskId}: tracked disposal failed: ${err}`);
    })
    .finally(() => {
      if (deps.pendingTaskDisposals.get(taskId) === wrapped) {
        deps.pendingTaskDisposals.delete(taskId);
      }
    });
  deps.pendingTaskDisposals.set(taskId, wrapped);
  /*
  FNXC:AssigneeTransferAtomicity 2026-09-21-20:36 (RUFU-260):
  Mirror the same wrapped promise into the per-task disposal barrier so hosts WITHOUT executor
  lifecycle authority (the heartbeat monitor) can await teardown at their one acquisition seam.
  Publishing here — the single registration point — means every teardown branch (assignee
  transfer, user move, delete) is observable to the barrier for free; readers use
  `awaitTaskDisposalBarrier`, never the executor host field.
  */
  registerTaskDisposal(taskId, wrapped);
}
