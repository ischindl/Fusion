import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
A durable owner went `paused` with no pauseReason and idled five assigned cards for a day because no
read surface could say why. These cover the two CLI read verbs that answer it, through the REAL core
projection (`@fusion/core` is partially mocked so `classifyAgentStall` / `formatAgentDiagnosticLines`
are the product's own): the three honest stall cases must print distinctly, a blank reason must print
as `unknown` rather than nothing, and a cross-project miss must name the project it searched.

Same partial-mock shape `project.test.ts` establishes — the real implementations stay under test so a
rewired surface cannot pass by mocking away the very projection being verified.
*/

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  if (impl) mock.mockImplementation(impl);
  return mock;
}

const { mockGetAgent, mockListAgents, mockInit, mockClose, mockResolveAgentStoreBase } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(async () => null),
  mockListAgents: vi.fn(async () => []),
  mockInit: vi.fn(async () => undefined),
  mockClose: vi.fn(),
  mockResolveAgentStoreBase: vi.fn(async () => ({
    rootDir: "/tmp/fusion-agent-read",
    asyncLayer: {},
    store: {},
    project: { projectId: "proj-77", projectName: "RunFusion" },
    cleanup: vi.fn(async () => undefined),
  })),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AgentStore: makeConstructibleMock(() => ({
    init: mockInit,
    getAgent: mockGetAgent,
    listAgents: mockListAgents,
    close: mockClose,
  })),
}));

vi.mock("../../project-context.js", () => ({
  resolveAgentStoreBase: mockResolveAgentStoreBase,
}));

import { formatAgentShowLines, runAgentList, runAgentShow } from "../agent.js";
import { formatAgentDiagnosticLines } from "@fusion/core";

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as unknown as typeof process.exit);
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function printed(): string {
  return logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function printedErrors(): string {
  return errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-5683bf15",
    name: "Heartbeat Keeper",
    role: "scheduler",
    roles: ["scheduler"],
    state: "paused",
    metadata: {},
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

/** A TaskStore stand-in carrying only the reads the stall projection performs. */
function fakeStore(tasks: Array<{ id: string; column: string; title?: string }> = []) {
  return {
    getAsyncLayer: () => null,
    getTasksByAssignedAgent: async () => tasks,
    getTaskWorkflowSelection: () => undefined,
    getWorkflowDefinition: async () => undefined,
    getTask: async (id: string) => tasks.find((task) => task.id === id) ?? null,
  };
}

function stubContext(overrides: Record<string, unknown> = {}) {
  mockResolveAgentStoreBase.mockResolvedValue({
    rootDir: "/tmp/fusion-agent-read",
    asyncLayer: {},
    store: fakeStore(),
    project: { projectId: "proj-77", projectName: "RunFusion" },
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy.mockImplementation((() => {
    throw new Error("process.exit");
  }) as unknown as typeof process.exit);
  logSpy.mockImplementation(() => {});
  errorSpy.mockImplementation(() => {});
  mockInit.mockResolvedValue(undefined as never);
  mockResolveAgentStoreBase.mockResolvedValue({
    rootDir: "/tmp/fusion-agent-read",
    asyncLayer: {},
    store: fakeStore(),
    project: { projectId: "proj-77", projectName: "RunFusion" },
    cleanup: vi.fn(async () => undefined),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runAgentShow — the three honest stall cases", () => {
  it("names an operator-actionable park with its human words", async () => {
    mockGetAgent.mockResolvedValue(agent({ pauseReason: "error-unrecoverable", lastError: "OAuth scope revoked" }) as never);
    await runAgentShow("agent-5683bf15");
    const out = printed();
    expect(out).toContain("Last Error: OAuth scope revoked");
    expect(out).toContain("Pause Reason: error-unrecoverable — Paused with an unrecoverable error");
  });

  it("names a retry-budget exhaustion differently from the credential park", async () => {
    mockGetAgent.mockResolvedValue(agent({ pauseReason: "error-retry-exhausted" }) as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Pause Reason: error-retry-exhausted — Automatic retries exhausted");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("prints a %s reason on a paused agent as unknown instead of printing nothing", async (_label, pauseReason) => {
    mockGetAgent.mockResolvedValue(agent({ pauseReason, metadata: null }) as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Pause Reason: unknown — no pause reason recorded (inspect agent logs/runlog)");
  });

  it("says nothing about a pause reason on a healthy agent — nothing stalled", async () => {
    mockGetAgent.mockResolvedValue(agent({ state: "active", pauseReason: undefined }) as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).not.toContain("Pause Reason:");
    expect(printed()).toContain("State: active");
  });

  it("carries the error-recovery budget line from agent metadata", async () => {
    mockGetAgent.mockResolvedValue(agent({
      pauseReason: "error-retry-exhausted",
      metadata: { durableErrorRecovery: { attempts: 5, exhausted: true } },
    }) as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Error Recovery: attempts 5, exhausted");
  });
});

describe("runAgentShow — ownership and the work it holds", () => {
  it("names the owning project so a reader knows which board this agent lives on", async () => {
    stubContext({ store: fakeStore() });
    mockGetAgent.mockResolvedValue(agent() as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Project: RunFusion (proj-77)");
  });

  it("lists the assigned cards with id and column, plus the parked count", async () => {
    stubContext({
      store: fakeStore([
        { id: "RUFU-1", column: "in-progress", title: "Fix lockfile drift" },
        { id: "RUFU-2", column: "todo", title: "Add stall diagnostics" },
      ]),
    });
    mockGetAgent.mockResolvedValue(agent({ taskId: "RUFU-1" }) as never);
    await runAgentShow("agent-5683bf15");
    const out = printed();
    expect(out).toContain("Assigned cards: 2 open");
    expect(out).toContain("RUFU-1");
    expect(out).toContain("in-progress");
    expect(out).toContain("Fix lockfile drift");
    expect(out).toContain("RUFU-2");
    // The bound card's lane comes from the store, not from the agent row.
    expect(out).toContain("Current Task: RUFU-1 (in-progress)");
  });

  it("says none open rather than going silent when the agent holds nothing", async () => {
    mockGetAgent.mockResolvedValue(agent() as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Assigned cards: none open");
  });

  it("reports zero approvals when the approval store cannot be consulted", async () => {
    mockGetAgent.mockResolvedValue(agent() as never);
    await runAgentShow("agent-5683bf15");
    expect(printed()).toContain("Pending approvals: 0");
  });

  it("emits a parseable --json projection with the same facts", async () => {
    mockGetAgent.mockResolvedValue(agent({ pauseReason: "error-retry-exhausted" }) as never);
    await runAgentShow("agent-5683bf15", undefined, { json: true });
    const payload = JSON.parse(printed().trim());
    expect(payload.id).toBe("agent-5683bf15");
    expect(payload.state).toBe("paused");
    expect(payload.project).toEqual({ projectId: "proj-77", projectName: "RunFusion" });
    expect(payload.pendingApprovalCount).toBe(0);
    expect(payload.diagnosticLines.join("\n")).toContain("error-retry-exhausted");
    expect(payload.assigned.cards).toEqual([]);
  });
});

describe("runAgentShow — a cross-project miss names the project it searched", () => {
  it("refuses to claim the agent does not exist anywhere", async () => {
    stubContext({ project: { projectId: "proj-77", projectName: "RunFusion" } });
    mockGetAgent.mockResolvedValue(null as never);

    await expect(runAgentShow("agent-99999999")).rejects.toThrow("process.exit");

    const err = printedErrors();
    expect(err).toContain("Agent agent-99999999 not found in project \"RunFusion\" (proj-77).");
    expect(err).toContain("--project");
  });

  it("closes both stores on the miss path so the process still exits (FN-7704)", async () => {
    const cleanup = vi.fn(async () => undefined);
    stubContext({ cleanup });
    mockGetAgent.mockResolvedValue(null as never);

    await expect(runAgentShow("agent-99999999")).rejects.toThrow("process.exit");

    expect(mockClose).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });
});

describe("runAgentList", () => {
  it("prints one row per agent with the stall code, its words, approvals and card count", async () => {
    mockListAgents.mockResolvedValue([
      agent({ id: "agent-a", state: "paused", pauseReason: "error-retry-exhausted" }),
      agent({ id: "agent-b", state: "active", pauseReason: undefined }),
    ] as never);
    await runAgentList();
    const out = printed();
    const [rowA, rowB] = out.split("\n").filter((line) => line.includes("agent-"));
    expect(rowA).toContain("agent-a");
    expect(rowA).toContain("error-retry-exhausted (Automatic retries exhausted)");
    expect(rowA).toContain("approvals:0");
    expect(rowB).not.toContain("Pause Reason");
    expect(out).toContain("2 agent(s) in project \"RunFusion\"; 1 stopped.");
  });

  it("prints the unknown stall code for a stopped lane that recorded no reason", async () => {
    mockListAgents.mockResolvedValue([agent({ state: "paused", pauseReason: null })] as never);
    await runAgentList();
    expect(printed()).toContain("unknown (no pause reason recorded (inspect agent logs/runlog))");
  });

  it("says no agents instead of printing an empty block", async () => {
    mockListAgents.mockResolvedValue([] as never);
    await runAgentList();
    expect(printed()).toContain("No agents in project \"RunFusion\".");
  });

  it("passes --all through to the ephemeral-inclusive agent list", async () => {
    mockListAgents.mockResolvedValue([] as never);
    await runAgentList(undefined, { includeEphemeral: true });
    expect(mockListAgents).toHaveBeenCalledWith({ includeEphemeral: true });
  });
});

describe("formatAgentShowLines", () => {
  it("keeps identity and ownership above the stall facts", () => {
    const lines = formatAgentShowLines({
      id: "agent-a",
      name: "Keeper",
      roles: ["scheduler", "reviewer"],
      state: "paused",
      reportsTo: "agent-mgr",
      project: { projectId: "p1", projectName: "RunFusion" },
      pendingApprovalCount: 2,
      diagnosticLines: formatAgentDiagnosticLines(
        { state: "paused", pauseReason: "error-unrecoverable", lastError: "billing" },
        { compact: false },
      ),
      assigned: {
        cards: [],
        totalOpen: 0,
        truncated: false,
        notActionableCount: 0,
        operatorPausedCount: 0,
        enginePausedCount: 0,
      },
    });
    expect(lines.slice(0, 2)).toEqual(["Agent agent-a — Keeper", "  Roles: scheduler,reviewer"]);
    expect(lines.indexOf("  Reports to: agent-mgr")).toBeLessThan(lines.indexOf("Project: RunFusion (p1)"));
    expect(lines.indexOf("Project: RunFusion (p1)"))
      .toBeLessThan(lines.findIndex((line) => line.startsWith("Last Error:")));
    expect(lines.at(-1)).toBe("  Assigned cards: none open");
  });
});
