/*
FNXC:OAuthAlarmEvidence 2026-11-08-00:26 (RUFU-498):
Route contract for `laneReferenced` on /api/auth/status. The re-login banner may only treat an
expired OAuth credential as board-wide evidence of work-at-risk when some resolvable model lane
on the HOST references its provider — the reference may live in another project's settings, a
task lane field, or a durable agent's runtime model, so the truth must be computed by a host
fan-out, not per project. The anthropic <-> anthropic-subscription alias closure must hold at
this surface too, and every scan failure (per-project read, registry absence, timeout) must fail
OPEN to laneReferenced=true: a broken scan may preserve the old always-visible behavior but may
never suppress a live alarm. Bounded staleness is asserted, not incidental: one fan-out per TTL
window, shared by concurrent polls. A second provider id (`openai-codex`) carries the generic
invariants so no test ever pins the anthropic-specific pair alone.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerAuthRoutes } from "../routes/register-auth-routes.js";

interface FakeStoreOptions {
  settings?: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  /** Persisted per-(workflow, project) lane VALUES (`workflow_settings` rows), the shape
   *  `store.listWorkflowSettingValuesForProject()` returns. */
  workflowSettingValues?: Record<string, Record<string, unknown>>;
  globalSettings?: Record<string, unknown>;
  failTasks?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}) {
  return {
    getSettings: vi.fn(async () => options.settings ?? {}),
    listTasks: vi.fn(async () => {
      if (options.failTasks) throw new Error("project store unreachable");
      return options.tasks ?? [];
    }),
    listWorkflowDefinitions: vi.fn(async () => options.workflows ?? []),
    listWorkflowSettingValuesForProject: vi.fn(async () => options.workflowSettingValues ?? {}),
    getIntakeOwnerAgentStore: () => ({ listAgents: vi.fn(async () => options.agents ?? []) }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn(async () => options.globalSettings ?? {}) }),
  };
}

const EXPIRED = () => Date.now() - 60_000;

function setup(config: {
  launch?: FakeStoreOptions;
  projects?: Record<string, FakeStoreOptions>;
  registryFails?: boolean;
  authStorageOverrides?: Record<string, unknown>;
} = {}) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const deleteHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn(), put: vi.fn(),
    delete: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      deleteHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const launch = fakeStore(config.launch);
  const projectStores = Object.fromEntries(
    Object.entries(config.projects ?? {}).map(([id, opts]) => [id, fakeStore(opts)]),
  );

  const authStorage = {
    reload: vi.fn(),
    // Empty catalog contributions: the static catalog already enumerates
    // openai-codex / anthropic-subscription as oauth and openai as api_key.
    getOAuthProviders: vi.fn(() => []),
    getApiKeyProviders: vi.fn(() => []),
    hasAuth: vi.fn((id: string) => id === "openai-codex" || id === "anthropic-subscription"),
    hasApiKey: vi.fn(() => false),
    get: vi.fn((id: string) => (id === "openai-codex" || id === "anthropic-subscription")
      ? { type: "oauth", expires: EXPIRED() }
      : undefined),
    getApiKey: vi.fn(async () => undefined),
    ...config.authStorageOverrides,
  };

  const centralCore = config.registryFails
    ? {
        isInitialized: () => false,
        init: async () => { throw new Error("central registry unavailable"); },
        listProjects: async () => { throw new Error("central registry unavailable"); },
      }
    : { listProjects: async () => Object.keys(projectStores).map((id) => ({ id })) };

  registerAuthRoutes({
    router,
    store: launch,
    options: {
      authStorage,
      centralCore,
      // Every registered id resolves through the fake engine so the scan never
      // reaches the real getOrCreateProjectStore bootstrap.
      engineManager: {
        getEngine: (id: string) => projectStores[id] ? { getTaskStore: () => projectStores[id] } : undefined,
      },
    },
    getScopedStore: vi.fn(),
    rethrowAsApiError: (err: unknown) => { throw err; },
  } as never);

  const handler = getHandlers.get("/auth/status")!;
  const deleteHandler = deleteHandlers.get("/auth/providers/:provider/instances/:instance")!;

  async function callStatus() {
    const json = vi.fn();
    await handler({ headers: {} }, { json });
    return json.mock.calls[0][0] as {
      providers: Array<{
        id: string;
        type?: string;
        expired?: boolean;
        laneReferenced?: boolean;
      }>;
    };
  }

  return { callStatus, callDelete: (req: unknown, res: { json: (body: unknown) => void }) => deleteHandler(req, res), launch, projectStores };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RUFU-498: /auth/status laneReferenced gate", () => {
  it("keeps an expired provider alarming when a DIFFERENT project's settings lane references it", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { settings: { executionProvider: "openai-codex" } } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")).toMatchObject({ expired: true, laneReferenced: true });
  });

  it("keeps an expired provider alarming when a task lane field references it (typed field only)", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { tasks: [{ modelProvider: "openai-codex", description: "unrelated" }] } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);
  });

  it("keeps an expired provider alarming when only a durable agent's legacy model string references it", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { agents: [{ runtimeConfig: { model: "openai-codex/gpt-5-codex" } }] } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);
  });

  it("counts global settings and the launch store tier too (launch project need not be registered)", async () => {
    const { callStatus } = setup({
      launch: { globalSettings: { planningProvider: "openai-codex" } },
      projects: {},
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);

    const launchTier = setup({ launch: { settings: { mergerProvider: "openai-codex" } }, projects: {} });
    expect((await launchTier.callStatus()).providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);
  });

  it("resolves the anthropic alias closure at the route surface (anthropic lane references the subscription credential)", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { tasks: [{ modelProvider: "anthropic" }] } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "anthropic-subscription")).toMatchObject({ expired: true, laneReferenced: true });
  });

  it("suppresses an expired provider referenced by NO lane host-wide, and never decorates non-oauth entries", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: {}, p2: { settings: { executionProvider: "some-other-provider" } } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")).toMatchObject({ expired: true, laneReferenced: false });
    for (const provider of body.providers) {
      if (provider.type && provider.type !== "oauth") {
        expect("laneReferenced" in provider).toBe(false);
      }
    }
  });

  it("fails open to laneReferenced=true when any per-project read fails", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { settings: { executionProvider: "openai-codex" } }, p2: { failTasks: true } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);
  });

  it("fails open when the central registry itself is unavailable", async () => {
    const { callStatus } = setup({ launch: {}, projects: {}, registryFails: true });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")?.laneReferenced).toBe(true);
    expect(body.providers.find((p) => p.id === "anthropic-subscription")?.laneReferenced).toBe(true);
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-09-13:12 (RUFU-498):
  Symptom Verification's control contract, asserted at the surface that computes the gate: the
  banner's absence must be explainable ONLY by "no lane references this provider", so EVERY
  tier that can resolve a model has to restore the alarm on its own. A suppressed-without-any-
  tier fixture case sits beside them as the negative control, and `openai-codex` (not just the
  anthropic pair) is the subject id so the invariant is never pinned to one provider.
  */
  it("restores laneReferenced=true from every resolvable lane tier on its own", async () => {
    const SUBJECT = "openai-codex";
    // `globalTier` fixtures sit on the launch store's GLOBAL settings store, which is the one
    // place the scan reads host-level defaults from (globals are not per-project reads).
    const tiers: Array<{ name: string; globalTier?: Record<string, unknown>; projectTier?: FakeStoreOptions }> = [
      { name: "task modelProvider", projectTier: { tasks: [{ modelProvider: SUBJECT }] } },
      { name: "task validatorModelProvider", projectTier: { tasks: [{ validatorModelProvider: SUBJECT }] } },
      { name: "task planningModelProvider", projectTier: { tasks: [{ planningModelProvider: SUBJECT }] } },
      { name: "task mergerModelProvider", projectTier: { tasks: [{ mergerModelProvider: SUBJECT }] } },
      { name: "project defaultProvider", projectTier: { settings: { defaultProvider: SUBJECT } } },
      { name: "project executionProvider", projectTier: { settings: { executionProvider: SUBJECT } } },
      { name: "project planningProvider", projectTier: { settings: { planningProvider: SUBJECT } } },
      /*
      FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
      The `selected workflow` tier of model resolution is the PERSISTED per-(workflow, project)
      lane value, not a project setting and not the workflow IR: a project whose Executor lane
      alone pointed at the expired provider had to keep alarming. This is the tier the scan
      missed, and it is reached through `store.listWorkflowSettingValuesForProject()`.
      */
      { name: "stored workflow lane value (workflow_settings row)", projectTier: { workflowSettingValues: { "builtin:coding": { executionProvider: SUBJECT, executionModelId: "gpt-5" } } } },
      {
        name: "stored workflow lane value of a non-selected workflow",
        projectTier: { workflowSettingValues: { "wf-custom": { planningProvider: SUBJECT } } },
      },
      /*
      FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
      Kept as a defensive sweep control, not as a real deployment tier: settings-scope.ts
      documents `selectedWorkflowModelLanes` as runtime-derived and NEVER persisted, so
      `getSettings()` cannot legitimately return it. It stays here because the collector does
      sweep nested objects, and an over-inclusive shape must still restore the alarm.
      */
      { name: "selectedWorkflowModelLanes overlay (runtime-derived shape, defensive sweep)", projectTier: { settings: { selectedWorkflowModelLanes: { executionProvider: SUBJECT, executionModelId: "m" } } } },
      { name: "global *GlobalProvider", globalTier: { executionGlobalProvider: SUBJECT } },
      { name: "global Default pair", globalTier: { defaultProvider: SUBJECT, defaultModelId: "m" } },
      { name: "agent runtimeConfig.modelProvider", projectTier: { agents: [{ runtimeConfig: { modelProvider: SUBJECT, modelId: "gpt-5" } }] } },
      { name: "agent legacy runtimeConfig.model", projectTier: { agents: [{ runtimeConfig: { model: `${SUBJECT}/gpt-5` } }] } },
      { name: "workflow IR node config", projectTier: { workflows: [{ ir: { nodes: [{ id: "n1", config: { modelProvider: SUBJECT } }] } }] } },
      { name: "workflow lane setting default", projectTier: { workflows: [{ ir: { settings: [{ id: "executorProvider", type: "string", default: SUBJECT }] } }] } },
    ];
    for (const tier of tiers) {
      const { callStatus } = setup({
        launch: tier.globalTier ? { globalSettings: tier.globalTier } : {},
        projects: { p1: tier.projectTier ?? {} },
      });
      const body = await callStatus();
      expect(body.providers.find((p) => p.id === SUBJECT)?.laneReferenced, `tier: ${tier.name}`).toBe(true);
    }
    // Negative control: the same subject with no tier anywhere is suppressed.
    const clean = setup({ launch: {}, projects: { p1: {}, p2: {} } });
    expect((await clean.callStatus()).providers.find((p) => p.id === SUBJECT)?.laneReferenced).toBe(false);
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0 symptom):
  The measured false-suppression shape, named as its own case: an operator pointed ONLY the
  Executor lane of a workflow at a provider (stored as a `workflow_settings` value, so it appears
  in no project settings row and in no workflow IR), the credential behind it expired, and both
  the board banner and the `oauth-token-expired` push stayed silent while every executor task
  failed. The banner contract the card must keep is "an absent banner means no lane references
  it", so this tier has to restore the alarm on its own.
  */
  it("keeps an expired provider alarming when only a stored workflow lane value references it", async () => {
    const { callStatus } = setup({
      launch: {},
      projects: { p1: { workflowSettingValues: { "builtin:coding": { executionProvider: "openai-codex" } } } },
    });
    const body = await callStatus();
    expect(body.providers.find((p) => p.id === "openai-codex")).toMatchObject({ expired: true, laneReferenced: true });
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P2):
  The host fan-out exists only to decide whether an alarm may be suppressed, so a host with
  nothing expired must not pay for it: /auth/status polls every few minutes and the scan reads
  settings, tasks, agents and workflow values for EVERY project on the host.
  */
  it("runs no host lane scan at all while no OAuth credential is expired", async () => {
    const { callStatus, launch, projectStores } = setup({
      launch: {},
      projects: { p1: { settings: { executionProvider: "openai-codex" } } },
      authStorageOverrides: {
        hasAuth: vi.fn(() => false),
        hasApiKey: vi.fn(() => false),
        get: vi.fn(() => undefined),
      },
    });
    const body = await callStatus();
    expect(launch.listTasks).not.toHaveBeenCalled();
    expect(projectStores.p1.listTasks).not.toHaveBeenCalled();
    // Nothing is expired, so the gate question is never asked and every entry keeps the
    // visible-by-default value a failed scan would report.
    for (const provider of body.providers) {
      if (provider.type === "oauth") expect(provider.laneReferenced).toBe(true);
    }
  });

  it("excludes terminal done cards from the reference sweep", async () => {
    const { callStatus, projectStores } = setup({ launch: {}, projects: { p1: {} } });
    await callStatus();
    const listTasks = projectStores.p1.listTasks.mock.calls[0][0];
    expect(listTasks).toMatchObject({ slim: true, excludeColumns: ["done"] });
  });

  it("reuses one scan within the TTL window and re-scans after it (bounded staleness)", async () => {
    // Control only the clock the TTL reads; global fake timers would starve
    // the CLI-probe timeouts inside the same handler.
    let clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    try {
      const { callStatus, projectStores } = setup({ launch: {}, projects: { p1: {} } });
      await callStatus();
      await callStatus();
      expect(projectStores.p1.listTasks).toHaveBeenCalledTimes(1);
      clockOffsetMs = 61_000;
      await callStatus();
      expect(projectStores.p1.listTasks).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shares one in-flight scan across concurrent status polls (single-flight)", async () => {
    const { callStatus, launch } = setup({ launch: {}, projects: {} });
    await Promise.all([callStatus(), callStatus()]);
    expect(launch.listTasks).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-08-01:02 (RUFU-498):
  Retiring the leftover is the remediation the gated banner points at, so the cleanup path
  must work for exactly the measured shape: an expired, unreferenced, SINGLE default
  instance. The DELETE route accepts the sole/default instance, and the following
  /auth/status reports the provider unauthenticated with no `expired: true` residue —
  which transitively drops the provider from the monitor's getOAuthProviders() input too.
  */
  it("retiring an expired single default instance succeeds and clears its expiry from the status", async () => {
    let removed = false;
    const removeInstance = vi.fn(async () => { removed = true; });
    const credential = () => ({ type: "oauth", expires: Date.now() - 60_000 });
    const { callStatus, callDelete } = setup({
      launch: {},
      projects: {},
      authStorageOverrides: {
        hasAuth: vi.fn((id: string) => !removed && id === "anthropic-subscription"),
        get: vi.fn((id: string) => (!removed && id === "anthropic-subscription" ? credential() : undefined)),
        getInstance: vi.fn((ref: { providerId: string; instanceId: string }) => (
          !removed && ref.providerId === "anthropic-subscription" && ref.instanceId === "default" ? credential() : undefined
        )),
        listInstances: vi.fn((providerId: string) => (
          !removed && providerId === "anthropic-subscription" ? [{ providerId, instanceId: "default" }] : []
        )),
        removeInstance,
      },
    });

    const before = await callStatus();
    expect(before.providers.find((p) => p.id === "anthropic-subscription")).toMatchObject({ expired: true, laneReferenced: false });

    const json = vi.fn();
    await callDelete({ params: { provider: "anthropic-subscription", instance: "default" } }, { json });
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(removeInstance).toHaveBeenCalledWith({ providerId: "anthropic-subscription", instanceId: "default" });

    const after = await callStatus();
    expect(after.providers.find((p) => p.id === "anthropic-subscription")).toMatchObject({
      authenticated: false,
      expired: false,
      instances: [],
    });
  });
});
