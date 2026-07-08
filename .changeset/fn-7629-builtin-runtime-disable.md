---
"@runfusion/fusion": minor
---

summary: Built-in runtime plugins (Hermes, Paperclip, OpenClaw, Droid) can now be disabled and stay disabled across restarts.
category: feature
dev: renderBuiltinPluginSection now renders a durable enable/disable toggle for runtime built-ins independent of installed status, replacing the dead-end "Built-in metadata only" CTA for the not-installed / activated-without-record case. Chosen persistence path: on disable, a not-yet-installed built-in runtime is first registered via the existing installPlugin path (mirroring the CLI's ensureBundledPluginInstalled lazy-install), then disablePlugin is called immediately so a plugin_installs row + project state exists with enabled=false — no new persistence primitive needed since loadAllPlugins/loadPlugin already skip disabled plugins and recordActivationEvent only fires on actual load, so a disabled runtime is never re-activated on restart. HermesRuntimeCard/OpenClawRuntimeCard/PaperclipRuntimeCard now reflect the Plugin Manager disabled state ("Disabled in Plugin Manager") instead of showing a stale detected/connected status.
