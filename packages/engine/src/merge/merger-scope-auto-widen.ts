import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";

import { classifyCommitAttribution } from "../execution/branch-attribution.js";

const execAsync = promisify(exec);
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
The fourth value is what this gate was refusing SANE-489's own file for. `own-mention` names a commit
whose subject carries the executing card's id outside prefix position — e.g. the measured
`test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)` — which the private
classifier this file used to own answered `null`, and `null` was refused as `foreign-commit`, so Layer 3
took MAIN'S BYTES for a file the card had itself written. The refusal vocabulary and the
`merge:scope:auto-widen` metadata key set are deliberately UNCHANGED: the gate's decision changes, its
contract does not.
*/
type Attribution = "subject-prefix" | "bracketed-prefix" | "trailer" | "own-mention";
export type ScopeAutoWidenRefusalReason = "foreign-commit" | "claimed-by-other-task" | "ignored-path" | "no-attribution";

export interface ScopeAutoWidenAccepted {
  file: string;
  attribution: Attribution;
  commits: string[];
}

export interface ScopeAutoWidenRefused {
  file: string;
  reason: ScopeAutoWidenRefusalReason;
}

export interface ScopeAutoWidenResult {
  widened: ScopeAutoWidenAccepted[];
  refused: ScopeAutoWidenRefused[];
}

export interface EvaluateScopeAutoWidenParams {
  store: Pick<TaskStore, "parseFileScopeFromPrompt"> & Partial<Pick<TaskStore, "listTasks">>;
  task: Task;
  taskId: string;
  rootDir: string;
  branch: string;
  baseRef: string;
  candidateFiles: string[];
  execAsyncImpl?: typeof execAsync;
}

export class ScopeAutoWidenPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeAutoWidenPersistError";
  }
}

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
Three private `attributedBy*` parsers and a private `classifyCommitAttribution` used to live here — the
fourth copy of the attribution grammar in the product, and the only one whose `null` answer carried the
weight of a merge refusal. They are gone; the canonical classifier in
`packages/engine/src/execution/branch-attribution.ts` is the single authority, so a commit this gate calls
foreign can never disagree with the contamination row written for the same commit.
*/

/**
 * RUFU-669: when a file's commits agree, report it; when they disagree, report the most authoritative
 * source that was ACTUALLY observed. The collapsed value used to be a literal `"trailer"` nobody had
 * seen, which made an own-mention-only range look like a trailer-attributed one in `merge:scope:auto-widen`.
 */
function collapseObservedAttribution(observed: Attribution[]): Attribution {
  for (const candidate of ["trailer", "subject-prefix", "bracketed-prefix", "own-mention"] as const) {
    if (observed.includes(candidate)) return candidate;
  }
  return observed[0]!;
}

async function isGitIgnored(file: string, rootDir: string, execImpl: typeof execAsync): Promise<boolean> {
  try {
    await execImpl(`git check-ignore -- ${quoteArg(file)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

function matchGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function scopeContainsPath(scope: string[], file: string): boolean {
  return scope.some((entry) => entry === file || (entry.includes("*") && matchGlob(file, entry)));
}

export async function evaluateScopeAutoWiden(params: EvaluateScopeAutoWidenParams): Promise<ScopeAutoWidenResult> {
  const { store, task, taskId, rootDir, branch, baseRef, candidateFiles } = params;
  const execImpl = params.execAsyncImpl ?? execAsync;
  const widened: ScopeAutoWidenAccepted[] = [];
  const refused: ScopeAutoWidenRefused[] = [];
  const attributionTaskId = task.id || taskId;

  const allTasks = typeof store.listTasks === "function"
    // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
    ? await store.listTasks({ slim: true, includeArchived: false, excludeLog: true })
    : [];
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-12:55 (batch-engine tail):
  "Still active" is the COMPLETE and ARCHIVED roles, not the two ids. On a renamed board every FINISHED
  card counted as an active other, so auto-widen refused to widen into files whose only other claimant
  had already shipped — a merge blocked by a task that no longer exists in any meaningful sense.

  NOT the query-filter class: this query passes no `column`, so the predicate is the only lane gate here.

  Resolved per OTHER TASK (each may run its own workflow), one IR cache for the pass, unioned with the
  legacy Done fallback because `resolveWorkflowIrForTask` degrades to the built-in IR rather than throwing —
  without the union a degraded board would treat every finished card as active, which is this bug.
  */
  const irCache = new Map<string, WorkflowIr>();
  const terminalByTaskId = new Map<string, ReadonlySet<string>>();
  for (const other of allTasks) {
    const columns = new Set<string>(["done"]);
    try {
      const ir = await resolveWorkflowIrForTask(store as TaskStore, other.id, irCache);
      if (ir) {
        for (const id of columnsWithFlag(ir, "complete")) columns.add(id);
      }
    } catch { /* degraded: Done only */ }
    terminalByTaskId.set(other.id, columns);
  }
  const activeOtherTasks = allTasks.filter((other) => (
    other.id !== taskId &&
    other.deletedAt == null &&
    terminalByTaskId.get(other.id)?.has(other.column) !== true
  ));

  for (const file of candidateFiles) {
    if (file === ".fusion" || file.startsWith(".fusion/")) {
      refused.push({ file, reason: "ignored-path" });
      continue;
    }

    if (await isGitIgnored(file, rootDir, execImpl)) {
      refused.push({ file, reason: "ignored-path" });
      continue;
    }

    let claimed = false;
    for (const otherTask of activeOtherTasks) {
      try {
        const otherScope = await store.parseFileScopeFromPrompt(otherTask.id);
        if (scopeContainsPath(otherScope, file)) {
          refused.push({ file, reason: "claimed-by-other-task" });
          claimed = true;
          break;
        }
      } catch {
        // fail-open per-task parse errors for peer prompts
      }
    }
    if (claimed) continue;

    const { stdout } = await execImpl(
      `git log ${quoteArg(`${baseRef}..${branch}`)} --format=%H%x00%s%x00%B%x1e -- ${quoteArg(file)}`,
      {
        cwd: rootDir,
        encoding: "utf-8",
        maxBuffer: GIT_MAX_BUFFER,
      },
    );

    const records = stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean);
    if (records.length === 0) {
      refused.push({ file, reason: "no-attribution" });
      continue;
    }

    const commits: string[] = [];
    const attributions: Attribution[] = [];
    /*
    FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669): the gate's conservative direction is UNCHANGED —
    a file widens only when EVERY commit touching it in the range is this card's own work. What changed
    is which answers count as "not mine": a commit that names no card at all used to fall in here and
    take `foreign-commit`, which both mis-accused the work and reported it as another card's. It now
    refuses `no-attribution`, so the file stays out of the effective scope (main's bytes win, exactly as
    before) while the audit row stops blaming a card that was never named. Foreign work still refuses
    hard, and it wins over an unattributed commit in the same range.
    */
    let refusal: ScopeAutoWidenRefusalReason | null = null;
    for (const record of records) {
      const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
      const body = bodyParts.join("\x00");
      const verdict = classifyCommitAttribution({ subject, body, taskId: attributionTaskId });
      if (verdict.kind === "foreign") {
        refusal = "foreign-commit";
        break;
      }
      if (verdict.kind === "unattributed") {
        refusal = "no-attribution";
        continue;
      }
      commits.push(sha);
      attributions.push(verdict.source as Attribution);
    }

    if (refusal) {
      refused.push({ file, reason: refusal });
      continue;
    }

    widened.push({ file, attribution: collapseObservedAttribution(attributions), commits });
  }

  return { widened, refused };
}

function splitPromptSections(prompt: string): { before: string; section: string; after: string } {
  const headingMatch = prompt.match(/^##\s+File Scope\s*$/m);
  if (!headingMatch || headingMatch.index == null) {
    throw new ScopeAutoWidenPersistError("PROMPT.md missing ## File Scope section");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = prompt.slice(sectionStart);
  const nextHeadingIndex = rest.search(/\n##?\s/);
  const sectionEnd = nextHeadingIndex === -1 ? prompt.length : sectionStart + nextHeadingIndex;

  return {
    before: prompt.slice(0, sectionStart),
    section: prompt.slice(sectionStart, sectionEnd),
    after: prompt.slice(sectionEnd),
  };
}

function parseScopeEntries(section: string): Set<string> {
  const tokens = section.match(/`([^`]+)`/g) ?? [];
  return new Set(tokens.map((token) => token.slice(1, -1)));
}

export async function appendAutoWidenedScopeToPrompt(params: {
  store: Pick<TaskStore, "getTaskDir">;
  taskId: string;
  files: string[];
}): Promise<string[]> {
  const { store, taskId, files } = params;
  if (files.length === 0) return [];

  const promptPath = join(store.getTaskDir(taskId), "PROMPT.md");
  const prompt = await readFile(promptPath, "utf-8");
  const { before, section, after } = splitPromptSections(prompt);
  const existing = parseScopeEntries(section);
  const toAdd = files.filter((file) => !existing.has(file));
  if (toAdd.length === 0) return [];

  const insertion = toAdd.map((file) => `- \`${file}\` <!-- scopeAutoWiden ${taskId} -->`).join("\n");
  const sectionTrimmed = section.trimEnd();
  const normalizedSection = sectionTrimmed.length === 0 ? `\n\n${insertion}\n` : `${sectionTrimmed}\n${insertion}\n`;
  await writeFile(promptPath, `${before}${normalizedSection}${after}`, "utf-8");
  return toAdd;
}
