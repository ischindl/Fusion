export const PROVIDER_ID = "llama-server";
export const PROVIDER_NAME = "Llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
/**
 * FNXC:LlamaCppWindows 2026-08-26-00:54:
 * RUFU-137: both values are FALLBACKS for llama-server builds that expose no
 * window metadata (no per-model meta.n_ctx and no readable /props). The real
 * per-model contextWindow is resolved from the live server in src/windows.ts
 * (per-model meta.n_ctx first, then the /props rungs). DEFAULT_MAX_TOKENS is
 * the RAW max-output fallback — the resolver window-caps it at
 * Math.floor(contextWindow / 2) before registration, so it is never registered
 * uncapped against a resolved window.
 */
export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_CONTEXT_WINDOW = 128000;
