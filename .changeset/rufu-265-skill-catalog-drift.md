---
"@runfusion/fusion": patch
---

summary: The fusion skill's tool list now matches the tools that exist, and builds stop rewriting it.
category: fix
dev: The shipped skill docs (`skill/fusion/SKILL.md`, `references/extension-tools.md`, `references/fusion-capabilities.md`) were regenerated from the canonical registrations, dropping rows for the retired `fn_task_archive`/`fn_task_unarchive`, a duplicated legacy two-column table, and merge residue. Regenerate only with `pnpm sync:fusion-skill`; drift is enforced by the new blocking `check-fusion-skill-sync` gate validator. `packages/cli` lost the `prebuild` that rewrote these tracked docs, so `pnpm build` no longer dirties the working tree.
