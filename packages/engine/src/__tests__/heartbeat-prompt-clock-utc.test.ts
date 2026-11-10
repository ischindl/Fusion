import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskDetail, TaskStore } from "@fusion/core";
import { createBudgetStatus, createInboxMessageStore, createMessage } from "./heartbeat-test-helpers.js";

/*
FNXC:AgentTimestampFormat 2026-11-09-13:17 (RUFU-345):
RUFU-345's symptom is a time an AGENT reads: an instant rendered in the host timezone while labelled "UTC",
in a shape that also changes with the host locale. A test that runs on a UTC CI box cannot see that, so every
case here pins two things at once: the host process timezone is forced to Europe/Bratislava (the measured
host, UTC+2 in September) and the instant is frozen to the measured one, 2026-09-26T20:04:17.000Z, whose
Bratislava wall clock is 22:04:17 on the SAME day. A render that leaks "22:04:17" is the exact defect; a
render that leaks "2026-09-27" would be the next-day variant the operator measured.

The surfaces asserted here are the ones that put a stamp inside an agent's own prompt or tool result:
both heartbeat prompt builders (task-assigned and no-task), the step-session `## Steering Comments` block,
and `fn_read_messages`. The `formatAgentTimestamp` primitive itself is covered in
`packages/core/src/__tests__/agent-timestamp.test.ts`; the CLI surfaces in
`packages/cli/src/__tests__/message-timestamp.test.ts`.
*/

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

vi.mock("../worktree/worktree-acquisition.js", () => ({
  acquireTaskWorktree: vi.fn(),
}));

import { createFnAgent } from "../pi.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { buildStepPrompt } from "../execution/step-session-executor.js";
import { createReadMessagesTool } from "../agent-tools.js";
import { formatCommentForInjection, formatTimestamp } from "../executor/execution-prompt.js";
import { HEARTBEAT_CRITICAL_RULES, HEARTBEAT_SYSTEM_PROMPT, HEARTBEAT_SYSTEM_PROMPT_NO_TASK } from "../agents/agent-heartbeat-prompts.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);

/** The measured instant: 20:04:17 UTC = 22:04:17 Europe/Bratislava (CEST, +02:00). */
const INSTANT_ISO = "2026-09-26T20:04:17.000Z";
const INSTANT_MS = Date.UTC(2026, 8, 26, 20, 4, 17);
const UTC_STAMP = "2026-09-26 20:04:17 UTC";
/** Bratislava wall-clock digits for the fixture. Either shape appearing in output is the defect: the 24-hour form is
 * what a sk/en 24-hour locale renders, the 12-hour form is what this runner's default (en-US) locale renders. */
const LOCAL_STAMPS = ["22:04:17", "10:04:17 PM"];

/** The measured defect's counterpart: the authoritative execution-time line both builders must carry. */
const AUTHORITATIVE_LINE = `- execution time (authoritative, UTC): ${UTC_STAMP} — this line, not any other stamp in this prompt or your runtime chrome, is the current time`;

function createMockAgentSession() {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

function createTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue({
      id: "FN-001",
      title: "Clock Task",
      description: "Render every agent-facing stamp in UTC",
      prompt: "# Task\n\n## Steps\n\n### Step 0: Preflight\n",
      steps: [],
      column: "in-progress",
      worktree: "/tmp/worktree-fn-001",
      branch: "fusion/fn-001",
      dependencies: [],
      log: [],
      attachments: [],
      createdAt: INSTANT_ISO,
      updatedAt: INSTANT_ISO,
    } as unknown as TaskDetail),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn().mockReturnValue({}),
    logEntry: vi.fn().mockResolvedValue({}),
    addComment: vi.fn().mockResolvedValue({}),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as TaskStore;
}

/** Minimal AgentStore covering the heartbeat execute path; `taskId: undefined` selects the no-task builder. */
function createAgentStore(agentData: Partial<Agent> = {}): AgentStore {
  const agent: Agent = {
    id: "agent-001",
    name: "Clock Agent",
    role: "executor",
    state: "active",
    taskId: "FN-001",
    soul: "Methodical and precise.",
    createdAt: INSTANT_ISO,
    updatedAt: INSTANT_ISO,
    metadata: {},
    ...agentData,
  } as Agent;

  const savedRuns = new Map<string, AgentHeartbeatRun>();

  return {
    getAgent: vi.fn().mockResolvedValue(agent),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    assignTask: vi.fn().mockResolvedValue(agent),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    startHeartbeatRun: vi.fn().mockImplementation(async (_agentId: string, initialMetadata = {}) => {
      const run = {
        id: "run-clock",
        agentId: agent.id,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active" as const,
        ...initialMetadata,
      } as AgentHeartbeatRun;
      savedRuns.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
      savedRuns.set(run.id, run);
    }),
    getRunDetail: vi.fn().mockImplementation(async (_agentId: string, runId: string) => savedRuns.get(runId) ?? null),
    endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
  } as unknown as AgentStore;
}

/** Runs one heartbeat and returns the execution prompt handed to the session. */
async function renderHeartbeatPrompt(opts: { taskId?: string; messages?: ReturnType<typeof createMessage>[] }): Promise<string> {
  const store = createAgentStore({ taskId: opts.taskId });
  const session = createMockAgentSession();
  mockedCreateFnAgent.mockResolvedValue({ session: session as never });
  const monitor = new HeartbeatMonitor({
    store,
    messageStore: createInboxMessageStore(opts.messages ?? []),
    taskStore: createTaskStore(),
    rootDir: "/tmp",
  });

  const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });
  expect(result.status).toBe("completed");

  const calls = session.prompt.mock.calls as unknown as string[][];
  expect(calls.length).toBeGreaterThan(0);
  return String(calls[calls.length - 1][0]);
}

function inboxMessage(id: string, content: string) {
  return createMessage({
    id,
    fromId: "user-1",
    fromType: "user",
    content,
    createdAt: INSTANT_ISO,
    updatedAt: INSTANT_ISO,
  });
}

describe("agent-facing prompt stamps are UTC (RUFU-345)", () => {
  const priorTz = process.env.TZ;

  beforeEach(() => {
    // Node reads process.env.TZ for host-timezone formatting, so the defect only exists once TZ is set here.
    process.env.TZ = "Europe/Bratislava";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(INSTANT_MS));
    mockedAcquireTaskWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktree-fn-001",
      branch: "fusion/fn-001",
      source: "existing",
      hydrated: false,
      isResume: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  });

  it("proves the fixture really disagrees with UTC under this timezone", () => {
    // Without this, every assertion below could pass vacuously on a UTC runner.
    const local = new Date(INSTANT_MS);
    expect(local.getUTCHours()).toBe(20);
    expect(local.getHours()).toBe(22); // +02:00 CEST, the offset the operator measured
    // The measured defect shape, and the same instant under this runner's default locale (the shape flip the card records).
    expect(local.toLocaleString("en-GB", { hourCycle: "h23" })).toContain(LOCAL_STAMPS[0]);
    expect(local.toLocaleString()).toContain(LOCAL_STAMPS[1]);
  });

  it("renders task-assigned Pending Message stamps as UTC, never as Bratislava wall clock", async () => {
    const prompt = await renderHeartbeatPrompt({ taskId: "FN-001", messages: [inboxMessage("msg-1", "steer me")] });

    expect(prompt).toContain("Pending Messages:");
    expect(prompt).toContain("[id: msg-1] [from: user:user-1] steer me");
    expect(prompt).toContain(`(${UTC_STAMP})`);
    expect(prompt).not.toContain(LOCAL_STAMPS[0]);
    expect(prompt).not.toContain(LOCAL_STAMPS[1]);
  });

  it("renders no-task Pending Message stamps as UTC, never as Bratislava wall clock", async () => {
    const prompt = await renderHeartbeatPrompt({ taskId: undefined, messages: [inboxMessage("msg-2", "no task here")] });

    expect(prompt).toContain("Pending Messages:");
    expect(prompt).toContain(`(${UTC_STAMP})`);
    expect(prompt).not.toContain(LOCAL_STAMPS[0]);
    expect(prompt).not.toContain(LOCAL_STAMPS[1]);
  });

  it("keeps an empty inbox free of timestamp noise in both builders", async () => {
    const assigned = await renderHeartbeatPrompt({ taskId: "FN-001", messages: [] });
    const noTask = await renderHeartbeatPrompt({ taskId: undefined, messages: [] });

    for (const prompt of [assigned, noTask]) {
      expect(prompt).not.toContain("Pending Messages:");
      expect(prompt).not.toContain(LOCAL_STAMPS[0]);
      expect(prompt).not.toContain(LOCAL_STAMPS[1]);
      expect(prompt).not.toContain("Invalid Date");
    }
  });

  it("renders the step-session Steering Comments timestamp as UTC", () => {
    const prompt = buildStepPrompt(
      {
        id: "FN-001",
        title: "Clock Task",
        description: "d",
        prompt: "# Task\n\n## Steps\n\n### Step 0: Preflight\n\n### Step 1: Work\n",
        steps: [{ name: "Preflight", status: "done" }, { name: "Work", status: "pending" }],
        column: "in-progress",
        dependencies: [],
        log: [],
        attachments: [],
        steeringComments: [
          { id: "c-1", author: "user", text: "Prefer the UTC invariant.", createdAt: INSTANT_ISO },
        ],
        createdAt: INSTANT_ISO,
        updatedAt: INSTANT_ISO,
      } as unknown as TaskDetail,
      1,
    );

    expect(prompt).toContain("## Steering Comments");
    expect(prompt).toContain(UTC_STAMP);
    expect(prompt).not.toContain(LOCAL_STAMPS[0]);
    expect(prompt).not.toContain(LOCAL_STAMPS[1]);
  });

  it("carries the authoritative execution-time line in the task-assigned builder's Wake Delta", async () => {
    const prompt = await renderHeartbeatPrompt({ taskId: "FN-001", messages: [inboxMessage("msg-clock", "clock please")] });

    expect(prompt).toContain("## Wake Delta");
    expect(prompt).toContain(AUTHORITATIVE_LINE);
    expect(prompt).not.toContain(LOCAL_STAMPS[0]);
    expect(prompt).not.toContain(LOCAL_STAMPS[1]);
  });

  it("carries the authoritative execution-time line in the no-task builder's Wake Delta", async () => {
    const prompt = await renderHeartbeatPrompt({ taskId: undefined, messages: [] });

    expect(prompt).toContain("## Wake Delta");
    expect(prompt).toContain(AUTHORITATIVE_LINE);
    expect(prompt).not.toContain(LOCAL_STAMPS[0]);
    expect(prompt).not.toContain(LOCAL_STAMPS[1]);
  });

  it("declares the execution-time line authoritative in the heartbeat system prompt the session is created with", async () => {
    await renderHeartbeatPrompt({ taskId: "FN-001", messages: [] });

    const createCalls = mockedCreateFnAgent.mock.calls as unknown as Array<Array<{ systemPrompt?: string }>>;
    const systemPrompts = createCalls
      .map((args) => args[0]?.systemPrompt)
      .filter((value): value is string => typeof value === "string");
    expect(systemPrompts.length).toBeGreaterThan(0);
    // The declaration must reach the session that also receives the execution-time line, otherwise the
    // prompt states a clock the agent was never told to trust.
    expect(systemPrompts.some((p) => p.includes("Clock of record") && p.includes("execution time (authoritative, UTC)"))).toBe(true);
  });

  it("declares the clock of record for both task-assigned and no-task system prompts", () => {
    for (const prompt of [HEARTBEAT_SYSTEM_PROMPT, HEARTBEAT_SYSTEM_PROMPT_NO_TASK]) {
      expect(prompt).toContain("Clock of record");
      expect(prompt).toContain("execution time (authoritative, UTC)");
    }
    expect(HEARTBEAT_CRITICAL_RULES).toContain("Clock of record");
  });

  it("renders the executor comment timestamp as UTC past the relative window, keeping the relative branches", () => {
    // The frozen now is INSTANT_MS, so 8 days earlier crosses the >7d boundary into the absolute fallback.
    const eightDaysAgo = new Date(INSTANT_MS - 8 * 86_400_000).toISOString();
    expect(formatTimestamp(eightDaysAgo)).toBe("2026-09-18 20:04:17 UTC");
    for (const local of LOCAL_STAMPS) expect(formatTimestamp(eightDaysAgo)).not.toContain(local);
    // Host-locale date shapes the removed `toLocaleDateString()` produced must not come back.
    expect(formatTimestamp(eightDaysAgo)).not.toMatch(/9\/18\/2026|18\. 9\./);

    const injected = formatCommentForInjection({
      id: "c-old",
      author: "user",
      text: "Hold the UTC invariant.",
      createdAt: eightDaysAgo,
    } as never);
    expect(injected).toContain("2026-09-18 20:04:17 UTC");

    // RUFU-181's relative contract is unchanged by this card: a fresh comment is still reported relatively.
    expect(formatTimestamp(new Date(INSTANT_MS - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatTimestamp(new Date(INSTANT_MS - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(formatTimestamp(new Date(INSTANT_MS - 3 * 86_400_000).toISOString())).toBe("3d ago");
  });

  it("renders fn_read_messages inbox lines with the UTC stamp", async () => {
    const messageStore = {
      getInbox: vi.fn().mockResolvedValue([
        {
          id: "msg-tool",
          fromId: "user-1",
          fromType: "user",
          toId: "agent-001",
          toType: "agent",
          content: "Read me",
          type: "user-to-agent",
          read: false,
          createdAt: INSTANT_ISO,
          updatedAt: INSTANT_ISO,
        },
      ]),
      getMessage: vi.fn(),
    };

    const result = await createReadMessagesTool(messageStore as never, "agent-001").execute("call-1", {});
    const text = String((result.content as Array<{ text?: string }>)[0]?.text ?? "");

    expect(text).toContain(UTC_STAMP);
    expect(text).not.toContain(LOCAL_STAMPS[0]);
    expect(text).not.toContain(LOCAL_STAMPS[1]);
  });
});
