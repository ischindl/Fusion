export const RUNTIME_PLUGIN_IDS = [
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-antigravity-runtime",
  "fusion-plugin-grok-runtime",
  "fusion-plugin-claude-runtime",
  // FNXC:OmpAcp 2026-07-11-23:35: Oh My Pi ACP runtime (omp acp) — staged like acp/droid for explicit runtime use.
  "fusion-plugin-omp-runtime",
  "fusion-plugin-droid-runtime",
  "fusion-plugin-acp-runtime",
] as const;

/**
 * FNXC:BundledPlugins 2026-06-17-22:03:
 * The published CLI stages more plugins than the auto-install subset: droid and ACP runtimes are bundled for explicit runtime use but are not auto-installed with the default plugin set. Keep one staged-id source shared by build assertions and freshness tests so a newly shipped plugin cannot bypass stale-dist checks.
 */
export const ALL_STAGED_BUNDLED_IDS = [
  ...RUNTIME_PLUGIN_IDS,
  "fusion-plugin-dependency-graph",
  "fusion-plugin-roadmap",
  "fusion-plugin-todos",
  "fusion-plugin-compound-engineering",
  "fusion-plugin-whatsapp-chat",
  // FNXC:BundledPlugins 2026-11-20-04:21 (RUFU-782): The Telegram bridge ships staged like the WhatsApp
  // template, so an operator enables it from Settings -> Plugins instead of installing it by hand.
  "fusion-plugin-telegram",
  "fusion-plugin-reports",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-linear-import",
  "fusion-plugin-quality",
] as const;
