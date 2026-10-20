---
"@runfusion/fusion": minor
---

summary: Cards now go to the project you name or the one you stand in; the default project is `--project @default`.
category: feature
dev: A one-shot `fn` command resolves `--project` (name or `@default`) → cwd detection → error and never consults `defaultProjectId` implicitly. `ProjectResolutionSource` lost `default`, the cross-project mismatch warning and `[y/N]` confirm are gone, so `--yes` no longer skips a routing prompt. `defaultProjectId` is still read at boot for the host runtime directory and by `fn project set-default`.
