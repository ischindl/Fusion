import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./src/constants.js";
import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "./src/resolver.js";
import { getLlamaProps, isLlamaServerReady, listLlamaModels } from "./src/retriever.js";
import { resolveLlamaModelWindows } from "./src/windows.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const cwd = process.cwd();
  if (!(await isLlamaServerReady(cwd))) {
    return;
  }

  /**
   * FNXC:LlamaCppWindows 2026-08-26-00:54:
   * RUFU-137: per-model contextWindow/maxTokens come from the live llama-server —
   * the model's meta.n_ctx first (per-slot context from the model list), then the
   * /props rungs (default_generation_settings.n_ctx, top-level n_ctx), then the
   * 128000 default (src/windows.ts). maxTokens is the resolver's window-capped
   * value (min(raw default or 32000 fallback, floor(contextWindow / 2))), so the
   * RUFU-118 chat pre-overflow compaction gate keeps a positive headroom instead
   * of reasoning from a 128K window that the server never allocated. A /props
   * failure NEVER blocks or skips registration: getLlamaProps resolves to null on
   * any failure and the 128000/32000 fallbacks (cap a no-op at that window) apply.
   */
  const [url, models, apiKey, props] = await Promise.all([
    resolveLlamaServerUrl(cwd),
    listLlamaModels(cwd),
    resolveLlamaServerApiKey(),
    getLlamaProps(cwd),
  ]);

  const windows = resolveLlamaModelWindows(models, props);

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: `${url}/v1`,
    api: "openai-completions",
    apiKey: apiKey ?? "",
    models: models.map((model) => {
      const resolved = windows.get(model.id);
      return {
        id: model.id,
        name: model.id,
        reasoning: true,
        input: ["text", "image"] as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Map-lookup fallback is defensive only — the resolver's map always
        // contains every listed model id.
        contextWindow: resolved?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: resolved?.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
    }),
  });
}
