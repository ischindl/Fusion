/**
 * Pure project-routing decision surface for the CLI card-minting commands.
 *
 * FNXC:ProjectRoutingVisibility 2026-09-22-16:37:
 * `fn task create` (and its duplicate/refine siblings) silently filed cards into the central DEFAULT
 * project when the operator stood in a different project's checkout — GEDA-1057/1058 were created in
 * the gedapp project from cwd=git/Fusion, and the only routing hint in the output was an ambiguous
 * relative `.fusion/tasks/<ID>/` path. The fix must report precedence without changing it
 * (docs/multi-project.md: explicit `--project` > `defaultProjectId` > cwd discovery), so this module
 * turns the provenance recorded by `resolveProject()` into (a) the target line the command prints and
 * (b) an optional mismatch warning plus an interactive-confirm decision. It takes plain data and
 * touches no process state, no store, and no filesystem, which is what lets the acceptance matrix be
 * tested as a unit; the commands own the printing and the prompting.
 */

import { join, resolve as resolvePath } from "node:path";
import type { CwdProjectSnapshot, ProjectResolutionSource } from "./project-context.js";

/** Everything the decision needs; a hand-built context simply omits the provenance fields. */
export interface ProjectRoutingInput {
  /** Name of the project that will receive the card. */
  projectName: string;
  /** Absolute path of the project that will receive the card. */
  projectPath: string;
  /** Provenance from `resolveProject()`; undefined keeps today's unreported behavior. */
  resolvedFrom?: ProjectResolutionSource;
  /** Project seen in the invocation cwd, whatever resolution chose. */
  cwdProject?: CwdProjectSnapshot;
  /** Refusing the mismatch without prompting (`--yes` / `--no-input`). */
  yes?: boolean;
  /** Whether an interactive confirmation is possible (TTY and not quiet/machine mode). */
  isTty: boolean;
  /** Invocation working directory, supplied by the caller so this module stays pure. */
  cwd: string;
}

export interface ProjectRoutingDecision {
  /** The indented `Project:` result line, built once so create/duplicate/refine cannot drift. */
  targetLine: string;
  /** Sentence for the caller to print on stderr before any board write; absent = nothing to say. */
  warning?: string;
  /** True when the caller must obtain an interactive confirmation before writing. */
  requiresConfirm: boolean;
}

/** Sentence-ready provenance labels, ordered like `ProjectResolutionSource`. */
const SOURCE_LABELS: Record<ProjectResolutionSource, string> = {
  flag: "the --project flag",
  default: "the central default project",
  cwd: "current-directory detection",
  "cwd-fallback": "an unregistered local project in the current directory",
};

/**
 * Decide what a card-minting command says about where the card is going.
 *
 * Reporting is unconditional; warning is not. An explicit `--project` is the operator's own
 * instruction and a `cwd` resolution derived its target from that same folder, so neither is ever
 * second-guessed. `cwd-fallback` stays quiet here because the louder unregistered-project message
 * owns that case. That leaves the one shape that surprised an operator in practice: the central
 * default project winning while the cwd belongs to a different project.
 */
export function evaluateProjectRouting(input: ProjectRoutingInput): ProjectRoutingDecision {
  // `cwd` is read by `crossProjectWarning` through the spread `input`, so it is not destructured here.
  const { projectName, projectPath, resolvedFrom, cwdProject, isTty } = input;
  const yes = input.yes === true;
  const sourceLabel = resolvedFrom ? SOURCE_LABELS[resolvedFrom] : undefined;
  const targetLine = sourceLabel
    ? `  Project: ${projectName}  ${projectPath}  (resolved via ${sourceLabel})`
    : `  Project: ${projectName}`;

  // No provenance (hand-built/plugin contexts) or no cwd evidence: report the target, say nothing more.
  if (!sourceLabel || !resolvedFrom || !cwdProject) return { targetLine, requiresConfirm: false };
  if (resolvedFrom === "cwd-fallback") return { targetLine, requiresConfirm: false };
  if (resolvedFrom === "flag" || resolvedFrom === "cwd") return { targetLine, requiresConfirm: false };

  /*
  FNXC:ProjectRoutingVisibility 2026-09-22-16:37: the same folder written two ways (relative vs absolute,
  trailing separator, an inner `..`) is not a routing mismatch. Deliberately textual: resolving symlinks
  would need a filesystem read, and this module is pure so the whole matrix is testable with fake paths.
  */
  if (normalizePath(cwdProject.path) === normalizePath(projectPath)) {
    return { targetLine, requiresConfirm: false };
  }

  return {
    targetLine,
    warning: crossProjectWarning({ ...input, cwdProject }),
    requiresConfirm: isTty && !yes,
  };
}

/**
 * The cross-project mismatch sentence. Exported so a test can pin the wording of what an operator
 * actually reads, and so the confirm question and the declined notice name the same remedies.
 */
export function crossProjectWarning(input: ProjectRoutingInput & { cwdProject: CwdProjectSnapshot }): string {
  const label = input.resolvedFrom ? SOURCE_LABELS[input.resolvedFrom] : "an unknown source";
  return (
    `⚠ Project routing: the current directory (${input.cwd}) belongs to project ` +
    `"${input.cwdProject.name}" (${input.cwdProject.path}), but this card would be created in ` +
    `project "${input.projectName}" (${input.projectPath}) resolved via ${label}. Pass ` +
    `\`--project ${input.cwdProject.name}\` to target the project you are standing in, or run ` +
    "`fn project set-default <name>` to change which project is default."
  );
}

/**
 * Sentence printed when an operator declines the cross-project confirmation. No card was written, so
 * the wording names the would-be target and the ways to make the routing permanent or repeat it.
 */
export function declinedCrossProjectNotice(projectName: string): string {
  return (
    `Not created: no card was written to project "${projectName}". Re-run with ` +
    `\`--project ${projectName}\` to target it again without being asked, or run ` +
    "`fn project set-default <name>` (or set the `defaultProjectId` global setting) to make it " +
    "the permanent default."
  );
}

/** Interactive question shown when the mismatch cannot be auto-acknowledged. */
export function crossProjectConfirmQuestion(projectName: string): string {
  return `Create this card in project "${projectName}" anyway? [y/N]: `;
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

/**
 * Path identity for comparison only; the reported strings keep whatever spelling the registry has.
 * Textual (`path.resolve`), never `realpath` — a symlinked spelling of the same folder can still read
 * as a mismatch, which is the honest cost of keeping this module I/O-free.
 */
function normalizePath(path: string): string {
  try {
    return resolvePath(path);
  } catch {
    return path;
  }
}
