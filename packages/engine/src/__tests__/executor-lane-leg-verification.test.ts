// @ts-nocheck
/*
FNXC:LaneLegGate 2026-11-11-23:30 (RUFU-425, W3):
The in-progress executor seam and the graph's Verification node share one deterministic-verification
primitive, so a lane-leg refusal reaches both. This file covers the executor half, which is the half
that can silently do the wrong thing: its existing reaction to `allPassed: false` is a fix-agent loop
with N retries. Pointed at a refusal, that loop would edit code to repair a test that never executed and
then report the card as remediated.

Two assertions carry the contract:
- no fix agent is dispatched, and
- the card parks with a greppable class name instead of advancing, because the session that could have
  repaired the checkout has already ended.

FNXC:LaneLegGate 2026-11-12-01:36 (RUFU-425, P0 remediation):
A park the engine can walk past is not a refusal. The code review caught that the first cut's park
survived neither of the two automatic paths that look at a card whose steps are all done: the
completed-task watchdog armed moments earlier promotes it 60 seconds later, and both stranded-completed
sweeps ask `evaluateCompletedPromotionFailureProvenance`, which reads only `FAILURE_PARK_MARKERS` from
the durable History — so the most recent marker was the clean completion and the refused card reached
review as if it had been measured. `parksTheCard` therefore now asserts the three facts that make the
park stick: the watchdog is no longer armed, a History line carrying the class token was written, and
the real promotion guard refuses that card.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { evaluateCompletedPromotionFailureProvenance } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import {
  createMockStore,
  mockedExistsSync,
  mockExecuteAll,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/worktree-acquisition.js")>()),
  acquireTaskWorktree: vi.fn(),
}));

const worktreePath = "/tmp/test/.fusion/worktrees/rufu-425-leg";
const now = "2026-11-11T23:30:00.000Z";

const laneLegRefusal = {
  code: "lane-leg-empty",
  repository: "member",
  path: `${worktreePath}/member`,
  legs: [{ repository: "member", classification: "empty-directory", entryCount: 0, toplevel: null, head: null, lag: null }],
};

function task() {
  return {
    id: "RUFU-425-consumer",
    title: "A workspace card whose member leg is empty",
    description: "prove the executor refuses instead of dispatching a fix agent",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 1\n- [x] done",
    workspaceWorktrees: { member: { worktreePath: `${worktreePath}/member`, branch: "fusion/rufu-425-consumer" } },
    createdAt: now,
    updatedAt: now,
  };
}

async function runExecutor(options: {
  verification: () => Promise<unknown>;
  fixOutcome?: () => Promise<unknown>;
}) {
  resetExecutorMocks();
  mockedExistsSync.mockReturnValue(true);
  vi.mocked(acquireTaskWorktree).mockReset().mockResolvedValue({
    worktreePath,
    branch: "fusion/rufu-425-consumer",
    source: "fresh",
    hydrated: true,
    isResume: false,
  });
  mockExecuteAll.mockResolvedValue([{ stepIndex: 0, success: true, retries: 0 }]);

  const liveTask = task();
  const store = createMockStore();
  store.getTask.mockImplementation(async () => ({ ...liveTask }));
  store.getSettings.mockResolvedValue({
    autoMerge: false,
    runStepsInNewSessions: true,
    testCommand: "pnpm test",
    verificationFixRetries: 3,
    experimentalFeatures: { workflowGraphExecutor: true },
  });

  const executor = new TaskExecutor(store, "/tmp/test");
  vi.spyOn(executor as never as { runExecutorDeterministicVerification: () => unknown }, "runExecutorDeterministicVerification")
    .mockImplementation(options.verification);
  const fixAgent = vi.spyOn(executor as never as { attemptExecutorVerificationFix: () => unknown }, "attemptExecutorVerificationFix")
    .mockImplementation(options.fixOutcome ?? (async () => ({ fixed: false })));

  await executor.runImplementation(liveTask, vi.fn(), vi.fn());
  return { executor, store, fixAgent };
}

/*
The executor writes card History through `store.logEntry(taskId, action, ...)`. Replaying those calls as
log entries in write order reconstructs what the promotion guard will read on the next sweep — the guard
consumes the durable History, not the in-memory `task.error`.
*/
function writtenHistory(store: { logEntry: { mock: { calls: unknown[][] } } }) {
  return store.logEntry.mock.calls.map((call) => ({ timestamp: now, action: String(call[1] ?? "") }));
}

describe("executor deterministic verification - a lane-leg refusal is not a red command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parks the card with a named class and never dispatches the fix agent", async () => {
    const { executor, store, fixAgent } = await runExecutor({
      verification: async () => ({ allPassed: false, laneLegRefusal }),
    });

    expect(fixAgent, "a fix agent may not be pointed at a command that never ran").not.toHaveBeenCalled();
    const parked = store.updateTask.mock.calls
      .map((call) => call[1])
      .find((patch) => typeof patch?.error === "string" && patch.error.startsWith("LANE_LEGS_NOT_MATERIALIZED:"));
    expect(parked).toMatchObject({ status: "failed" });
    expect(parked.error).toContain("lane-leg-empty");
    expect(parked.error).toContain("member");

    /*
    The watchdog was armed before this gate ran, so an uncleared park leaves a live 60-second timer
    whose only job is to promote a card whose steps are all done. Asserting on the real timer registry
    (not a mock) is what proves the refusal, not a test double, cancelled it.
    */
    const watchdogs = (executor as unknown as { completedTaskWatchdogs: Map<string, unknown> }).completedTaskWatchdogs;
    expect(watchdogs.size, "the refusal must cancel the completed-task watchdog it armed").toBe(0);

    /*
    The park is only honest if the promotion guard that the watchdog defers to also refuses. Feed the
    guard the History the run actually wrote, behind the clean completion a real `fn_task_done` writes
    inside the session, and ask whether this card may be promoted.
    */
    const history = writtenHistory(store);
    expect(
      history.some((entry) => entry.action.includes("LANE_LEGS_NOT_MATERIALIZED")),
      "the park must leave its class token in durable History, not only in task.error",
    ).toBe(true);
    const verdict = evaluateCompletedPromotionFailureProvenance({
      log: [{ timestamp: now, action: "Task marked done by agent" }, ...history],
    });
    expect(verdict.blocked, "a card the gate refused may not be promoted to review").toBe(true);
    expect(verdict.markerAction).toContain("LANE_LEGS_NOT_MATERIALIZED");
  });

  it("a red command still reaches the fix agent", async () => {
    const { fixAgent } = await runExecutor({
      verification: async () => ({
        allPassed: false,
        failedCommand: "testCommand",
        testResult: { command: "pnpm test", exitCode: 1, stdout: "", stderr: "1 failed", success: false },
      }),
      fixOutcome: async () => ({ fixed: true }),
    });

    expect(fixAgent, "the ordinary remediation path is unchanged by the refusal branch").toHaveBeenCalled();
  });

  /*
  FNXC:LaneLegGate 2026-11-11-23:40 (RUFU-425, W3):
  The mid-loop half of the same rule. A leg that stops being a repository WHILE a fix agent works must
  end the loop on the first attempt: the second agent would be dispatched at the same empty directory,
  and the card would end up with a remediation history about a command that is no longer measurable.
  */
  it("a refusal discovered mid-loop stops the re-dispatch instead of spending the retries", async () => {
    const { executor, store, fixAgent } = await runExecutor({
      verification: async () => ({
        allPassed: false,
        failedCommand: "testCommand",
        testResult: { command: "pnpm test", exitCode: 1, stdout: "", stderr: "1 failed", success: false },
      }),
      fixOutcome: async () => ({ fixed: false, laneLegRefusal }),
    });

    expect(fixAgent, "one agent may run, but a second cannot materialise a repository").toHaveBeenCalledTimes(1);
    const parked = store.updateTask.mock.calls
      .map((call) => call[1])
      .find((patch) => typeof patch?.error === "string" && patch.error.startsWith("LANE_LEGS_NOT_MATERIALIZED:"));
    expect(parked).toMatchObject({ status: "failed" });
    expect(parked.error).toContain("lane-leg-empty");

    // The mid-loop park is the same disposition reached by a different route, so it owes the same two
    // writes: no surviving watchdog, and a History marker the promotion guard reads.
    const watchdogs = (executor as unknown as { completedTaskWatchdogs: Map<string, unknown> }).completedTaskWatchdogs;
    expect(watchdogs.size, "the mid-loop refusal must cancel the completed-task watchdog").toBe(0);
    const verdict = evaluateCompletedPromotionFailureProvenance({
      log: [{ timestamp: now, action: "Task marked done by agent" }, ...writtenHistory(store)],
    });
    expect(verdict.blocked, "a fix loop stopped by a refusal may not be promoted to review").toBe(true);
  });
});
