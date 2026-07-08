import { describe, expect, it, vi } from "vitest";
import type { CustomProvider } from "@fusion/core";
import { seedDashboardProviders } from "../provider-registration.js";

/*
FNXC:ProviderRegistration 2026-07-07-00:00:
FN-7622 regression coverage: asserts seedDashboardProviders() produces the SAME provider catalog the
CLI serve/dashboard/daemon commands produce (built-in API-key providers + any registered custom
provider) across the enumerated data states — customProviders undefined/[]/one/multiple — and that a
settings:updated change re-registers custom providers via the disposer-managed listener.
*/

function makeAuthStorage() {
  const credentials: Record<string, { type: string; key?: string }> = {};
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    hasAuth: vi.fn((provider: string) => Boolean(credentials[provider])),
    login: vi.fn(),
    logout: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    set: vi.fn((provider: string, credential: { type: string; key?: string }) => {
      credentials[provider] = credential;
    }),
    remove: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    get: vi.fn((provider: string) => credentials[provider]),
    getAll: vi.fn(() => ({ ...credentials })),
    list: vi.fn(() => Object.keys(credentials)),
    getApiKey: vi.fn(async (provider: string) => credentials[provider]?.key),
  } as any;
}

function makeModelRegistry() {
  const registeredProviders = new Map<string, { models: Array<{ provider: string; id: string }> }>();
  return {
    registerProvider: vi.fn((name: string, config: { models?: Array<{ id: string }> }) => {
      registeredProviders.set(name, {
        models: (config.models ?? []).map((model) => ({ provider: name, id: model.id })),
      });
    }),
    refresh: vi.fn(),
    getAll: vi.fn(() =>
      Array.from(registeredProviders.entries()).flatMap(([, provider]) => provider.models),
    ),
    registeredProviders,
  } as any;
}

interface FakeGlobalSettings {
  customProviders?: CustomProvider[];
}

function makeStore(initialCustomProviders?: CustomProvider[]) {
  let settings: FakeGlobalSettings = { customProviders: initialCustomProviders };
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    getGlobalSettingsStore: () => ({
      getSettings: async () => settings,
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return undefined as never;
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((item) => item !== listener));
      return undefined as never;
    }),
    // Test-only helper: emits settings:updated the way TaskStore does.
    __emitSettingsUpdated(next: FakeGlobalSettings) {
      const previous = settings;
      settings = next;
      for (const listener of listeners.get("settings:updated") ?? []) {
        listener({ settings: next, previous });
      }
    },
  };
}

const customProvider = (overrides: Partial<CustomProvider> = {}): CustomProvider => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Acme AI",
  apiType: "openai-compatible",
  baseUrl: "https://acme.test/v1",
  apiKey: "ACME_KEY",
  models: [{ id: "acme-1", name: "Acme Model 1" }],
  ...overrides,
});

describe("seedDashboardProviders", () => {
  it("registers built-in API-key providers even with no custom providers (undefined)", async () => {
    const store = makeStore(undefined);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding"]));
  });

  it("registers built-in API-key providers with an empty customProviders array", async () => {
    const store = makeStore([]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding"]));
  });

  it("registers one custom provider alongside built-ins", async () => {
    const store = makeStore([customProvider()]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "acme-ai",
      expect.objectContaining({ baseUrl: "https://acme.test/v1" }),
    );
    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding", "acme-ai"]));
  });

  it("registers multiple custom providers alongside built-ins", async () => {
    const store = makeStore([
      customProvider({ id: "id-1", name: "Acme One", baseUrl: "https://one.test" }),
      customProvider({ id: "id-2", name: "Acme Two", baseUrl: "https://two.test" }),
    ]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "acme-one", "acme-two"]));
  });

  it("does not abort startup when reading custom providers from global settings fails", async () => {
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();
    const log = vi.fn();
    const store = {
      getGlobalSettingsStore: () => ({
        getSettings: async () => {
          throw new Error("disk read failed");
        },
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry, log });

    // Built-ins still registered despite the custom-provider load failure.
    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter"]));
    expect(log).toHaveBeenCalledWith("custom-providers", expect.stringContaining("disk read failed"));
  });

  it("re-registers custom providers on settings:updated and dispose() unsubscribes", async () => {
    const store = makeStore([]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { dispose } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    expect(store.on).toHaveBeenCalledWith("settings:updated", expect.any(Function));
    modelRegistry.registerProvider.mockClear();

    store.__emitSettingsUpdated({ customProviders: [customProvider()] });
    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "acme-ai",
      expect.objectContaining({ baseUrl: "https://acme.test/v1" }),
    );

    dispose();
    expect(store.off).toHaveBeenCalledWith("settings:updated", expect.any(Function));

    modelRegistry.registerProvider.mockClear();
    store.__emitSettingsUpdated({ customProviders: [customProvider({ id: "id-2", name: "Second" })] });
    expect(modelRegistry.registerProvider).not.toHaveBeenCalled();
  });
});
