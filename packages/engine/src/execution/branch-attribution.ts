import { exec } from "node:child_process";
import { promisify } from "node:util";
/*
FNXC:CommitAttribution 2026-11-19-03:57 (RUFU-669):
The id grammar is imported from core's leaf subpath `@fusion/core/task-id-token`, NOT from the
`@fusion/core` barrel, and this is a measured constraint rather than a style preference. Importing the
barrel here turned `packages/engine/src/__tests__/merger-landed-files-capture.test.ts` (a merge-gate file)
red: the same grammar, the same classifier, and a barrel import gave 14 failed / 8 passed, while a
grammatically identical local constant gave 22 passed. The barrel drags core's whole module
initialisation into the graph of a module the merge lane already imports (and in the `engine-core` gate
project it is aliased to a pre-bundled gate slice, not `index.ts`); the reproduction is the pass/fail pair
above, and that test mocks `node:fs`/`node:child_process`, so anything core probes at module-init time
reads a mock that has no implementation yet.
The leaf is the documented pattern for exactly this (`./column-roles`, `./heartbeat-recovery-state`,
`@fusion/core/mcp-builtin-servers`): same single dictionary, no dependency graph. Importing
`branch-conflicts.js` instead would also work grammatically, but it pulls `merge/integration-branch` and
`merge/merger-ref-update-advance` into a module `merger.ts` already imports.
*/
import { TASK_ID_TOKEN_PROSE_SOURCE, TASK_ID_TOKEN_SOURCE } from "@fusion/core/task-id-token";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "test",
  "chore",
  "docs",
  "refactor",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
] as const;

export type AttributionSource =
  | "trailer"
  | "subject-prefix"
  | "bracketed-prefix"
  | "own-mention"
  | "none";

/** The three-way attribution verdict one commit receives from the canonical classifier. */
export type CommitAttributionKind = "own" | "foreign" | "unattributed";

export interface CommitAttributionVerdict {
  kind: CommitAttributionKind;
  /** The card the commit positively names, or `null` when it names none. */
  attributedTaskId: string | null;
  source: AttributionSource;
}

export interface CommitAttributionInput {
  subject: string;
  body: string;
  /** The card being executed (or measured), in its canonical `PREFIX-digits` form. */
  taskId: string;
}

export interface AttributionResult {
  files: string[];
  foreignCommits: { sha: string; subject: string; attributedTaskId: string | null }[];
  /**
   * RUFU-669: commits that name no card at all. Their files stay out of `files` exactly as before,
   * but they are NOT foreign and must never be reported as foreign.
   */
  unattributedCommits: { sha: string; subject: string }[];
  ownCommitCount: number;
  ownCommitShas?: string[];
  rawDiffFileCount: number;
  commitAttributions: {
    sha: string;
    subject: string;
    kind: CommitAttributionKind;
    source: AttributionSource;
    attributed: boolean;
    attributedTaskId: string | null;
  }[];
}

export class BranchAttributionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BranchAttributionError";
    this.cause = cause;
  }
}

export class SilentNoOpAttributionMismatchError extends Error {
  readonly taskId: string;
  readonly recordedSha: string;
  readonly rebaseMergeBaseSha: string;
  readonly sourceBranchRef: string;
  readonly sourceBranchOwnCommitCount: number;
  readonly sourceBranchOwnCommitShas: string[];

  constructor(params: {
    taskId: string;
    recordedSha: string;
    rebaseMergeBaseSha: string;
    sourceBranchRef: string;
    sourceBranchOwnCommitCount: number;
    sourceBranchOwnCommitShas: string[];
  }) {
    super(
      `silent no-op attribution mismatch: ${params.sourceBranchRef} carries ${params.sourceBranchOwnCommitCount} attributable commit(s) for ${params.taskId} not present in recorded head ${params.recordedSha}`,
    );
    this.name = "SilentNoOpAttributionMismatchError";
    this.taskId = params.taskId;
    this.recordedSha = params.recordedSha;
    this.rebaseMergeBaseSha = params.rebaseMergeBaseSha;
    this.sourceBranchRef = params.sourceBranchRef;
    this.sourceBranchOwnCommitCount = params.sourceBranchOwnCommitCount;
    this.sourceBranchOwnCommitShas = params.sourceBranchOwnCommitShas;
  }
}

export interface BranchAttributionOptions {
  worktreePath: string;
  baseRef: string;
  taskId: string;
  requireTrailer?: boolean;
  execAsyncImpl?: typeof execAsync;
}

export interface BranchRangeAttributionOptions {
  worktreePath: string;
  rangeRef: string;
  taskId: string;
  execAsyncImpl?: typeof execAsync;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractAttributedTaskId(body: string): string | null {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return last?.[1] ?? null;
}

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
The free-text scan needs BOTH boundaries, and the token itself comes from core's single dictionary
(`packages/core/src/tasks/task-id-token.ts`, reached through its `@fusion/core/task-id-token` leaf export).
The grammar is imported rather than restated here because RUFU-292/RUFU-352/RUFU-730 make a second
`[A-Z][A-Z0-9]*-\d+` literal the exact asymmetry those cards removed, and the leaf export adds no
dependency graph to this module (see the import above for why the barrel is not used). The left
`(?<![\w-])` guard is new to this site: the right boundary
`(?![\w-])` is already inside `TASK_ID_TOKEN_PROSE_SOURCE`, and without the left guard a mention of
`SANE-4890` would rescue the card `SANE-489` — the phantom-id failure the core comment names, in reverse.
Composed here (not in core) because the bounded-scope sites below need the bare token: `feat(SANE-489):`
is already bounded by its `):` syntax.
*/
/** Exported for the drift pin in `__tests__/branch-attribution.test.ts`, which asserts this composition against core's dictionary. */
export const OWN_MENTION_SCAN_SOURCE = `(?<![\\w-])(${TASK_ID_TOKEN_PROSE_SOURCE})`;

const CONVENTIONAL_SUBJECT_SCOPE_RE = new RegExp(
  `^(?:${CONVENTIONAL_COMMIT_TYPES.join("|")})\\s*\\((${TASK_ID_TOKEN_SOURCE})\\)!?:`,
  "i",
);
const BRACKETED_SUBJECT_PREFIX_RE = new RegExp(`^\\s*\\[(${TASK_ID_TOKEN_SOURCE})\\]`, "i");
const LEGACY_COLON_PREFIX_RE = new RegExp(`^\\s*(${TASK_ID_TOKEN_SOURCE}):`, "i");

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669) tier 0:
A git-GENERATED merge subject quotes a ref name (`Merge branch 'main' into fusion/sane-489`) and Fusion
branch names embed the task id, so an unguarded free-text scan would rescue every merge commit into `own`
by the branch token the card never authored. The shape is git's own vocabulary, not a leading `Merge `,
so a hand-written "Merge the vendor branch (SANE-489)" subject still gets its mention honoured.
*/
const GENERATED_MERGE_SUBJECT_RE =
  /^Merge (?:branch|remote-tracking branch|pull request|commit|refs\/heads|refs\/tags|tags?|heads?)\b/i;

/**
 * FN-5083/FN-5060 hotfix: extract a task-id reference from a commit subject when the
 * `Fusion-Task-Id` trailer is missing. Recognizes conventional commits
 * (`feat(FN-123): ...`, `fix(FN-123): ...`, etc.), bracketed prefixes
 * (`[FN-123] ...`) and legacy colon prefixes (`FN-123: ...`).
 *
 * RUFU-669: the id character class is now core's canonical token, so a project whose
 * `settings.taskPrefix` carries a digit (`SANE4-42`) attributes the same way `FN-123` does.
 * Prefix position ONLY — a mid-subject mention is a different tier with different authority; see
 * {@link classifyCommitAttribution}.
 */
function extractTaskIdFromSubject(subject: string): {
  attributedTaskId: string | null;
  source: Extract<AttributionSource, "subject-prefix" | "bracketed-prefix" | "none">;
} {
  if (!subject) {
    return { attributedTaskId: null, source: "none" };
  }
  // Conventional commit: feat(FN-123): ... or fix(FN-123)!: ... (case-insensitive)
  const conventional = CONVENTIONAL_SUBJECT_SCOPE_RE.exec(subject);
  if (conventional?.[1]) {
    return { attributedTaskId: conventional[1].toUpperCase(), source: "subject-prefix" };
  }
  // Bracketed: [FN-123] ...
  const bracketed = BRACKETED_SUBJECT_PREFIX_RE.exec(subject);
  if (bracketed?.[1]) {
    return { attributedTaskId: bracketed[1].toUpperCase(), source: "bracketed-prefix" };
  }
  // Legacy colon: FN-123: ...
  const colon = LEGACY_COLON_PREFIX_RE.exec(subject);
  if (colon?.[1]) {
    return { attributedTaskId: colon[1].toUpperCase(), source: "subject-prefix" };
  }
  return { attributedTaskId: null, source: "none" };
}

/**
 * Tier 3 of the attribution contract: a word-bounded mention of THIS card anywhere else in the
 * subject. Deliberately one-directional — it can only ever answer for the card being asked about,
 * because a mention may rescue a commit into `own` but must never accuse a commit of belonging to
 * another lineage (see {@link classifyCommitAttribution}).
 */
function findOwnMentionInSubject(subject: string, taskId: string): boolean {
  if (!subject || !taskId) return false;
  if (GENERATED_MERGE_SUBJECT_RE.test(subject)) return false;
  // Fresh instance per call: a `g` RegExp carries mutable lastIndex state.
  const scan = new RegExp(OWN_MENTION_SCAN_SOURCE, "gi");
  let match: RegExpExecArray | null = null;
  while ((match = scan.exec(subject)) !== null) {
    if (taskIdsMatch(match[1] ?? null, taskId)) return true;
  }
  return false;
}

function taskIdsMatch(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.toUpperCase() === b.toUpperCase();
}

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
ONE attribution contract, measured on SANE-489 (saneca workspace, proj_e70af3a5554a4f03, 2026-10-14).
A card re-driven on the branch it had already built emitted `task:worktree-contamination-detected` five
times whose `foreignCommitShas` named `d2447193ebf…`, a commit whose own subject is
`test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)`. The card was accused of
contamination by its own work, and the same misclassification made the Layer-3 auto-widen gate refuse that
file `foreign-commit`, so the merge took MAIN'S BYTES for the card's own file.

The operator contract, ordered, first match wins:
  1. a `Fusion-Task-Id`/`Task-Id` trailer naming card T -> own/foreign by T,
  2. a subject PREFIX id naming card T -> own/foreign by T,
  3. a word-bounded mention of THIS card elsewhere in the subject -> own (`own-mention`),
  4. anything else -> unattributed, NEVER foreign.
Three rules hold the safety direction:
  * an id equal to the executing task — trailer, prefix, or mention at ANY position — is never foreign;
  * a mention may only RESCUE, never accuse: making mentions bidirectional would mislabel and drop work
    that must land, i.e. reproduce the RUFU-561 class of harm pointing the other way;
  * git-generated merge subjects are never rescued, because the branch name they quote carries the id.
Commits naming no card at all are their own bucket. That is the difference between "someone else's work
is on my branch" (recovery may act) and "unlabelled work is on this branch" (recovery must preserve).
*/
export function classifyCommitAttribution(input: CommitAttributionInput): CommitAttributionVerdict {
  const { subject, body, taskId } = input;

  const trailerTaskId = extractAttributedTaskId(body);
  if (trailerTaskId) {
    return {
      kind: taskIdsMatch(trailerTaskId, taskId) ? "own" : "foreign",
      attributedTaskId: trailerTaskId.toUpperCase(),
      source: "trailer",
    };
  }

  const subjectPrefix = extractTaskIdFromSubject(subject);
  if (subjectPrefix.attributedTaskId) {
    return {
      kind: taskIdsMatch(subjectPrefix.attributedTaskId, taskId) ? "own" : "foreign",
      attributedTaskId: subjectPrefix.attributedTaskId,
      source: subjectPrefix.source,
    };
  }

  if (findOwnMentionInSubject(subject, taskId)) {
    return { kind: "own", attributedTaskId: taskId.toUpperCase(), source: "own-mention" };
  }

  return { kind: "unattributed", attributedTaskId: null, source: "none" };
}

export async function collectOwnTaskCommitsForRange(
  opts: BranchRangeAttributionOptions,
): Promise<{ ownCommitCount: number; ownCommitShas: string[]; unattributedCommitCount: number }> {
  const execImpl = opts.execAsyncImpl ?? execAsync;
  let logOutput: string;
  try {
    const result = await execImpl(
      `git log --format=%H%x00%s%x00%B%x1e ${quoteShellArg(opts.rangeRef)}`,
      {
        cwd: opts.worktreePath,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    logOutput = result.stdout;
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : String(error);
    throw new BranchAttributionError(
      `git command failed: git log --format=%H%x00%s%x00%B%x1e ${opts.rangeRef} (${stderr || "no stderr"})`,
      error,
    );
  }

  if (!logOutput.trim()) {
    return { ownCommitCount: 0, ownCommitShas: [], unattributedCommitCount: 0 };
  }

  const ownCommitShas: string[] = [];
  let unattributedCommitCount = 0;
  const records = logOutput.split("\x1e").map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
    if (!sha) {
      throw new BranchAttributionError("malformed git log output: missing commit sha");
    }
    // RUFU-669: this loop re-implemented the prefix-only extraction inline, so it under-counted the
    // card's own work exactly like the classifier it now calls (a `SilentNoOpAttributionMismatchError`
    // arm reads `ownCommitCount === 0`). One contract, one copy.
    const verdict = classifyCommitAttribution({ subject, body: bodyParts.join("\x00"), taskId: opts.taskId });
    if (verdict.kind === "own") {
      ownCommitShas.push(sha);
    } else if (verdict.kind === "unattributed") {
      unattributedCommitCount += 1;
    }
  }

  return { ownCommitCount: ownCommitShas.length, ownCommitShas, unattributedCommitCount };
}

export async function filterFilesToOwnTaskCommits(opts: BranchAttributionOptions): Promise<AttributionResult> {
  const execImpl = opts.execAsyncImpl ?? execAsync;
  const runGit = async (command: string): Promise<string> => {
    try {
      const { stdout } = await execImpl(command, {
        cwd: opts.worktreePath,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return stdout;
    } catch (error) {
      const stderr =
        typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim()
          : String(error);
      throw new BranchAttributionError(`git command failed: ${command} (${stderr || "no stderr"})`, error);
    }
  };

  const rawDiffOutput = await runGit(`git diff --name-only ${quoteShellArg(opts.baseRef)}..HEAD`);
  const rawDiffFileCount = rawDiffOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

  const logOutput = await runGit(
    `git log --format=%H%x00%s%x00%B%x1e ${quoteShellArg(`${opts.baseRef}..HEAD`)}`,
  );

  if (!logOutput.trim()) {
    return {
      files: [],
      foreignCommits: [],
      unattributedCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount,
      commitAttributions: [],
    };
  }

  const fileSet = new Set<string>();
  const foreignCommits: { sha: string; subject: string; attributedTaskId: string | null }[] = [];
  const unattributedCommits: { sha: string; subject: string }[] = [];
  const ownCommitShas: string[] = [];
  const commitAttributions: AttributionResult["commitAttributions"] = [];

  const records = logOutput.split("\x1e").map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
    if (!sha) {
      throw new BranchAttributionError("malformed git log output: missing commit sha");
    }
    const body = bodyParts.join("\x00");
    // RUFU-669: the trailer stays primary and the subject prefix second, but a commit that names no
    // card is no longer folded into `foreignCommits` — that array's contents are reported to the
    // operator as contamination, and unlabelled work is not another card's work.
    const verdict = classifyCommitAttribution({ subject, body, taskId: opts.taskId });

    commitAttributions.push({
      sha,
      subject,
      kind: verdict.kind,
      source: verdict.source,
      attributed: verdict.kind === "own",
      attributedTaskId: verdict.attributedTaskId,
    });

    if (verdict.kind === "own") {
      ownCommitShas.push(sha);
      continue;
    }
    if (verdict.kind === "foreign") {
      foreignCommits.push({ sha, subject, attributedTaskId: verdict.attributedTaskId });
      continue;
    }
    unattributedCommits.push({ sha, subject });
  }

  for (const sha of ownCommitShas) {
    const diffTreeOutput = await runGit(`git diff-tree --no-commit-id --name-only -r ${quoteShellArg(sha)}`);
    for (const file of diffTreeOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      fileSet.add(file);
    }
  }

  return {
    files: [...fileSet].sort((a, b) => a.localeCompare(b)),
    foreignCommits,
    unattributedCommits,
    ownCommitCount: ownCommitShas.length,
    ownCommitShas,
    rawDiffFileCount,
    commitAttributions,
  };
}
