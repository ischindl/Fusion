---
"@runfusion/fusion": patch
---

summary: Agent sessions and the Usage probe no longer run inside Fusion's own launch directory.
category: fix
dev: Every agent lane now passes an explicit working directory and a lane missing one fails by name (`MissingAgentCwdError`, `CLI_MISSING_WORKTREE`, `CLI_CHAT_WORKING_DIRECTORY_MISSING`, `AUTOMATION_MISSING_WORKING_DIRECTORY`, `SCHEDULED_EVAL_MISSING_WORKING_DIRECTORY`, `SANDBOX_WRITABLE_ROOT_MISSING`) instead of silently inheriting the server's directory. Declare deployment checkouts in `FUSION_PROTECTED_CHECKOUTS` (path-delimiter or newline separated, `~` expanded, matches the directory itself or anything inside it, unset = no behavior change) to refuse an agent session rooted there; the policy never redirects the path. The Usage Claude CLI fallback now runs in a temp scratch directory, is single-flight, carries `FUSION_PROBE=usage-claude`, and no longer passes `--add-dir`. `packages/engine/src/__tests__/agent-cwd-ratchet.test.ts` fails the build on any new inherited cwd; exemptions and their reasons live there.
