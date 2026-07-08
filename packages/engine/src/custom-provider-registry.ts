/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: relocated from packages/cli/src/commands/custom-provider-registry.ts into @fusion/engine
so the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share ONE
custom-provider registration implementation. packages/cli/src/commands/custom-provider-registry.ts
is now a thin re-export shim of this module; its observable behavior is unchanged.
*/
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";

interface ModelRegistryLike {
  registerProvider: (name: string, config: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: ("text" | "image")[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: {
        supportsDeveloperRole?: boolean;
      };
    }>;
  }) => void;
  refresh: () => void;
}

export function resolveApiType(apiType: string): string {
  if (apiType === "anthropic-compatible") {
    return "anthropic";
  }
  if (apiType === "openai-responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

function toProviderConfig(provider: CustomProvider) {
  const api = resolveApiType(provider.apiType);
  const supportsDeveloperRole = provider.supportsDeveloperRole === true;

  return {
    baseUrl: provider.baseUrl,
    api,
    apiKey: provider.apiKey,
    models: (provider.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text" as const],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128000,
      maxTokens: 16384,
      ...(api === "openai-completions" ? { compat: { supportsDeveloperRole } } : {}),
    })),
  };
}

function providersDiffer(previous: CustomProvider, current: CustomProvider): boolean {
  return JSON.stringify(toProviderConfig(previous)) !== JSON.stringify(toProviderConfig(current));
}

export function registerCustomProviders(
  modelRegistry: ModelRegistryLike,
  customProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): void {
  const providers = customProviders ?? [];
  for (const provider of providers) {
    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`Registered custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  modelRegistry.refresh();
}

export function reregisterCustomProviders(
  modelRegistry: ModelRegistryLike,
  previousProviders: CustomProvider[] | undefined,
  currentProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): void {
  const previousById = new Map((previousProviders ?? []).map((provider) => [provider.id, provider]));
  const providers = currentProviders ?? [];

  for (const provider of providers) {
    const previous = previousById.get(provider.id);
    if (previous && !providersDiffer(previous, provider)) {
      continue;
    }

    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`${previous ? "Updated" : "Registered"} custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  modelRegistry.refresh();
}
