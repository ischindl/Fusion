/*
FNXC:PlanPromptWriteRefusal 2026-10-14-10:04 (RUFU-651):
`STUCK_LOOP_EXHAUSTED` cards ran many planner sessions, wrote no PROMPT.md, and their six attempts
each reported only "Planner did not update the authoritative PROMPT.md". The durable writer can be
the party that stopped the plan — a reset fence, malformed `### Step N:` dependencies, or a failed
read-back — and every one of those refusals used to be returned as `STORE_UNAVAILABLE` with retry
guidance, which is the lie `tool-store-errors.ts` records for STAS-251 ("telling an agent to retry a
refusal teaches them to retry it").

The invariant is two-sided, so both halves are asserted here: a refusal must be shape- and text-wise
a refusal AND a genuine store failure must keep the outage shape. Laundering either direction is what
made the cause unreadable. Asserted through the real tool body, not a mock of its conclusion.
*/
import { describe, expect, it } from "vitest";

import type { TaskStore } from "@fusion/core";
import {
  createTaskPromptWriteTool,
  type PlanPromptWriteRefusalReason,
} from "../agent-tools.js";
import { describeUnwrittenPlanArtifact } from "../triage.js";
import { STORE_RETRY_GUIDANCE } from "../tool-store-errors.js";

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const STORE_UNAVAILABLE_TEXT = "did not reach the task store";

function call(tool: { execute: (id: string, params: unknown) => Promise<ToolResult> }, content: string): Promise<ToolResult> {
  return tool.execute("t1", { content });
}

/** The store is never reached on any refusal path, so an empty stub is the honest fake here. */
const unusedStore = {} as unknown as TaskStore;

describe("fn_task_prompt_write refusal attribution (RUFU-651)", () => {
  it("a superseded planning generation is returned as a refusal, never as a store outage", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const tool = createTaskPromptWriteTool(
      unusedStore,
      "FN-1",
      undefined,
      () => false,
      (info) => refusals.push(info.reason),
    );

    const result = await call(tool as never, "# Task\n\nPlain plan body with no step headings.\n");

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("PLAN_PROMPT_WRITE_REFUSED");
    expect(result.details.refusal).toBe("planning-reset-fenced");
    expect(result.content[0].text).toContain("planning-reset-fenced");
    // The old shape told the model the board recorded nothing and to retry — for something a retry
    // can never change, because a newer planning generation owns the spec now.
    expect(result.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);
    expect(result.content[0].text).not.toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0].text).toContain("Do not retry");
    expect(refusals).toEqual(["planning-reset-fenced"]);
  });

  it("malformed step-dependency annotations are the writer's verdict, not an outage", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const tool = createTaskPromptWriteTool(unusedStore, "FN-1", undefined, undefined, (info) => refusals.push(info.reason));

    // Two `(depends:` annotations on one heading is the documented `malformed` coordinate.
    const result = await call(tool as never, "### Step 0 (depends: ): A (depends: ): B\n");

    expect(result.isError).toBe(true);
    expect(result.details.refusal).toBe("invalid-step-headings");
    expect(result.content[0].text).toContain("invalid-step-headings");
    expect(result.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);
    expect(refusals).toEqual(["invalid-step-headings"]);
  });

  it("a real store failure still reports the outage shape — refusals did not swallow outages", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const throwingStore = {
      updateTask: async () => {
        throw new Error("connection refused");
      },
    } as unknown as TaskStore;
    const tool = createTaskPromptWriteTool(throwingStore, "FN-1", undefined, undefined, (info) => refusals.push(info.reason));

    const result = await call(tool as never, "# Task\n\nBody.\n");

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("STORE_UNAVAILABLE");
    expect(result.content[0].text).toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0].text).not.toContain("PLAN_PROMPT_WRITE_REFUSED");
    expect(refusals).toEqual([]);
  });
});

describe("describeUnwrittenPlanArtifact attributes the stopped plan correctly", () => {
  const SENTENCE = "Planner did not update the authoritative PROMPT.md during attempt FN-1:3";

  it("keeps the historical sentence verbatim when the writer never refused", () => {
    expect(describeUnwrittenPlanArtifact("FN-1:3")).toBe(SENTENCE);
    expect(describeUnwrittenPlanArtifact("FN-1:3", [])).toBe(SENTENCE);
  });

  it("names the writer and counts each refusal once the writer refused", () => {
    const text = describeUnwrittenPlanArtifact("FN-1:3", ["planning-reset-fenced", "planning-reset-fenced", "invalid-step-headings"]);
    expect(text).toContain(SENTENCE);
    expect(text).toContain("planning-reset-fenced x2");
    expect(text).toContain("invalid-step-headings x1");
    expect(text).toContain("not a planner that produced no plan");
  });
});

/*
FNXC:PlanArtifactIntegrity 2026-11-13-02:36 (RUFU-693):
A plan with no executable step used to publish as an approved spec and then die at the graph's `parse`
node with `missing-implementation-steps`, which terminalized the card in the execution lane (measured on
RUFU-518 and RUFU-268: 0 `### Step` headings, 55 overseer retries in a day). The writer is the first place
that can see the defect cheaply, so it refuses here. Asserted through the real tool body with a narrow
store seam, because the honest question is what the planner receives and whether the row was touched --
not what a helper returns. The pass-cases matter as much as the refusal: a duplicate redirect, a declared
no-commits card, the fast lane, a workflow that does not require steps, and a real step plan must all
still write, or the guard becomes a new way to withhold a legitimate plan.
*/
describe("fn_task_prompt_write refuses a plan that carries no executable step (RUFU-693)", () => {
  const PROSE_PLAN = [
    "# Task: RUFU-518 - Cold-engine project scope must not borrow the launch project's onMerge",
    "## Original Description",
    "The wrong project's onMerge runs.",
    "## What to do",
    "Route the merge by the target project.",
    "## Surface Enumeration",
    "- packages/dashboard/src/routes/register-task-workflow-routes.ts",
  ].join("\n");

  const STEP_PLAN = [
    "# Task: RUFU-693 - A zero-step plan is refused at the writer",
    "## Steps",
    "### Step 0: Preflight",
    "- [ ] confirm the seam",
    "### Step 1: Refuse at the writer",
    "- [ ] add the guard",
  ].join("\n");

  function irWithParseNode(requireSteps: boolean) {
    return {
      nodes: [{
        id: "parse",
        kind: "parse-steps",
        column: "in-progress",
        config: requireSteps
          ? { artifact: "PROMPT.md", parser: "step-headings", requireStepsUnlessNoCommits: true }
          : { artifact: "PROMPT.md", parser: "step-headings" },
      }],
    };
  }

  type FakeStore = {
    writes: Array<Record<string, unknown>>;
    logRows: Array<{ action: string; dedupeKey: string }>;
    getTask: (id: string) => Promise<Record<string, unknown>>;
    updateTask: (id: string, patch: Record<string, unknown>) => Promise<{ id: string }>;
    getTaskWorkflowSelection: () => undefined;
    getWorkflowDefinition: (id: string) => Promise<{ ir: unknown }>;
    logEntryOnce: (id: string, input: { action: string; dedupeKey: string; windowMs: number }) => Promise<boolean>;
  };

  function makeStore(opts: {
    task?: Record<string, unknown>;
    requireSteps?: boolean;
    irThrows?: boolean;
    taskThrows?: boolean;
    customWorkflow?: boolean;
  } = {}): TaskStore & FakeStore {
    let rowPrompt: string | undefined;
    const store: FakeStore = {
      writes: [],
      logRows: [],
      getTask: async () => {
        if (opts.taskThrows) throw new Error("row unreadable");
        return { id: "t1", column: "todo", executionMode: "normal", ...(opts.task ?? {}) };
      },
      updateTask: async (_id, patch) => {
        store.writes.push(patch);
        rowPrompt = patch.prompt as string;
        return { id: "t1" };
      },
      // A builtin selection never reaches getWorkflowDefinition at all -- the resolver reads the
      // registered builtin IR -- so a custom IR is only exercisable through a custom workflow id.
      getTaskWorkflowSelection: () => (opts.customWorkflow ? { workflowId: "acme:review-only" } : undefined),
      getWorkflowDefinition: async () => {
        if (opts.irThrows) throw new Error("definition unreadable");
        return { ir: irWithParseNode(opts.requireSteps !== false) };
      },
      logEntryOnce: async (_id, input) => {
        // The real store dedupes inside the window; the fake must too, or the "one History row" case
        // would assert the fake's behaviour instead of the tool's.
        if (store.logRows.some((row) => row.dedupeKey === input.dedupeKey)) return false;
        store.logRows.push({ action: input.action, dedupeKey: input.dedupeKey });
        return true;
      },
    };
    // Read-back verification compares getTask().prompt with the submission, so the row answers with
    // whatever was written; a refusal never reaches that check because nothing is written.
    const inner = store.getTask;
    store.getTask = async (id: string) => ({ ...(await inner(id)), prompt: rowPrompt });
    return store as unknown as TaskStore & FakeStore;
  }

  function toolFor(store: TaskStore & FakeStore) {
    const refusals: string[] = [];
    const tool = createTaskPromptWriteTool(store, "t1", undefined, undefined, (info) => {
      refusals.push(info.reason);
    });
    return { tool, refusals };
  }

  it("refuses a stepless plan, writes nothing, and records one durable History row", async () => {
    const store = makeStore();
    const { tool, refusals } = toolFor(store);
    const result = await call(tool, PROSE_PLAN);
    expect(result.isError).toBe(true);
    expect(result.details.refusal).toBe("missing-implementation-steps");
    expect(store.writes).toEqual([]);
    expect(refusals).toEqual(["missing-implementation-steps"]);
    expect(store.logRows).toHaveLength(1);
    expect(store.logRows[0].dedupeKey).toContain("missing-implementation-steps");
    // The refusal is a refusal, never an outage, and never tells the planner to retry the same bytes.
    expect(result.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);
    expect(result.details.code).toBe("PLAN_PROMPT_WRITE_REFUSED");
  });

  it("carries the classifying counts without quoting the plan", async () => {
    const store = makeStore();
    const { tool } = toolFor(store);
    const result = await call(tool, PROSE_PLAN);
    expect(result.details.parsedStepCount).toBe(0);
    expect(typeof result.details.receivedBytes).toBe("number");
    // The guidance must name the missing shape, because a planner told only "refused" retries the
    // same stepless bytes.
    expect(result.content[0].text).toContain("### Step");
  });

  it("lets an explicit duplicate redirect through, because that marker owns its own path", async () => {
    const store = makeStore();
    const { tool } = toolFor(store);
    const result = await call(tool, "DUPLICATE: FN-1234");
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.writes).toHaveLength(1);
  });

  it("lets a declared no-commits plan through", async () => {
    const store = makeStore();
    const { tool } = toolFor(store);
    const result = await call(tool, `${PROSE_PLAN}\n\n**No commits expected:** true\n`);
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.writes).toHaveLength(1);
  });

  it("lets the fast lane through, which bypasses the plan-review seam that needs steps", async () => {
    const store = makeStore({ task: { executionMode: "fast" } });
    const { tool } = toolFor(store);
    const result = await call(tool, PROSE_PLAN);
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.writes).toHaveLength(1);
  });

  it("lets a workflow that does not require steps through", async () => {
    const store = makeStore({ requireSteps: false, customWorkflow: true });
    const { tool } = toolFor(store);
    const result = await call(tool, PROSE_PLAN);
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.writes).toHaveLength(1);
  });

  it("lets a real step plan through, which is the whole point", async () => {
    const store = makeStore();
    const { tool } = toolFor(store);
    const result = await call(tool, STEP_PLAN);
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.writes).toHaveLength(1);
  });

  it("writes one History row for two identical refusals", async () => {
    const store = makeStore();
    const { tool } = toolFor(store);
    await call(tool, PROSE_PLAN);
    await call(tool, PROSE_PLAN);
    expect(store.logRows).toHaveLength(1);
  });

  it("degrades inside the resolver when a custom definition cannot be read, and still classifies", async () => {
    /*
    Measured, and it corrects this card's own assumption: resolveWorkflowIrForTask swallows a failing
    getWorkflowDefinition and falls back to the default coding IR, so it never throws for that reason
    and this guard's own catch is defensive only. The honest assertion is therefore that after that
    degradation the answer is still a refusal and never an outage (the default IR requires steps),
    and that a step plan under the same unreadable definition still writes.
    */
    const store = makeStore({ irThrows: true, customWorkflow: true });
    const { tool } = toolFor(store);
    const refused = await call(tool, PROSE_PLAN);
    expect(refused.details.refusal).toBe("missing-implementation-steps");
    expect(refused.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);

    const otherStore = makeStore({ irThrows: true, customWorkflow: true });
    const { tool: stepTool } = toolFor(otherStore);
    const written = await call(stepTool, STEP_PLAN);
    expect(written.details.refusal).not.toBe("missing-implementation-steps");
    expect(otherStore.writes).toHaveLength(1);
  });

  it("fails OPEN when the task row cannot be read, so an unreadable exemption never refuses a plan", async () => {
    const store = makeStore({ taskThrows: true });
    const { tool } = toolFor(store);
    const result = await call(tool, PROSE_PLAN);
    expect(result.details.refusal).not.toBe("missing-implementation-steps");
    expect(store.logRows).toHaveLength(0);
  });
});
