/**
 * FNXC:NonInteractiveGit 2026-09-11-22:40:
 * RUFU-210 — non-interactive git for every autonomous lane.
 *
 * Incident evidence (production host, discovered 2026-09-09): a task-session shell ran
 * `git rebase --continue`, which spawns `git commit -n --no-gpg-sign -F ... -e --allow-empty`.
 * The `-e` opens an editor; the session has no TTY and `git var GIT_EDITOR` resolved to `vi`,
 * so the commit blocked on editor input forever. The process survived its owning session
 * (reparented to `systemd --user`) and sat at ~0% CPU for 1 day 13:38 — long after both the
 * worktree directory and the rebase state directory had been deleted underneath it. A git
 * command that wants an interactive editor is therefore not a hypothetical: it is a measured
 * immortal orphan, invisible to CPU-based monitoring.
 *
 * Design decisions (do not re-litigate):
 * 1. SCOPED, NOT GLOBAL. Nothing here mutates `process.env`. The operator-facing embedded
 *    dashboard terminal legitimately wants a real editor for `git commit`, so hardening is
 *    threaded per-lane through the env objects this helper is applied to, never ambient.
 * 2. FUSION'S HARDENING WINS. `applyNonInteractiveGitEnv` applies the fixed keys LAST, after
 *    ambient env, plugin-injected env (`collectExecutorRuntimeEnv`), and task env. A plugin or
 *    task that wants an editor is not a reason to hang the board.
 * 3. CORE-EXPORTED. Both engine env seams and the runtime plugins' spawn seams import the same
 *    constants; RUFU-216 (droid/paperclip/openclaw plugin lanes) consumes this same export.
 *    When wrapped around an allow-list-filtered env (ACP `buildSpawnEnv`, KTD6b), the floor only
 *    ever ADDS these fixed non-secret keys at the call site — it must never widen an allow-list
 *    and never inherits a value from an excluded key.
 * 4. VALUE SET. `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR=true` (rebase --continue/--edit-todo, commit
 *    without -m, merge, cherry-pick can all open one), `GIT_PAGER=cat` (log/blame/diff/show
 *    must never page on a missing TTY), `GIT_TERMINAL_PROMPT=0` (the credential prompt is the
 *    same hang class with a different prompt; matches the vitest harness precedent in
 *    packages/core/src/__test-utils__/vitest-setup.ts), and `GIT_MERGE_AUTOEDIT=no` (decided:
 *    `git merge` without `--no-edit` is the same hang class and no autonomous lane has a reason
 *    to want its autoedit prompt).
 *
 * Deliberate exclusions (decisions, not oversights):
 * - Engine MCP server processes (`mcp-session-tools.ts`, `mcp-validation-service.ts`), remote
 *   tunnel binaries (`remote-access/provider-adapters.ts`), and the benchmark harness
 *   (`experiment/benchmark-runner.ts`) are not task-session lanes — a benchmark hands its env
 *   to a session that is itself hardened.
 * - droid/paperclip/openclaw plugin lanes lack a `@fusion/core` dependency today; their
 *   coverage is tracked as RUFU-216 and consumes this export.
 */

/**
 * The fixed non-interactive git floor. Values are constants, never sourced from ambient env,
 * so applying this map cannot smuggle an environment-dependent value into a task lane.
 */
export const NON_INTERACTIVE_GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_MERGE_AUTOEDIT: "no",
});

/**
 * Return a NEW env object carrying the non-interactive git floor applied LAST, so these keys
 * win over ambient, plugin-injected, and task-supplied values. The input object is never
 * mutated (the caller's object may be `process.env` or a shared parent env).
 */
export function applyNonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...NON_INTERACTIVE_GIT_ENV };
}
