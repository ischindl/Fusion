import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";

import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import {
  COMMIT_EPOCH_FORMAT_FIELD,
  commitDeclaresForeignProject,
  commitPredatesTaskBirth,
  COMMIT_BIRTH_CLOCK_SKEW_MS,
  type CommitOwnershipProofContext,
} from "./commit-trailer-evidence.js";

const execAsync = promisify(exec);

export type AlreadyMergedDetectionStrategy = "trailer" | "ancestry" | "patch-id" | "tree-equal" | "no-diff";

export interface AlreadyMergedLookupInput {
  taskId: string;
  lineageId?: string;
  repoDir: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
  /*
  FNXC:CommitOwnership 2026-11-19-15:48: the two facts that turn a task-id match into an ownership
  proof — this board's project namespace and the owning card's `createdAt`. Every candidate a
  lookup wants to credit is checked against them, so an anachronistic or foreign-project commit can
  never be named as this card's delivery. Absent or null on either half skips only that check.
  */
  ownership?: CommitOwnershipProofContext;
}

export type AlreadyMergedOwnershipProof =
  | "task-trailer"
  | "lineage-trailer"
  | "subject-anchor"
  | "canonical-branch-patch"
  | "canonical-branch-tree"
  | "canonical-branch-no-diff";

export interface AlreadyMergedLookupResult {
  sha: string;
  strategy: AlreadyMergedDetectionStrategy;
  ownershipProof?: AlreadyMergedOwnershipProof;
}

export interface CommitTaskOwnership {
  owned: boolean;
  proof?: Extract<AlreadyMergedOwnershipProof, "task-trailer" | "lineage-trailer" | "subject-anchor">;
  ownerTaskId?: string;
  ownerLineageId?: string;
  /*
  FNXC:CommitOwnership 2026-11-19-15:48: `foreign-project` and `anachronistic` extend the rejection
  vocabulary for the two states a task-id match cannot see: the commit declares a DIFFERENT
  project's namespace, or it was committed before the card that allegedly owns it was created.
  */
  rejectionReason?: "foreign-task" | "foreign-lineage" | "foreign-project" | "anachronistic";
}

interface DetectAlreadyLandedInput {
  rootDir: string;
  taskId: string;
  lineageId?: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
  /** See `AlreadyMergedLookupInput.ownership` — the same evidence the detector's anchors require. */
  ownership?: CommitOwnershipProofContext;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstTrailerValue(body: string, trailer: "Fusion-Task-Id" | "Fusion-Task-Lineage"): string | undefined {
  const match = body.match(new RegExp(`(?:^|\\n)${trailer}:\\s*([^\\n]+?)\\s*(?:\\n|$)`));
  return match?.[1]?.trim();
}

/**
 * Ownership anchor shared with self-healing's already-merged recovery guards.
 *
 * The 2026-05-23 lost-work incident (bug #2) was a `git log --grep=<taskId>`
 * first-hit attribution: a commit whose body merely *mentioned* a task ID in
 * prose was accepted as that task's landed commit, stranding/mis-attributing
 * the real work. The FN-7143/FN-7187 incident added the inverse guard: explicit
 * foreign Fusion trailers are rejection evidence even when a stale branch tip,
 * patch-id, or tree-equality fallback otherwise appears to match.
 */
export function getCommitTaskOwnership(
  taskId: string,
  lineageId: string | undefined,
  subject: string,
  body: string,
  evidence?: CommitOwnershipProofContext & { committerEpochMs?: number | null },
): CommitTaskOwnership {
  const ownerTaskId = firstTrailerValue(body, "Fusion-Task-Id");
  const ownerLineageId = firstTrailerValue(body, "Fusion-Task-Lineage");
  if (ownerTaskId && ownerTaskId !== taskId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-task" };
  }
  if (lineageId && ownerLineageId && ownerLineageId !== lineageId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-lineage" };
  }
  /*
  FNXC:CommitOwnership 2026-11-19-15:48: the two identity refusals run BEFORE any positive proof,
  because they are refusals of the match itself, not tie-breakers: a commit that declares another
  project's namespace, or that was committed before this card existed, is not this card's delivery
  however exactly its trailer or subject names the id. RUFU-394 measured three such commits on
  `main`, two of them stamped hours before the card they name was created.
  */
  if (commitDeclaresForeignProject(body, evidence?.projectNamespace ?? null)) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-project" };
  }
  if (commitPredatesTaskBirth(
    evidence?.committerEpochMs ?? null,
    evidence?.taskCreatedAtMs ?? null,
    COMMIT_BIRTH_CLOCK_SKEW_MS,
  )) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "anachronistic" };
  }
  if (ownerTaskId === taskId) {
    return { owned: true, proof: "task-trailer", ownerTaskId, ownerLineageId };
  }
  if (lineageId && ownerLineageId === lineageId) {
    return { owned: true, proof: "lineage-trailer", ownerTaskId, ownerLineageId };
  }
  // Subject anchor MUST mention the task ID — either inside a conventional
  // scope (`<type>(<…taskId…>): …`) or as a leading `<taskId>: …`. The scope
  // group is intentionally NOT optional here: a bare `feat: …` with no task ID
  // is NOT ownership evidence (a prose commit such as `feat: unrelated change`
  // whose body merely mentions the task must be rejected — incident bug #2).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  if (subjectAnchor.test(subject)) {
    return { owned: true, proof: "subject-anchor", ownerTaskId, ownerLineageId };
  }
  return { owned: false, ownerTaskId, ownerLineageId };
}

/**
 * Read the commit facts an ownership decision needs: subject, body, and committer epoch seconds.
 *
 * FNXC:CommitOwnership 2026-11-19-15:48: `%ct` is the only git clock that is honestly advanced by
 * the operations that legitimately move a commit forward (rebase, cherry-pick, squash), so a
 * re-attributed commit keeps its delivery while a commit stamped before its card's `createdAt`
 * cannot be one. A read that fails yields `null` fields, which SKIP the anachronism check rather
 * than refuse — the refusal direction stays reserved for a proven claim.
 */
export async function readCommitOwnershipFacts(
  repoDir: string,
  sha: string,
): Promise<{ subject: string; body: string; committerEpochMs: number | null }> {
  const { stdout } = await execAsync(
    `git show -s --format=%s%x1f%b%x1f${COMMIT_EPOCH_FORMAT_FIELD} ${shellQuote(sha)}`,
    { cwd: repoDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const [subject = "", body = "", epochRaw = ""] = stdout.split("\x1f");
  const epochSeconds = Number(epochRaw.trim());
  return {
    subject,
    body,
    committerEpochMs: Number.isFinite(epochSeconds) && epochSeconds > 0 ? epochSeconds * 1000 : null,
  };
}

/** True when the commit's ownership evidence REFUSES it as this task's delivery. */
async function commitOwnershipRejectsDelivery(
  repoDir: string,
  sha: string,
  taskId: string,
  lineageId: string | undefined,
  ownership?: CommitOwnershipProofContext,
): Promise<boolean> {
  const facts = await readCommitOwnershipFacts(repoDir, sha).catch(() => null);
  if (!facts) return false;
  const ownershipVerdict = getCommitTaskOwnership(taskId, lineageId, facts.subject, facts.body, {
    projectNamespace: ownership?.projectNamespace,
    taskCreatedAtMs: ownership?.taskCreatedAtMs,
    committerEpochMs: facts.committerEpochMs,
  });
  return ownershipVerdict.rejectionReason !== undefined;
}

async function commitHasForeignTaskOwnership(
  repoDir: string,
  sha: string,
  taskId: string,
  lineageId: string | undefined,
  ownership?: CommitOwnershipProofContext,
): Promise<boolean> {
  return commitOwnershipRejectsDelivery(repoDir, sha, taskId, lineageId, ownership);
}

async function branchHasNoUniqueDiff(repoDir: string, branchTip: string, baseBranch: string): Promise<boolean> {
  const { stdout: mergeBaseStdout } = await execAsync(
    `git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`,
    {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const mergeBase = mergeBaseStdout.trim();
  if (!mergeBase) return false;

  await execAsync(`git diff --quiet ${shellQuote(mergeBase)}..${shellQuote(branchTip)}`, {
    cwd: repoDir,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return true;
}

export async function findAlreadyMergedTaskCommit(
  input: AlreadyMergedLookupInput,
): Promise<AlreadyMergedLookupResult | null> {
  const { taskId, lineageId, repoDir, baseBranch, taskBranch, baseCommitSha, ownership } = input;

  try {
    if (lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`;
      const lineageCommand = [
        "git log",
        `--grep=${shellQuote(lineagePattern)}`,
        "-E",
        "--max-count=5",
        "--format=%H",
        shellQuote(baseBranch),
      ].join(" ");
      const lineage = await execAsync(lineageCommand, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      /*
      FNXC:CommitOwnership 2026-11-19-15:48: the trailer fast path used to hand back its FIRST grep
      hit with no ownership read at all, so it bypassed the anchor the ancestry path routes through.
      A refusal now moves to the next bounded candidate (and then on to the ancestry path), which is
      why the grep is bounded rather than `--max-count=1`.
      */
      for (const lineageSha of lineage.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        if (await commitOwnershipRejectsDelivery(repoDir, lineageSha, taskId, lineageId, ownership)) continue;
        return { sha: lineageSha, strategy: "trailer", ownershipProof: "lineage-trailer" };
      }
    }

    const trailerPattern = `^Fusion-Task-Id: ${escapeRegex(taskId)}$`;
    const trailerCommand = [
      "git log",
      `--grep=${shellQuote(trailerPattern)}`,
      "-E",
      "--max-count=5",
      "--format=%H",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(trailerCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    /*
    FNXC:CommitOwnership 2026-11-19-15:48: same closure as the lineage fast path — the first hit is
    a CANDIDATE, not a verdict. `36a88363e2` is exactly this shape: a bare-id grep would credit it
    to RUFU-391 with no ownership check ever running.
    */
    for (const sha of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      if (await commitOwnershipRejectsDelivery(repoDir, sha, taskId, lineageId, ownership)) continue;
      return { sha, strategy: "trailer", ownershipProof: "task-trailer" };
    }
  } catch {
    // Fall through to ancestry/patch-id checks.
  }

  let branchTip: string | null = null;
  const branchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
  const canonicalBranchName = canonicalFusionBranchName(taskId);
  /*
  FNXC:WorkflowRecovery 2026-06-28-21:36:
  FN-7143/FN-7187 proved patch-id and tree-equal fallbacks need branch identity proof, not just content equivalence. Only the canonical task branch may imply ownership for fallback matches, and any explicit foreign Fusion trailer on the branch tip or candidate commit rejects the recovery.
  */
  const hasCanonicalBranchIdentity = branchName === canonicalBranchName;
  let branchTipOwnershipVerified = false;
  let branchTipHasNoUniqueDiff = false;
  let branchTipForeignNoDiff = false;
  try {
    branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (hasCanonicalBranchIdentity) {
      branchTipHasNoUniqueDiff = await branchHasNoUniqueDiff(repoDir, branchTip, baseBranch).catch(() => false);
    }
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:31:
    A new no-op task branch can inherit the current main tip and therefore a previous task's Fusion trailer. Prove the branch has no unique diff from its merge-base before applying the FN-7143/FN-7187 foreign-tip guard; the base branch may have advanced since the no-op branch was created, so current base-tree equality is not part of ownership classification.
    */
    const branchTipHasForeignOwnership = await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId, ownership);
    if (!branchTipHasNoUniqueDiff && branchTipHasForeignOwnership) {
      return null;
    }
    branchTipForeignNoDiff = branchTipHasNoUniqueDiff && branchTipHasForeignOwnership;
    branchTipOwnershipVerified = true;

    execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (branchTipForeignNoDiff) {
      return { sha: branchTip, strategy: "no-diff", ownershipProof: "canonical-branch-no-diff" };
    }

    // FN-5441/5446 (2026-05-23 lost-work bug #2): `--grep=<taskId>` is a loose
    // match that also hits commits merely mentioning the task ID in prose.
    // Gather candidates (bounded) and accept only the first whose subject/body
    // is OWNERSHIP-anchored on the task — never the first raw grep hit.
    const ancestryCommand = [
      "git log",
      "--first-parent",
      "-E",
      `--format=%H%x1f%s%x1f%b%x1f${COMMIT_EPOCH_FORMAT_FIELD}%x1e`,
      `--grep=${shellQuote(escapeRegex(taskId))}`,
      "--max-count=20",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(ancestryCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const records = stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record.length > 0);
    for (const record of records) {
      const [candidateSha, candidateSubject = "", candidateBody = "", candidateEpoch = ""] = record.split("\x1f");
      const sha = candidateSha?.trim();
      const epochSeconds = Number(candidateEpoch.trim());
      /*
      FNXC:CommitOwnership 2026-11-19-15:48: the ancestry loop now carries `%ct` in its format.
      Without the clock the anachronism refusal would be unreachable on the one path that already
      ran the anchor honestly.
      */
      const ownershipVerdict = getCommitTaskOwnership(taskId, lineageId, candidateSubject, candidateBody, {
        projectNamespace: ownership?.projectNamespace,
        taskCreatedAtMs: ownership?.taskCreatedAtMs,
        committerEpochMs: Number.isFinite(epochSeconds) && epochSeconds > 0 ? epochSeconds * 1000 : null,
      });
      if (sha && ownershipVerdict.owned) {
        return { sha, strategy: "ancestry", ownershipProof: ownershipVerdict.proof };
      }
    }
  } catch {
    // Fall through to patch-id checks.
  }

  try {
    if (!hasCanonicalBranchIdentity) {
      return null;
    }
    if (!branchTip || !branchTipOwnershipVerified) {
      branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (hasCanonicalBranchIdentity) {
        branchTipHasNoUniqueDiff = await branchHasNoUniqueDiff(repoDir, branchTip, baseBranch).catch(() => false);
      }
      const branchTipHasForeignOwnership = await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId, ownership);
      if (!branchTipHasNoUniqueDiff && branchTipHasForeignOwnership) {
        return null;
      }
      branchTipForeignNoDiff = branchTipHasNoUniqueDiff && branchTipHasForeignOwnership;
      branchTipOwnershipVerified = true;
    }

    let branchBase = baseCommitSha?.trim();
    if (!branchBase) {
      const { stdout: mergeBaseStdout } = await execAsync(
        `git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`,
        {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      branchBase = mergeBaseStdout.trim();
    }

    if (!branchBase) {
      return null;
    }

    const branchPatchIdCommand = `git diff ${shellQuote(branchBase)}..${shellQuote(branchTip)} | git patch-id`;
    const { stdout: branchPatchIdOut } = await execAsync(branchPatchIdCommand, {
      cwd: repoDir,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const branchPatchIdLine = branchPatchIdOut
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0);
    const branchPatchId = branchPatchIdLine?.trim().split(/\s+/)[0];
    if (branchPatchId) {
      const basePatchMapCommand = `git log -n 200 -p --format='%H' ${shellQuote(baseBranch)} | git patch-id`;
      const { stdout: basePatchIdsOut } = await execAsync(basePatchMapCommand, {
        cwd: repoDir,
        shell: "/bin/sh",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });

      const basePatchMap = new Map<string, string>();
      for (const line of basePatchIdsOut.split("\n")) {
        const [patchId, sha] = line.trim().split(/\s+/);
        if (!patchId || !sha) continue;
        basePatchMap.set(patchId, sha);
      }

      const matchedSha = basePatchMap.get(branchPatchId);
      if (matchedSha && !await commitHasForeignTaskOwnership(repoDir, matchedSha, taskId, lineageId, ownership)) {
        return { sha: matchedSha, strategy: "patch-id", ownershipProof: "canonical-branch-patch" };
      }
    }
  } catch {
    // Fall through to null when patch-id detection fails.
  }

  try {
    const treeBranchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
    if (treeBranchName !== canonicalBranchName) {
      return null;
    }
    execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const { stdout: baseTreeStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const { stdout: branchTreeStdout } = await execAsync(`git rev-parse ${shellQuote(treeBranchName)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const baseTree = baseTreeStdout.trim();
    const branchTree = branchTreeStdout.trim();
    if (baseTree && branchTree && baseTree === branchTree) {
      const { stdout: baseHeadStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}`, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const baseHead = baseHeadStdout.trim();
      if (baseHead && (branchTipForeignNoDiff || !await commitHasForeignTaskOwnership(repoDir, baseHead, taskId, lineageId, ownership))) {
        return { sha: baseHead, strategy: "tree-equal", ownershipProof: "canonical-branch-tree" };
      }
    }
  } catch {
    // Fall through to null when tree-equality detection fails.
  }

  return null;
}

export async function detectAlreadyLandedOnMain(
  input: DetectAlreadyLandedInput,
): Promise<AlreadyMergedLookupResult | null> {
  return findAlreadyMergedTaskCommit({
    taskId: input.taskId,
    lineageId: input.lineageId,
    repoDir: input.rootDir,
    baseBranch: input.baseBranch,
    taskBranch: input.taskBranch,
    baseCommitSha: input.baseCommitSha,
    ownership: input.ownership,
  });
}
