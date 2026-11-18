---
"@runfusion/fusion": patch
---

summary: Sandboxed commands no longer fail when the pnpm store directory is missing.
category: fix
dev: BubblewrapBackend now passes existsSync into the policy-to-argv mapping, so a bind source that is not on disk is omitted instead of aborting the whole bwrap invocation with "Can't find source path". This only ever drops a mount; isolation flags, read-only system binds, the environment filter, and --chdir are unchanged.
