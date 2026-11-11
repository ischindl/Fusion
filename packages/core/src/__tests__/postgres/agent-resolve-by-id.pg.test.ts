/**
 * FNXC:AgentIdentityResolution 2026-11-11-07:18 (RUFU-543):
 * PostgreSQL-backed proof that an exact agent-id lookup never pays for a full
 * `project.agents` listing.
 *
 * The incident: `fn_agent_evaluation_followup(agent_id=agent-3ac88b82, ...)` failed on
 * 2026-10-03 with a bare `Failed query: select ... from "project"."agents" where
 * "project"."agents"."project_id" = $1 order by "project"."agents"."created_at" desc,
 * "project"."agents"."id" desc / params: proj_9326d74a133b421a` and no underlying
 * database cause, while `fn_agent_show` on the SAME agent succeeded in the same session.
 * Replaying that verbatim statement (verbatim column list, verbatim project-scope
 * predicate, verbatim ORDER BY, verbatim param) against a fresh partition SUCCEEDS and
 * returns exactly the scoped rows, which disproves ordering / params / typing / join /
 * project-scope as the defect. What was statically attributable is that a caller who
 * already held an exact id was routed through the whole-roster listing at all — and that
 * half is pinned here.
 *
 * Auto-skipped via pgDescribe when PostgreSQL is unreachable.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as postgresSchema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore, AmbiguousAgentNameError } from "../../agents/agent-store.js";

const pgTest = pgDescribe;

pgTest("AgentStore.resolveAgent resolves an exact id without a full agents listing (PostgreSQL)", () => {
  /*
  FNXC:WorkflowAgentRouting 2026-08-07-18:40: bind a real projectId so FN-8764 built-in
  workflow-owner provisioning in AgentStore.init() has a partition and agent config-revision
  writes (GUC-default project_id) share it with the explicit agent writes.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_resolve_by_id",
    projectId: "proj_resolve_by_id",
  });

  let agentStore: AgentStore;

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    /*
    FNXC:AgentIdentityResolution 2026-11-11-07:18 (RUFU-543):
    init() runs BEFORE any listing is measured, deliberately. init() legitimately provisions the
    built-in workflow-role and memory owners, and each provisioning pass issues
    listAgents({ includeEphemeral: true }) (agent-store.ts:2311 / :2431). A spy installed before
    init() — let alone a mock-throwing one — would therefore fail in setup rather than measure the
    resolver, which is exactly the trap this file's assertion must avoid.
    */
    await agentStore.init();
  });

  afterEach(async () => {
    try {
      await agentStore.close();
    } catch {
      // best-effort
    }
    await h.afterEach();
  });

  afterAll(h.afterAll);

  it("resolves an exact agent id issuing ZERO listAgents calls inside the window", async () => {
    const target = await agentStore.createAgent({ name: "Id First Target", role: "executor" });

    // Pass-through spies: they record the calls they do not change.
    const listSpy = vi.spyOn(AgentStore.prototype, "listAgents");
    const getSpy = vi.spyOn(AgentStore.prototype, "getAgent");
    const windowStart = listSpy.mock.calls.length;

    try {
      const resolved = await agentStore.resolveAgent(target.id);

      expect(resolved?.id).toBe(target.id);
      // The whole-roster listing (`ORDER BY created_at DESC, id DESC`) must not run at all on an
      // exact-id hit — a direct resolveAgent() call contains no init(), so zero is the honest bound.
      expect(listSpy.mock.calls.length - windowStart).toBe(0);
      // The read that replaced it is the indexed single-row by-id shape fn_agent_show already used.
      expect(getSpy.mock.calls.map((call) => call[0])).toContain(target.id);
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it("still resolves a unique normalized name through the listing fallback", async () => {
    const unique = await agentStore.createAgent({ name: "Listing Fallback Target", role: "reviewer" });

    const listSpy = vi.spyOn(AgentStore.prototype, "listAgents");
    const windowStart = listSpy.mock.calls.length;

    try {
      const resolved = await agentStore.resolveAgent("listing_fallback_target");

      expect(resolved?.id).toBe(unique.id);
      // Only an ID miss may enumerate, so the fallback must be the listing — the fast path did
      // not swallow name resolution.
      expect(listSpy.mock.calls.length - windowStart).toBeGreaterThan(0);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("rejects an ambiguous normalized name instead of guessing a durable agent", async () => {
    const first = await agentStore.createAgent({ name: "Resolve Ambiguous First", role: "executor" });
    const second = await agentStore.createAgent({ name: "Resolve Ambiguous Second", role: "executor" });

    // Durable-name creation is guarded, so seed the legacy duplicate identity exactly as
    // production reads it (same shape agent-instructions.pg.test.ts uses).
    for (const id of [first.id, second.id]) {
      await h.layer().db
        .update(postgresSchema.project.agents)
        .set({ name: "Resolve Ambiguous Durable Name" })
        .where(and(
          eq(postgresSchema.project.agents.projectId, "proj_resolve_by_id"),
          eq(postgresSchema.project.agents.id, id),
        ));
    }

    await expect(agentStore.resolveAgent("Resolve Ambiguous Durable Name")).rejects.toEqual(
      expect.objectContaining({
        name: "AmbiguousAgentNameError",
        code: "AMBIGUOUS_AGENT_NAME",
        candidateAgentIds: [first.id, second.id].sort(),
      } satisfies Partial<AmbiguousAgentNameError>),
    );
  });

  it("resolves an ephemeral agent by exact id while the default listing still hides it", async () => {
    const ephemeral = await agentStore.createAgent({
      name: "Resolve Ephemeral Target",
      roles: ["executor"],
      metadata: { type: "spawned" },
    });

    /*
    FNXC:AgentIdentityResolution 2026-11-11-07:18 (RUFU-543):
    RUFU-543's spec asked the fast path to re-apply `isEphemeralAgent` so an ephemeral exact id
    resolved to null, because the pre-existing resolver reached the row only through
    `listAgents()`, whose default filter excludes ephemerals. Commit 88505e524a ("fix(agents):
    resolve exact agent IDs before display names", PR #3678) landed that requirement in a
    different shape: exact-id resolution is IDENTITY-authoritative and returns the row, and
    durability is a per-surface decision made with `isEphemeralAgent` (the evaluation surface
    does it in resolveManagerEvaluationTarget, extension.ts:1088). This test pins that shipped
    contract together with the half the spec cared about — the default listing still hides the
    ephemeral row — so the two statements stay true in one place instead of silently diverging.
    */
    const listSpy = vi.spyOn(AgentStore.prototype, "listAgents");
    const windowStart = listSpy.mock.calls.length;

    try {
      await expect(agentStore.resolveAgent(ephemeral.id)).resolves.toMatchObject({ id: ephemeral.id });
      expect(listSpy.mock.calls.length - windowStart).toBe(0);
    } finally {
      listSpy.mockRestore();
    }

    const durableListing = await agentStore.listAgents();
    expect(durableListing.map((agent) => agent.id)).not.toContain(ephemeral.id);
  });

  it("returns null for a blank query and for an unknown id-or-name", async () => {
    await expect(agentStore.resolveAgent("   ")).resolves.toBeNull();
    await expect(agentStore.resolveAgent("agent-does-not-exist")).resolves.toBeNull();
  });
});
