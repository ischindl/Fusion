type AnthropicModelInput = "text" | "image";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const CLAUDE_SONNET_5_MODEL_ID = "claude-sonnet-5";

interface AnthropicModelRegistration {
  id: string;
  name: string;
  reasoning: boolean;
  input: AnthropicModelInput[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface AnthropicProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "anthropic-messages";
  models: AnthropicModelRegistration[];
}

/*
 * FNXC:ModelCatalog 2026-07-01-18:05:
 * Anthropic's official model overview lists `claude-sonnet-5` as a Claude API ID, but FN-7374 observed sparse provider `404 not_found_error` responses for direct Anthropic accounts after Fusion force-added that ID from static supplemental metadata. Fusion cannot encode per-account/model-surface availability from static docs, so direct Anthropic pickers must rely on the live/upstream registry for Sonnet 5 and only dedupe rows the registry already provides. Existing saved selections keep runtime fallback/actionable failure handling instead of being newly advertised here.
 */
export const SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION: AnthropicProviderRegistration = {
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "$ANTHROPIC_API_KEY",
  api: "anthropic-messages",
  models: [],
};

type AnthropicModelLike = Partial<Omit<AnthropicModelRegistration, "name" | "compat">> & {
  id: string;
  name?: unknown;
  provider?: string;
  compat?: unknown;
};

interface AnthropicModelRegistryLike {
  registerProvider(providerName: string, config: AnthropicProviderRegistration): void;
  getAll?: () => AnthropicModelLike[];
}

type RegistryWithProviderState = AnthropicModelRegistryLike & {
  registeredProviders?: Map<string, Partial<AnthropicProviderRegistration>>;
};

function toAnthropicModelRegistration(model: AnthropicModelLike): AnthropicModelRegistration {
  const supplemental = SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.find((entry) => entry.id === model.id);
  return {
    id: model.id,
    name: String(model.name ?? supplemental?.name ?? model.id),
    reasoning: model.reasoning ?? supplemental?.reasoning ?? false,
    input: Array.isArray(model.input) ? model.input as AnthropicModelInput[] : supplemental?.input ?? ["text"],
    cost: model.cost ?? supplemental?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow ?? supplemental?.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? supplemental?.maxTokens ?? 0),
    compat: typeof model.compat === "object" && model.compat !== null
      ? { ...(model.compat as Record<string, unknown>) }
      : supplemental?.compat ? { ...supplemental.compat } : undefined,
  };
}

function cloneAnthropicProviderRegistration(config: AnthropicProviderRegistration): AnthropicProviderRegistration {
  return {
    ...config,
    models: config.models.map((model) => toAnthropicModelRegistration(model)),
  };
}

export function mergeSupplementalAnthropicModels(
  modelRegistry: AnthropicModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(ANTHROPIC_PROVIDER_ID);
    const registeredModels = registeredProvider?.models?.map((model) => toAnthropicModelRegistration(model)) ?? [];
    const currentModels = registeredModels.length > 0
      ? registeredModels
      : modelRegistry.getAll?.()
        .filter((model) => model.provider === ANTHROPIC_PROVIDER_ID)
        .map((model) => toAnthropicModelRegistration(model)) ?? [];
    const currentModelIds = new Set(currentModels.map((model) => model.id));
    const missingModels = SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models
      .filter((model) => !currentModelIds.has(model.id));

    if (missingModels.length === 0) return;

    modelRegistry.registerProvider(ANTHROPIC_PROVIDER_ID, {
      ...cloneAnthropicProviderRegistration(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION),
      ...registeredProvider,
      models: [...currentModels, ...missingModels.map((model) => toAnthropicModelRegistration(model))],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to merge supplemental ${ANTHROPIC_PROVIDER_ID} models: ${message}`);
  }
}
