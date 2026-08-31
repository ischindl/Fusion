import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import { requestPreMergeOptionalStepFix, reviewInputSignature } from "../executor/request-pre-merge-optional-step-fix.js";
import { claimRemediationAttempt } from "../executor/claim-review-remediation-attempt.js";

/*
FNXC:LifecycleContainment 2026-08-30-13:36:
FN-267: the graph-failure sink is the SECOND automatic remediation requester. It used to call the
optional-step requester with no claim at all, so a graph failure racing the self-healing sweep could
append a second remediation wave, bounce twice, or write a second "explained once" refusal for one
review input — the once-only contract held on one path and leaked on the other. These cases drive the
real `handleGraphFailure` sink so the claim, its release/retain, and its silence on a lost claim are
proven where production takes them.
*/

const now = "2026-08-30T13:00:00.000Z";

function failedCodeReview(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review-step",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "failed",
    verdict: "REVISE",
    reviewKind: "code",
    reviewInputFingerprint: "backstop-round-one",
    startedAt: now,
    completedAt: now,
    findings: [{
      id: "critical-backstop",
      severity: "critical",
      filePath: "packages/engine/src/executor/handle-graph-failure.ts",
      line: 1106,
      title: "Backstop bypasses the claim",
      body: "Route the backstop through the admission claim.",
    }],
    ...overrides,
  } as WorkflowStepResult;
}

function harness(resultOverrides: Partial<WorkflowStepResult> = {}) {
  const store = createMockStore();
  const task = {
    id: "FN-267-backstop",
    title: "Graph failure backstop",
    description: "A graph run that ends in review with a blocking failed gate.",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-267-backstop",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-267-backstop",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    createdAt: now,
    updatedAt: now,
    workflowStepResults: [failedCodeReview(resultOverrides)],
  } as unknown as TaskDetail;

  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ maxConcurrent: 2, autoMerge: true });
  store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
  store.updateTaskAtomic = vi.fn(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
    const updates = await updater(task);
    if (updates) Object.assign(task, updates);
    return task;
  });
  store.getTaskWorkflowSelection = vi.fn(() => undefined);
  store.getWorkflowDefinition = vi.fn(async () => null);

  const executor = new TaskExecutor(store, "/tmp/test");
  const requestPreMergeOptionalStepFix = vi.fn(async () => true);
  Object.assign(executor as unknown as Record<string, unknown>, {
    requestPreMergeOptionalStepFix: (...args: unknown[]) =>
      (requestPreMergeOptionalStepFix as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    routeResetParsePinMismatchToRetry: vi.fn(async () => false),
    routeRetryableRemediationGraphFailureToPreMergeFix: vi.fn(async () => false),
    routeGraphFailureToExecutionResume: vi.fn(async () => false),
  });
  return { executor, store, task, requestPreMergeOptionalStepFix };
}

const graphFailure = () => ({
  disposition: "failed" as const,
  outcome: "failure" as const,
  failedNode: "code-review-step",
  visitedNodeIds: ["code-review-step"],
  context: { "node:code-review-step:value": "failure" },
});

const liveResult = (task: TaskDetail) => task.workflowStepResults![0] as WorkflowStepResult;
const parkEntries = (store: ReturnType<typeof createMockStore>) =>
  store.logEntry.mock.calls.filter((call: unknown[]) => String(call[1]).includes("remediation was not scheduled"));

describe("FN-267 the graph-failure backstop is claim-scoped", () => {
  beforeEach(() => resetExecutorMocks());

  it("claims the failed round, drives the requester, and releases on a scheduled hand-off", async () => {
    const { executor, task, requestPreMergeOptionalStepFix } = harness();

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    expect(requestPreMergeOptionalStepFix).toHaveBeenCalledTimes(1);
    expect(requestPreMergeOptionalStepFix.mock.calls[0]![2]).toMatchObject({ nodeId: "code-review-step", verdict: "REVISE" });
    // A scheduled hand-off releases the claim so a genuinely new round is admitted later.
    expect(liveResult(task).remediationAttemptOwner).toBeUndefined();
    expect(liveResult(task).remediationRefusedReason).toBeUndefined();
  });

  it("retains the claim with its reason when the requester declines", async () => {
    const { executor, store, task, requestPreMergeOptionalStepFix } = harness();
    requestPreMergeOptionalStepFix.mockResolvedValue(false);

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    expect(liveResult(task).remediationRefusedReason).toBe("appender-declined");
    expect(liveResult(task).remediationAttemptOwner).toEqual(expect.stringMatching(/^graph-failure:/));
    expect(parkEntries(store)).toHaveLength(1);
  });

  it("stays silent when another owner already holds the claim on the same review round", async () => {
    const signature = reviewInputSignature(failedCodeReview())!;
    const { executor, store, task, requestPreMergeOptionalStepFix } = harness({
      remediationAttemptSignature: signature,
      remediationAttemptOwner: "self-healing:already-running",
      remediationAttemptClaimedAt: new Date().toISOString(),
    } as Partial<WorkflowStepResult>);

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    // The sweep owns this round: no duplicate remediation, and no second park message.
    expect(requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(parkEntries(store)).toHaveLength(0);
    expect(liveResult(task).remediationAttemptOwner).toBe("self-healing:already-running");
  });

  it("aborts the REAL requester when a newer round lands between admission and the hand-off", async () => {
    const { executor, store, task } = harness();
    const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
    const sendTaskBackForFix = vi.fn(async () => undefined);

    /* The newer round lands after the claim is won and before the requester re-asserts it. */
    store.getSettings.mockImplementation(async () => {
      if (liveResult(task).remediationAttemptOwner) {
        task.workflowStepResults = [{
          ...liveResult(task),
          reviewInputFingerprint: "backstop-round-two",
          findings: [{
            id: "critical-newer-round", severity: "critical", title: "A newer round",
            body: "Different feedback.", filePath: "packages/engine/src/executor/handle-graph-failure.ts",
          }],
        }] as WorkflowStepResult[];
      }
      return { maxConcurrent: 2, autoMerge: true };
    });
    Object.assign(executor as unknown as Record<string, unknown>, {
      requestPreMergeOptionalStepFix: (taskId: string, live: unknown, info: unknown, options: unknown) =>
        requestPreMergeOptionalStepFix({
          store, getRunContextFor: () => undefined,
          appendReviewRemediationSteps, sendTaskBackForFix,
          recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
          parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
          clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
        } as never, taskId, live as never, info as never, options as never),
    });

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    // The stale attempt neither remediated nor bounced the newer round...
    expect(appendReviewRemediationSteps).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    // ...and it neither condemned it nor spoke about it.
    expect(liveResult(task).remediationRefusedReason).toBeUndefined();
    expect(parkEntries(store)).toHaveLength(0);
  });

  it("writes no convergence narration when a newer round supersedes a budget-stopped claim", async () => {
    const { executor, store, task } = harness();
    const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
    const sendTaskBackForFix = vi.fn(async () => undefined);
    /* An exhausted budget sends a claimed run down routeStop, which routes convergence and narrates. */
    store.getSettings.mockImplementation(async () => {
      if (liveResult(task).remediationAttemptOwner) {
        task.workflowStepResults = [{
          ...liveResult(task),
          reviewInputFingerprint: "backstop-round-two",
          findings: [{
            id: "critical-newer-round", severity: "critical", title: "A newer round",
            body: "Different feedback.", filePath: "packages/engine/src/executor/handle-graph-failure.ts",
          }],
        }] as WorkflowStepResult[];
      }
      return { maxConcurrent: 2, autoMerge: true, codeReviewMaxRevisions: 0, maxPostReviewFixes: 0 };
    });
    Object.assign(executor as unknown as Record<string, unknown>, {
      requestPreMergeOptionalStepFix: (taskId: string, live: unknown, info: unknown, options: unknown) =>
        requestPreMergeOptionalStepFix({
          store, getRunContextFor: () => undefined,
          appendReviewRemediationSteps, sendTaskBackForFix,
          recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
          parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
          clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
        } as never, taskId, live as never, info as never, options as never),
    });

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    // The stale runner narrated nothing about the newer round and routed no convergence for it.
    expect(appendReviewRemediationSteps).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry.mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes("did not converge")
      || String(call[1]).includes("revision budget exhausted"))).toHaveLength(0);
    expect(liveResult(task).remediationRefusedReason).toBeUndefined();
  });

  it("releases the claim when the requester throws, leaving no reason-less lease", async () => {
    const { executor, task, requestPreMergeOptionalStepFix: requester } = harness();
    requester.mockRejectedValue(new Error("hand-off exploded"));

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure())
      .catch(() => undefined);

    expect(liveResult(task).remediationAttemptOwner).toBeUndefined();
    expect(liveResult(task).remediationAttemptSignature).toBeUndefined();
    expect(liveResult(task).remediationRefusedReason).toBeUndefined();
  });

  it("stays silent when this round already carries a durable refusal", async () => {
    const signature = reviewInputSignature(failedCodeReview())!;
    const { executor, store, task, requestPreMergeOptionalStepFix } = harness({
      remediationAttemptSignature: signature,
      remediationAttemptOwner: "self-healing:refused",
      remediationAttemptClaimedAt: new Date().toISOString(),
      remediationRefusedReason: "no-actionable-findings",
    } as Partial<WorkflowStepResult>);

    await (executor as unknown as { handleGraphFailure: (t: TaskDetail, r: unknown) => Promise<void> })
      .handleGraphFailure(task, graphFailure());

    expect(requestPreMergeOptionalStepFix).not.toHaveBeenCalled();
    expect(parkEntries(store)).toHaveLength(0);
    expect(liveResult(task).remediationRefusedReason).toBe("no-actionable-findings");
  });
});
