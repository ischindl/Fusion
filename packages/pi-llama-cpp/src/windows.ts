import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./constants.js";
import type { LlamaModel, LlamaProps } from "./retriever.js";

export type LlamaModelWindows = {
  contextWindow: number;
  maxTokens: number;
};

/**
 * Accept only positive finite numbers — degenerate server values (0, -1, null,
 * strings, NaN, Infinity) fall through to the next rung of the fallback chain.
 */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * FNXC:LlamaCppWindows 2026-08-26-00:49:
 * RUFU-137: pure per-model window resolver for the llama.cpp extension — no I/O,
 * so every fallback rung and the maxTokens cap are unit-testable in isolation.
 *
 * Per-model contextWindow is the first positive finite value in the fallback
 * chain: the model's meta.n_ctx (the running server's per-slot context, from the
 * model list) → /props default_generation_settings.n_ctx → /props top-level
 * n_ctx (older builds) → DEFAULT_CONTEXT_WINDOW (128000).
 *
 * maxTokens is ALWAYS window-capped: Math.min(rawMaxTokens,
 * Math.floor(contextWindow / 2)). rawMaxTokens is the server-reported positive
 * default (params.n_predict, with params.max_tokens as the alias before falling
 * back) or else DEFAULT_MAX_TOKENS (32000). llama.cpp exposes no per-model
 * output cap over HTTP, so the raw source is server-wide by design; the
 * Math.floor(contextWindow / 2) cap is the ONLY window-derived maxTokens
 * adjustment this package makes.
 *
 * The cap is mandatory because of the RUFU-118 gate math in
 * packages/engine/src/chat-context-guard.ts (reserve = max(MIN_RESERVE_TOKENS =
 * 16384, maxTokens); hardLimit = contextWindow - reserve; the gate null-skips
 * when hardLimit <= 0 and throws post-compaction at hardLimit while pi's
 * compaction keeps >= keepRecentTokens = 20000):
 * - registering the UNCAPPED 32000 against a 32768 window collapses hardLimit
 *   to 768 — the on-by-default gate fires at ~768 tokens and throws after
 *   every compaction (chat permanently wedged);
 * - windows <= 32000 (llama-server's default n_ctx 4096, 8K/16K servers) give
 *   hardLimit <= 0 — the gate stays silently blind, the exact failure class
 *   this task removes.
 * The cap therefore makes a registered maxTokens >= contextWindow impossible
 * (it is strictly below every positive window). Windows <= 16384 remain blind
 * via the gate's 16384 reserve floor — a gate-side (RUFU-118) concern this
 * resolver documents but does not work around.
 */
export function resolveLlamaModelWindows(
  models: LlamaModel[],
  props: LlamaProps | null | undefined,
): Map<string, LlamaModelWindows> {
  const resolved = new Map<string, LlamaModelWindows>();
  const params = props?.default_generation_settings?.params;
  const rawNPredict = params?.n_predict;
  const rawMaxTokensAlias = params?.max_tokens;
  const rawMaxTokens = isPositiveFinite(rawNPredict)
    ? rawNPredict
    : isPositiveFinite(rawMaxTokensAlias)
      ? rawMaxTokensAlias
      : DEFAULT_MAX_TOKENS;

  for (const model of models) {
    let contextWindow = DEFAULT_CONTEXT_WINDOW;
    for (const candidate of [
      model.meta?.n_ctx,
      props?.default_generation_settings?.n_ctx,
      props?.n_ctx,
    ]) {
      if (isPositiveFinite(candidate)) {
        contextWindow = candidate;
        break;
      }
    }
    resolved.set(model.id, {
      contextWindow,
      maxTokens: Math.min(rawMaxTokens, Math.floor(contextWindow / 2)),
    });
  }
  return resolved;
}
