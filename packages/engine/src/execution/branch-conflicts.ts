import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";

const execAsync = promisify(exec);
const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface BranchConflictCommit {
  sha: string;
  subject: string;
}

export interface BranchCrossContaminationCommit extends BranchConflictCommit {
  foreignTaskId: string;
}

export interface BranchConflictDetails {
  branchName: string;
  conflictingWorktreePath: string;
  /**
   * FNXC:BranchCollisionRecovery 2026-09-20-00:56:
   * Bare collisions need a durable typed source because their requested path is absent.
   */
  collisionKind?: "foreign-unmerged";
  existingTipSha: string;
  strandedCommits: BranchConflictCommit[];
  startPoint: string;
  recommendedAction: string;
}

export class BranchConflictError extends Error implements BranchConflictDetails {
  readonly name = "BranchConflictError";
  readonly branchName: string;
  readonly conflictingWorktreePath: string;
  readonly existingTipSha: string;
  readonly strandedCommits: BranchConflictCommit[];
  readonly startPoint: string;
  readonly recommendedAction: string;
  readonly collisionKind?: "foreign-unmerged";

  constructor(details: BranchConflictDetails) {
    const commitSummary = details.strandedCommits.length > 0
      ? `${details.strandedCommits.length} stranded commit${details.strandedCommits.length === 1 ? "" : "s"}`
      : "no stranded commits";
    super(
      `Branch ${details.branchName} is already checked out at ${details.conflictingWorktreePath} ` +
      `(tip ${details.existingTipSha.slice(0, 12)}, ${commitSummary} since ${details.startPoint}). ` +
      details.recommendedAction,
    );
    this.branchName = details.branchName;
    this.conflictingWorktreePath = details.conflictingWorktreePath;
    this.existingTipSha = details.existingTipSha;
    this.strandedCommits = details.strandedCommits;
    this.startPoint = details.startPoint;
    this.recommendedAction = details.recommendedAction;
    this.collisionKind = details.collisionKind;
  }
}

export function isBranchConflictError(error: unknown): error is BranchConflictError {
  return error instanceof BranchConflictError;
}

export interface BranchCrossContaminationDetails {
  branchName: string;
  baseSha: string;
  taskId: string;
  foreignCommits: BranchCrossContaminationCommit[];
}

export class BranchCrossContaminationError extends Error implements BranchCrossContaminationDetails {
  readonly name = "BranchCrossContaminationError";
  readonly branchName: string;
  readonly baseSha: string;
  readonly taskId: string;
  readonly foreignCommits: BranchCrossContaminationCommit[];

  constructor(details: BranchCrossContaminationDetails) {
    super(
      `Branch ${details.branchName} contains ${details.foreignCommits.length} foreign task-attributed commits ` +
      `since base ${details.baseSha.slice(0, 12)} for ${details.taskId}`,
    );
    this.branchName = details.branchName;
    this.baseSha = details.baseSha;
    this.taskId = details.taskId;
    this.foreignCommits = details.foreignCommits;
  }
}

export interface InspectBranchConflictInput {
  repoDir: string;
  branchName: string;
  conflictingWorktreePath: string;
  requestingTaskId: string;
  ownerTaskId?: string;
  startPoint?: string;
  integrationRef?: string;
}

/*
FNXC:BranchBaseIdentity 2026-09-13-02:10:
RUFU-231 Deliverable 1 (zero-own-commit wedge): every landed/foreign proof previously measured
against the LOCAL integration identity only. A card whose branch was rebased onto
`<remote>/<integrationBranch>` sits on a commit that local `<integrationBranch>` does not contain
(local is behind), so its inherited foreign tip proved "not merged" while it was in fact landed
upstream. The wedge re-detected `live-foreign` forever because no proof could ever pass against a
mis-trusted identity. Trusted refs = the local integration branch plus its remote-tracking
counterparts (`<remote>/<branch>`), discovered from `git remote show`.
*/

/**
 * Resolve the ordered set of integration identities a task branch's landed state may be proven
 * against: the local integration branch first, then each `<remote>/<integrationBranch>` that
 * exists locally. Local-first keeps existing verdicts byte-identical; the remote-tracking
 * entries are the additional trusted identity for a branch that was rebased onto it.
 */
export async function resolveTrustedIntegrationRefs(repoDir: string, integrationRef: string): Promise<string[]> {
  const refs = [integrationRef];
  let remotes: string[] = [];
  try {
    const output = await runGit(repoDir, "git remote");
    remotes = output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return refs;
  }
  for (const remote of remotes) {
    const remoteRef = `${remote}/${integrationRef}`;
    try {
      await revParse(repoDir, remoteRef);
    } catch {
      continue;
    }
    if (!refs.includes(remoteRef)) refs.push(remoteRef);
  }
  return refs;
}

export type TipLandedVia = "local" | "remote-tracking";

export interface TipAlreadyLandedFields {
  /**
   * Which trusted integration identity the branch tip is proven landed against. `remote-tracking`
   * marks a landing the LOCAL identity could not prove — the RUFU-231 wedge shape — and is the
   * signal consumers must require an explicit clean-checkout proof before releasing the checkout.
   */
  landedVia: TipLandedVia;
}

export type BranchConflictInspectionResult =
  | { kind: "stale" }
  | { kind: "stale-resolved" }
  | { kind: "tip-already-merged"; livePath: string | null; tipSha: string; integrationRef: string } & TipAlreadyLandedFields
  | { kind: "fully-subsumed"; livePath: string; tipSha: string }
  | { kind: "reclaimable"; livePath: string; tipSha: string; taskAttributedCommitCount: number; strandedCommits: BranchConflictCommit[] }
  | { kind: "live-foreign"; livePath: string; error: BranchConflictError };

/**
 * FNXC:WorktreeAcquisition 2026-07-16-00:00:
 * FN-8132 / #2232 needs a classifier for a bare `git worktree add -b` collision,
 * where the requested path normally does not exist. Unlike inspectBranchConflict,
 * this path must enumerate live worktrees before considering branch recovery:
 * only exclusively task-attributed unique commits are reclaimable; any foreign or
 * unattributed unique commit, including mixed history, remains protected.
 */
export type BareBranchCollisionInspectionResult =
  | { kind: "missing" }
  | { kind: "tip-already-merged"; tipSha: string; integrationRef: string } & TipAlreadyLandedFields
  | { kind: "fully-subsumed"; tipSha: string }
  | { kind: "reclaimable"; tipSha: string; taskAttributedCommitCount: number; uniqueCommitCount: number }
  | { kind: "foreign-unmerged"; tipSha: string; uniqueCommitCount: number; error: BranchConflictError }
  | { kind: "live-foreign"; tipSha: string; error: BranchConflictError };

interface UniqueBranchCommitListResult {
  commits: BranchConflictCommit[];
  mainRef: string;
  degraded: boolean;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runGit(repoDir: string, command: string): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function revParse(repoDir: string, ref: string): Promise<string> {
  return runGit(repoDir, `git rev-parse --verify ${quoteShellArg(`${ref}^{commit}`)}`);
}

async function isAncestor(repoDir: string, sha: string, ref: string): Promise<boolean> {
  try {
    await execAsync(`git merge-base --is-ancestor ${quoteShellArg(sha)} ${quoteShellArg(ref)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function listStrandedCommits(repoDir: string, startPoint: string, branchName: string): Promise<BranchConflictCommit[]> {
  try {
    const output = await runGit(
      repoDir,
      `git log --reverse --format=%H%x09%s ${quoteShellArg(`${startPoint}..${branchName}`)}`,
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subjectParts] = line.split("\t");
        return { sha, subject: subjectParts.join("\t") };
      });
  } catch {
    return [];
  }
}

async function resolveBranchComparisonRef(repoDir: string, startPoint: string, branchName: string): Promise<string> {
  try {
    await revParse(repoDir, startPoint);
    await runGit(repoDir, `git merge-base ${quoteShellArg(startPoint)} ${quoteShellArg(branchName)}`);
    return startPoint;
  } catch {
    const resolved = await resolveIntegrationBranch(repoDir, undefined);
    return resolved;
  }
}

export async function listUniqueBranchCommits(
  repoDir: string,
  startPoint: string,
  branchName: string,
): Promise<UniqueBranchCommitListResult> {
  const mainRef = await resolveBranchComparisonRef(repoDir, startPoint, branchName);
  try {
    const comparisonBase = await runGit(repoDir, `git merge-base ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)}`);
    const cherryOutput = await runGit(
      repoDir,
      `git cherry ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)} ${quoteShellArg(comparisonBase)}`,
    );
    const plusTokens = cherryOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

    const commits: BranchConflictCommit[] = [];
    for (const token of plusTokens) {
      const [sha, subject] = await Promise.all([
        runGit(repoDir, `git rev-parse --verify ${quoteShellArg(`${token}^{commit}`)}`).catch(() => token),
        runGit(repoDir, `git log -1 --format=%s ${quoteShellArg(token)}`).catch(() => ""),
      ]);
      commits.push({ sha, subject });
    }

    return {
      commits,
      mainRef,
      degraded: false,
    };
  } catch {
    return {
      commits: await listStrandedCommits(repoDir, mainRef, branchName),
      mainRef,
      degraded: true,
    };
  }
}

async function getWorktreeBranchMap(repoDir: string): Promise<Map<string, string>> {
  const output = await runGit(repoDir, "git worktree list --porcelain");
  const map = new Map<string, string>();
  let currentWorktree: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch refs/heads/") && currentWorktree) {
      map.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    }
    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return map;
}


interface TaskAttributionSummary {
  ownCount: number;
  foreignCount: number;
}

async function summarizeTaskAttributedCommits(repoDir: string, range: string, taskId: string): Promise<TaskAttributionSummary> {
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownSubjectPattern = new RegExp(`^(feat|fix|test|chore|docs|refactor|perf|build)\\(${escapedTaskId}\\):`);
  const ownTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escapedTaskId}(?:\\n|$)`);
  const genericSubjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const genericTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}:\\s*(FN-\\d+)(?:\\n|$)`, "i");
  let output = "";
  try {
    output = await runGit(repoDir, `git log --format=%H%x00%s%x00%b ${quoteShellArg(range)}`);
  } catch {
    return { ownCount: 0, foreignCount: 0 };
  }
  if (!output) return { ownCount: 0, foreignCount: 0 };

  const normalizedTaskId = taskId.toUpperCase();
  const tokens = output.split("\u0000");
  let ownCount = 0;
  let foreignCount = 0;
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const subject = tokens[i + 1] ?? "";
    const body = tokens[i + 2] ?? "";
    if (ownSubjectPattern.test(subject) || ownTrailerPattern.test(body)) {
      ownCount += 1;
      continue;
    }
    const subjectMatch = subject.match(genericSubjectPattern);
    const trailerMatch = body.match(genericTrailerPattern);
    const attributedTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
    if (attributedTaskId && attributedTaskId !== normalizedTaskId) {
      foreignCount += 1;
    }
  }

  return { ownCount, foreignCount };
}

export interface BranchAttributionReport {
  /** Commits whose subject matches `<type>(<taskId>):` AND carry the trailer. */
  ownTrailed: number;
  /** Commits attributed to taskId via subject but missing the Fusion-Task-Id trailer
   *  (signals: hook didn't fire — worktree was used without identity guards). */
  ownUntrailed: { sha: string; subject: string }[];
  /** Commits attributed to a different FN-id via subject or trailer (contamination). */
  foreign: { sha: string; subject: string; foreignTaskId: string }[];
  /** Commits with neither a conventional subject nor any trailer (orphaned writes). */
  unattributed: { sha: string; subject: string }[];
}

/**
 * Post-session audit of every commit in `base..branch`. Used by the executor
 * immediately after a step-session completes to detect three classes of
 * contamination early — long before merge time:
 *
 *   1. ownUntrailed: agent committed legitimately but the commit-msg hook
 *      didn't fire (missing fusion-task-id, --no-verify, plumbing commit).
 *   2. foreign: another task's work landed on this branch (FN-5233 pattern).
 *   3. unattributed: commit lacks both subject prefix and trailer (often a
 *      hand-merged commit or plumbing-driven update).
 *
 * Returns counts/details rather than throwing so callers can decide whether
 * to refuse, warn, or just audit.
 */
export async function reportBranchAttribution(
  repoDir: string,
  branch: string,
  baseSha: string,
  taskId: string,
): Promise<BranchAttributionReport> {
  const report: BranchAttributionReport = { ownTrailed: 0, ownUntrailed: [], foreign: [], unattributed: [] };
  const output = await runGit(repoDir, `git log --format=%H%x1f%s%x1f%b%x1e ${quoteShellArg(`${baseSha}..${branch}`)}`)
    .catch(() => "");
  if (!output) return report;
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownSubjectPattern = new RegExp(`^(feat|fix|test|chore|docs|refactor|perf|build)\\(${escapedTaskId}\\):`, "i");
  const ownTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escapedTaskId}\\s*(?:\\n|$)`, "i");
  const genericSubjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const genericTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}:\\s*(FN-\\d+)\\s*(?:\\n|$)`, "i");
  const normalizedTaskId = taskId.toUpperCase();
  for (const record of output.split("").map((entry) => entry.trim()).filter(Boolean)) {
    const [sha = "", subject = "", body = ""] = record.split("");
    const subjectMatch = subject.match(genericSubjectPattern);
    const trailerMatch = body.match(genericTrailerPattern);
    const attributedTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
    if (attributedTaskId && attributedTaskId !== normalizedTaskId) {
      report.foreign.push({ sha, subject, foreignTaskId: attributedTaskId });
      continue;
    }
    if (!attributedTaskId) {
      report.unattributed.push({ sha, subject });
      continue;
    }
    const trailerPresent = ownTrailerPattern.test(body);
    const subjectPresent = ownSubjectPattern.test(subject);
    if (subjectPresent && trailerPresent) {
      report.ownTrailed += 1;
    } else if (subjectPresent && !trailerPresent) {
      report.ownUntrailed.push({ sha, subject });
    } else {
      // trailer present, subject not — counts as trailed-own.
      report.ownTrailed += 1;
    }
  }
  return report;
}

/**
 * True iff `branch`'s tip commit carries a `Fusion-Task-Id: <taskId>` trailer.
 * Used as the cheap "is this branch ref authoritative for this task" probe
 * at merge handoff so that HEAD drift (detached, wrong branch) can recover
 * via a safe re-attach instead of refusing the handoff outright.
 */
export async function branchTipCarriesTaskIdTrailer(
  repoDir: string,
  branch: string,
  taskId: string,
): Promise<boolean> {
  try {
    const body = await runGit(repoDir, `git log -1 --pretty=%B ${quoteShellArg(branch)}`);
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escaped}\\s*(?:\\n|$)`);
    return pattern.test(body);
  } catch {
    return false;
  }
}

/**
 * Whole-branch authority check: the branch ref exists, its tip carries the
 * task's Fusion-Task-Id trailer.
 *
 * Returns `{ ok: true }` when safe to treat the branch ref as authoritative
 * for `taskId`. On failure, returns `{ ok: false, reason }` so callers can
 * log/audit why the gentle recovery was refused.
 */
export async function isBranchAuthoritativeForTask(
  repoDir: string,
  branch: string,
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await revParse(repoDir, `refs/heads/${branch}`);
  } catch {
    return { ok: false, reason: "branch-ref-missing" };
  }
  const tipCarriesTrailer = await branchTipCarriesTaskIdTrailer(repoDir, branch, taskId);
  if (!tipCarriesTrailer) {
    return { ok: false, reason: "tip-missing-task-trailer" };
  }
  return { ok: true };
}

export async function assertCleanBranchAtBase(
  repoDir: string,
  branchName: string,
  baseSha: string,
  taskId: string,
): Promise<void> {
  // Foreign task attribution in a branch range is informational only. Stacked
  // task branches and cherry-equivalent commits are handled by merge/display
  // attribution, not by failing worktree acquisition or branch authority.
  void repoDir;
  void branchName;
  void baseSha;
  void taskId;
}

export interface ClassifyBootstrapMisbindingInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  /**
   * Optional and advisory only. The classifier derives the foreign-commit
   * count from its own `git log baseSha..branchName` walk because callers
   * such as the auto-recovery fallback in `branch-worktree.ts` only have a
   * `BranchConflictInspectionResult` (no foreign-commit list) and used to
   * pass `[]`, which silently disabled the predicate.
   */
  foreignCommits?: BranchCrossContaminationCommit[];
}

export interface ClassifyBootstrapMisbindingResult {
  isBootstrapMisbinding: boolean;
  ownCommitCount: number;
  foreignCommitCount: number;
  nonAttributedCount: number;
}

export async function classifyBootstrapMisbinding(
  input: ClassifyBootstrapMisbindingInput,
): Promise<ClassifyBootstrapMisbindingResult> {
  const { repoDir, branchName, baseSha, taskId } = input;
  const output = await runGit(repoDir, `git log --format=%H%x1f%s%x1f%b ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  if (!output) {
    return {
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    };
  }

  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownSubjectPattern = new RegExp(`^(feat|fix|test|chore|docs|refactor|perf|build)\\(${escapedTaskId}\\):`, "i");
  const ownTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}:\\s*${escapedTaskId}\\s*(?:\\n|$)`, "i");
  const subjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const trailerPattern = /(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i;

  let ownCommitCount = 0;
  let nonAttributedCount = 0;
  let foreignCommitCount = 0;
  for (const line of output.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [, subject = "", body = ""] = line.split("\u001f");
    if (ownSubjectPattern.test(subject) || ownTrailerPattern.test(body)) {
      ownCommitCount += 1;
      continue;
    }

    const subjectMatch = subject.match(subjectPattern);
    const trailerMatch = body.match(trailerPattern);
    const attributedTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
    if (!attributedTaskId) {
      nonAttributedCount += 1;
    } else {
      foreignCommitCount += 1;
    }
  }

  return {
    isBootstrapMisbinding: foreignCommitCount > 0 && ownCommitCount === 0 && nonAttributedCount === 0,
    ownCommitCount,
    foreignCommitCount,
    nonAttributedCount,
  };
}

export interface ClassifyForeignCommitsInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  foreignCommits: BranchCrossContaminationCommit[];
  mainRef?: string;
  /**
   * Trusted integration identities for landedness (local integration branch first, then
   * `<remote>/<integration>` refs). RUFU-231: a foreign commit landed on origin/main must
   * classify `alreadyUpstream` even when local main never received it.
   */
  trustedRefs?: string[];
}

export interface ClassifyForeignCommitsResult {
  /**
   * Commits whose patch-id already exists on main and are safe to drop.
   */
  alreadyUpstream: BranchCrossContaminationCommit[];
  /**
   * Commits whose patch-id is unique and require human adjudication.
   */
  unique: BranchCrossContaminationCommit[];
}

export type ForeignOnlyContaminationKind =
  | "foreign-only-no-own-work"
  | "foreign-only-already-upstream"
  | "ambiguous"
  | "clean";

export interface ClassifyForeignOnlyContaminationInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  mainRef?: string;
  /**
   * Trusted integration identities (local integration branch first, then `<remote>/<integration>`
   * refs). RUFU-231: landedness of foreign commits must consider every trusted identity so a
   * commit landed on origin/main classifies `alreadyUpstream` against a behind local identity.
   */
  trustedRefs?: string[];
}

export interface ClassifyForeignOnlyContaminationResult {
  kind: ForeignOnlyContaminationKind;
  ownCommitCount: number;
  foreignCommitCount: number;
  nonAttributedCount: number;
  alreadyUpstreamShas: string[];
  uniqueShas: string[];
}

async function buildUpstreamPatchIdSet(repoDir: string, ref: string): Promise<Set<string>> {
  const upstreamPatchIdsOutput = await runGit(
    repoDir,
    `git rev-list ${quoteShellArg(ref)} | while read c; do git show "$c" | git patch-id --stable; done`,
  ).catch(() => "");

  return new Set(
    upstreamPatchIdsOutput
      .split("\n")
      .map((line) => line.trim().split(" ")[0])
      .filter(Boolean),
  );
}

/*
FNXC:BranchBaseIdentity 2026-09-13-02:25:
RUFU-231: patch-id landedness is evaluated against EVERY trusted integration identity — a
commit replayed by `rebaseNewWorktreeOntoRemote` (or rebase/merge elsewhere) keeps its patch
against `<remote>/<integration>` even though the local identity never received it. A commit is
landed when any trusted ref carries its patch; sets are built lazily so the common local hit
never pays for the remote scan.
*/
async function commitPatchesLandedOnAnyTrustedRef(
  repoDir: string,
  shas: string[],
  trustedRefs: string[],
): Promise<Set<string>> {
  const landed = new Set<string>();
  if (shas.length === 0) return landed;
  const builtSets: Array<{ ref: string; patchIds: Set<string> }> = [];
  const patchIdsFor = async (ref: string) => {
    const cached = builtSets.find((entry) => entry.ref === ref);
    if (cached) return cached.patchIds;
    const patchIds = await buildUpstreamPatchIdSet(repoDir, ref);
    builtSets.push({ ref, patchIds });
    return patchIds;
  };
  const shaPatchId = new Map<string, string>();
  for (const sha of shas) {
    const patchIdLine = await runGit(repoDir, `git show ${quoteShellArg(sha)} | git patch-id --stable`).catch(() => "");
    shaPatchId.set(sha, patchIdLine.trim().split(" ")[0]);
  }
  for (const sha of shas) {
    const patchId = shaPatchId.get(sha);
    if (!patchId) continue;
    for (const ref of trustedRefs) {
      const patchIds = await patchIdsFor(ref);
      if (patchIds.has(patchId)) {
        landed.add(sha);
        break;
      }
    }
  }
  return landed;
}

async function classifyForeignCommitsViaPatchId(
  repoDir: string,
  mainRef: string,
  commits: BranchCrossContaminationCommit[],
  trustedRefs?: string[],
): Promise<ClassifyForeignCommitsResult> {
  const refs = trustedRefs && trustedRefs.length > 0 ? trustedRefs : [mainRef];
  const landed = await commitPatchesLandedOnAnyTrustedRef(repoDir, commits.map((commit) => commit.sha), refs);
  const alreadyUpstream: BranchCrossContaminationCommit[] = [];
  const unique: BranchCrossContaminationCommit[] = [];
  for (const commit of commits) {
    if (landed.has(commit.sha)) {
      alreadyUpstream.push(commit);
    } else {
      unique.push(commit);
    }
  }

  return { alreadyUpstream, unique };
}

export async function classifyForeignCommits(
  input: ClassifyForeignCommitsInput,
): Promise<ClassifyForeignCommitsResult> {
  const resolvedIntegrationBranch = await resolveIntegrationBranch(input.repoDir, undefined);
  const { repoDir, branchName, baseSha, foreignCommits } = input;
  const mainRef = input.mainRef?.trim() || resolvedIntegrationBranch;
  const trustedRefs = input.trustedRefs && input.trustedRefs.length > 0
    ? input.trustedRefs
    : await resolveTrustedIntegrationRefs(repoDir, mainRef);
  const targetBySha = new Map(foreignCommits.map((commit) => [commit.sha, commit]));
  if (targetBySha.size === 0) {
    return { alreadyUpstream: [], unique: [] };
  }

  try {
    const comparisonBase = baseSha || await runGit(repoDir, `git merge-base ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)}`);
    /*
    FNXC:BranchBaseIdentity 2026-09-13-02:30:
    RUFU-231: landedness proof per trusted ref. Three channels, any one sufficient:
    1. reachability — a foreign commit already ON a trusted ref never appears in that ref's
       `git cherry` output (cherry enumerates `branch ^upstream` only), so prove it directly.
    2. `git cherry` '-' — patch-equivalent copy landed on that ref (rebase replays).
    3. everything else falls to the trusted-ref patch-id fallback below. A '+' from a BEHIND
       ref must not foreclose the other refs' patch sets — that is exactly how the wedge
       classification turned origin/main's landed commit into "unique".
    */
    const landedSha = new Set<string>();
    const resolveFullSha = (token: string): string | null => {
      if (targetBySha.has(token)) return token;
      const match = foreignCommits.find((commit) => commit.sha.startsWith(token));
      return match?.sha ?? null;
    };
    let sawAnyOutput = false;
    for (const trustedRef of trustedRefs) {
      for (const commit of foreignCommits) {
        if (landedSha.has(commit.sha)) continue;
        if (await isAncestor(repoDir, commit.sha, trustedRef)) landedSha.add(commit.sha);
      }
      const output = await runGit(
        repoDir,
        `git cherry ${quoteShellArg(trustedRef)} ${quoteShellArg(branchName)} ${quoteShellArg(comparisonBase)}`,
      ).catch(() => "");
      if (!output.trim()) continue;
      sawAnyOutput = true;
      for (const rawLine of output.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const [marker, token] = line.split(/\s+/, 2);
        if (!token) continue;
        if (marker !== "-") continue;
        const sha = resolveFullSha(token);
        if (sha) landedSha.add(sha);
      }
    }
    if (!sawAnyOutput && landedSha.size === 0) {
      return classifyForeignCommitsViaPatchId(repoDir, mainRef, foreignCommits, trustedRefs);
    }
    const unresolved = foreignCommits.filter((commit) => !landedSha.has(commit.sha));
    const unresolvedClassified = unresolved.length > 0
      ? await classifyForeignCommitsViaPatchId(repoDir, mainRef, unresolved, trustedRefs)
      : { alreadyUpstream: [], unique: [] };
    return {
      alreadyUpstream: [
        ...foreignCommits.filter((commit) => landedSha.has(commit.sha)),
        ...unresolvedClassified.alreadyUpstream,
      ],
      unique: unresolvedClassified.unique,
    };
  } catch {
    return classifyForeignCommitsViaPatchId(repoDir, mainRef, foreignCommits, trustedRefs);
  }
}

export interface ClassifyMisroutedForeignCommitInput {
  repoDir: string;
  sha: string;
  commitSubject: string;
  commitBody: string;
  currentTaskId: string;
}

export interface ClassifyMisroutedForeignCommitResult {
  misrouted: boolean;
  foreignTaskId?: string;
  paths: string[];
}

export async function classifyMisroutedForeignCommit(
  input: ClassifyMisroutedForeignCommitInput,
): Promise<ClassifyMisroutedForeignCommitResult> {
  const { repoDir, sha, commitSubject, commitBody, currentTaskId } = input;
  const subjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const trailerPattern = /(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i;
  const subjectMatch = commitSubject.match(subjectPattern);
  const trailerMatch = commitBody.match(trailerPattern);
  const foreignTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
  if (!foreignTaskId || foreignTaskId === currentTaskId.toUpperCase()) {
    return { misrouted: false, paths: [] };
  }

  const pathsOutput = await runGit(
    repoDir,
    `git diff-tree --root --no-commit-id --name-only -r ${quoteShellArg(sha)}`,
  ).catch(() => "");
  const paths = pathsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    misrouted: paths.length > 0 && paths.every((path) => path.startsWith(".changeset/")),
    foreignTaskId,
    paths,
  };
}

export async function classifyForeignOnlyContamination(
  input: ClassifyForeignOnlyContaminationInput,
): Promise<ClassifyForeignOnlyContaminationResult> {
  const resolvedIntegrationBranch = await resolveIntegrationBranch(input.repoDir, undefined);
  const { repoDir, branchName, baseSha, taskId } = input;
  const mainRef = input.mainRef?.trim() || resolvedIntegrationBranch;
  // FN-5090 hotfix: stale baseSha (older than the actual fork point with main) caused
  // classifyForeignOnlyContamination to see commits that have since been merged into main
  // as "foreign", returning kind:"ambiguous" and stranding the task. Prefer the live
  // merge-base when it is a descendant of the persisted baseSha.
  let effectiveBaseSha = baseSha;
  try {
    const mergeBaseRaw = await runGit(repoDir, `git merge-base ${quoteShellArg(branchName)} ${quoteShellArg(mainRef)}`);
    const liveMergeBase = mergeBaseRaw.trim();
    if (liveMergeBase && liveMergeBase !== baseSha) {
      // Use live merge-base if it is a descendant of baseSha (newer)
      const ancestryCheck = await runGit(
        repoDir,
        `git merge-base --is-ancestor ${quoteShellArg(baseSha)} ${quoteShellArg(liveMergeBase)} && echo yes || echo no`,
      ).catch(() => "no");
      if (ancestryCheck.trim() === "yes") {
        effectiveBaseSha = liveMergeBase;
      }
    }
  } catch {
    // fall back to persisted baseSha on any git failure
  }
  const persistedRangeOutput = await runGit(repoDir, `git log --format=%H%x1f%s%x1f%b ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  const subjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const trailerPattern = /(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i;
  const foreignCommits: BranchCrossContaminationCommit[] = [];
  for (const line of persistedRangeOutput.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [sha, subject, body] = line.split("\u001f");
    const subjectMatch = (subject ?? "").match(subjectPattern);
    const trailerMatch = (body ?? "").match(trailerPattern);
    const attributedTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
    if (attributedTaskId && attributedTaskId !== taskId.toUpperCase()) {
      foreignCommits.push({ sha, subject: subject ?? "", foreignTaskId: attributedTaskId });
    }
  }

  const bootstrap = await classifyBootstrapMisbinding({
    repoDir,
    branchName,
    baseSha: effectiveBaseSha,
    taskId,
    foreignCommits,
  });

  if (foreignCommits.length === 0) {
    return {
      kind: "clean",
      ownCommitCount: bootstrap.ownCommitCount,
      foreignCommitCount: 0,
      nonAttributedCount: bootstrap.nonAttributedCount,
      alreadyUpstreamShas: [],
      uniqueShas: [],
    };
  }

  const foreignClassification = await classifyForeignCommits({
    repoDir,
    branchName,
    baseSha: effectiveBaseSha,
    foreignCommits,
    mainRef,
    trustedRefs: input.trustedRefs,
  });

  const result: ClassifyForeignOnlyContaminationResult = {
    kind: "ambiguous",
    ownCommitCount: bootstrap.ownCommitCount,
    foreignCommitCount: foreignCommits.length,
    nonAttributedCount: bootstrap.nonAttributedCount,
    alreadyUpstreamShas: foreignClassification.alreadyUpstream.map((entry) => entry.sha),
    uniqueShas: foreignClassification.unique.map((entry) => entry.sha),
  };

  if (result.ownCommitCount === 0 && result.nonAttributedCount === 0 && result.foreignCommitCount > 0) {
    result.kind = result.uniqueShas.length === 0
      ? "foreign-only-already-upstream"
      : "foreign-only-no-own-work";
    return result;
  }

  if (result.ownCommitCount > 0 || result.nonAttributedCount > 0) {
    result.kind = "ambiguous";
    return result;
  }

  result.kind = "clean";
  return result;
}

export interface ReanchorBranchToBaseInput {
  repoDir: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  taskId: string;
}

export interface ReanchorBranchToBaseResult {
  previousTipSha: string;
  newTipSha: string;
}

/**
 * Re-anchor a task branch to base while handling already-at-base worktrees.
 *
 * Fast-path: when both worktree HEAD and branch tip already equal baseSha,
 * avoid detach/rebranch churn (`checkout -B` can fail with worktree-binding
 * conflicts) and only attempt lightweight branch re-association.
 */
export async function reanchorBranchToBase(
  input: ReanchorBranchToBaseInput,
): Promise<ReanchorBranchToBaseResult> {
  const { repoDir, worktreePath, branchName, baseSha, taskId } = input;
  const previousTipSha = await revParse(repoDir, branchName);

  try {
    await execAsync("git checkout -- .", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    // best-effort: worktree may already be clean
  }

  await execAsync("git clean -fd", {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });

  const worktreeHeadSha = await revParse(worktreePath, "HEAD");
  const branchTipSha = previousTipSha;
  const worktreeHeadBranch = await runGit(worktreePath, "git symbolic-ref --quiet --short HEAD").catch(() => "");

  if (worktreeHeadSha === baseSha && branchTipSha === baseSha) {
    if (worktreeHeadBranch !== branchName) {
      try {
        await runGit(worktreePath, `git checkout ${quoteShellArg(branchName)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already used by worktree")) {
          throw error;
        }
      }
    }
    await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);
    return {
      previousTipSha,
      newTipSha: previousTipSha,
    };
  }

  await runGit(worktreePath, `git checkout --detach ${quoteShellArg(baseSha)}`);
  await runGit(worktreePath, `git checkout -B ${quoteShellArg(branchName)} ${quoteShellArg(baseSha)}`);
  await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);

  return {
    previousTipSha,
    newTipSha: await revParse(repoDir, branchName),
  };
}

export interface AutoRecoverCrossContaminationInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  shasToDrop: string[];
  mainRef?: string;
}

export interface AutoRecoverCrossContaminationResult {
  newTipSha: string;
  droppedShas: string[];
}

export async function autoRecoverCrossContamination(
  input: AutoRecoverCrossContaminationInput,
): Promise<AutoRecoverCrossContaminationResult> {
  const { repoDir, branchName, baseSha, taskId, shasToDrop } = input;
  const dropSet = new Set(shasToDrop);
  if (dropSet.size === 0) {
    throw new Error("autoRecoverCrossContamination requires at least one SHA to drop");
  }

  const originalTip = await revParse(repoDir, branchName);
  const commitListOutput = await runGit(repoDir, `git rev-list --reverse ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  const commits = commitListOutput.split("\n").map((line) => line.trim()).filter(Boolean);

  await runGit(repoDir, `git checkout --detach ${quoteShellArg(baseSha)}`);

  try {
    for (const sha of commits) {
      if (dropSet.has(sha)) continue;
      await execAsync(`git cherry-pick ${quoteShellArg(sha)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
    }

    const newTip = await revParse(repoDir, "HEAD");
    await runGit(repoDir, `git update-ref ${quoteShellArg(`refs/heads/${branchName}`)} ${quoteShellArg(newTip)} ${quoteShellArg(originalTip)}`);
    await runGit(repoDir, `git checkout ${quoteShellArg(branchName)}`);
  } catch (error) {
    await runGit(repoDir, `git cherry-pick --abort`).catch(() => undefined);
    await runGit(repoDir, `git checkout ${quoteShellArg(branchName)}`).catch(() => undefined);
    throw error;
  }

  await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);

  return {
    newTipSha: await revParse(repoDir, branchName),
    droppedShas: Array.from(dropSet),
  };
}

export function deriveTaskIdFromFusionBranch(branchName: string): string | null {
  const match = /^fusion\/(fn-\d+)$/i.exec(branchName.trim());
  if (!match) return null;
  return match[1].toUpperCase();
}

async function isZeroUniqueCommitBranchViaPatchIdFallback(
  repoDir: string,
  startPoint: string,
  branchName: string,
  mainRef: string,
  trustedRefs?: string[],
): Promise<boolean> {
  const range = `${startPoint}..${branchName}`;
  const branchCommitsOutput = await runGit(repoDir, `git rev-list ${quoteShellArg(range)}`).catch(() => "");
  const branchCommitShas = branchCommitsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (branchCommitShas.length === 0) {
    return true;
  }

  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:35:
  RUFU-231: landedness against ANY trusted integration identity. A branch rebased onto
  `<remote>/<integration>` keeps every commit's patch there even though the behind local
  identity carries none of it; measuring only the local identity kept such branches out of
  `fully-subsumed` and inside the `live-foreign` wedge.
  */
  const refs = trustedRefs && trustedRefs.length > 0 ? trustedRefs : [mainRef];
  const landed = await commitPatchesLandedOnAnyTrustedRef(repoDir, branchCommitShas, refs);
  return landed.size === branchCommitShas.length;
}

/**
 * Inspect a branch-name collision from `git worktree add -b` without requiring
 * the requested destination path to exist. Existing callers must use
 * inspectBranchConflict, whose missing-path short-circuit is intentionally kept.
 */
export async function inspectBareBranchCollision(
  input: InspectBranchConflictInput,
): Promise<BareBranchCollisionInspectionResult> {
  const startPoint = input.startPoint ?? "HEAD";

  try {
    await runGit(input.repoDir, "git worktree prune");
  } catch {
    // Best-effort: the mapping check below still protects a registered live worktree.
  }

  try {
    await revParse(input.repoDir, `refs/heads/${input.branchName}`);
  } catch {
    return { kind: "missing" };
  }

  let worktreeMap = await getWorktreeBranchMap(input.repoDir);
  let livePath = worktreeMap.get(input.branchName);
  if (livePath && !existsSync(livePath)) {
    try {
      await runGit(input.repoDir, "git worktree prune");
    } catch {
      // Best-effort: a still-present mapping is not considered live below.
    }
    worktreeMap = await getWorktreeBranchMap(input.repoDir);
    livePath = worktreeMap.get(input.branchName);
  }

  const tipSha = await revParse(input.repoDir, input.branchName);
  const uniqueCommitResult = await listUniqueBranchCommits(input.repoDir, startPoint, input.branchName);
  const requestedIntegrationRef = input.integrationRef ?? await resolveIntegrationBranch(input.repoDir, undefined);
  const integrationRef = await resolveBranchComparisonRef(input.repoDir, requestedIntegrationRef, input.branchName);

  if (livePath && existsSync(livePath)) {
    return {
      kind: "live-foreign",
      tipSha,
      error: new BranchConflictError({
        branchName: input.branchName,
        conflictingWorktreePath: livePath,
        existingTipSha: tipSha,
        strandedCommits: uniqueCommitResult.commits,
        startPoint: uniqueCommitResult.mainRef,
        recommendedAction: "Inspect the live conflicting worktree before retrying.",
      }),
    };
  }

  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:20:
  RUFU-231: bare-collision landing proof consults every trusted integration identity
  (local first, then `<remote>/<integration>`). Recreating from the caller's startPoint
  after a remote-landed tip discards only commits that are already upstream — zero loss.
  */
  const trustedRefs = await resolveTrustedIntegrationRefs(input.repoDir, integrationRef);
  for (const trustedRef of trustedRefs) {
    if (await isAncestor(input.repoDir, tipSha, trustedRef)) {
      return {
        kind: "tip-already-merged",
        tipSha,
        integrationRef: trustedRef,
        landedVia: trustedRef === integrationRef ? "local" : "remote-tracking",
      };
    }
  }

  const zeroUnique = uniqueCommitResult.commits.length === 0 && (
    !uniqueCommitResult.degraded || await isZeroUniqueCommitBranchViaPatchIdFallback(
      input.repoDir,
      startPoint,
      input.branchName,
      uniqueCommitResult.mainRef,
      trustedRefs,
    )
  );
  if (zeroUnique) {
    return { kind: "fully-subsumed", tipSha };
  }

  const attribution = await reportBranchAttribution(
    input.repoDir,
    input.branchName,
    uniqueCommitResult.mainRef,
    input.requestingTaskId,
  );
  const taskAttributedCommitCount = attribution.ownTrailed + attribution.ownUntrailed.length;
  const foreignOrUnattributedCount = attribution.foreign.length + attribution.unattributed.length;
  if (
    taskAttributedCommitCount === uniqueCommitResult.commits.length
    && foreignOrUnattributedCount === 0
  ) {
    return {
      kind: "reclaimable",
      tipSha,
      taskAttributedCommitCount,
      uniqueCommitCount: uniqueCommitResult.commits.length,
    };
  }

  return {
    kind: "foreign-unmerged",
    tipSha,
    uniqueCommitCount: uniqueCommitResult.commits.length,
    error: new BranchConflictError({
      branchName: input.branchName,
      conflictingWorktreePath: input.conflictingWorktreePath,
      existingTipSha: tipSha,
      strandedCommits: uniqueCommitResult.commits,
      startPoint: uniqueCommitResult.mainRef,
      recommendedAction: "Preserve this unregistered branch and inspect its foreign or unattributed commits before retrying.",
      collisionKind: "foreign-unmerged",
    }),
  };
}

/**
 * Proof that a checkout holds nothing uncommitted: an empty `git status --porcelain`
 * (untracked files included, ignored excluded). Any doubt — a failing read, a dirty tree —
 * returns false, because a checkout release must never destroy work it cannot prove absent.
 * RUFU-231: required before releasing a checkout whose landedness was only proven against
 * the remote-tracking identity (`landedVia: "remote-tracking"`).
 */
export async function taskWorktreeCheckoutIsClean(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

export async function inspectBranchConflict(
  input: InspectBranchConflictInput,
): Promise<BranchConflictInspectionResult> {
  const startPoint = input.startPoint ?? "HEAD";
  if (!existsSync(input.conflictingWorktreePath)) {
    return { kind: "stale" };
  }

  try {
    await runGit(input.repoDir, "git worktree prune");
  } catch {
    // best-effort
  }

  let worktreeMap = await getWorktreeBranchMap(input.repoDir);
  let livePath = worktreeMap.get(input.branchName);

  try {
    await revParse(input.repoDir, `refs/heads/${input.branchName}`);
  } catch {
    return { kind: "stale-resolved" };
  }

  if (livePath && !existsSync(livePath)) {
    try {
      await runGit(input.repoDir, "git worktree prune");
    } catch {
      // best-effort
    }
    worktreeMap = await getWorktreeBranchMap(input.repoDir);
    const refreshedLivePath = worktreeMap.get(input.branchName);
    livePath = refreshedLivePath && existsSync(refreshedLivePath) ? refreshedLivePath : undefined;
  }

  if (!livePath) {
    return { kind: "stale-resolved" };
  }

  const existingTipSha = await revParse(input.repoDir, input.branchName);
  const requestedIntegrationRef = input.integrationRef ?? await resolveIntegrationBranch(input.repoDir, undefined);
  const integrationRef = await resolveBranchComparisonRef(input.repoDir, requestedIntegrationRef, input.branchName);
  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:20:
  RUFU-231: prove the tip against EVERY trusted integration identity (local first, then
  `<remote>/<integration>`). A zero-own-commit branch rebased onto origin/main is landed
  upstream even though local main never caught up; measuring only against local main
  labelled that landed tip `live-foreign` forever (the RUFU-217 wedge). A landing proven
  only against the remote-tracking identity carries `landedVia: "remote-tracking"` so
  checkout-releasing consumers must first prove the worktree clean.
  */
  const trustedRefs = await resolveTrustedIntegrationRefs(input.repoDir, integrationRef);
  for (const trustedRef of trustedRefs) {
    if (await isAncestor(input.repoDir, existingTipSha, trustedRef)) {
      return {
        kind: "tip-already-merged",
        livePath: livePath ?? null,
        tipSha: existingTipSha,
        integrationRef: trustedRef,
        landedVia: trustedRef === integrationRef ? "local" : "remote-tracking",
      };
    }
  }

  const uniqueCommitResult = await listUniqueBranchCommits(input.repoDir, startPoint, input.branchName);
  const attribution = await summarizeTaskAttributedCommits(
    input.repoDir,
    `${startPoint}..${input.branchName}`,
    input.requestingTaskId,
  );
  const taskAttributedCommitCount = attribution.ownCount;

  if (!uniqueCommitResult.degraded && uniqueCommitResult.commits.length === 0) {
    return {
      kind: "fully-subsumed",
      livePath,
      tipSha: existingTipSha,
    };
  }

  if (uniqueCommitResult.degraded && uniqueCommitResult.commits.length === 0) {
    const isZeroUnique = await isZeroUniqueCommitBranchViaPatchIdFallback(
      input.repoDir,
      startPoint,
      input.branchName,
      uniqueCommitResult.mainRef,
      trustedRefs,
    );
    if (isZeroUnique) {
      return {
        kind: "fully-subsumed",
        livePath,
        tipSha: existingTipSha,
      };
    }
  }

  const normalizedOwnerTaskId = (input.ownerTaskId ?? input.requestingTaskId).trim().toUpperCase();
  const branchOwnerTaskId = deriveTaskIdFromFusionBranch(input.branchName);
  const isSelfOwnedWorktree =
    livePath === input.conflictingWorktreePath ||
    (branchOwnerTaskId !== null && branchOwnerTaskId === normalizedOwnerTaskId);

  if (taskAttributedCommitCount > 0 || (isSelfOwnedWorktree && attribution.foreignCount === 0)) {
    return {
      kind: "reclaimable",
      livePath,
      tipSha: existingTipSha,
      taskAttributedCommitCount,
      strandedCommits: uniqueCommitResult.commits,
    };
  }

  return {
    kind: "live-foreign",
    livePath,
    error: new BranchConflictError({
      branchName: input.branchName,
      conflictingWorktreePath: livePath,
      existingTipSha,
      strandedCommits: uniqueCommitResult.commits,
      startPoint: uniqueCommitResult.mainRef,
      recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
    }),
  };
}
