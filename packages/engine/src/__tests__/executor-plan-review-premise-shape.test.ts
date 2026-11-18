import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

/*
FNXC:PlanPremiseAuthoring 2026-11-18-06:36 (RUFU-727 Steps 5 and 6):
The plan-premise shape gate is deterministic and ALWAYS ON for Plan Review — unlike the external-integration
evidence gate, which a node flag selects, `## Plan Premises` is mandatory on every planned card, so there is
no flag to wait for. That makes its cost contract the whole point of this file: a refusal must spend no
reviewer-agent call, no session, and no unit of the review-revision budget, because a gate that consumes the
budget it is protecting turns a deterministic string comparison into a burned revision cycle.

The two cases are the pair that keeps the gate honest in both directions. The refusing case asserts the REVISE
shape the graph's plan-replan loop already consumes, plus the History line that names the deterministic check
so an operator can tell it apart from a reviewer's REVISE. The passing case asserts the gate stays silent on a
plan it has no complaint about — a gate that always fires is indistinguishable from a broken reviewer, and
this is the only suite that would notice.
*/

type CapturedSession = { last?: { systemPrompt?: string } };

function captureSession() {
  const holder: CapturedSession = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    holder.last = { systemPrompt: opts.systemPrompt };
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (fn: (event: any) => void) => {
          listeners.push(fn);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const fn of listeners) {
            fn({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                partial: '{"verdict":"APPROVE","notes":"Reviewed the plan and found it sound."}',
                contentIndex: 0,
                delta: '{"verdict":"APPROVE","notes":"Reviewed the plan and found it sound."}',
              },
            });
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
  return holder;
}

function baseTask(prompt: string) {
  return {
    id: "FN-7130",
    title: "Premise shape",
    description: "exercise the plan-premise shape gate",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-7130",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompt,
  };
}

function planReviewStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "graph:plan-review-step",
    name: "Plan Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the plan.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The RUFU-698 shape: the deliverable introduces the marker the premise forbids, on a path the plan
 *  itself declares it writes. */
const SELF_CONSUMING = [
  "## Mission",
  "Remove the deferred-rotation marker from the release door.",
  "",
  "## Plan Premises",
  "",
  '- {"kind":"text-absent","path":"packages/engine/src/execution/hold-release.ts","literal":"rotated-deferred"}',
  "",
  "## File Scope",
  "",
  "- `packages/engine/src/execution/hold-release.ts`",
  "",
  "## Steps",
  "",
  "1. delete the marker",
].join("\n");

/** The legal sibling: a fact on a path this card edits that the edit leaves true. */
const WELL_FORMED = [
  "## Mission",
  "Read the release door and report.",
  "",
  "## Plan Premises",
  "",
  '- {"kind":"text-present","path":"packages/engine/src/execution/hold-release.ts","literal":"export async function admitTaskToWip"}',
  "",
  "## File Scope",
  "",
  "- `packages/engine/src/execution/hold-release.ts`",
  "",
  "## Steps",
  "",
  "1. read it",
].join("\n");

async function runPlanReview(prompt: string) {
  const store = createMockStore();
  const task = baseTask(prompt);
  store.getTask.mockResolvedValue(task);
  store.getTaskDocument = vi.fn(async (_id: string, key: string) =>
    key === "PROMPT.md" ? { content: prompt } : undefined,
  );
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  const result = await (executor as any).executeWorkflowStep(task, planReviewStep(), "/tmp/wt", {}, undefined, undefined);
  return { store, result };
}

describe("Plan Review deterministic plan-premise shape gate", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("refuses a self-consuming plan premise without launching a session or charging the revision budget", async () => {
    const { store, result } = await runPlanReview(SELF_CONSUMING);

    expect(result).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
    expect(result.output).toContain("REVISE:");
    expect(result.notes).toContain("self-consuming premise");
    // Deterministic: no reviewer agent, therefore no session and no review-revision budget unit.
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7130",
      expect.stringContaining("Plan Review deterministic plan-premise shape check requested revision"),
    );
    // The remedy travels with the verdict, in operator terms, never as something to force.
    expect(result.notes).toContain("Fix it in the PLAN");
  });

  it("leaves a Plan Review whose premises this card does not consume to the reviewer", async () => {
    const capture = captureSession();
    const { result } = await runPlanReview(WELL_FORMED);

    expect(result.success).toBe(true);
    // Silence means the reviewer still gets the plan: a gate that always fires looks identical to a
    // broken reviewer from the board.
    expect(capture.last).toBeTruthy();
  });
});
