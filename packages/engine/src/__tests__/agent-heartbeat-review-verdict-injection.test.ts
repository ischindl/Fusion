import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { appendHeartbeatReviewVerdictTool, HeartbeatMonitor } from "../agent-heartbeat.js";
import { heartbeatReviewVerdictGateOpens } from "../review/record-review-verdict.js";

/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-21:10 (RUFU-531):
 * Caller-site coverage for the injection rule that decides whether a task-scoped heartbeat wake is handed
 * `fn_record_review_verdict` at all. RUFU-531's defect was a reviewer lane with nowhere to publish; the
 * first cut of the fix answered by offering the tool on EVERY task-scoped wake, which is its own defect -
 * an implementation wake, a card with no review gate, a card whose gate is already proven, and a card whose
 * gate is FN-295's archived carrier all then receive an affordance whose only possible answer is a refusal,
 * and an agent that calls it and reads the refusal has spent a turn and earned nothing.
 *
 * So the rule is: the wake asks the seam's own candidacy decision and injects only on a live, non-workspace,
 * non-superseded pre-merge `code-review` row that is `pending` or FN-8492's verdict-less `failed`, carries
 * no `reviewInputFingerprint`, and carries no `remediationArchivedAt`. These tests pin BOTH directions —
 * injected and withheld — over the exact function the wake calls, and pin that the synchronous tool builder
 * never carries the tool unconditionally, which is the regression that would re-open the over-offer.
 */

const TASK_ID = "RUFU-531";
const REVIEWER = "agent-reviewer";

function codeReviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowStepId: "code-review",
    name: "Code Review",
    kind: "prompt",
    status: "pending",
    verdict: null,
    summary: null,
    findings: [],
    report: null,
    artifacts: [],
    startedAt: null,
    completedAt: null,
    durationMs: null,
    agentId: REVIEWER,
    modelId: null,
    skippedReason: null,
    metadata: null,
    ...overrides,
  };
}

function wakeTask(overrides: Record<string, unknown> = {}): Task {
  const task = {
    id: TASK_ID,
    title: "Reviewer verdict surface",
    column: "review",
    status: null,
    error: null,
    branch: "fusion/rufu-531",
    worktree: "/tmp/does-not-need-to-exist-rufu-531",
    baseCommitSha: null,
    workflowStepResults: [codeReviewRow()],
    dependencies: [],
    blocks: [],
    ...(overrides ?? {}),
  };
  return task as unknown as Task;
}

function storeFor(getTask: TaskStore["getTask"]): TaskStore {
  return { getTask } as unknown as TaskStore;
}

async function injected(store: TaskStore): Promise<string[]> {
  const tools: any[] = [];
  await appendHeartbeatReviewVerdictTool({ tools, taskStore: store, agentId: REVIEWER, taskId: TASK_ID });
  return tools.map((tool) => tool.name);
}

describe("heartbeat review verdict tool injection", () => {
  it("injects the verdict surface when the live code-review row still owes a verdict", async () => {
    const names = await injected(storeFor(vi.fn().mockResolvedValue(wakeTask())));
    expect(names).toEqual(["fn_record_review_verdict"]);
  });

  it("injects it for FN-8492's verdict-less failed gate row, the reported symptom", async () => {
    const names = await injected(
      storeFor(
        vi.fn().mockResolvedValue(
          wakeTask({ workflowStepResults: [codeReviewRow({ status: "failed", completedAt: "2026-11-12T00:00:00.000Z" })] }),
        ),
      ),
    );
    expect(names).toEqual(["fn_record_review_verdict"]);
  });

  it("withholds it when the card has no code-review gate at all", async () => {
    const names = await injected(storeFor(vi.fn().mockResolvedValue(wakeTask({ workflowStepResults: [] }))));
    expect(names).toEqual([]);
  });

  it("withholds it when the live row already carries its content proof", async () => {
    const names = await injected(
      storeFor(
        vi.fn().mockResolvedValue(
          wakeTask({
            workflowStepResults: [
              codeReviewRow({
                status: "passed",
                verdict: "APPROVE",
                completedAt: "2026-11-12T00:00:00.000Z",
                reviewInputFingerprint: "abc123def456",
              }),
            ],
          }),
        ),
      ),
    );
    expect(names).toEqual([]);
  });

  it("withholds it over FN-295's archived remediation carrier", async () => {
    const names = await injected(
      storeFor(
        vi.fn().mockResolvedValue(
          wakeTask({
            workflowStepResults: [
              codeReviewRow({ status: "failed", verdict: "REVISE", remediationArchivedAt: "2026-11-12T00:00:00.000Z" }),
            ],
          }),
        ),
      ),
    );
    expect(names).toEqual([]);
  });

  it("withholds it for a workspace card, whose proof is per-repository", async () => {
    const names = await injected(
      storeFor(
        vi.fn().mockResolvedValue(
          wakeTask({ workspaceWorktrees: { "repo-a": { path: "/tmp/rufu-531-a", branch: "fusion/rufu-531" } } }),
        ),
      ),
    );
    expect(names).toEqual([]);
  });

  it("withholds it when the live row cannot be read, because a refusal needs a row to be honest about", async () => {
    const names = await injected(storeFor(vi.fn().mockRejectedValue(new Error("store unreachable"))));
    expect(names).toEqual([]);
  });

  it("asks the seam, so the injection rule and the write path cannot drift", async () => {
    const shapes: Array<{ label: string; task: Task }> = [
      { label: "pending gate", task: wakeTask() },
      { label: "verdict-less failed gate", task: wakeTask({ workflowStepResults: [codeReviewRow({ status: "failed", completedAt: "x" })] }) },
      { label: "no gate", task: wakeTask({ workflowStepResults: [] }) },
      {
        label: "proven gate",
        task: wakeTask({
          workflowStepResults: [codeReviewRow({ status: "passed", verdict: "APPROVE", completedAt: "x", reviewInputFingerprint: "abc123" })],
        }),
      },
      {
        label: "archived carrier",
        task: wakeTask({ workflowStepResults: [codeReviewRow({ status: "failed", verdict: "REVISE", remediationArchivedAt: "x" })] }),
      },
      { label: "workspace card", task: wakeTask({ workspaceWorktrees: { "repo-a": { path: "/tmp/rufu-531-a" } } }) },
    ];
    for (const shape of shapes) {
      const injectedNames = await injected(storeFor(vi.fn().mockResolvedValue(shape.task)));
      expect(injectedNames.length, shape.label).toBe(heartbeatReviewVerdictGateOpens(shape.task) ? 1 : 0);
    }
  });

  it("keeps the synchronous task-scoped builder free of the verdict surface", () => {
    // The gate needs a live read, so the tool must never be pushed by the synchronous builder it replaced.
    const monitor = new HeartbeatMonitor({
      store: { getAgent: vi.fn().mockResolvedValue(null) } as any,
      taskStore: storeFor(vi.fn().mockResolvedValue(wakeTask())),
      rootDir: "/tmp",
    });
    const names = monitor.createHeartbeatTools(REVIEWER, storeFor(vi.fn().mockResolvedValue(wakeTask())), TASK_ID).map((tool) => tool.name);
    expect(names).not.toContain("fn_record_review_verdict");
  });

  it("binds the injected tool to the wake's own agent and task", async () => {
    const tools: any[] = [];
    const store = storeFor(vi.fn().mockResolvedValue(wakeTask()));
    await appendHeartbeatReviewVerdictTool({ tools, taskStore: store, agentId: REVIEWER, taskId: TASK_ID, runContext: { agentId: REVIEWER, runId: "run-1" } });
    expect(tools).toHaveLength(1);
    const call = await tools[0].execute("call-inject-1", { verdict: "APPROVE", summary: "Ship it." });
    // The fixture checkout cannot be measured, so only the seam can answer this way - and it answers about
    // the card the WAKE was bound to (the injected `currentTaskId`), never a caller-named one.
    expect(call.details).toMatchObject({ taskId: TASK_ID, outcome: "refused" });
    expect(call.isError).toBe(true);
  });
});
