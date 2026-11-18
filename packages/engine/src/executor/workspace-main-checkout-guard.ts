/*
 * FNXC:Workspace 2026-08-15-07:05:
 * Completion, review, and merge inspect only acquired workspace worktrees. Probe every configured
 * main checkout so direct edits cannot bypass those surfaces. Classification uses execution time,
 * not File Scope: unenumerated and unscoped paths must not become an escape hatch.
 *
 * FNXC:WorkspaceFinalization 2026-08-27-08:42:
 * Only COMMITS in a main checkout are a completion violation. Uncommitted status entries warn.
 * Two measured reasons. (1) The very next pipeline stage absorbs a dirty main checkout: workspace
 * lands call the same `landOneRepo`/`landSquash` mechanic as single-repo with `projectRootDir` set
 * to the sub-repo main checkout, so a dirty tree there is stashed (untracked included) -> ff ->
 * restored under `merger.allowDirtyLocalCheckoutSync`, or the landing refuses with the ref unmoved
 * when the stash is impossible (STAS-292: a ref is never advanced past a checkout that cannot
 * follow it). Refusing completion for a state the merger is built to handle stops the board for
 * nothing. (2) Attribution had no evidence: a File Scope match was
 * treated as task work with NO timing test, so an operator editing the same feature in the shared
 * checkout was indistinguishable from an agent that skipped its pre-created task worktree — and the
 * refusal named an operator-only remedy, so the card could only loop.
 * The dangerous cases keep hard refusals elsewhere: a task-attributed commit still returns
 * `main_checkout_edit` (it would reach the shared branch unreviewed), and work that exists ONLY in
 * the main checkout now falls through to the acquired-worktree `no_commits` invariant, which
 * refuses because the acquired worktree carries no commits.
 *
 * FNXC:WorkspaceFinalization 2026-11-18-13:57:
 * "Task-attributed" now means a STRUCTURAL marker (attribution trailer or task-ID subject prefix),
 * never a bare mention of the task ID in the message. Production refused a card over a commit whose
 * subject named a *different* card and whose prose merely cross-referenced this one, and the
 * published-to-remote delivery proof is what lets an already-shipped commit out of the refusal.
 * See `commitMessageAttributesTask` and the decision site in the commit loop below.
 */
import { exec } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Settings, Task } from "@fusion/core";
import { normalizeRepoRelPath, resolveRepoDeclaredScope } from "../worktree/workspace-paths.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";
import { isAlwaysAllowedScopeLeakPath, workflowPathMatchesDeclaredScope } from "./workflow-feedback-paths.js";

const execAsync = promisify(exec);
const probeOptions = { encoding: "utf-8" as const, timeout: 10_000, maxBuffer: 1024 * 1024 };
export type MainCheckoutEvidence = "task-era-change" | "declared-scope-change" | "task-attributed-commit" | "post-anchor-commit";
/**
 * `uncommitted-only`: task-era or in-scope status entries with no commit behind them (2026-08-27).
 * `published-to-remote`: a structurally task-attributed main-checkout commit already reachable from
 * a remote-tracking ref — refusing cannot recover it, so it warns (2026-11-18).
 */
export type MainCheckoutWarningReason = "pre-existing-dirt" | "anchor-unresolved" | "commit-scan-unavailable" | "uncommitted-only" | "published-to-remote";
export type MainCheckoutFinding = { repo: string; files: string[]; commits: string[]; evidence: MainCheckoutEvidence };
/** `evidence` is retained on downgraded findings so telemetry keeps the classification it had. */
export type MainCheckoutWarning = { repo: string; files: string[]; commits: string[]; reason: MainCheckoutWarningReason; evidence?: MainCheckoutEvidence };
export type MainCheckoutGuardResult = { violations: MainCheckoutFinding[]; warnings: MainCheckoutWarning[]; skipped: string[] };

/** Earliest durable attempt timestamp, with a small filesystem clock tolerance. */
export function workspaceExecutionAnchor(task: Task): number | null {
  const executionValues = [task.firstExecutionAt, task.executionStartedAt]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  const values = executionValues.length
    ? executionValues
    : [typeof task.createdAt === "string" ? Date.parse(task.createdAt) : Number.NaN].filter(Number.isFinite);
  return values.length ? Math.min(...values) - 5_000 : null;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function nearestMtime(filePath: string): Promise<number | null> {
  let candidate = filePath;
  while (true) {
    try { return (await fs.stat(candidate)).mtimeMs; } catch { /* climb for deletions */ }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function parseStatus(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).filter(Boolean);
}

/**
 * Subject and body arrive as SEPARATE fields (`%s`/`%b`), deliberately not as one `%B` blob:
 * `%B` contains the subject line, so a subject-prefix rule run over it would misfire on a
 * multi-line message that merely starts with an ID-like line.
 *
 * FNXC:WorkspaceFinalization 2026-11-18-13:57:
 * `git log --format` appends a NEWLINE after every record, so every record after the first arrives
 * prefixed with `\n` and the leading newline lands in the FIRST field — the sha. Left in place it
 * made `entry.landedSha === commit.sha` unmatchable for any but the newest commit in the window and
 * fed a `\n`-prefixed sha to the remote-containment probe, which honestly rejects a malformed object
 * name — i.e. an already-published older commit would have been refused again. RUFU-594's
 * cross-reference regression is what exposed it (only the second commit in the window carried it).
 */
function parseCommits(stdout: string): Array<{ sha: string; committedAt: number; subject: string; body: string }> {
  return stdout.split("\x1e").filter(Boolean).flatMap((record) => {
    const [sha, timestamp, subject = "", body = ""] = record.replace(/^\s+/, "").split("\x1f");
    const committedAt = Number(timestamp) * 1000;
    return sha && Number.isFinite(committedAt) ? [{ sha, committedAt, subject, body }] : [];
  });
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FALLBACK_ATTRIBUTION_TRAILER_NAMES = ["Fusion-Task-Id"];

/**
 * Structural commit attribution — the ONLY evidence that a main-checkout commit is this task's work.
 *
 * FNXC:WorkspaceFinalization 2026-11-18-13:57:
 * RULING: a bare occurrence of the task ID anywhere in the message is NOT attribution. Measured in
 * production on 2026-10-06 (SANE-453): a human-written commit whose subject was
 * `SANE-452: document the TaskStore cold-boot lottery …` mentioned `SANE-453` in its prose, and the
 * old `task.id|Fusion-Task-Id:\s*<id>` body regex read that cross-reference as authorship, refusing
 * `fn_task_done` for a card that had never touched the checkout. The remedy the refusal named
 * ("move it onto the acquired fusion/<id> worktree branch") was un-actionable because the commit was
 * already published. The codebase already treats two shapes as authorship — a line-anchored
 * attribution trailer and a task-ID subject anchor (`getCommitTaskOwnership` in
 * `merge/already-merged-detector.ts`, `commitOwnedByTask` in `merge/merger-owned-landed.ts`,
 * `branch-conflicts.ts`) — so this predicate mirrors them instead of inventing a third definition.
 *
 * Accepted forms:
 * - a configured attribution trailer: a whole body line `<trailerName>: <taskId>`, for every name in
 *   `taskAttributionTrailerNames` (user-configured strings, so they are escaped, never interpolated raw);
 * - a conventional-commit subject with the ID in the scope or subject-head position:
 *   `fix(<id>): …`, `feat(<id>)!: …`, `chore(<scope> <id>): …`;
 * - a bare subject prefix `<id>: …` — the shape the SANE-452 commit uses for *its own* ID.
 *
 * Every pattern enforces an ID boundary (`\b`), so `FN-1001` never matches `FN-10011` or `FN-1001A`.
 * Case-insensitive, matching the guard's previous regex. A prose mention, URL, or `See FN-1001`
 * reference returns false by construction: nothing here scans free text.
 */
export function commitMessageAttributesTask(
  message: { subject: string; body: string },
  taskId: string,
  trailerNames?: readonly string[],
): boolean {
  const id = escapeForRegex(taskId);
  // Blank configured entries are not usable trailer keys; an unusable list falls back to the
  // product default rather than silently disabling trailer attribution.
  const names = (trailerNames ?? []).map((name) => name.trim()).filter(Boolean);
  for (const name of names.length ? names : FALLBACK_ATTRIBUTION_TRAILER_NAMES) {
    const trailer = new RegExp(`^[ \\t]*${escapeForRegex(name)}:[ \\t]*${id}[ \\t]*$`, "im");
    if (trailer.test(message.body)) return true;
  }
  // The conventional scope group is required to hold the ID: a bare `feat: …` subject is not
  // ownership evidence, exactly as `getCommitTaskOwnership` rules (incident bug #2 — prose mentions).
  const subjectAnchor = new RegExp(`^(?:[a-z]+\\((?:[^)]*)\\b${id}\\b[^)]*\\)!?:|${id}\\b[ \\t]*:)`, "i");
  return subjectAnchor.test(message.subject);
}

/**
 * Third delivery proof: the commit is already contained in a REMOTE-tracking ref.
 *
 * FNXC:WorkspaceFinalization 2026-11-18-13:57:
 * RULING: a commit reachable from a remote-tracking ref cannot be recovered by refusing completion,
 * so it warns. Measured 2026-10-06 (SANE-453): the commit was a `merge-base --is-ancestor` yes
 * against `origin/main` nine days before the card tried to finish, and the only escape hatch the
 * guard offered (`entry.baseCommitSha` ancestry) needs a `workspaceWorktrees[repo]` record the card
 * did not have — so a published, human-written commit read as a fresh bypass. Refusing it asks the
 * operator to rewrite pushed history. Mirrors the in-repo ref-containment idiom in
 * `execution/branch-autocorrect.ts` (`git for-each-ref --contains <sha> refs/heads/`), narrowed to
 * `refs/remotes/`: the scan is rooted at the main checkout's own HEAD, so LOCAL ancestry is trivially
 * true and would neutralise the guard entirely — only remote containment proves delivery.
 *
 * Unknown is NOT proven: a non-zero exit, a timeout, or any other error returns false (never throws,
 * never accepts), so a repository with no remote keeps refusing.
 *
 * Exported so the probe's own error contract (unreadable repository, unknown object, empty ref
 * listing) is testable directly — the guard's call site cannot otherwise reach a failing git without
 * corrupting a fixture repository.
 */
export async function commitPublishedToRemote(sha: string, cwd: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  try {
    const { stdout } = await execAsync(`git for-each-ref --format='%(refname:short)' --contains ${sha} refs/remotes/`, { ...probeOptions, cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Read-only evidence collector for task-era writes in configured workspace main checkouts.
 * It intentionally scans status with untracked files and a bounded HEAD window rather than a
 * diff-base range: a main checkout's branch advances with the bypass commit, making base..HEAD empty.
 */
export async function detectWorkspaceMainCheckoutWork(
  deps: { rootDir: string; settings: Settings },
  task: Task,
  repos: readonly string[],
  declaredScope: readonly string[],
): Promise<MainCheckoutGuardResult> {
  const violations: MainCheckoutFinding[] = [];
  const warnings: MainCheckoutWarning[] = [];
  const skipped: string[] = [];
  const anchor = workspaceExecutionAnchor(task);
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = [...new Set([...repos, ...Object.keys(workspaceWorktrees)])].map(normalizeRepoRelPath).filter(Boolean).sort();
  const recordedPaths = Object.values(workspaceWorktrees).map((entry) => path.resolve(entry.worktreePath));
  for (const repo of repoKeys) {
    const checkout = path.resolve(deps.rootDir, repo);
    if (!existsSync(checkout) || recordedPaths.some((candidate) => candidate === checkout)) { skipped.push(repo); continue; }
    try {
      const { stdout: insideWorkTree } = await execAsync("git rev-parse --is-inside-work-tree", { ...probeOptions, cwd: checkout });
      const { stdout: topLevel } = await execAsync("git rev-parse --show-toplevel", { ...probeOptions, cwd: checkout });
      // FNXC:Workspace 2026-08-15-07:27:
      // A configured path can sit inside an enclosing Git checkout without being a repository itself.
      // Require its canonical top-level to be itself so an invalid repo entry cannot inspect unrelated
      // operator work or consume fn_task_done's bounded refusal budget.
      if (insideWorkTree.trim() !== "true" || await fs.realpath(topLevel.trim()) !== await fs.realpath(checkout)) {
        skipped.push(repo);
        continue;
      }
    } catch { skipped.push(repo); continue; }
    const repoScope = resolveRepoDeclaredScope(declaredScope, repo, repoKeys).scope;
    const worktreesDir = path.resolve(resolveWorktreesDir(checkout, deps.settings, { workspaceRootDir: deps.rootDir, repoRelPath: repo }));
    const excluded = (file: string) => {
      const absolute = path.resolve(checkout, file);
      return file === ".fusion" || file.startsWith(".fusion/") || isWithin(absolute, worktreesDir) || recordedPaths.some((candidate) => isWithin(absolute, candidate));
    };
    let statusFiles: string[] = [];
    try {
      const { stdout } = await execAsync("git status --porcelain=v1 -uall --no-renames -z", { ...probeOptions, cwd: checkout });
      statusFiles = parseStatus(stdout).filter((file) => !excluded(file));
    } catch { skipped.push(repo); continue; }
    const taskFiles: string[] = [];
    const oldFiles: string[] = [];
    for (const file of statusFiles) {
      const mtime = await nearestMtime(path.resolve(checkout, file));
      const inScope = !isAlwaysAllowedScopeLeakPath(file) && workflowPathMatchesDeclaredScope(file, repoScope);
      if (inScope) taskFiles.push(file);
      else if (anchor !== null && mtime !== null && mtime >= anchor) taskFiles.push(file);
      else oldFiles.push(file);
    }
    // FNXC:WorkspaceFinalization 2026-08-27-08:42: status-only evidence is reported, never refused (see header).
    if (taskFiles.length) {
      warnings.push({
        repo,
        files: taskFiles,
        commits: [],
        reason: "uncommitted-only",
        evidence: repoScope.length && taskFiles.some((file) => workflowPathMatchesDeclaredScope(file, repoScope)) ? "declared-scope-change" : "task-era-change",
      });
    }
    if (oldFiles.length) warnings.push({ repo, files: oldFiles, commits: [], reason: anchor === null ? "anchor-unresolved" : "pre-existing-dirt" });
    if (anchor === null && statusFiles.length && !oldFiles.length) warnings.push({ repo, files: statusFiles, commits: [], reason: "anchor-unresolved" });
    try {
      // FNXC:WorkspaceFinalization 2026-11-18-13:57: `%s` and `%b` are separate fields so attribution can
      // tell a subject-prefix claim from a body cross-reference; `%B` would blur the two (see parseCommits).
      const { stdout } = await execAsync("git log -n 200 --format=%H%x1f%ct%x1f%s%x1f%b%x1e HEAD", { ...probeOptions, cwd: checkout });
      const entry = workspaceWorktrees[repo];
      const trailerNames = deps.settings.taskAttributionTrailerNames;
      for (const commit of parseCommits(stdout)) {
        const recordedLanding = entry?.landedSha === commit.sha
          || task.mergeDetails?.workspaceLandedShas?.[repo] === commit.sha
          || task.mergeDetails?.commitSha === commit.sha;
        let reachableFromBaseline = false;
        if (entry?.baseCommitSha) {
          try {
            await execAsync(`git merge-base --is-ancestor ${commit.sha} ${entry.baseCommitSha}`, { ...probeOptions, cwd: checkout });
            reachableFromBaseline = true;
          } catch {
            // A missing/unreadable base is handled by the timestamp fallback below.
          }
        }
        const undelivered = !recordedLanding && !reachableFromBaseline;
        const postAnchor = anchor !== null && commit.committedAt >= anchor;
        // Pre-baseline or pre-execution commits are historical task prose, never a direct edit:
        // attribution alone must not permanently block workspace completion (2026-08-21).
        if (!undelivered || !postAnchor) continue;
        /*
        FNXC:WorkspaceFinalization 2026-11-18-13:57:
        Two narrowing rules decide this verdict, and both were production-measured on 2026-10-06:
        (a) attribution requires a STRUCTURAL marker — a configured attribution trailer or a task-ID
            subject prefix — never a bare ID mention in the body (`commitMessageAttributesTask`), so a
            cross-reference in another card's commit message can no longer be read as authorship; and
        (b) a commit already reachable from a remote-tracking ref is reported as `published-to-remote`
            rather than refused, because refusing completion cannot recover published work and the
            named remedy would demand rewriting pushed history.
        A structurally attributed, genuinely undelivered commit (no recorded landing, no recorded base
        ancestry, no remote containment — e.g. any repository with no remote at all) still refuses
        exactly as before, which is what keeps the zero-acquire bypass protection intact.
        */
        if (!commitMessageAttributesTask({ subject: commit.subject, body: commit.body }, task.id, trailerNames)) {
          // Foreign post-anchor commits stay warnings (2026-08-21).
          warnings.push({ repo, files: [], commits: [commit.sha], reason: "pre-existing-dirt" });
          continue;
        }
        // The remote probe is reached only for an attributed, otherwise-undelivered, post-anchor
        // commit, so the other ~200 commits in the window cost no extra git process.
        if (await commitPublishedToRemote(commit.sha, checkout)) {
          warnings.push({ repo, files: [], commits: [commit.sha], reason: "published-to-remote", evidence: "task-attributed-commit" });
          continue;
        }
        violations.push({ repo, files: [], commits: [commit.sha], evidence: "task-attributed-commit" });
      }
    } catch { warnings.push({ repo, files: [], commits: [], reason: "commit-scan-unavailable" }); }
  }
  return { violations, warnings, skipped };
}
