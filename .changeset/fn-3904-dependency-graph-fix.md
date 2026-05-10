---
"@runfusion/fusion": patch
---

Fix bundled Dependency Graph plugin reliability in the dashboard. Built-in plugin view registration now uses literal-specifier lazy imports so production bundles can resolve and load the bundled graph/roadmap dashboard views instead of falling back to an unavailable placeholder. Plugin install mode now resolves bundled plugin paths server-side when relative `./plugins/...` inputs do not exist under the current working directory, so installing built-in plugins from Settings works reliably across runtime locations.
