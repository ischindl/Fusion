import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "./resolver.js";

/**
 * Per-model metadata emitted by the llama-server model-list endpoints (`/models`,
 * `/v1/models`). Every field is optional and unknown-typed so that current builds
 * (which always emit `meta`) and older bare OpenAI-style entries (no `meta`) both
 * parse, and so a schema drift never breaks model registration.
 */
export type LlamaModelMeta = {
  n_ctx?: unknown;
  n_ctx_train?: unknown;
  n_embd?: unknown;
  n_vocab?: unknown;
  n_params?: unknown;
  size?: unknown;
  ftype?: unknown;
  vocab_type?: unknown;
  [field: string]: unknown;
};

export type LlamaModel = {
  id: string;
  object?: string;
  owned_by?: string;
  meta?: LlamaModelMeta;
};

/**
 * Shape of GET /props from the llama-server. `default_generation_settings` carries
 * the slot context (`n_ctx`) and the generation params on current builds; older
 * builds expose a top-level `n_ctx` instead. Unknown fields must not break parsing.
 */
export type LlamaProps = {
  n_ctx?: unknown;
  default_generation_settings?: {
    n_ctx?: unknown;
    params?: {
      n_predict?: unknown;
      max_tokens?: unknown;
      [param: string]: unknown;
    };
    [field: string]: unknown;
  };
  [field: string]: unknown;
};

export type LlamaProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export async function llamaRpc<T>(endpoint: string, cwd = process.cwd()): Promise<T> {
  const url = `${await resolveLlamaServerUrl(cwd)}${endpoint}`;
  const apiKey = await resolveLlamaServerApiKey();
  const response = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function isLlamaServerReady(cwd = process.cwd()): Promise<boolean> {
  try {
    const status = await llamaRpc<{ status?: string }>("/health", cwd);
    return status.status === "ok";
  } catch {
    return false;
  }
}

export async function listLlamaModels(cwd = process.cwd()): Promise<LlamaModel[]> {
  const response = await llamaRpc<{ data?: LlamaModel[]; models?: unknown }>("/models", cwd);
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * FNXC:LlamaCppWindows 2026-08-26-00:45:
 * RUFU-137: local llama.cpp models must register their real per-slot context window
 * (resolved in src/windows.ts) so the chat pre-overflow compaction gate and pi's
 * threshold compaction reason from the running server's window instead of the
 * 128000/32000 registry defaults.
 *
 * Endpoint contract (verified against ggml-org/llama.cpp master on 2026-08-20;
 * tools/server README + server-context.cpp are the source of truth):
 * - The model list (GET /models — the same handler as /v1/models, already fetched by
 *   listLlamaModels) carries the per-slot context window in each entry's `meta.n_ctx`
 *   (llama_n_ctx_seq, capped at the model's training context). Older builds return
 *   bare OpenAI-style entries without `meta`, so `meta` is optional.
 * - GET /props returns `default_generation_settings` holding `n_ctx` (the slot
 *   context) and `params`; older builds expose a top-level `n_ctx` instead. Both
 *   locations are optional fallbacks for models whose list entries carry no meta.
 * - `params` emits both `n_predict` and `max_tokens`, but current master defaults
 *   them to -1 (unlimited) and no always-on endpoint exposes the effective
 *   --n-predict cap, so the resolver treats a positive reported value as the
 *   best-available raw maxTokens and otherwise falls back to DEFAULT_MAX_TOKENS,
 *   window-capped in windows.ts.
 *
 * Non-fatal semantics: props are enrichment, never a registration blocker — any
 * failure (non-2xx, network error, malformed JSON) resolves to null and provider
 * registration proceeds with the fallback windows.
 */
export async function getLlamaProps(cwd = process.cwd()): Promise<LlamaProps | null> {
  try {
    return await llamaRpc<LlamaProps>("/props", cwd);
  } catch {
    return null;
  }
}
