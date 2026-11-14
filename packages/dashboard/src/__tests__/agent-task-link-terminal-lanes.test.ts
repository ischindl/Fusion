/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:00 (dashboard-server feed):

THE INVARIANT: the agent "working on" sanitizer asks each linked task's OWN terminal lanes.

`sanitizeAgentTaskLinks` drops `taskId` from an agent response when the linked task is finished, so
the UI stops showing a stale "working on" indicator. It tested hard-coded terminal ids
— CENSUS-INVISIBLE, because a Set literal is a definition rather than a comparison, so nothing in the
lifecycle backlog pointed at this file. On a renamed board it matched nothing and a FINISHED card kept
its agent's indicator lit: the agent list advertised work that had already shipped, which is exactly
what this sanitizer exists to prevent.

WHY THIS GUARD IS STRUCTURAL AND NOT BEHAVIOURAL, stated plainly rather than dressed up:
`sanitizeAgentTaskLinks` is a closure inside `createApiRoutes`, reachable only by building the full
express app and driving `GET /api/agents` through it. That harness exists (see
`routes-automation.test.ts`) but standing it up to re-assert a per-task resolver is a large amount of
machinery around a small seam, and I did not write it. So this asserts the SOURCE: the resolver is
threaded per task and the bare literal call is gone.

It fails on revert — verified by reverting — which is the bar. It is not a substitute for a
behavioural test, and whoever owns the dashboard server should add one through the express harness if
this seam grows. Flagging that rather than letting a structural check read as full coverage.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");

describe("agent task-link sanitizer resolves each task's own terminal lanes", () => {
  it("resolves the workflow IR per linked task id", () => {
    expect(source).toContain("resolveWorkflowIrForTask(scopedStore, taskId, terminalIrCache");
  });

  it("uses EVERY Complete column, not only the first", () => {
    /*
    #2787 review (greptile P1). The first version resolved `lifecycle.complete`, which is
    FIRST-per-role: a workflow declaring two Complete lanes had only one recognised, so a
    task in the second kept its taskId and the agent stayed shown as working on finished work — the
    exact symptom this sanitizer removes, one degree narrower.
    */
    expect(source).toContain('const terminal = columnsWithFlag(ir, "complete");');
  });

  it("passes the resolved answer into the terminal check", () => {
    expect(source).toContain("isTerminalTaskStatus(taskStatus, terminalByTaskId.get(agent.taskId))");
    // The bare one-argument call is what the conversion removes; its return would be the literal.
    expect(source).not.toContain("isTerminalTaskStatus(taskStatus)");
  });

  it("shares ONE IR cache across the batch rather than resolving per agent", () => {
    // A page of agents may link many tasks across a few workflows; the cache is what keeps this
    // from becoming an IR read per row.
    expect(source).toContain("const terminalIrCache = new Map");
  });

  it("keeps Done as the documented unresolvable-workflow fallback", () => {
    // Removing it would make an unresolvable task read as non-terminal forever, which is a
    // regression in the opposite direction — the indicator would never clear.
    expect(source).toContain('const TERMINAL_TASK_STATUSES = new Set(["done"])');
    expect(source).toContain("resolvedTerminal ?? TERMINAL_TASK_STATUSES");
  });
});

/*
FNXC:AgentLinkBatchResolution 2026-11-11-14:40 (RUFU-591):
Behavioral half of the seam the structural guard above could only point at. `sanitizeAgentTaskLinks`
is now exported from `routes.ts`, so these drive it directly with an instrumented store and assert
the RUFU-591 acceptance contract:
  (a) one selection BATCH per request over N distinct linked cards (constant in N, not linear),
  (b) each card judged against its OWN selected workflow's Complete lanes on BOTH the batched leg
      and the single-lookup fallback leg - a custom workflow whose terminal lane differs from the
      default board's is the substitution guard against the `prefetchWorkflowIrs` cold-cache hazard,
  (c) the prefetched payload deep-equals the payload produced with prefetching skipped, so the
      optimization can never change an answer.
*/
import { vi } from "vitest";

const { sanitizeAgentTaskLinks } = await import("../routes.js");

interface FakeTask { column: string; selection?: { workflowId: string; stepIds: string[] }; absent?: boolean }

const CUSTOM_IR = {
  version: "v2",
  id: "custom:board",
  nodes: [{ id: "start", kind: "start", column: "wip" }],
  edges: [],
  columns: [
    { id: "wip", name: "WIP", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function makeStore(tasks: Map<string, FakeTask>, opts?: { batched?: boolean }) {
  const batched = opts?.batched !== false;
  const store: Record<string, unknown> = {
    getTaskColumns: vi.fn(async (ids: string[]) => {
      const out = new Map<string, string>();
      for (const id of new Set(ids)) {
        const task = tasks.get(id);
        // A card absent from the board reports no column at all (selection rows may still exist).
        if (task && !task.absent) out.set(id, task.column);
      }
      return out;
    }),
    getTaskWorkflowSelection: vi.fn((id: string) => tasks.get(id)?.selection),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => tasks.get(id)?.selection),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "custom:board" ? { ir: CUSTOM_IR } : undefined)),
  };
  if (batched) {
    store.getTaskWorkflowSelectionsAsync = vi.fn(async (ids: string[]) => {
      const out = new Map<string, { workflowId: string; stepIds: string[] }>();
      for (const id of ids) {
        const selection = tasks.get(id)?.selection;
        if (selection) out.set(id, selection);
      }
      return out;
    });
  }
  return store as never;
}

const MIXED_TASKS = new Map<string, FakeTask>([
  // Custom workflow declares "shipped" (not "done") as its Complete lane: judging this card with
  // the default board's lanes would keep its taskId - the substitution the guard must catch.
  ["FN-CUSTOM", { column: "shipped", selection: { workflowId: "custom:board", stepIds: [] } }],
  ["FN-CUSTOM-WIP", { column: "wip", selection: { workflowId: "custom:board", stepIds: [] } }],
  ["FN-DEFSEL", { column: "done", selection: { workflowId: "builtin:coding", stepIds: [] } }],
  // No selection row at all: the default workflow governs, so "done" is still terminal.
  ["FN-NOSEL", { column: "done" }],
  // Linked task absent from the board: explicit unresolved marker, taskId preserved.
  ["FN-MISSING", { column: "shipped", selection: { workflowId: "custom:board", stepIds: [] }, absent: true }],
]);

function mixedAgents() {
  return [
    { id: "agent-a", taskId: "FN-CUSTOM" },
    // Two agents linked to the SAME task: unique-id dedupe must keep both judged identically.
    { id: "agent-b", taskId: "FN-CUSTOM" },
    { id: "agent-c", taskId: "FN-CUSTOM-WIP" },
    { id: "agent-d", taskId: "FN-DEFSEL" },
    { id: "agent-e", taskId: "FN-NOSEL" },
    { id: "agent-f", taskId: "FN-MISSING" },
    { id: "agent-g" },
  ] as never;
}

describe("agent task-link sanitizer batched resolution behavior", () => {
  it("issues one selection batch plus at most one definition read per distinct workflow, constant in the number of cards", async () => {
    const tasks = new Map<string, FakeTask>(MIXED_TASKS);
    for (let i = 0; i < 19; i++) {
      const id = `FN-BULK-${i}`;
      tasks.set(id, {
        column: i % 2 === 0 ? "shipped" : "wip",
        selection: { workflowId: i % 3 === 0 ? "builtin:coding" : "custom:board", stepIds: [] },
      });
    }
    const store = makeStore(tasks);
    const agents = [
      ...mixedAgents(),
      ...Array.from({ length: 19 }, (_, i) => ({ id: `agent-bulk-${i}`, taskId: `FN-BULK-${i}` })),
    ] as never;

    const sanitized = await sanitizeAgentTaskLinks(agents, store);

    const batchedRead = (store as never as { getTaskWorkflowSelectionsAsync: ReturnType<typeof vi.fn> }).getTaskWorkflowSelectionsAsync;
    const singleRead = (store as never as { getTaskWorkflowSelection: ReturnType<typeof vi.fn> }).getTaskWorkflowSelection;
    const definitionRead = (store as never as { getWorkflowDefinition: ReturnType<typeof vi.fn> }).getWorkflowDefinition;
    expect(batchedRead).toHaveBeenCalledTimes(1);
    expect(singleRead).not.toHaveBeenCalled();
    expect(definitionRead.mock.calls.map((call) => call[0]).sort()).toEqual(["custom:board"]);
    // A second request over one card pays the same shape: one batch, one custom definition read.
    const smallStore = makeStore(MIXED_TASKS);
    await sanitizeAgentTaskLinks(mixedAgents(), smallStore);
    const smallBatched = (smallStore as never as { getTaskWorkflowSelectionsAsync: ReturnType<typeof vi.fn> }).getTaskWorkflowSelectionsAsync;
    expect(smallBatched).toHaveBeenCalledTimes(1);
    expect(sanitized.length).toBe(26);
  });

  it("judges each card against its own workflow's Complete lanes on the batched leg", async () => {
    const store = makeStore(MIXED_TASKS);

    const sanitized = await sanitizeAgentTaskLinks(mixedAgents(), store);
    const byId = new Map(sanitized.map((agent: { id: string }) => [agent.id, agent]));

    // Custom terminal lane: stripped ONLY if the card was judged with custom:board's lanes.
    expect(byId.get("agent-a")).not.toHaveProperty("taskId");
    expect(byId.get("agent-b")).not.toHaveProperty("taskId");
    // Custom non-terminal lane kept with its column.
    expect(byId.get("agent-c")).toMatchObject({ taskId: "FN-CUSTOM-WIP", taskColumn: "wip" });
    // Default selection + default terminal lane.
    expect(byId.get("agent-d")).not.toHaveProperty("taskId");
    // Selection-less card judged with the default workflow (done is terminal there).
    expect(byId.get("agent-e")).not.toHaveProperty("taskId");
    // Absent task: explicit unresolved marker.
    expect(byId.get("agent-f")).toMatchObject({ taskId: "FN-MISSING", taskColumn: "unresolved" });
    // Unlinked agent untouched.
    expect(byId.get("agent-g")).not.toHaveProperty("taskColumn");
  });

  it("single-lookup fallback leg resolves each card's own workflow with no default substitution", async () => {
    const store = makeStore(MIXED_TASKS, { batched: false });

    const sanitized = await sanitizeAgentTaskLinks(mixedAgents(), store);
    const byId = new Map(sanitized.map((agent: { id: string }) => [agent.id, agent]));

    // The substitution guard on the fallback leg: "shipped" is terminal ONLY per custom:board.
    expect(byId.get("agent-a")).not.toHaveProperty("taskId");
    expect(byId.get("agent-c")).toMatchObject({ taskId: "FN-CUSTOM-WIP", taskColumn: "wip" });
    expect(byId.get("agent-d")).not.toHaveProperty("taskId");
    expect(byId.get("agent-e")).not.toHaveProperty("taskId");
    const singleRead = (store as never as { getTaskWorkflowSelectionAsync: ReturnType<typeof vi.fn> }).getTaskWorkflowSelectionAsync;
    expect(singleRead.mock.calls.length).toBeGreaterThan(0);
  });

  it("prefetched payload deep-equals the payload with prefetching skipped", async () => {
    const batchedStore = makeStore(MIXED_TASKS);
    const fallbackStore = makeStore(MIXED_TASKS, { batched: false });

    const prefetched = await sanitizeAgentTaskLinks(mixedAgents(), batchedStore);
    const direct = await sanitizeAgentTaskLinks(mixedAgents(), fallbackStore);

    expect(prefetched).toEqual(direct);
  });
});
