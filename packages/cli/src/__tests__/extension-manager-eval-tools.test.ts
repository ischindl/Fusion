import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { AgentStore, ReflectionStore } from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness";

/*
FNXC:AgentEvaluations 2026-08-12-22:30:
Manager evaluation tools must prove their permission invariant through the PostgreSQL-backed
extension path: managers may read and coach direct or indirect reports, while self, ancestors,
and unrelated agents receive neither evaluation content nor a write.
*/
const h = createPgExtensionHarness("extension-manager-eval-tools");

async function withOrg(
  run: (context: {
    cwd: string;
    agentStore: AgentStore;
    reflectionStore: ReflectionStore;
    readTool: any;
    followupTool: any;
    ids: { manager: string; middle: string; leaf: string; peer: string };
  }) => Promise<void>,
): Promise<void> {
  const cwd = h.rootDir();
  const agentStore = new AgentStore({
    rootDir: join(cwd, ".fusion"),
    asyncLayer: h.store().getAsyncLayer()!,
  });
  const reflectionStore = new ReflectionStore({ rootDir: join(cwd, ".fusion") });
  try {
    await agentStore.init();
    await reflectionStore.init();
    const manager = await agentStore.createAgent({ name: "manager", role: "engineer", metadata: {} });
    const middle = await agentStore.createAgent({ name: "middle-manager", role: "engineer", reportsTo: manager.id, metadata: {} });
    const leaf = await agentStore.createAgent({ name: "leaf-agent", role: "executor", reportsTo: middle.id, metadata: {} });
    const peer = await agentStore.createAgent({ name: "peer-agent", role: "executor", metadata: {} });
    const api = createMockApi();
    registerExtension(api);
    await run({
      cwd,
      agentStore,
      reflectionStore,
      readTool: requireTool(api, "fn_agent_read_evaluations"),
      followupTool: requireTool(api, "fn_agent_evaluation_followup"),
      ids: { manager: manager.id, middle: middle.id, leaf: leaf.id, peer: peer.id },
    });
  } finally {
    agentStore.close();
  }
}

const execute = (tool: any, params: Record<string, unknown>, ctx: Record<string, unknown>) =>
  tool.execute("manager-eval-call", params, undefined, undefined, ctx);

pgDescribe("manager evaluation tools", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("registers manager evaluation schemas", async () => {
    await withOrg(async ({ readTool, followupTool }) => {
      expect(readTool.parameters).toMatchObject({ type: "object", required: ["agent_id"] });
      expect(followupTool.parameters).toMatchObject({ type: "object", required: ["agent_id", "score", "comment"] });
    });
  });

  it("allows a manager to read direct-report ratings and reflections", async () => {
    await withOrg(async ({ cwd, agentStore, reflectionStore, readTool, ids }) => {
      await agentStore.addRating(ids.middle, { raterType: "user", score: 4, comment: "solid triage" });
      await reflectionStore.createReflection({
        agentId: ids.middle,
        trigger: "manual",
        metrics: {},
        insights: ["Keeps planning focused"],
        suggestedImprovements: ["Continue concise plans"],
        summary: "Strong planning reflection",
      });
      const result = await execute(readTool, { agent_id: ids.middle }, { cwd, agentId: ids.manager });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "read", agentId: ids.middle, summary: { averageScore: 4 } });
      expect(result.content[0].text).toContain("solid triage");
      expect(result.content[0].text).toContain("Strong planning reflection");
    });
  });

  it("allows a manager to read an indirect report", async () => {
    await withOrg(async ({ cwd, readTool, ids }) => {
      const result = await execute(readTool, { agent_id: ids.leaf }, { cwd, agentId: ids.manager });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "empty", agentId: ids.leaf });
    });
  });

  it("denies unrelated, self, and ancestor reads without leaking report data", async () => {
    await withOrg(async ({ cwd, agentStore, readTool, ids }) => {
      await agentStore.addRating(ids.peer, { raterType: "user", score: 1, comment: "PRIVATE PEER FEEDBACK" });
      const peerResult = await execute(readTool, { agent_id: ids.peer }, { cwd, agentId: ids.manager });
      expect(peerResult.isError).toBe(true);
      expect(peerResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      expect(JSON.stringify(peerResult)).not.toContain("PRIVATE PEER FEEDBACK");
      const selfResult = await execute(readTool, { agent_id: ids.manager }, { cwd, agentId: ids.manager });
      const ancestorResult = await execute(readTool, { agent_id: ids.manager }, { cwd, agentId: ids.leaf });
      expect(selfResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      expect(ancestorResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
    });
  });

  it("allows privileged operators to read any durable agent", async () => {
    await withOrg(async ({ cwd, agentStore, readTool, ids }) => {
      await agentStore.addRating(ids.peer, { raterType: "user", score: 5, comment: "operator visible" });
      const result = await execute(readTool, { agent_id: ids.peer }, { cwd });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "read", agentId: ids.peer });
    });
  });

  it("records subtree follow-ups and rejects out-of-subtree writes", async () => {
    await withOrg(async ({ cwd, agentStore, followupTool, ids }) => {
      const recorded = await execute(followupTool, {
        agent_id: ids.leaf,
        score: 2,
        comment: "needs tighter test scoping",
        category: "testing",
      }, { cwd, agentId: ids.manager });
      expect(recorded.details).toMatchObject({ outcome: "recorded", agentId: ids.leaf, score: 2, raterType: "agent" });
      await expect(agentStore.getRatings(ids.leaf)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ raterType: "agent", raterId: ids.manager, score: 2, comment: "needs tighter test scoping" }),
      ]));

      const peerBefore = await agentStore.getRatings(ids.peer);
      const denied = await execute(followupTool, { agent_id: ids.peer, score: 3, comment: "unauthorized" }, { cwd, agentId: ids.manager });
      expect(denied.isError).toBe(true);
      expect(denied.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      await expect(agentStore.getRatings(ids.peer)).resolves.toHaveLength(peerBefore.length);
    });
  });

  it("validates follow-up scores and comments before writing", async () => {
    await withOrg(async ({ cwd, agentStore, followupTool, ids }) => {
      for (const params of [
        { agent_id: ids.leaf, score: 0, comment: "invalid score" },
        { agent_id: ids.leaf, score: 6, comment: "invalid score" },
        { agent_id: ids.leaf, score: 3, comment: "   " },
      ]) {
        const result = await execute(followupTool, params, { cwd, agentId: ids.manager });
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({ outcome: "invalid", field: params.comment.trim() ? "score" : "comment" });
      }
      await expect(agentStore.getRatings(ids.leaf)).resolves.toHaveLength(0);
    });
  });

  /*
  FNXC:AgentEvaluations 2026-11-11-07:18 (RUFU-543):
  The 2026-10-03 incident lost a manager's coaching record and reported only a wall of SQL. Two
  independent defects are pinned separately below: an exact-id caller paying for the whole-roster
  `project.agents` listing, and the handler discarding Drizzle's `cause`.
  */

  it("records a follow-up for an exact agent id without issuing the full agents listing", async () => {
    await withOrg(async ({ cwd, agentStore, followupTool, ids }) => {
      /*
      A PASS-THROUGH spy, deliberately not a mock-throwing one. Both evaluation handlers begin with
      `await agentStore.init()`, and AgentStore.init() provisions the built-in workflow-role and
      memory owners, each issuing listAgents({ includeEphemeral: true }). A throwing spy would kill
      the tool before the target is ever resolved, and a bare "zero listAgents calls" assertion would
      then fail for the wrong reason. Discriminating on the ARGUMENT is exact, because the resolver's
      whole-roster read is precisely the zero-argument listAgents() call.
      */
      const listSpy = vi.spyOn(AgentStore.prototype, "listAgents");
      const windowStart = listSpy.mock.calls.length;

      try {
        const recorded = await execute(followupTool, {
          agent_id: ids.leaf,
          score: 2,
          comment: "needs tighter test scoping",
          category: "report-verifiability",
        }, { cwd, agentId: ids.manager });

        expect(recorded.details).toMatchObject({ outcome: "recorded", agentId: ids.leaf, score: 2 });
        await expect(agentStore.getRatings(ids.leaf)).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ raterType: "agent", raterId: ids.manager, score: 2, comment: "needs tighter test scoping" }),
        ]));

        const inWindow = listSpy.mock.calls.slice(windowStart);
        const unfiltered = inWindow.filter((call) => call[0] === undefined);
        expect(unfiltered).toHaveLength(0);
        // Every listing left in the window is init()'s provisioning shape; none is the resolver's
        // `ORDER BY created_at DESC, id DESC` whole-roster read.
        for (const call of inWindow) {
          expect(call[0]).toMatchObject({ includeEphemeral: true });
        }
      } finally {
        listSpy.mockRestore();
      }
    });
  });

  it("names the underlying database cause instead of a bare Failed query string", async () => {
    // The verbatim failing statement shape from the 2026-10-03 incident.
    const statement = 'select "id", "name", "role", "roles", "state", "task_id", "created_at", "updated_at",'
      + ' "last_heartbeat_at", "metadata", "data" from "project"."agents"'
      + ' where "project"."agents"."project_id" = $1'
      + ' order by "project"."agents"."created_at" desc, "project"."agents"."id" desc';

    /*
    A shape-compatible stand-in for DrizzleQueryError: message = the SQL shell, cause = the real
    Postgres error. drizzle-orm is not a dependency of @runfusion/fusion (the CLI reaches the driver
    only through @fusion/core), so importing the real class here would add a package-graph edge to a
    published manifest for one assertion; the chain walker only walks `.message` and `.cause`.
    */
    const drizzleShell = () => {
      const shell = new Error(`Failed query: ${statement} params: proj_test`);
      (shell as Error & { cause?: unknown }).cause = new Error("canceling statement due to statement timeout");
      return shell;
    };

    await withOrg(async ({ cwd, followupTool, readTool, ids }) => {
      // getChainOfCommand is the first store call the authorized path makes, and it sits inside the
      // guarded body (resolveManagerEvaluationTarget), not in the policy gate that runs before it.
      const chainSpy = vi.spyOn(AgentStore.prototype, "getChainOfCommand").mockRejectedValueOnce(drizzleShell());
      try {
        const result = await execute(followupTool, {
          agent_id: ids.leaf,
          score: 2,
          comment: "coaching note that must not be lost silently",
        }, { cwd, agentId: ids.manager });

        expect(result.isError).toBe(true);
        const text = result.content[0]!.text;
        expect(text).toContain("canceling statement due to statement timeout");
        expect(text.startsWith("Failed query:")).toBe(false);
        expect(text).toContain("while running:");
        // The named cause is the HEADLINE, not an appended detail: it must precede the SQL shell.
        expect(text.indexOf("canceling statement due to statement timeout"))
          .toBeLessThan(text.indexOf("Failed query:"));
        expect(result.details).toMatchObject({
          outcome: "error",
          agentId: ids.leaf,
          error: expect.stringContaining("canceling statement due to statement timeout"),
        });
      } finally {
        chainSpy.mockRestore();
      }

      // The read surface is guarded the same way; a failure there must not read as a bare shell either.
      const ratingsSpy = vi.spyOn(AgentStore.prototype, "getRatingSummary").mockRejectedValueOnce(drizzleShell());
      try {
        const readResult = await execute(readTool, { agent_id: ids.leaf }, { cwd, agentId: ids.manager });
        expect(readResult.isError).toBe(true);
        expect(readResult.content[0]!.text).toContain("canceling statement due to statement timeout");
        expect(readResult.content[0]!.text.startsWith("Failed query:")).toBe(false);
        expect(readResult.details).toMatchObject({ outcome: "error", agentId: ids.leaf });
      } finally {
        ratingsSpy.mockRestore();
      }
    });
  });
});
