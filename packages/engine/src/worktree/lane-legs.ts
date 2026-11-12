/*
FNXC:LaneLegGate 2026-11-11-23:20 (RUFU-425):
A workspace member directory can exist without being that member's repository. The measured origin
shape: a lane whose declared member folder held ZERO entries still answered `rev-parse HEAD` with the
commit of the folder that CONTAINS it, because git resolves upward. Every measurement taken "in the
leg" then described the wrong repository, and on a sibling board a card was reported complete with
every acceptance criterion green while its store row said queued and no ref anywhere held a commit.
Five occurrences of that class were recorded before anyone owned it.

The same mechanism is live in this engine at two seams that both trust a path they never identify:
the deterministic verification gate (a configured test/build command run at the leg path) and the
checkout-emptiness prover (a porcelain status plus a commit count at the leg path, where a wrong
`empty` answer releases a live lease). Both ask the wrong repository a fair question and get a
confident wrong answer.

So: identity is proven BEFORE anything is measured, and a leg that is not itself a repository is a
NAMED refusal rather than a data point. The precedent for this ordering is already landed in
`workspace-review-evidence.ts` (reason code `member-worktree-missing`, RUFU-519); this module is that
pattern lifted out of the review lane so the two other seams stop inventing their own half-guard.

Design constraints that shaped this file:
- Legs are enumerated from the task record's workspace entries. No directory name is ever hardcoded,
  so a project that adds a third member needs no change here.
- The probe order is mandated and load-bearing: entry count, then `--show-toplevel`, then HEAD, then
  the lag against a LOCAL trunk ref. Counting first is what lets the empty shape be named `empty`
  instead of being mislabelled as a borrowed top-level, and it is also the cheapest probe.
- The lag stage never contacts a network. A missing local trunk ref is reported as
  `no-local-trunk-ref`, which is a label an operator acts on; silently skipping the comparison is how
  a stale leg keeps producing a false green.
- This module measures and refuses. It never repairs: every verb that could materialise, relocate, or
  clear a checkout belongs to that lane's owner, and a guard that mutates the thing it is judging is
  the defect this card exists to close.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const LANE_LEG_GIT_TIMEOUT_MS = 5_000;
const LANE_LEG_MAX_BUFFER_BYTES = 1024 * 1024;

/** Every state exactly one leg can be in. The set is closed: an unlisted state must not be inventable. */
export const LANE_LEG_CLASSIFICATIONS = [
  "materialized",
  "detached-head",
  "behind-trunk",
  "no-local-trunk-ref",
  "unmeasurable",
  "unborn-repository",
  "borrowed-toplevel",
  "empty-directory",
  "missing-directory",
] as const;

export type LaneLegClassification = (typeof LANE_LEG_CLASSIFICATIONS)[number];

/**
 * Gate-level verdicts. `null` refusal means the measurement was taken and may be trusted.
 * The three non-refusing labels (`materialized`, `detached-head`, `behind-trunk`, plus
 * `no-local-trunk-ref`) are information an operator acts on, never blockers: refusing for them would
 * trade a false green for a false red, which is a different outage with the same shape.
 */
export const LANE_LEG_REFUSAL_CODES = [
  "lane-leg-empty",
  "lane-leg-missing",
  "lane-leg-borrowed-toplevel",
  "lane-leg-unborn",
  "lane-leg-unmeasurable",
] as const;

export type LaneLegRefusalCode = (typeof LANE_LEG_REFUSAL_CODES)[number];

/** What one leg was found to be, with every number carrying the probe that produced it. */
export interface LaneLegRecord {
  repository: string;
  classification: LaneLegClassification;
  /** Directory entries including hidden ones, or `null` when the directory could not be read. */
  entryCount: number | null;
  toplevel: string | null;
  head: string | null;
  /** Commits the LOCAL trunk ref has that HEAD does not; `null` when no local trunk ref resolved. */
  lag: number | null;
}

export type LaneLegAssessment =
  | { refused: false; legs: LaneLegRecord[] }
  | { refused: true; code: LaneLegRefusalCode; repository: string; legs: LaneLegRecord[] };

/** The part of a task row this classifier needs, so it works with a `slim: true` row too. */
export type LaneLegTaskShape = {
  workspaceWorktrees?: Record<string, { worktreePath?: string | null; baseBranch?: string | null } | undefined>;
};

/** Injectable git runner: `(git arguments, working directory)` resolves to trimmed stdout, or throws. */
export type LaneLegExec = (args: readonly string[], cwd: string) => Promise<string>;

export interface LaneLegProbeOptions {
  execImpl?: LaneLegExec;
  timeoutMs?: number;
}

/*
FNXC:LaneLegGate 2026-11-11-23:20 (RUFU-425):
Severity decides WHICH refusal a multi-leg lane reports, and it is a total order over a closed set so
the answer cannot depend on record iteration order. Worst first. The refusal classes necessarily
outrank the label classes: a lane with one empty leg and one unreadable leg must report the
unreadable one, or the guard would pick its own blind spot.
*/
const CLASSIFICATION_SEVERITY: Record<LaneLegClassification, number> = {
  "missing-directory": 0,
  unmeasurable: 1,
  "empty-directory": 2,
  "borrowed-toplevel": 3,
  "unborn-repository": 4,
  "no-local-trunk-ref": 5,
  "behind-trunk": 6,
  "detached-head": 7,
  materialized: 8,
};

/*
FNXC:LaneLegGate 2026-11-11-23:50 (RUFU-425):
The ONE classification -> refusal-code mapping. It is exported because the checkout-emptiness prover
reaches the same labels through a different probe (fork-free, no `LaneLegRecord` behind it) and a
second copy of this table would be a second opinion about what a given discovery is called — which is
exactly how a refusal ends up with a code its own sentence contradicts.
*/
export const REFUSAL_BY_CLASSIFICATION: Partial<Record<LaneLegClassification, LaneLegRefusalCode>> = {
  "missing-directory": "lane-leg-missing",
  unmeasurable: "lane-leg-unmeasurable",
  "empty-directory": "lane-leg-empty",
  "borrowed-toplevel": "lane-leg-borrowed-toplevel",
  "unborn-repository": "lane-leg-unborn",
};

async function defaultExec(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: LANE_LEG_GIT_TIMEOUT_MS,
    maxBuffer: LANE_LEG_MAX_BUFFER_BYTES,
  });
  return stdout.trim();
}

/** A git answer that could not be had is `""`, never a thrown error: every probe treats it as absent. */
async function ask(exec: LaneLegExec, args: readonly string[], cwd: string): Promise<string> {
  try {
    return (await exec(args, cwd)).trim();
  } catch {
    return "";
  }
}

/*
FNXC:LaneLegGate 2026-11-11-23:20 (RUFU-425):
Identity has to survive symlinks, and this comparison is the one shared by every lane-leg consumer.
`resolve()` is purely lexical while git reports a resolved path, so under a symlinked checkout root
(a `/var` -> `/private/var` link, or a linked worktree store) a lexical comparison declares a
perfectly good leg missing. Realpath both sides; fall back to the lexical form only when the
filesystem cannot answer. Landed first in `workspace-review-evidence.ts` for RUFU-519 and lifted here
so the verification gate and the emptiness prover cannot grow a subtly different equality rule.
*/
export async function isSamePath(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  const real = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  return await real(left) === await real(right);
}

function parseCount(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) ? count : null;
}

function record(
  repository: string,
  classification: LaneLegClassification,
  entryCount: number | null,
  toplevel: string | null,
  head: string | null,
  lag: number | null,
): LaneLegRecord {
  return { repository, classification, entryCount, toplevel, head, lag };
}

/**
 * The trunk this leg must be compared with, chosen from what is ALREADY in this repository.
 *
 * The recorded `baseBranch` comes first because it is the ref acquisition wrote down for THIS
 * repository, then the remote's own default-branch alias. Each candidate is verified to name a
 * commit locally before it is used, and an empty answer means the comparison is simply not
 * available — which is reported, not skipped, and never resolved by reaching out over a network.
 */
async function resolveLocalTrunkRef(
  exec: LaneLegExec,
  cwd: string,
  recordedBaseBranch: string | null,
): Promise<string | null> {
  const baseBranchCandidates = recordedBaseBranch
    ? [recordedBaseBranch, `refs/remotes/${recordedBaseBranch}`, `refs/heads/${recordedBaseBranch}`]
    : [];
  const originHead = await ask(exec, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  for (const candidate of originHead ? [...baseBranchCandidates, originHead] : baseBranchCandidates) {
    if (await ask(exec, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], cwd)) return candidate;
  }
  return null;
}

/** Probe one leg in the mandated order and stop at the first stage that decides its state. */
async function probeLeg(
  repository: string,
  worktreePath: string,
  recordedBaseBranch: string | null,
  exec: LaneLegExec,
): Promise<LaneLegRecord> {
  // 1. Entry count including hidden entries. Cheapest probe, and the only one that can name the
  //    reported shape before git is asked anything at all.
  if (!worktreePath) return record(repository, "missing-directory", null, null, null, null);
  let entries: string[] | null = null;
  try {
    entries = await readdir(worktreePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // A path that is absent is a different fact from a path that cannot be read, and the operator
    // remedies differ, so the two never share a label.
    return record(repository, code === "ENOENT" ? "missing-directory" : "unmeasurable", null, null, null, null);
  }
  if (entries.length === 0) return record(repository, "empty-directory", 0, null, null, null);

  // 2. Repository identity: the leg must be its OWN top-level, or every git number below belongs to
  //    somebody else's repository.
  const toplevel = await ask(exec, ["rev-parse", "--show-toplevel"], worktreePath);
  if (!toplevel) return record(repository, "unmeasurable", entries.length, null, null, null);
  if (!await isSamePath(toplevel, worktreePath)) {
    return record(repository, "borrowed-toplevel", entries.length, toplevel, null, null);
  }

  // 3. HEAD. A repository with no commits yet is real but has nothing to measure.
  /*
  FNXC:LaneLegGate 2026-11-11-23:55 (RUFU-425, AC5):
  This read is NOT the ownership test and must never become one. The measured record states that at an
  empty member path `rev-parse HEAD` answers with the ENCLOSING commit, so ownership is decided only by
  stage 2's `rev-parse --show-toplevel` compared against the recorded path; a HEAD read is admissible
  here solely because that test already passed and the path is its own top-level.
  */
  const head = await ask(exec, ["rev-parse", "HEAD"], worktreePath);
  if (!head) return record(repository, "unborn-repository", entries.length, toplevel, null, null);

  // 4. Lag against a local trunk ref. A leg that is real, named, and a full trunk behind still
  //    measures as a clean checkout, which is the same false green one step further along.
  const trunkRef = await resolveLocalTrunkRef(exec, worktreePath, recordedBaseBranch);
  if (!trunkRef) return record(repository, "no-local-trunk-ref", entries.length, toplevel, head, null);
  const lag = parseCount(await ask(exec, ["rev-list", "--count", `HEAD..${trunkRef}`], worktreePath));
  if (lag === null) return record(repository, "no-local-trunk-ref", entries.length, toplevel, head, null);
  if (lag > 0) return record(repository, "behind-trunk", entries.length, toplevel, head, lag);

  // A leg materialised by an initialisation sits in detached HEAD. Measuring it is fine; COMMITTING
  // in it is not, because a commit reached by no ref is unrecoverable. Labeled here so the card that
  // is about to commit reads the warning before it writes the object.
  if (!(await ask(exec, ["symbolic-ref", "--quiet", "HEAD"], worktreePath))) {
    return record(repository, "detached-head", entries.length, toplevel, head, lag);
  }
  return record(repository, "materialized", entries.length, toplevel, head, lag);
}

/**
 * Assess every declared leg of a task before anything measures one of them.
 *
 * Returns `{ refused: false, legs: [] }` for a card with no workspace entries — the singular-card
 * breakpoint, which must pass through with no extra git work and no new verdict field, because most
 * cards in this system have no legs at all.
 */
export async function assessLaneLegs(
  task: LaneLegTaskShape,
  options: LaneLegProbeOptions = {},
): Promise<LaneLegAssessment> {
  const entries = Object.entries(task.workspaceWorktrees ?? {});
  if (entries.length === 0) return { refused: false, legs: [] };

  const exec = options.execImpl ?? defaultExec;
  let legs: LaneLegRecord[] = [];
  for (const [repository, entry] of entries) {
    const rawPath = typeof entry?.worktreePath === "string" ? entry.worktreePath.trim() : "";
    const recordedBase = typeof entry?.baseBranch === "string" ? entry.baseBranch.trim() || null : null;
    // One leg at a time, on purpose: the probes are three cheap reads, and a parallel fan-out over a
    // lane that is about to be refused buys nothing.
    legs = legs.concat(await probeLeg(repository, rawPath, recordedBase, exec));
  }

  // Worst class decides the report; a tie breaks on repository name so two runs of one row agree.
  let worst = legs[0]!;
  for (const leg of legs) {
    const severity = CLASSIFICATION_SEVERITY[leg.classification];
    const worstSeverity = CLASSIFICATION_SEVERITY[worst.classification];
    if (severity < worstSeverity || (severity === worstSeverity && leg.repository < worst.repository)) worst = leg;
  }

  const code = REFUSAL_BY_CLASSIFICATION[worst.classification];
  if (code) return { refused: true, code, repository: worst.repository, legs };
  return { refused: false, legs };
}

/**
 * The path the task record names for one leg.
 *
 * Kept out of {@link LaneLegRecord} on purpose: the measurement record answers "what is this leg",
 * and a filesystem path belongs to the operator's History line, not to a comparable measurement.
 */
export function laneLegRecordedPath(task: LaneLegTaskShape, repository: string): string {
  const entry = task.workspaceWorktrees?.[repository];
  return typeof entry?.worktreePath === "string" ? entry.worktreePath.trim() : "";
}

/**
 * The fork-free subset of the leg probe, for a hot path that may not add git subprocesses.
 *
 * `CheckoutEmptinessProver` proves dozens of checkouts per scheduling pass and its fork count is a
 * measured ratchet (RUFU-871: 1421 spawn samples, 6.1 % of idle dashboard CPU), so it cannot afford
 * `assessLaneLegs`' git probes. It can, however, afford what the filesystem already knows: a
 * checkout's own root always carries `.git`, and an upward walk of `stat` calls is a handful of
 * syscalls rather than a process spawn.
 *
 * Answers:
 * - `own-checkout` — the directory carries its own `.git`, so a read at this path is this leg's.
 * - `empty-directory` — the reported shape: zero entries, so anything read here is the enclosing tree.
 * - `borrowed-toplevel` — populated, no `.git` here, and an ancestor carries one.
 * - `unmeasurable` — populated, no `.git` here, and no ancestor within the walk carries one, or the
 *   directory could not be read at all.
 * - `missing-directory` — no directory at the path. A CALLER THAT HAS A REFS-ONLY PROOF MODE must keep
 *   using it: that mode is the designed answer for a released worktree and predates this guard.
 */
export type LaneLegLocalState =
  | "own-checkout"
  | "empty-directory"
  | "borrowed-toplevel"
  | "unmeasurable"
  | "missing-directory";

/** How far the `.git` walk looks for an enclosing repository before the answer becomes unknown. */
const LANE_LEG_ANCESTOR_WALK_LIMIT = 12;

async function hasOwnGitMarker(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function inspectLaneLegLocal(path: string): Promise<LaneLegLocalState> {
  if (!path) return "missing-directory";
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing-directory" : "unmeasurable";
  }
  // Zero entries is named before the marker check so the reported shape keeps its own label instead of
  // collapsing into "not a repository root": the two have different operator remedies.
  if (entries.length === 0) return "empty-directory";
  if (entries.includes(".git")) return "own-checkout";
  // A hidden-entry-insensitive check would miss `.git`; readdir already includes dotfiles above.
  let ancestor = resolve(path);
  for (let depth = 0; depth < LANE_LEG_ANCESTOR_WALK_LIMIT; depth += 1) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
    if (await hasOwnGitMarker(ancestor)) return "borrowed-toplevel";
  }
  return "unmeasurable";
}

/** The lane directory names that gate refusals resolve to, for surfaces that render them. */
export function describeLaneLegRefusal(code: LaneLegRefusalCode, repository: string): string {
  switch (code) {
    case "lane-leg-empty":
      return `Workspace repository "${repository}" has an empty directory at its recorded path, so git there reads the enclosing project. Nothing was measured.`;
    case "lane-leg-missing":
      return `Workspace repository "${repository}" has no directory at its recorded path. Nothing was measured.`;
    case "lane-leg-borrowed-toplevel":
      return `Workspace repository "${repository}" is not a repository of its own: its path resolves into an enclosing project. Nothing was measured.`;
    case "lane-leg-unborn":
      return `Workspace repository "${repository}" has no commits yet, so no verification result taken there can be attributed to it. Nothing was measured.`;
    case "lane-leg-unmeasurable":
      return `Workspace repository "${repository}" could not be read as a checkout, so its state is unknown rather than clean. Nothing was measured.`;
  }
}
