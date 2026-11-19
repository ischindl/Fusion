import { describe, expect, it } from "vitest";

import {
  collectAgentAssignedCards,
  formatAgentAssignedCardLines,
  formatAgentAssignedCardsCompact,
  formatAgentDiagnosticLines,
  formatAgentErrorRecoveryLine,
  formatProjectAttributionLine,
  loadAgentPendingApprovalCounts,
  truncateAgentDiagnosticText,
  withAgentPendingApprovalCounts,
  type AgentAssignedCardStore,
} from "../agent-diagnostic-projection.js";
import { AGENT_STALL_REASON_UNKNOWN, AGENT_STALL_REASON_UNKNOWN_LABEL } from "../agent-pause-reasons.js";
import { WAKE_DELTA_ASSIGNED_TASKS_CAP } from "../assigned-task-ranking.js";
import type { WorkflowIr } from "../../workflows/workflow-ir-types.js";

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
The truncation and recovery helpers moved here VERBATIM from `packages/cli/src/extension.ts`, where
they were private to one Pi tool. The byte-identity pins below use the same metadata fixtures
`packages/cli/src/__tests__/extension.test.ts` drives, so a refactor that changes a word or a bound
fails here rather than at five surfaces. `Pause Reason: <code>` keeps its prefix untouched — RUFU-247
only appends the human words after it.
*/

describe("formatAgentDiagnosticLines — the three honest stall cases", () => {
  it("renders an operator-actionable park as code plus its human words", () => {
    const lines = formatAgentDiagnosticLines(
      { state: "paused", pauseReason: "error-unrecoverable" },
      { compact: true },
    );
    expect(lines).toContain(
      "Pause Reason: error-unrecoverable — Paused with an unrecoverable error",
    );
  });

  it("renders budget exhaustion distinctly from the credential park", () => {
    const lines = formatAgentDiagnosticLines(
      { state: "paused", pauseReason: "error-retry-exhausted" },
      { compact: true },
    );
    expect(lines).toContain(
      "Pause Reason: error-retry-exhausted — Automatic retries exhausted",
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("renders a %s reason on a stopped agent as unknown with guidance, never as nothing", (_label, pauseReason) => {
    const lines = formatAgentDiagnosticLines(
      { state: "paused", pauseReason, lastError: null, metadata: null },
      { compact: true },
    );
    expect(lines).toContain(`Pause Reason: ${AGENT_STALL_REASON_UNKNOWN} — ${AGENT_STALL_REASON_UNKNOWN_LABEL}`);
  });

  it("applies the unknown rule to an errored agent as well", () => {
    const lines = formatAgentDiagnosticLines({ state: "error", metadata: null }, { compact: true });
    expect(lines.some((line) => line.startsWith("Pause Reason: unknown"))).toBe(true);
  });

  it("keeps an unknown reason off a healthy agent — nothing stalled, nothing to explain", () => {
    expect(formatAgentDiagnosticLines({ state: "active" }, { compact: true })).toEqual([]);
    expect(formatAgentDiagnosticLines({ state: "active" }, { compact: false })).toEqual([]);
  });

  it("preserves the compact gating that keeps healthy-agent rows short", () => {
    const input = { state: "active", lastError: "stale hidden error", pauseReason: "stale hidden pause" };
    expect(formatAgentDiagnosticLines(input, { compact: true })).toEqual([]);
    // Non-compact always shows a recorded reason (FN-7859 contract).
    expect(formatAgentDiagnosticLines(input, { compact: false })).toEqual([
      "Last Error: stale hidden error",
      "Pause Reason: stale hidden pause — stale hidden pause",
    ]);
  });

  it("keeps the Last Error bound byte-identical between modes (compact 180, full 500)", () => {
    const lastError = "E".repeat(600);
    const compact = formatAgentDiagnosticLines({ state: "error", lastError }, { compact: true })[0]!;
    const full = formatAgentDiagnosticLines({ state: "error", lastError }, { compact: false })[0]!;
    expect(compact).toBe(`Last Error: ${"E".repeat(180)}…`);
    expect(full).toBe(`Last Error: ${"E".repeat(500)}…`);
  });

  it("orders the lines Last Error, Pause Reason, Error Recovery", () => {
    const lines = formatAgentDiagnosticLines(
      {
        state: "paused",
        lastError: "boom",
        pauseReason: "error-retry-exhausted",
        metadata: { durableErrorRecovery: { attempts: 5, exhausted: true } },
      },
      { compact: true },
    );
    expect(lines).toEqual([
      "Last Error: boom",
      "Pause Reason: error-retry-exhausted — Automatic retries exhausted",
      "Error Recovery: attempts 5, exhausted",
    ]);
  });
});

describe("formatAgentErrorRecoveryLine — moved verbatim from extension.ts", () => {
  it("reads the heartbeat streak (extension.test.ts error-agent fixture)", () => {
    expect(formatAgentErrorRecoveryLine({
      metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 2, updatedAt: "2026-07-12T18:20:00.000Z" } },
    })).toBe("Error Recovery: attempts 2");
  });

  it("reads the durable exhausted park (extension.test.ts paused-agent fixture)", () => {
    expect(formatAgentErrorRecoveryLine({
      metadata: { durableErrorRecovery: { attempts: 5, exhausted: true } },
    })).toBe("Error Recovery: attempts 5, exhausted");
  });

  it("reads the durable next-retry instant (extension.test.ts detail fixture)", () => {
    expect(formatAgentErrorRecoveryLine({
      metadata: { durableErrorRecovery: { attempts: 3, nextRetryAt: "2026-07-12T18:30:00.000Z" } },
    })).toBe("Error Recovery: attempts 3, next 2026-07-12T18:30:00.000Z");
  });

  it("takes the higher of the two counters and omits absent keys", () => {
    expect(formatAgentErrorRecoveryLine({
      metadata: {
        heartbeatErrorRecovery: { consecutiveAttempts: 7 },
        durableErrorRecovery: { attempts: 2 },
      },
    })).toBe("Error Recovery: attempts 7");
  });

  it("returns null when neither recovery record exists, and ignores malformed ones", () => {
    expect(formatAgentErrorRecoveryLine({ metadata: null })).toBeNull();
    expect(formatAgentErrorRecoveryLine({ metadata: {} })).toBeNull();
    expect(formatAgentErrorRecoveryLine({ metadata: { heartbeatErrorRecovery: "nope" } })).toBeNull();
    expect(formatAgentErrorRecoveryLine({ metadata: { otherThing: { attempts: 4 } } })).toBeNull();
  });

  it("labels a live throttle cooldown through the shared reader rather than re-deriving it", () => {
    const line = formatAgentErrorRecoveryLine({
      metadata: {
        heartbeatErrorRecovery: {
          consecutiveAttempts: 1,
          throttleStreak: 4,
          cooldownUntilAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    })!;
    expect(line).toContain("attempts 1");
    expect(line).toContain("throttle cooldown until");
    expect(line).toContain("streak 4");
    expect(line).not.toContain("exhausted");
  });
});

describe("truncateAgentDiagnosticText", () => {
  it("leaves short text untouched and marks a cut with the shared ellipsis", () => {
    expect(truncateAgentDiagnosticText("short", 180)).toBe("short");
    expect(truncateAgentDiagnosticText("abc", 2)).toBe("ab…");
    expect(truncateAgentDiagnosticText("", 5)).toBe("");
  });

  it("truncates a long pause code at the 180-char bound the helper has always used", () => {
    const lines = formatAgentDiagnosticLines(
      { state: "paused", pauseReason: "x".repeat(300) },
      { compact: true },
    );
    expect(lines[0]!.startsWith(`Pause Reason: ${"x".repeat(180)}…`)).toBe(true);
  });
});

describe("loadAgentPendingApprovalCounts / withAgentPendingApprovalCounts", () => {
  const actors = [{ id: "agent-a" }, { id: "agent-b" }];

  /**
   * A minimal asyncLayer whose drizzle-shaped read chain resolves to fixed rows: `select().from().where()
   * .groupBy()` is awaited, so the chain only has to be thenable. No database, no network, no timers.
   */
  function fakeLayer(rows: Array<{ actorId: string; requestCount: number | string }>) {
    const chain: Record<string | symbol, unknown> = {};
    for (const method of ["select", "from", "where", "groupBy", "orderBy", "limit"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: unknown) => unknown) => resolve(rows);
    return { db: chain, projectId: "p-1" };
  }

  it("scopes counts to the requested actors", async () => {
    const store = { getAsyncLayer: () => fakeLayer([{ actorId: "agent-a", requestCount: "3" }]) };
    const counts = await loadAgentPendingApprovalCounts(store as never, ["agent-a", "agent-b"]);
    expect(counts.get("agent-a")).toBe(3);
    expect(counts.get("agent-b")).toBe(0);
  });

  it("answers the whole board unscoped when no actor list is given", async () => {
    const store = { getAsyncLayer: () => fakeLayer([{ actorId: "agent-z", requestCount: 2 }]) };
    const counts = await loadAgentPendingApprovalCounts(store as never);
    expect(counts.get("agent-z")).toBe(2);
  });

  it("zeroes every requested actor when the layer is absent, so the read never fails", async () => {
    const store = { getAsyncLayer: () => null };
    const counts = await loadAgentPendingApprovalCounts(store as never, ["agent-a", "agent-b"]);
    expect(counts.get("agent-a")).toBe(0);
    expect(counts.get("agent-b")).toBe(0);
  });

  it("answers identically for an absent layer and a throwing one", async () => {
    const absent = await loadAgentPendingApprovalCounts({ getAsyncLayer: () => null } as never, ["agent-a"]);
    const throwing = await loadAgentPendingApprovalCounts({
      getAsyncLayer: () => {
        throw new Error("42P01 relation does not exist");
      },
    } as never, ["agent-a"]);
    expect(throwing).toEqual(absent);
    expect(absent.get("agent-a")).toBe(0);
  });

  it("zeroes every actor when the approval read throws", async () => {
    const store = {
      getAsyncLayer: () => ({
        db: {
          select() {
            throw new Error("approval read refused");
          },
        },
      }),
    };
    const counts = await loadAgentPendingApprovalCounts(store as never, ["agent-a", "agent-b"]);
    expect([...counts.values()]).toEqual([0, 0]);
  });

  it("attaches pendingApprovalCount to every agent, zeroing on failure", async () => {
    const enriched = await withAgentPendingApprovalCounts(
      actors,
      { getAsyncLayer: () => null } as never,
    );
    expect(enriched.map((agent) => agent.pendingApprovalCount)).toEqual([0, 0]);
    expect(enriched.map((agent) => agent.id)).toEqual(["agent-a", "agent-b"]);
  });

  it("attaches real counts for each actor through the same helper", async () => {
    const enriched = await withAgentPendingApprovalCounts(
      actors,
      { getAsyncLayer: () => fakeLayer([{ actorId: "agent-b", requestCount: 7 }]) } as never,
    );
    expect(enriched.map((agent) => agent.pendingApprovalCount)).toEqual([0, 7]);
  });
});

describe("formatProjectAttributionLine", () => {
  it("names the project by name plus id, and degrades to id-only", () => {
    expect(formatProjectAttributionLine({ projectId: "p-1", projectName: "RunFusion" }))
      .toBe("Project: RunFusion (p-1)");
    expect(formatProjectAttributionLine({ projectId: "p-1" })).toBe("Project: p-1");
  });
});

/* ── assigned-card inventory ───────────────────────────────────────────── */

/** One board: hold/wip ids are the legacy pair, plus a RENAMED completion lane. */
const IR = {
  version: "v2",
  id: "wf-inventory",
  name: "inventory",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", name: "Ready", traits: [] },
    { id: "in-progress", name: "Wip", traits: [] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

interface FakeTask {
  id: string;
  column: string;
  title?: string | null;
  paused?: boolean | null;
  userPaused?: boolean | null;
  dependencies?: string[] | null;
  checkedOutBy?: string | null;
}

function makeStore(tasks: FakeTask[]): AgentAssignedCardStore {
  return {
    getTasksByAssignedAgent: async () => tasks as never,
    getTaskWorkflowSelection: () => ({ workflowId: "wf-inventory", stepIds: [] }) as never,
    getWorkflowDefinition: async () => ({ ir: IR }) as never,
  };
}

describe("collectAgentAssignedCards", () => {
  it("excludes cards resting in a RENAMED complete column via resolved trait flags", async () => {
    const store = makeStore([
      { id: "RUFU-1", column: "todo", title: "ready work" },
      { id: "RUFU-2", column: "shipped", title: "finished work" },
    ]);
    const result = await collectAgentAssignedCards("agent-x", { store });
    expect(result.cards.map((card) => card.taskId)).toEqual(["RUFU-1"]);
    // totalOpen counts post-filter open rows, so the finished card is not "hidden work".
    expect(result.totalOpen).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("splits parked cards by who parked them and keeps them out of the titled list", async () => {
    const store = makeStore([
      { id: "RUFU-1", column: "todo", title: "live" },
      { id: "RUFU-2", column: "todo", title: "operator hold", userPaused: true, paused: false },
      { id: "RUFU-3", column: "in-progress", title: "engine park", paused: true },
    ]);
    const result = await collectAgentAssignedCards("agent-x", { store });
    expect(result.cards.map((card) => card.taskId)).toEqual(["RUFU-1"]);
    expect(result.notActionableCount).toBe(2);
    // RUFU-264: an operator hard-cancel must never read as an engine rebound.
    expect(result.operatorPausedCount).toBe(1);
    expect(result.enginePausedCount).toBe(1);
  });

  it("honors a cap with honest truncated accounting", async () => {
    const many: FakeTask[] = Array.from({ length: 10 }, (_unused, index) => ({
      id: `RUFU-${index + 1}`,
      column: "todo",
      title: `work ${index + 1}`,
    }));
    const result = await collectAgentAssignedCards("agent-x", {
      store: makeStore(many),
      cap: 2,
    });
    expect(result.cards).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // `totalOpen` stays the post-filter open count, so "showing 2 of 10" is honest, not 2 of 2.
    expect(result.totalOpen).toBe(10);
  });

  it("labels the bound card so the row can name the one it is standing for", async () => {
    const result = await collectAgentAssignedCards("agent-x", {
      store: makeStore([
        { id: "RUFU-1", column: "todo", title: "other work" },
        { id: "RUFU-2", column: "todo", title: "the bound card" },
      ]),
      boundTaskId: "RUFU-2",
    });
    const bound = result.cards.find((card) => card.taskId === "RUFU-2")!;
    const other = result.cards.find((card) => card.taskId === "RUFU-1")!;
    expect(bound.labels).toContain("bound");
    expect(bound.isBoundTask).toBe(true);
    expect(other.isBoundTask).toBe(false);
    expect(other.labels).not.toContain("bound");
  });

  it("defaults the cap to the shared Wake Delta cap rather than inventing a second number", async () => {
    const many: FakeTask[] = Array.from({ length: WAKE_DELTA_ASSIGNED_TASKS_CAP + 3 }, (_unused, index) => ({
      id: `RUFU-${index + 1}`,
      column: "todo",
      title: `work ${index + 1}`,
    }));
    const result = await collectAgentAssignedCards("agent-x", { store: makeStore(many) });
    expect(result.cards).toHaveLength(WAKE_DELTA_ASSIGNED_TASKS_CAP);
    expect(result.truncated).toBe(true);
  });

  it("carries the tier and column through so the caller can render one line per card", async () => {
    const result = await collectAgentAssignedCards("agent-x", {
      store: makeStore([
        { id: "RUFU-9", column: "in-progress", title: "running work" },
        { id: "RUFU-8", column: "todo", title: "ready work", dependencies: ["RUFU-9"] },
      ]),
    });
    const byId = new Map(result.cards.map((card) => [card.taskId, card]));
    expect(byId.get("RUFU-9")!.tier).toBe("in_progress");
    expect(byId.get("RUFU-8")!.tier).toBe("partial_blocked");
    expect(byId.get("RUFU-9")!.column).toBe("in-progress");
    expect(byId.get("RUFU-9")!.titleSnippet).toBe("running work");
  });

  it("keeps the inventory alive when a workflow IR cannot resolve trait flags", async () => {
    // `traits` is optional on the column type; `columnsWithFlag` iterates it and throws. One malformed
    // workflow must cost that card's terminal-column filter, never the whole assigned-card answer.
    const brokenIr = {
      version: "v2", id: "wf-broken", name: "b", nodes: [], edges: [],
      columns: [{ id: "todo", name: "Ready" }],
    } as unknown as WorkflowIr;
    const store: AgentAssignedCardStore = {
      getTasksByAssignedAgent: async () => [{ id: "RUFU-1", column: "todo", title: "work" }] as never,
      getTaskWorkflowSelection: () => ({ workflowId: "wf-broken", stepIds: [] }) as never,
      getWorkflowDefinition: async () => ({ ir: brokenIr }) as never,
    };
    const result = await collectAgentAssignedCards("agent-x", { store });
    expect(result.cards.map((card) => card.taskId)).toEqual(["RUFU-1"]);
  });

  it("degrades to an empty inventory when the task read fails", async () => {
    const store = {
      getTasksByAssignedAgent: async () => {
        throw new Error("task read refused");
      },
      getTaskWorkflowSelection: () => undefined,
      getWorkflowDefinition: async () => undefined,
    } as unknown as AgentAssignedCardStore;
    const result = await collectAgentAssignedCards("agent-x", { store });
    expect(result.cards).toEqual([]);
    expect(result.totalOpen).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe("assigned-card line formatters", () => {
  it("numbers each card with tier, column, and title snippet", () => {
    const lines = formatAgentAssignedCardLines({
      cards: [
        { taskId: "RUFU-1", column: "todo", tier: "ready_todo", labels: [], titleSnippet: "ready work", isBoundTask: false },
        { taskId: "RUFU-2", column: "in-progress", tier: "in_progress", labels: ["bound"], titleSnippet: "held work", isBoundTask: true },
      ],
      totalOpen: 4,
      truncated: true,
      notActionableCount: 1,
      operatorPausedCount: 1,
      enginePausedCount: 0,
    });
    expect(lines[0]).toBe("1. RUFU-1 [ready_todo] todo — ready work");
    expect(lines[1]).toBe("2. RUFU-2 [in_progress] in-progress — held work (bound)");
    expect(lines.join("\n")).toContain("Parked and not shown: 1 (operator 1, engine 0)");
    expect(lines.join("\n")).toContain("Showing 2 of 4 open assigned cards.");
  });

  it("renders a one-line compact inventory with the hidden count", () => {
    expect(formatAgentAssignedCardsCompact({
      cards: [
        { taskId: "RUFU-1", column: "todo", tier: "ready_todo", labels: [], titleSnippet: "a", isBoundTask: false },
      ],
      totalOpen: 4,
      truncated: true,
      notActionableCount: 0,
      operatorPausedCount: 0,
      enginePausedCount: 0,
    })).toBe("Assigned cards: RUFU-1 [todo] +3 more");
  });

  it("says nothing when the agent holds no open cards at all", () => {
    expect(formatAgentAssignedCardsCompact({
      cards: [],
      totalOpen: 0,
      truncated: false,
      notActionableCount: 0,
      operatorPausedCount: 0,
      enginePausedCount: 0,
    })).toBeNull();
  });

  it("still reports an empty-but-open inventory instead of going silent", () => {
    const line = formatAgentAssignedCardsCompact({
      cards: [],
      totalOpen: 3,
      truncated: false,
      notActionableCount: 3,
      operatorPausedCount: 3,
      enginePausedCount: 0,
    })!;
    expect(line).toContain("3 open");
    expect(line).toContain("none actionable");
  });
});
