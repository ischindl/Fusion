/*
FNXC:OAuthAlarmEvidence 2026-11-09-13:35 (RUFU-498):
Wiring contract for the engine half of the OAuth re-login gate. `OAuthExpiryMonitor` is proven
elsewhere to obey whatever predicate it is handed; THIS file proves the predicate the engine
actually hands it is built from the tiers that can resolve a model — global settings, this
project's settings, durable agents, non-terminal task lane fields, workflow lane DECLARATIONS and
the persisted per-workflow lane VALUES (`workflow_settings`) — because a wiring bug here (a missed
tier, a wrong store method) would silently silence a real
"your token expired" push for a provider some lane is still using, which is the one failure
this gate may never have. Every tier must restore the alarm on its own, the anthropic alias
closure must resolve through the shared core collector, and every unreadable tier must answer
true (fail-open = the pre-gate always-notify behavior). A synchronous throw from a tier read
is asserted not to leak an unhandled rejection: the scan owns every settlement.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectEngine } from "../project-engine.js";

const SUBJECT = "openai-codex";

interface FakeStore {
  settings?: Record<string, unknown>;
  globalSettings?: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
  /** Persisted per-(workflow, project) lane VALUES (`workflow_settings` rows) — the
   *  `selected workflow` tier of model resolution, read through
   *  `store.listWorkflowSettingValuesForProject()`. */
  workflowSettingValues?: Record<string, Record<string, unknown>>;
  throwOn?: ("globalSettings" | "settings" | "tasks" | "workflows" | "workflowSettingValues" | "agents" | "agentStore")[];
  /** Synchronous throws, i.e. a store double that simply lacks a method. */
  throwSyncOn?: ("settings" | "tasks" | "workflows" | "workflowSettingValues")[];
}

function fakeEngine(store: FakeStore) {
  const throwOn = new Set(store.throwOn ?? []);
  /** A method that throws SYNCHRONOUSLY: the shape of a store double that lacks the method. */
  const syncThrow = (message: string) => (..._args: unknown[]): never => { throw new Error(message); };
  /** An async read that rejects, i.e. a tier that exists but is unreachable. */
  const read = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (throwOn.has(key)) throw new Error(`${key} unreadable`);
    return fn();
  };
  const syncThrowKeys = new Set(store.throwSyncOn ?? []);
  const taskStore = {
    getGlobalSettingsStore: () => ({
      getSettings: () => read("globalSettings", async () => store.globalSettings ?? {}),
    }),
    getSettings: syncThrowKeys.has("settings")
      ? syncThrow("getSettings unavailable")
      : () => read("settings", async () => store.settings ?? {}),
    listTasks: syncThrowKeys.has("tasks")
      ? syncThrow("listTasks unavailable")
      : async (options?: unknown) => {
          listTasksOptions.push(options);
          return read("tasks", async () => store.tasks ?? []);
        },
    listWorkflowDefinitions: syncThrowKeys.has("workflows")
      ? syncThrow("listWorkflowDefinitions unavailable")
      : () => read("workflows", async () => store.workflows ?? []),
    listWorkflowSettingValuesForProject: syncThrowKeys.has("workflowSettingValues")
      ? syncThrow("listWorkflowSettingValuesForProject unavailable")
      : () => read("workflowSettingValues", async () => store.workflowSettingValues ?? {}),
  };
  const agentStore = {
    listAgents: () => read("agents", async () => store.agents ?? []),
  };
  const runtime = {
    getTaskStore: () => taskStore,
    getAgentStore: () => (throwOn.has("agentStore") ? undefined : agentStore),
  };
  const predicate = ProjectEngine.prototype.createLaneReferencedPredicate.call({ runtime });
  return { predicate, taskStore };
}

/** Collected `listTasks` arguments so the terminal-card exclusion is asserted at this surface too. */
let listTasksOptions: unknown[] = [];
/** Captured unhandled rejections; a scan failure must never reach the process handler. */
let unhandled: unknown[] = [];

function rejectionListener(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  listTasksOptions = [];
  unhandled = [];
  process.on("unhandledRejection", rejectionListener);
});

afterEach(() => {
  process.off("unhandledRejection", rejectionListener);
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ProjectEngine.createLaneReferencedPredicate (RUFU-498 engine monitor gate wiring)", () => {
  it("restores the alarm from every lane tier this engine can read, on its own", async () => {
    const tiers: Array<{ name: string; store: FakeStore }> = [
      { name: "global *GlobalProvider", store: { globalSettings: { executionGlobalProvider: SUBJECT } } },
      { name: "global Default pair", store: { globalSettings: { defaultProvider: SUBJECT, defaultModelId: "m" } } },
      { name: "project defaultProvider", store: { settings: { defaultProvider: SUBJECT } } },
      { name: "project executionProvider", store: { settings: { executionProvider: SUBJECT } } },
      /*
      FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
      The tier the predicate originally missed. A workflow's lane VALUES are persisted per
      (workflow, project) in `workflow_settings` by Settings → Workflow and read back by model
      resolution; they are in no project settings row and no workflow IR (the IR carries only
      lane DECLARATIONS, and `selectedWorkflowModelLanes` is runtime-derived, never persisted).
      Missing this read made the engine itself stop pushing `oauth-token-expired` for the exact
      provider its executor lane was failing on.
      */
      { name: "stored workflow lane value (workflow_settings row)", store: { workflowSettingValues: { "builtin:coding": { executionProvider: SUBJECT, executionModelId: "gpt-5" } } } },
      { name: "stored workflow lane value of a non-selected workflow", store: { workflowSettingValues: { "wf-custom": { mergerProvider: SUBJECT } } } },
      /*
      FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
      Defensive sweep control, not a real deployment tier: settings-scope.ts documents
      `selectedWorkflowModelLanes` as runtime-derived and never persisted, so `getSettings()`
      cannot legitimately return it. It stays because the collector does sweep nested objects
      and an over-inclusive shape must still restore the alarm.
      */
      { name: "selectedWorkflowModelLanes overlay (runtime-derived shape, defensive sweep)", store: { settings: { selectedWorkflowModelLanes: { executionProvider: SUBJECT, executionModelId: "m" } } } },
      { name: "task modelProvider", store: { tasks: [{ modelProvider: SUBJECT }] } },
      { name: "task validatorModelProvider", store: { tasks: [{ validatorModelProvider: SUBJECT }] } },
      { name: "task planningModelProvider", store: { tasks: [{ planningModelProvider: SUBJECT }] } },
      { name: "task mergerModelProvider", store: { tasks: [{ mergerModelProvider: SUBJECT }] } },
      { name: "agent runtimeConfig.modelProvider", store: { agents: [{ runtimeConfig: { modelProvider: SUBJECT, modelId: "gpt-5" } }] } },
      { name: "agent legacy runtimeConfig.model", store: { agents: [{ runtimeConfig: { model: `${SUBJECT}/gpt-5` } }] } },
      { name: "workflow IR node config", store: { workflows: [{ ir: { nodes: [{ id: "n1", config: { modelProvider: SUBJECT } }] } }] } },
      { name: "workflow lane setting default", store: { workflows: [{ ir: { settings: [{ id: "executorProvider", type: "string", default: SUBJECT }] } }] } },
    ];
    for (const tier of tiers) {
      const { predicate } = fakeEngine(tier.store);
      expect(await predicate(SUBJECT), `tier: ${tier.name}`).toBe(true);
    }
    // Negative control: the same subject with no tier anywhere is proven unreferenced.
    const clean = fakeEngine({});
    expect(await clean.predicate(SUBJECT)).toBe(false);
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0 symptom):
  Named instance of the measured false-silencing: the Executor lane of the workflow this
  project's tasks run under is the ONLY reference to the expired provider. The push must fire.
  */
  it("keeps pushing when only a stored workflow lane value references the provider", async () => {
    const { predicate } = fakeEngine({
      workflowSettingValues: { "builtin:coding": { executionProvider: SUBJECT } },
    });
    expect(await predicate(SUBJECT)).toBe(true);
  });

  it("resolves the anthropic alias closure through the shared collector", async () => {
    const referenced = fakeEngine({ tasks: [{ modelProvider: "anthropic" }] });
    expect(await referenced.predicate("anthropic-subscription")).toBe(true);
    const clean = fakeEngine({});
    expect(await clean.predicate("anthropic-subscription")).toBe(false);
  });

  it("excludes terminal done cards from the engine-side sweep", async () => {
    const { predicate } = fakeEngine({});
    await predicate(SUBJECT);
    expect(listTasksOptions[0]).toMatchObject({ slim: true, excludeColumns: ["done"] });
  });

  it("answers true for any unreadable tier (fail-open) and never leaks an unhandled rejection", async () => {
    for (const throwOn of [["globalSettings"], ["settings"], ["tasks"], ["workflows"], ["workflowSettingValues"], ["agents"], ["agentStore"]] as const) {
      const { predicate } = fakeEngine({ throwOn: [...throwOn] });
      expect(await predicate(SUBJECT), `throwOn: ${throwOn.join(",")}`).toBe(true);
    }
    // A store double whose method is missing throws SYNCHRONOUSLY while the Promise.all
    // array is built; the thunk wrapper must keep that inside the scan's own catch.
    for (const throwSyncOn of [["settings"], ["tasks"], ["workflows"], ["workflowSettingValues"], ["settings", "tasks"]] as const) {
      const { predicate } = fakeEngine({ throwSyncOn: [...throwSyncOn] });
      expect(await predicate(SUBJECT), `throwSyncOn: ${throwSyncOn.join(",")}`).toBe(true);
    }
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("reuses one cached scan across providers instead of re-reading on every probe", async () => {
    const { predicate } = fakeEngine({});
    await predicate(SUBJECT);
    await predicate("anthropic-subscription");
    expect(listTasksOptions.length).toBe(1);
  });
});
