/*
FNXC:OAuthAlarmEvidence 2026-11-08-00:26 (RUFU-498):
Unit contract for the ONE lane-reference authority behind the OAuth re-login alarms: every
tier that can resolve a model contributes its provider id; nothing else (preferences, task
prose, names) does; corrupt input never throws; and the anthropic <-> anthropic-subscription
alias closure is bidirectional. These are the fixtures the dashboard route and the engine
monitor rely on for their gate direction (referenced = alarm, unreferenced = silent).
*/
import { describe, expect, it } from "vitest";
import {
  collectLaneReferencedProviderIds,
  expandProviderIdAliasClosure,
  isProviderLaneReferenced,
} from "../ai/lane-referenced-providers.js";

describe("collectLaneReferencedProviderIds", () => {
  it("collects provider ids from every settings key shape ending in the Provider suffix", () => {
    const referenced = collectLaneReferencedProviderIds({
      settingsObjects: [{
        defaultProvider: "openai",
        executionProvider: "google",
        planningProvider: "mistral",
        validatorProvider: "deepseek",
        mergerProvider: "zai",
        executionGlobalProvider: "xai",
        executionFallbackProvider: "groq",
        chatDefaultModelProvider: "minimax",
      }],
    });
    expect(referenced).toEqual(new Set([
      "openai", "google", "mistral", "deepseek", "zai", "xai", "groq", "minimax",
    ]));
  });

  it("collects defaultProviderOverride even though the key does not end in the suffix", () => {
    const referenced = collectLaneReferencedProviderIds({
      settingsObjects: [{ defaultProviderOverride: "project-default", defaultModelIdOverride: "some-model" }],
    });
    expect(referenced.has("project-default")).toBe(true);
    expect(referenced.has("some-model")).toBe(false);
  });

  it("reaches nested settings overlays including selectedWorkflowModelLanes", () => {
    const referenced = collectLaneReferencedProviderIds({
      settingsObjects: [{
        selectedWorkflowModelLanes: {
          executionProvider: "lane-provider",
          executionModelId: "lane-model",
          validatorFallbackProvider: " lane-fallback ",
        },
        nested: { deeper: { planningProvider: "deep-provider" } },
      }],
    });
    expect(referenced).toEqual(new Set(["lane-provider", "lane-fallback", "deep-provider"]));
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
  The persisted per-(workflow, project) lane VALUES tier. Callers hand each workflow's stored
  values map in as a settings object (`store.listWorkflowSettingValuesForProject()` returns
  `Record<workflowId, values>`), because the workflow IR carries only lane DECLARATIONS and
  `selectedWorkflowModelLanes` is runtime-derived — nothing else reaches here shows which lane
  an operator actually pointed at a provider. Non-lane stored settings (timeouts, gates) must
  still contribute nothing.
  */
  it("collects a provider from stored per-workflow lane values and ignores non-lane stored settings", () => {
    const referenced = collectLaneReferencedProviderIds({
      settingsObjects: [
        { stepTimeoutMs: 900_000, allowRework: true, executionProvider: "workflow-lane-provider" },
        { mergerFallbackProvider: "workflow-fallback-provider" },
      ],
    });
    expect(referenced).toEqual(new Set(["workflow-lane-provider", "workflow-fallback-provider"]));
  });

  it("deduplicates the same provider referenced across tiers", () => {
    const referenced = collectLaneReferencedProviderIds({
      settingsObjects: [{ executionProvider: "openai" }],
      tasks: [{ modelProvider: "openai" }],
      agents: [{ runtimeConfig: { modelProvider: "openai", modelId: "gpt" } }],
    });
    expect([...referenced]).toEqual(["openai"]);
  });

  it("collects only the typed lane fields from tasks, never free-text metadata", () => {
    const referenced = collectLaneReferencedProviderIds({
      tasks: [{
        modelProvider: "task-provider",
        validatorModelProvider: "validator-provider",
        planningModelProvider: "planning-provider",
        mergerModelProvider: "merger-provider",
        modelId: "not-a-provider",
        title: "provider: grok is mentioned in prose",
        sourceMetadata: { summary: "anthropic", notes: { provider: "grok" } },
      }],
    });
    expect(referenced).toEqual(new Set([
      "task-provider", "validator-provider", "planning-provider", "merger-provider",
    ]));
  });

  it("collects agent runtime model pairs and the provider prefix of the legacy model string", () => {
    const referenced = collectLaneReferencedProviderIds({
      agents: [
        { runtimeConfig: { modelProvider: "agent-provider", modelId: "m" } },
        { runtimeConfig: { model: "openai-codex/gpt-5" } },
        { runtimeConfig: { modelProvider: "  ", model: "nov Slash" } },
        { runtimeConfig: { model: "/leading-slash" } },
        { runtimeConfig: { model: "trailing-slash/" } },
        { runtimeConfig: null },
        { metadata: { note: "runtimeConfig missing" } },
      ],
    });
    expect(referenced).toEqual(new Set(["agent-provider", "openai-codex"]));
  });

  it("collects workflow IR node modelProvider configs and lane setting defaults", () => {
    const referenced = collectLaneReferencedProviderIds({
      workflowDefinitions: [{
        ir: {
          version: "v2",
          name: "anthropic-pipeline",
          columns: [{ id: "todo", name: "Todo", traits: [] }],
          nodes: [
            { id: "n1", kind: "prompt", config: { modelProvider: "node-provider", modelId: "m" } },
            { id: "n2", kind: "prompt", config: { description: "provider: prose-only" } },
          ],
          edges: [],
          settings: [
            { id: "executorProvider", name: "Executor Provider", type: "string", default: "setting-provider" },
            { id: "executorModelId", name: "Executor Model", type: "string", default: "plain-model" },
          ],
        },
      }],
    });
    expect(referenced).toEqual(new Set(["node-provider", "setting-provider"]));
  });

  it("returns an empty set (never throws) for empty, undefined, and corrupt element inputs", () => {
    expect(collectLaneReferencedProviderIds({})).toEqual(new Set());
    expect(collectLaneReferencedProviderIds({
      settingsObjects: [undefined, null, "not-an-object", 42, [1, 2, 3]],
      tasks: [undefined, null, "nope", {}],
      agents: [undefined, null, { runtimeConfig: "corrupt" }, { runtimeConfig: { model: 7 } }],
      workflowDefinitions: [undefined, null, "nope", { ir: { settings: "corrupt" } }, { ir: null }],
    })).toEqual(new Set());
  });

  it("raises when a container itself is not iterable, because a caller's catch means visible", () => {
    // A store method that stopped returning an array is a WIRING bug, not corrupt data.
    // Raising routes it into every caller's fail-open catch (`referenced = true`), while
    // silently treating the tier as empty would suppress a live alarm — so this raise is the
    // fail-safe direction and is pinned against a future "just ignore it" cleanup.
    expect(() => collectLaneReferencedProviderIds({ tasks: { modelProvider: "x" } as never })).toThrow();
    expect(() => collectLaneReferencedProviderIds({ agents: { runtimeConfig: {} } as never })).toThrow();
  });

  it("survives cyclic and pathologically deep input structures", () => {
    const cyclic: Record<string, unknown> = { executionProvider: "cycle-provider" };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leafProvider: "deep-leaf" };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    expect(() => collectLaneReferencedProviderIds({
      settingsObjects: [cyclic, deep],
    })).not.toThrow();
    expect(collectLaneReferencedProviderIds({ settingsObjects: [cyclic] }).has("cycle-provider")).toBe(true);
  });

  it("never counts anthropicAuthPreference as a lane reference", () => {
    // The preference key does not end in `Provider` and its value is an enum, not a provider id.
    expect(collectLaneReferencedProviderIds({
      settingsObjects: [{ anthropicAuthPreference: "api-key" }],
    })).toEqual(new Set());
    expect(collectLaneReferencedProviderIds({
      settingsObjects: [{ anthropicAuthPreference: "subscription" }],
    })).toEqual(new Set());
  });

  it("collects a provider referenced only through an agent legacy model string", () => {
    const referenced = collectLaneReferencedProviderIds({
      agents: [{ runtimeConfig: { model: "openai-codex/gpt-5-codex" } }],
    });
    expect(referenced.has("openai-codex")).toBe(true);
  });
});

describe("isProviderLaneReferenced alias closure", () => {
  it("expands the anthropic pair bidirectionally and leaves other ids alone", () => {
    expect(expandProviderIdAliasClosure("anthropic")).toEqual(new Set(["anthropic", "anthropic-subscription"]));
    expect(expandProviderIdAliasClosure("anthropic-subscription")).toEqual(new Set(["anthropic-subscription", "anthropic"]));
    expect(expandProviderIdAliasClosure("openai-codex")).toEqual(new Set(["openai-codex"]));
  });

  it("treats an anthropic lane as referencing the anthropic-subscription credential and vice versa", () => {
    expect(isProviderLaneReferenced("anthropic-subscription", new Set(["anthropic"]))).toBe(true);
    expect(isProviderLaneReferenced("anthropic", new Set(["anthropic-subscription"]))).toBe(true);
  });

  it("does not extend the alias closure to other provider ids", () => {
    expect(isProviderLaneReferenced("openai-codex", new Set(["anthropic"]))).toBe(false);
    expect(isProviderLaneReferenced("anthropic", new Set(["openai-codex"]))).toBe(false);
    expect(isProviderLaneReferenced("anthropic-subscription", new Set(["anthropic-subscription"]))).toBe(true);
    expect(isProviderLaneReferenced("anthropic", new Set())).toBe(false);
  });
});
