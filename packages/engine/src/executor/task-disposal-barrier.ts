/*
FNXC:AssigneeTransferAtomicity 2026-09-21-20:36 (RUFU-260):
Per-task DISPOSAL BARRIER: a tiny module-scoped registry that lets a heartbeat wake block until any
in-flight teardown for the same card has fully settled. It exists because every existing teardown
consumer awaits `TaskExecutor.pendingTaskDisposals` — an executor host field — while the heartbeat
monitor is a separate host that must NOT gain executor lifecycle authority just to wait. The barrier
holds WAITING power only: releasing it is `settle`, never a decision. No timeout and no bypass — the
same posture as `pendingTaskDisposals` (see track-task-disposal.ts): a caller that cannot prove the
teardown finished must not proceed, and a stuck teardown stalls the wake rather than racing it.

Publication happens inside `trackTaskDisposal` (the single registration point for every teardown
branch — assignee transfer, user move, delete), so every branch is observable here for free.
Readers use `awaitTaskDisposalBarrier` — the one seam heartbeat wakes consult before acquiring a
task worktree.
*/

const barriers = new Map<string, Promise<void>>();

/**
 * Publish a teardown for `taskId`. Successive teardowns CHAIN, so a wake that arrives while an
 * earlier teardown is still settling waits for the whole chain, not just the latest registration.
 * The entry removes itself once it is the tail and has settled.
 */
export function registerTaskDisposal(taskId: string, teardown: Promise<void>): void {
  const previous = barriers.get(taskId);
  const chained = previous ? previous.then(() => teardown, () => teardown) : teardown;
  const barrier = chained.then(
    () => {},
    () => {},
  );
  barriers.set(taskId, barrier);
  void barrier.then(() => {
    if (barriers.get(taskId) === barrier) barriers.delete(taskId);
  });
}

/**
 * Await every teardown currently published for `taskId`. Re-checks after each settle so a teardown
 * published DURING the wait extends it; returns only once no barrier remains. An absent barrier is
 * an immediate no-op — most wakes never raced a teardown.
 */
export async function awaitTaskDisposalBarrier(taskId: string): Promise<void> {
  for (;;) {
    const barrier = barriers.get(taskId);
    if (!barrier) return;
    await barrier;
  }
}

/** Whether a teardown is currently published for `taskId` (test/diagnostic seam). */
export function hasTaskDisposalBarrier(taskId: string): boolean {
  return barriers.has(taskId);
}

/**
 * Drop every published barrier. Test-only: suites that run `trackTaskDisposal` must reset this
 * module in teardown so a barrier registered by one test never gates a later test in the same
 * worker. Production code must never call it.
 */
export function resetTaskDisposalBarrierForTests(): void {
  barriers.clear();
}
