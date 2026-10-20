/**
 * Pure project-routing reporting surface for the CLI card-minting commands.
 *
 * FNXC:ProjectRoutingVisibility 2026-09-22-16:37:
 * `fn task create` (and its duplicate/refine siblings) silently filed cards into the central DEFAULT
 * project when the operator stood in a different project's checkout — GEDA-1057/1058 were created in
 * the gedapp project from cwd=git/Fusion, and the only routing hint in the output was an ambiguous
 * relative `.fusion/tasks/<ID>/` path. The fix reported the provenance recorded by `resolveProject()`
 * as a target line, plus a mismatch warning and an interactive confirm. It takes plain data and touches
 * no process state, no store, and no filesystem, which is what lets the acceptance matrix be tested as
 * a unit; the commands own the printing and the prompting.
 *
 * FNXC:DefaultProjectNotARouter 2026-10-20-19:46 (RUFU-572):
 * The mismatch warning and the confirm prompt are DELETED, because the state they fired on can no
 * longer be reached. They existed for exactly one shape: the stored default winning while cwd belonged
 * to a different project. RUFU-572 removed the default from the router — a one-shot command targets
 * `--project` (including the `@default` token) or the current directory — so a cross-project card now
 * requires the operator to have typed the project themselves, and second-guessing that is not this
 * module's job. `evaluateProjectRouting` stays as the single shared target-line formatter so
 * create/duplicate/refine cannot drift, and `unregisteredCwdProjectWarning` stays because that hazard
 * is independent of the default project. With the prompt gone, `--yes` no longer answers a routing
 * question; it keeps parsing and forwarding for its other meanings.
 */

import { join } from "node:path";
import type { ProjectResolutionSource } from "./project-context.js";

/** Everything the report needs; a hand-built context simply omits the provenance field. */
export interface ProjectRoutingInput {
  /** Name of the project that will receive the card. */
  projectName: string;
  /** Absolute path of the project that will receive the card. */
  projectPath: string;
  /** Provenance from `resolveProject()`; undefined keeps today's unreported behavior. */
  resolvedFrom?: ProjectResolutionSource;
}

export interface ProjectRoutingDecision {
  /** The indented `Project:` result line, built once so create/duplicate/refine cannot drift. */
  targetLine: string;
}

/**
 * Sentence-ready provenance labels, ordered like `ProjectResolutionSource`.
 *
 * FNXC:DefaultProjectNotARouter 2026-10-20-19:46 (RUFU-572): `default` is gone from the source union — the
 * stored default no longer chooses a target, so there is nothing left to label. `@default` arrives as an
 * explicit flag and is therefore reported as `the --project flag`, which is what the operator actually typed.
 */
const SOURCE_LABELS: Record<ProjectResolutionSource, string> = {
  flag: "the --project flag",
  cwd: "current-directory detection",
  "cwd-fallback": "an unregistered local project in the current directory",
};

/**
 * Decide what a card-minting command says about where the card is going.
 *
 * Reporting is unconditional and nothing else. An explicit `--project` is the operator's own instruction
 * and a `cwd` resolution derived its target from the folder they are standing in, so neither is
 * second-guessed; `cwd-fallback` has its own louder message below.
 */
export function evaluateProjectRouting(input: ProjectRoutingInput): ProjectRoutingDecision {
  const { projectName, projectPath, resolvedFrom } = input;
  const sourceLabel = resolvedFrom ? SOURCE_LABELS[resolvedFrom] : undefined;
  return {
    targetLine: sourceLabel
      ? `  Project: ${projectName}  ${projectPath}  (resolved via ${sourceLabel})`
      : `  Project: ${projectName}`,
  };
}

/**
 * Absolute directory the card actually lives in: `<projectPath>/.fusion/tasks/<taskId>/`.
 *
 * FNXC:ProjectRoutingVisibility 2026-09-22-23:26 (RUFU-269): every card-minting command printed the
 * cwd-relative `Path:   .fusion/tasks/<ID>/`, which is simply false when the card was filed into another
 * project — the operator looks in the directory they are standing in and the card is not there. The
 * absolute path is true by construction, and because that honesty is the point of the fix the helper is
 * shared by `create`, `duplicate` and `refine` instead of formatting the same path three ways.
 *
 * @param {string} projectPath - Absolute resolved project root
 * @param {string} taskId - Created task id
 * @returns {string} Absolute task card directory with a trailing separator
 */
export function cardDirectoryPath(projectPath: string, taskId: string): string {
  return `${join(projectPath, ".fusion", "tasks", taskId)}/`;
}

/**
 * Sentence for the unregistered-cwd local-store fallback: no registered project matched the cwd, so
 * reads and writes land under the folder's own `.fusion/` instead of a registered project. Worded for
 * every board command, since the fallback is shared by reads (`fn task list`) as well as card minting.
 */
export function unregisteredCwdProjectWarning(cwd: string, projectPath: string): string {
  return (
    `⚠ Project routing: no registered Fusion project was found for the current directory (${cwd}). ` +
    "This command will read and write an UNREGISTERED local project under " +
    `${projectPath}/.fusion/ — a card created here lands there, not in a registered project. ` +
    "Register it with `fn project add <name> <path>` or pass `--project <name>` to target a " +
    "registered one."
  );
}
