/**
 * FNXC:CodeOrganization 2026-08-03-14:35:
 * planSquashImportFromDep peeled from TaskExecutor (U4 Slice B).
 * Inject rootDir + settings reader; no class state.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { quoteShellArg } from "./shell-quote.js";
import { resolveLocalIntegrationBase, type TaskBaseExecImpl } from "../worktree/task-base-resolution.js";

const execAsync = promisify(exec);

export type SquashImportPlanStore = {
  getSettings: () => Promise<Settings | Partial<Settings>>;
};

/*
FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
The main base is now the LOCAL integration branch's SHA. It used to prefer
`<remote>/<defaultBranch>` (probing `<remote>/HEAD` and best-effort `git fetch`-ing the branch first)
whenever worktreeRebaseBeforeMerge was enabled. That made a card's base — and therefore every later
classifier that measures the branch against "main" — a moving remote pointer the operator had no
hand in moving, so a local main that had not been fast-forwarded produced a base whose commits were
absent from local main. RUFU-237 discarded the mismatched claim-time identity and the card merged
against a base with zero own commits (RUFU-245 reproduced the wedge at main aa3f4a2a8b).

The HEAD fallback stays LAST on purpose: ambient HEAD is whatever the primary checkout happens to sit
on, which is the contamination shape FNXC:WorktreeIsolation exists to prevent. It is used only when
the integration ref itself cannot be resolved, i.e. no better local answer exists.
*/
async function resolveMainBase(
  rootDir: string,
  settings: Settings | Partial<Settings>,
  execImpl: TaskBaseExecImpl,
): Promise<string | null> {
  const { localSha } = await resolveLocalIntegrationBase({ rootDir, settings, execImpl });
  if (localSha) return localSha;

  // Integration ref unresolvable — last-resort ambient HEAD, still never a remote ref.
  try {
    const { stdout } = await execImpl("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a task's declared dep base should be squash-imported
 * (instead of forked from). Returns the planned operation's data when the
 * dep tip differs from the resolvable main base; returns null when no
 * import is needed (dep is already at main) or when no main base is
 * resolvable (caller falls back to legacy fork-from-dep).
 *
 * `originalStartPoint` is the user-facing label (typically the branch name
 * like `fusion/fn-2729`) used purely for log messages. `depTip` is the
 * resolved SHA of the dep's tip — that's what gets squash-merged.
 *
 * `execImpl` is an optional git seam for tests; production callers omit it.
 */
export async function planSquashImportFromDep(
  rootDir: string,
  store: SquashImportPlanStore,
  _taskId: string,
  depTip: string,
  originalStartPoint: string | undefined,
  execImpl?: TaskBaseExecImpl,
): Promise<{ depTip: string; mainBase: string; label: string } | null> {
  let settings;
  try {
    settings = await store.getSettings();
  } catch {
    return null;
  }

  const exec = execImpl ?? (execAsync as unknown as TaskBaseExecImpl);
  const mainBase = await resolveMainBase(rootDir, settings, exec);
  if (!mainBase) return null;

  // If the dep tip is already an ancestor of main, no squash import is
  // needed — the dep's content is already represented in main.
  try {
    await exec(
      `git merge-base --is-ancestor ${quoteShellArg(depTip)} ${quoteShellArg(mainBase)}`,
      { cwd: rootDir },
    );
    // Exit code 0 → ancestor → no import needed; legacy fork-from-main is fine.
    // Returning the plan with mainBase but signalling "no work" via dep===main.
    if (depTip === mainBase) return null;
    // Dep is ancestor of main but its tip SHA differs from main's tip; the
    // worktree should still branch off main, no squash needed.
    return { depTip: mainBase, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
  } catch {
    // Not an ancestor — squash-import is the safer path.
  }

  return { depTip, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
}
