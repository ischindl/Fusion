/**
 * RUFU-377 Step 3: an agent called `fn_agent_show` and received
 * `fn_agent_show failed: fn extension TaskStore boot timed out after 30000ms`.
 *
 * The Step-2 discriminator (`task-store-boot-concurrency.test.ts`) only proves which budget
 * expired when the caller goes to the store resolver directly. This file closes the two claims
 * that live one layer out, at the agent-class surface itself:
 *
 * 1. **The registered tool is the one that pays the budget.** `kbExtension` intercepts
 *    `pi.registerTool` and re-wraps every execute, so the deadline text can only reach an agent
 *    through `wrapExtensionToolExecute`. Asserting that on a hand-written wrapper would be a
 *    tautology, so the PostgreSQL-gated section below registers the real extension and drives the
 *    tools it actually registered — `fn_agent_show` / `fn_list_agents` / `fn_agent_org_chart`,
 *    representatives of the agent-class read family that share one `getAgentStore` → `getStore`
 *    resolution.
 * 2. **A tool-layer rejection keeps its attribution.** A cold-cache boot failure must surface
 *    *inside* the `${toolName} failed: ` prefix — the wrapper's job is to propagate the store-boot
 *    reason, not to relabel it as an agent-tool fault.
 *
 * Premise correction against the spec, re-verified on HEAD: `fn_agent_show` is NOT behind the
 * agent permission-policy gate — `applyAgentPolicyGateForExtensionTool` has 9 call sites on HEAD
 * (`fn_task_pause` / `fn_task_unpause` / `fn_task_retry` / `fn_agent_stop` / `fn_agent_start` /
 * `fn_agent_set_instructions` / `fn_workflow_update` / `fn_workflow_delete` / `fn_delegate_task`).
 * RUFU-275's `taskstore-boot-unavailable` deny cause therefore CANNOT be the shape this card saw;
 * only the tool-wrapper prefix `${toolName} failed: ` can, which is exactly the discriminator this
 * file pins.
 *
 * FNXC:TaskStoreBootDeadline 2026-09-28-05:20: No 30 000 ms of wall clock is burned here. The
 * deadline class is proven by arming the shared backoff through the registry seam with a tiny
 * budget and asserting the agent-class surface reads it at once, plus a fast-rejecting factory for
 * the propagated-failure shape. A hung factory a regressed tool actually awaited would park the
 * lane for the full real budget, so the registered-tool arm resolves its spy factory in 5 ms and
 * lets the zero-invocation counter carry the assertion.
 */
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import kbExtension, {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __resolveProjectRootForTesting,
  __setCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  closeCachedStores,
  wrapExtensionToolExecute,
} from "../extension.js";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
  type ToolResult,
} from "./pg-extension-harness.js";

const TOOL_CALL_CWD = "/home/schindler/git/Fusion";

/** A store stand-in; the registry layer never touches it, only hands it back. */
function makeFakeStore(): TaskStore {
  return { fake: "ready-store" } as unknown as TaskStore;
}

/** A boot promise that never settles on its own — only the budget can end the wait. */
function makeHungBootFactory() {
  const calls: Array<{ projectRoot: string }> = [];
  let release: () => void = () => {};
  const landed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = vi.fn(async (opts: { rootDir: string }) => {
    calls.push({ projectRoot: opts.rootDir });
    await landed;
    return { taskStore: makeFakeStore(), shutdown: async () => {} };
  });
  return {
    factory,
    calls,
    /** Number of times the factory has been entered, after its microtask flushes. */
    settled: () => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => calls.length),
    release: () => release(),
  };
}

/** An agent tool body that resolves the store exactly like fn_agent_show does. */
function agentReadToolWithBudget(bootBudgetMs: number) {
  return wrapExtensionToolExecute("fn_agent_show", async () => {
    const store = await __getStoreForTesting(TOOL_CALL_CWD, bootBudgetMs);
    return { content: [{ type: "text" as const, text: `agents for ${(store as unknown as { fake: string }).fake}` }] };
  });
}

afterEach(async () => {
  // The shared registry is process-global: never leak a fake factory, cooldown, or cache entry.
  // The cache must go too — a ready entry left by one test short-circuits the next test's cold
  // boot before its budget is ever reached, which reads as "the budget never fires".
  await closeCachedStores();
  __setExtensionStoreBootFactoryForTesting(undefined);
  __clearExtensionStoreBootStateForTesting();
  vi.useRealTimers();
});

describe("extension agent-class boot budget (RUFU-377)", () => {
  it("a ready cached store short-circuits before the budget wrapper is ever constructed", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);
    const root = __resolveProjectRootForTesting(TOOL_CALL_CWD);
    const ready = makeFakeStore();
    __setCachedStoreForTesting(root, ready);

    await expect(__getStoreForTesting(TOOL_CALL_CWD, 30_000)).resolves.toBe(ready);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(hung.calls).toHaveLength(0);
    expect(hung.factory).not.toHaveBeenCalled();
  });

  it("a cold agent-class call surfaces the deadline class INSIDE the tool-wrapper prefix", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    const pending = agentReadToolWithBudget(25)("call-1", { id: "agent-48a5da4e" }) as Promise<ToolResult>;
    await vi.advanceTimersByTimeAsync(26);
    const result = await pending;

    // The shape RUFU-377 actually saw: wrapper prefix + store-boot subject + bare deadline.
    expect(result.content[0]?.text ?? "").toMatch(
      /^fn_agent_show failed: fn extension TaskStore boot timed out after \d+ms$/,
    );
    expect(result.isError).toBe(true);
    expect(hung.calls).toHaveLength(1);
  });

  it("a tool-layer boot rejection after the deadline reads the cooldown class, not a bare timeout", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    // Step 2 proved the registry arms the backoff on a reported deadline; here the agent-class
    // surface must READ that backoff instead of re-paying the budget.
    const abandoning = __getStoreForTesting(TOOL_CALL_CWD, 25).catch((error) => error);
    await vi.advanceTimersByTimeAsync(26);
    await expect(abandoning).resolves.toBeInstanceOf(Error);

    const startedAt = Date.now();
    const result = (await agentReadToolWithBudget(30_000)("call-2", { id: "agent-48a5da4e" })) as ToolResult;
    const text = result.content[0]?.text ?? "";

    // An abandoned-but-live boot must not make the agent class pay 30 s a second time.
    expect(Date.now() - startedAt).toBeLessThan(25);
    expect(text).toContain("fn extension TaskStore boot recently failed");
    expect(text).not.toMatch(/timed out after \d+ms$/);
    expect(hung.calls).toHaveLength(1);
  });

  it("a boot that lands late serves the next agent-class call from the cache", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    const abandoning = __getStoreForTesting(TOOL_CALL_CWD, 25).catch((error) => error);
    await vi.advanceTimersByTimeAsync(26);
    await abandoning;

    hung.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => {
      await expect(__getStoreForTesting(TOOL_CALL_CWD, 25)).resolves.toBeTruthy();
    });

    // Cache-before-cooldown: the late landing outranks the backoff the deadline armed.
    const result = (await agentReadToolWithBudget(30_000)("call-3", { id: "agent-48a5da4e" })) as ToolResult;
    expect(result.content[0]?.text).toBe("agents for ready-store");
  });
});

/*
FNXC:TaskStoreBootDeadline 2026-09-28-05:20:
Registered-tool arm (PostgreSQL-gated; the pgDescribe skip contract applies when the test server is
unreachable). The synthetic wrapper above proves the shape but not the wiring. This section proves
the wiring: it hands the real `kbExtension` a mock registration API, pulls the tools it registered,
and drives `execute()` — so a future agent-class surface that resolved its own store instead of the
shared seam cannot pass it. A ready store that reached the deadline wrapper would register factory
invocations, so the counter is the assertion; the spy resolves in 5 ms so a regression fails fast
instead of parking the lane for the real 30 s budget.
*/
const pgHarness = createPgExtensionHarness("rufu377-agentclass");

pgDescribe("registered agent-class tools share the one boot seam (RUFU-377)", () => {
  beforeAll(pgHarness.beforeAll);
  beforeEach(pgHarness.beforeEach);
  afterEach(pgHarness.afterEach);
  afterAll(pgHarness.afterAll);

  /** Register the real extension and hand back the tools it wrapped at registration time. */
  function registerAgentClassTools() {
    const api = createMockApi();
    registerExtension(api);
    return {
      ctx: { cwd: pgHarness.rootDir() },
      show: requireTool(api, "fn_agent_show"),
      list: requireTool(api, "fn_list_agents"),
      orgChart: requireTool(api, "fn_agent_org_chart"),
    };
  }

  it("fn_list_agents and fn_agent_org_chart read off the ready store with zero boot-factory invocations", async () => {
    const bootFactory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { taskStore: makeFakeStore(), shutdown: async () => {} };
    });
    __setExtensionStoreBootFactoryForTesting(bootFactory as never);
    const { ctx, list, orgChart } = registerAgentClassTools();

    const listed = (await list.execute("call-1", {}, undefined, undefined, ctx)) as ToolResult;
    const org = (await orgChart.execute("call-2", {}, undefined, undefined, ctx)) as ToolResult;

    // Ready store: both reads answer and nothing was booted — this surface provably never pays
    // the boot budget while a live store already exists in the process.
    expect(listed.isError, `fn_list_agents: ${listed.content[0]?.text}`).toBeFalsy();
    expect(org.isError, `fn_agent_org_chart: ${org.content[0]?.text}`).toBeFalsy();
    expect(((listed.details as { count?: number })?.count ?? 0), "harness provisions the durable built-in agents").toBeGreaterThan(0);
    expect(bootFactory).not.toHaveBeenCalled();
  });

  it("fn_agent_show serves a real agent off the ready store with zero boot-factory invocations", async () => {
    const bootFactory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { taskStore: makeFakeStore(), shutdown: async () => {} };
    });
    __setExtensionStoreBootFactoryForTesting(bootFactory as never);
    const { ctx, show, list } = registerAgentClassTools();

    const listed = (await list.execute("probe", {}, undefined, undefined, ctx)) as ToolResult;
    const agents = (listed.details as { agents?: Array<{ id: string }> })?.agents ?? [];
    expect(agents.length).toBeGreaterThan(0);

    const result = (await show.execute("call-1", { id: agents[0].id }, undefined, undefined, ctx)) as ToolResult;

    expect(result.isError, `fn_agent_show: ${result.content[0]?.text}`).toBeFalsy();
    expect(result.content[0]?.text).toContain(`ID: ${agents[0].id}`);
    expect(bootFactory).not.toHaveBeenCalled();
  });

  it("a cold-cache boot failure keeps its store attribution inside the fn_agent_show prefix", async () => {
    // The boot fails fast with the host-side cause a real stall produces, so the propagated tool
    // shape is proven without burning the 30 000 ms it would take to measure live.
    const rejecting = vi.fn(async () => {
      throw new Error("connection timed out after 20242ms (canceling statement due to lock timeout)");
    });
    __setExtensionStoreBootFactoryForTesting(rejecting as never);
    const { ctx, show } = registerAgentClassTools();

    // Force the cold path: drop the harness-injected (externally-owned) store so the resolver
    // must boot. closeCachedStores skips external entries, so the harness store itself survives.
    await closeCachedStores();

    const startedAt = Date.now();
    const result = (await show.execute("call-1", { id: "agent-48a5da4e" }, undefined, undefined, ctx)) as ToolResult;
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    // Attribution survives the wrapper: tool prefix + real store-boot cause, not a bare tool fault.
    expect(text).toMatch(/^fn_agent_show failed: /);
    expect(text).toContain("canceling statement due to lock timeout");
    expect(rejecting).toHaveBeenCalledTimes(1);

    // And the next agent call reads the backoff instead of re-paying: same reason, distinct shape.
    const second = (await show.execute("call-2", { id: "agent-48a5da4e" }, undefined, undefined, ctx)) as ToolResult;
    expect(second.content[0]?.text).toContain("fn extension TaskStore boot recently failed");
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
