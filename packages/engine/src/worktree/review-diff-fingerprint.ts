/*
FNXC:ReviewConvergence 2026-08-22-05:35:
FN-149 compares review rounds by the binary patch the reviewer received. Both singular and workspace
reviews use this helper so an unchanged code loop has one durable, content-addressed definition.
*/
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { resolveDescendantMergeBase } from "../execution/base-commit-capture.js";
import { executorLog } from "../logger.js";

const execFileAsync = promisify(execFile);

/*
FNXC:ReviewInputProof 2026-09-01-11:18:
A content-binding review proof must not silently disappear when a binary diff exceeds Node's default
one-megabyte child-process buffer. Bound Git capture explicitly so a large change either produces its
fingerprint or reports a named, fail-closed reason instead of creating a permanent merge wedge.

FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 keeps that BOUND and reworks how it is measured: the budget is now a streamed-byte ceiling,
not the size of a buffer that must hold the whole patch. `git diff --binary` output is hashed from
stdout chunk-by-chunk, so memory stays chunk-bounded while the refused size is exactly the same
10 MiB it was before (no raise without measurement). The bound still refuses rather than truncates:
a patch past it resolves to `git-diff-too-large`, never to a partial digest.
*/
export const REVIEW_DIFF_GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIFF_GIT_TIMEOUT_MS = 120_000;

/** Bounded options for the SMALL metadata probes below (`rev-list --count`, `--name-only`,
 *  `--shortstat`, `cat-file -e`), whose output is kilobytes. The binary patch itself never uses
 *  these — it streams (see `streamGitDiffFingerprint`). */
function gitCaptureOptions(cwd: string) {
  return {
    cwd,
    encoding: "utf8" as const,
    maxBuffer: REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
    timeout: REVIEW_DIFF_GIT_TIMEOUT_MS,
  };
}

export type ReviewDiffFingerprintProbe =
  | { state: "fingerprint"; fingerprint: string }
  | { state: "empty" }
  | { state: "unavailable"; reason: string };

export type ReviewChangesSinceCommitProbe =
  | { state: "frozen"; commitCount: 0 }
  | {
    state: "changed";
    commitCount: number;
    changedFiles: string[];
    totalChangedFileCount: number;
    shortstat?: string;
  }
  | { state: "unavailable"; reason: string };

export const MAX_REVIEW_CHANGED_FILES = 100;

export const EMPTY_REVIEW_DIFF_FINGERPRINT = "empty-review-input:v1";

export type ContentReviewInputProof =
  | { kind: "fingerprint"; fingerprint: string }
  | { kind: "unprovable"; reason: string };

/** Input for {@link probeSingularReviewDiffFingerprint}. */
export type SingularReviewDiffProbeInput = {
  /** The task's own checkout. Absent → `unavailable`, exactly as the HEAD-only probe reported it. */
  worktreePath: string | undefined;
  /** The card's recorded `baseCommitSha` when it has one; validated against the branch tip before use. */
  recordedBaseCommitSha: string | undefined;
  /** The card's own branch (`task.branch`). Absent → today's HEAD path, unchanged, for legacy rows. */
  branchRef: string | undefined;
  /**
   * Optional witness for checkout drift, called when the branch tip and HEAD name different commits.
   * Observation only — it adds no lifecycle state, because reviewer-session tree consistency against a
   * reclaimed detached checkout is a documented, out-of-scope limitation of reclaim policy.
   */
  driftNotice?: (detail: { branchRef: string; branchTipSha: string; headSha: string }) => void;
};

/** Peel a revision to its commit, or `undefined` when Git cannot resolve it in this repository. */
async function revParseCommit(worktreePath: string, revision: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${revision}^{commit}`],
      gitCaptureOptions(worktreePath),
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `git merge-base --is-ancestor`, tri-state collapsed to a boolean (any failure is "not an ancestor"). */
async function isCommitAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      gitCaptureOptions(worktreePath),
    );
    return true;
  } catch {
    return false;
  }
}

/** `resolveDiffBaseRef` never throws today, but its callers have always treated a throw as "no base". */
async function resolveHeadLegBaseRef(worktreePath: string, recordedBaseCommitSha: string | undefined): Promise<string | undefined> {
  try {
    return await resolveDiffBaseRef(worktreePath, recordedBaseCommitSha);
  } catch {
    return undefined;
  }
}

/*
FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521):
The singular review content proof measured the checkout's mutable HEAD, so a drifted checkout could
convince the platform a card with real work had delivered nothing at all.

Live harm (RUFU-290): the card's branch carried its own commits while `.fusion/worktrees/rufu-290`
sat detached on an unrelated `main` commit. The HEAD-relative base resolved to that very commit, so
`git diff --binary mainTip..HEAD` was an empty patch, the step row recorded
`reviewInputFingerprint = empty-review-input:v1`, and a `REVISE` verdict was written about content that
was never read. `no-commits-finalize-guard.ts` then accepts that sentinel as zero-diff proof, so one
false sentinel is a false "zero delivery" claim at the finalize gate too.

The target rule this composition locks, in order:
 1. No `branchRef` → today's HEAD path verbatim. Legacy/branchless cards are untouched.
 2. Resolve the tip with ONE `rev-parse --verify <branch>^{commit}`; unresolvable → the named
    `branch-ref-unresolvable` reason, fail-closed. Never `empty`: "cannot read the branch" and
    "the branch is empty" are different claims (dispatch refuses, the merge door says `unavailable`).
 3. The base MUST be branch-relative. The probe is a TWO-DOT `git diff --binary <base>..<target>`, a
    tree-to-tree comparison, so a base newer than the tip renders every integration-only commit the
    branch lacks as DELETIONS of other people's work and corrupts the digest. Accept the recorded base
    only when it is an ancestor of the tip; otherwise recompute with the SAME descendant-of-two-merge-bases
    rule RUFU-445 consolidated, anchored on the tip. Neither resolving → `no-diff-base`, never `empty`.
 4. A non-empty branch leg wins outright. That one rule is what frees a drifted card from a false empty.
 5. Branch leg empty → re-probe HEAD exactly as today (`resolveDiffBaseRef` + `base..HEAD`), preserving
    the documented overlap-resume case where the branch is at the base but the checkout carries the work.
 6. Only when BOTH legs, each on its own correctly-based diff, report no content does `empty` — and so
    the sentinel — become true. The sentinel now means "verified HEAD <-> task.branch relation", not
    "the checkout happened to be sitting somewhere".

Locked stability invariant: when HEAD already equals the branch tip and the base is an ancestor of it,
rule 3 plus rule 4 compute the SAME byte range today's HEAD probe computes, so the sha256 — and every
stored `reviewInputFingerprint`, including the rows `stale-content-review-reroute.ts` compares at the
merge door — stays valid across this deploy. Only genuinely drifted cards change identity, which IS the
correction. Pinned by the two healthy-checkout fixtures in `review-diff-fingerprint.test.ts`.
*/
export async function probeSingularReviewDiffFingerprint(
  input: SingularReviewDiffProbeInput,
): Promise<ReviewDiffFingerprintProbe> {
  const { worktreePath, recordedBaseCommitSha, branchRef } = input;
  if (!worktreePath) return { state: "unavailable", reason: "missing-worktree-or-base" };

  if (!branchRef) {
    return await probeReviewDiffFingerprint(worktreePath, await resolveHeadLegBaseRef(worktreePath, recordedBaseCommitSha));
  }

  const branchTipSha = await revParseCommit(worktreePath, branchRef);
  if (!branchTipSha) return { state: "unavailable", reason: "branch-ref-unresolvable" };

  if (input.driftNotice) {
    const headSha = await revParseCommit(worktreePath, "HEAD");
    if (headSha && headSha !== branchTipSha) {
      input.driftNotice({ branchRef, branchTipSha, headSha });
    }
  }

  let branchBaseRef: string | undefined;
  if (recordedBaseCommitSha) {
    const recorded = await revParseCommit(worktreePath, recordedBaseCommitSha);
    if (recorded && await isCommitAncestor(worktreePath, recorded, branchTipSha)) branchBaseRef = recorded;
  }
  if (!branchBaseRef) {
    branchBaseRef = await resolveDescendantMergeBase(worktreePath, {
      revision: branchTipSha,
      logger: { warn: (msg) => executorLog.warn(`Failed branch-relative merge-base lookup for review proof in ${worktreePath}: ${msg}`) },
    });
  }
  if (!branchBaseRef) return { state: "unavailable", reason: "no-diff-base" };

  const branchProbe = await probeReviewDiffFingerprint(worktreePath, branchBaseRef, branchTipSha);
  if (branchProbe.state !== "empty") return branchProbe;

  // Rules 5 and 6 share one call: a HEAD fingerprint is the overlap-resume truth, `empty` is the
  // both-legs-agree verdict, and an unavailable HEAD keeps the probe fail-closed instead of empty.
  return await probeReviewDiffFingerprint(worktreePath, await resolveHeadLegBaseRef(worktreePath, recordedBaseCommitSha));
}

/** {@link computeReviewDiffFingerprint} under the branch target rule: no signal for empty or unreadable. */
export async function computeSingularReviewDiffFingerprint(
  input: SingularReviewDiffProbeInput,
): Promise<string | undefined> {
  const result = await probeSingularReviewDiffFingerprint(input);
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

/** {@link computeCodeReviewInputFingerprint} under the branch target rule: empty collapses to the sentinel. */
export async function computeSingularCodeReviewInputFingerprint(
  input: SingularReviewDiffProbeInput,
): Promise<string | undefined> {
  const result = await probeSingularReviewDiffFingerprint(input);
  if (result.state === "empty") return EMPTY_REVIEW_DIFF_FINGERPRINT;
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

/**
 * Resolve and normalize the singular source input that a content-binding review must approve.
 *
 * FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521): `branchRef` is optional so branchless callers keep
 * today's HEAD path byte-for-byte; singular content-binding lanes pass `task.branch` and are measured
 * against the card's own delivery. Every pre-existing `reason` value still ships: the composition
 * reports an unresolvable base as `missing-worktree-or-base`, which this seam has always published under
 * its own honest name (`no-diff-base`) and still does. `driftNotice` is the dispatch lane's chance to
 * name a drifted checkout on the card; it never changes the proof.
 */
export async function resolveContentReviewInputProof(
  worktreePath: string,
  diffBaseCommitSha: string | undefined,
  branchRef?: string,
  driftNotice?: SingularReviewDiffProbeInput["driftNotice"],
): Promise<ContentReviewInputProof> {
  const probe = await probeSingularReviewDiffFingerprint({
    worktreePath,
    recordedBaseCommitSha: diffBaseCommitSha,
    branchRef,
    ...(driftNotice ? { driftNotice } : {}),
  });
  if (probe.state === "empty") {
    return { kind: "fingerprint", fingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT };
  }
  if (probe.state === "fingerprint") return { kind: "fingerprint", fingerprint: probe.fingerprint };
  return { kind: "unprovable", reason: probe.reason === "missing-worktree-or-base" ? "no-diff-base" : probe.reason };
}

/*
FNXC:MergeContentDescriptor 2026-08-23-07:12:
FN-180's positive merge gate must distinguish an empty patch from an unreadable
one. The legacy helper keeps its lossy signature for existing callers; merge
admission uses this probe and fails closed on unavailable Git evidence.
*/
/*
FNXC:WorkspaceReviewFingerprint 2026-08-23-08:32:
FN-180 must compare a workspace repository's approved base-to-task-branch patch even when its
checkout remains on the integration branch. The optional target ref preserves singular HEAD callers
while preventing a clean checkout from being mistaken for an empty reviewed branch.
*/
/*
FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 — hashing a streamed patch instead of buffering it. Measured on RUFU-281:
`git diff --binary e0b25b4ccd..HEAD` produced 38 867 308 bytes and Node killed the child at
10 470 778 bytes with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which classified as `git-diff-too-large`
and refused the mandatory Code Review gate forever — even though the card's REAL diff (against the
correct integration base) was 112 781 bytes. Two requirements are preserved verbatim:

 - FN-180's empty-vs-unreadable split: zero bytes streamed with a clean exit is a definite EMPTY
   input (`{ state: "empty" }` → `EMPTY_REVIEW_DIFF_FINGERPRINT`); a spawn failure, a timeout kill,
   or a non-zero git exit stays `unavailable` / `git-diff-failed` and fails closed. The argv
   (`git diff --binary <base>..<target>`) is unchanged, so the reviewed content is identical.
 - The refusal reason enum (`no-diff-base` / `git-diff-too-large` / `git-diff-failed`) stays honest:
   the byte ceiling is checked as chunks arrive and the child is killed the moment it is exceeded,
   so `git-diff-too-large` means "more than 10 MiB of patch", never "we lost part of it".

Fingerprint definition: the legacy digest hashed the utf8-DECODED stdout string; this one hashes the
raw bytes. For any patch that round-trips through utf8 (which includes git's own base85 `GIT binary
patch` blocks) the two digests are identical — asserted by `review-diff-fingerprint-buffer.test.ts`.
For a byte-lossy patch (a text file holding invalid utf8) the digest MAY differ, because utf8
decoding is lossy where streaming is not. The only consequence is one extra "review input changed"
convergence round after this ships: it can never approve a review that has not run, and it cannot
wedge a merge, because an input fingerprint is compared only against another input fingerprint.
*/
/*
FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521):
The refusal reason enum above grew one member: `branch-ref-unresolvable`, returned when the card names
`task.branch` but that ref resolves to no commit in the repository. It is deliberately a named refusal
and never `empty`, because `empty` is a positive claim of zero delivery that a card with commits must
not receive. The three pre-existing reasons keep their exact meanings; `missing-worktree-or-base` still
publishes as `no-diff-base` through `resolveContentReviewInputProof`.
*/
function streamGitDiffFingerprint(worktreePath: string, range: string): Promise<ReviewDiffFingerprintProbe> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    let streamedBytes = 0;
    let settled = false;
    let timedOut = false;
    // Holder object rather than a bare `let`: `finish` is defined before the timer exists and must
    // still be able to clear it.
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {};
    let child: ReturnType<typeof spawn>;
    const finish = (probe: ReviewDiffFingerprintProbe) => {
      if (settled) return;
      settled = true;
      if (timerRef.id) clearTimeout(timerRef.id);
      resolve(probe);
    };
    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead or unkillable — the settled probe is what the caller acts on.
      }
    };

    try {
      // stderr is discarded, not collected: a full stderr pipe would stall the child, and a git
      // warning is never review evidence.
      child = spawn("git", ["diff", "--binary", range], {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ state: "unavailable", reason: "git-diff-failed" });
      return;
    }

    timerRef.id = setTimeout(() => {
      timedOut = true;
      killChild();
      finish({ state: "unavailable", reason: "git-diff-failed" });
    }, REVIEW_DIFF_GIT_TIMEOUT_MS);
    timerRef.id.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      streamedBytes += chunk.length;
      if (streamedBytes > REVIEW_DIFF_GIT_MAX_BUFFER_BYTES) {
        killChild();
        finish({ state: "unavailable", reason: "git-diff-too-large" });
        return;
      }
      hash.update(chunk);
    });
    child.on("error", () => {
      killChild();
      finish({ state: "unavailable", reason: "git-diff-failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut || code !== 0) {
        finish({ state: "unavailable", reason: "git-diff-failed" });
        return;
      }
      finish(streamedBytes === 0
        ? { state: "empty" }
        : { state: "fingerprint", fingerprint: hash.digest("hex") });
    });
  });
}

export async function probeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<ReviewDiffFingerprintProbe> {
  if (!worktreePath || !baseRef) return { state: "unavailable", reason: "missing-worktree-or-base" };
  return await streamGitDiffFingerprint(worktreePath, `${baseRef}..${targetRef}`);
}

/*
FNXC:ReviewConvergence 2026-08-28-10:57:
A same-gate review needs Git-derived evidence of what landed after the commit its previous round
inspected. Keep the file list bounded for prompt safety, and report unreadable evidence as unavailable
rather than inventing progress or a frozen tree.
*/
export async function probeReviewChangesSinceCommit(
  worktreePath: string | undefined,
  reviewedCommitSha: string | undefined,
): Promise<ReviewChangesSinceCommitProbe> {
  if (!worktreePath || !reviewedCommitSha) {
    return { state: "unavailable", reason: "missing-worktree-or-reviewed-commit" };
  }

  try {
    await execFileAsync("git", ["cat-file", "-e", `${reviewedCommitSha}^{commit}`], gitCaptureOptions(worktreePath));
    const [{ stdout: countOutput }, { stdout: filesOutput }, { stdout: shortstatOutput }] = await Promise.all([
      execFileAsync("git", ["rev-list", "--count", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
      execFileAsync("git", ["diff", "--name-only", "-z", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
      execFileAsync("git", ["diff", "--shortstat", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
    ]);
    const commitCount = Number.parseInt(countOutput.trim(), 10);
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
      return { state: "unavailable", reason: "invalid-commit-count" };
    }
    if (commitCount === 0) return { state: "frozen", commitCount: 0 };

    const allChangedFiles = filesOutput.split("\0").filter(Boolean);
    const shortstat = shortstatOutput.trim() || undefined;
    return {
      state: "changed",
      commitCount,
      changedFiles: allChangedFiles.slice(0, MAX_REVIEW_CHANGED_FILES),
      totalChangedFileCount: allChangedFiles.length,
      ...(shortstat ? { shortstat } : {}),
    };
  } catch {
    return { state: "unavailable", reason: "git-changes-since-review-failed" };
  }
}

/** Returns no signal for an absent/empty/unreadable diff; a failed probe must never invent progress. */
export async function computeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<string | undefined> {
  const result = await probeReviewDiffFingerprint(worktreePath, baseRef, targetRef);
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

/*
FNXC:ReviewEmptyContent 2026-08-28-13:14:
A provably empty Code Review diff is a definite input, not missing evidence. Collapsing it into
undefined made unchanged-review convergence permanently blind for tasks with no changes, while an
unreadable Git diff must remain unavailable and fail closed.
*/
export async function computeCodeReviewInputFingerprint(
  worktreePath: string | undefined,
  baseRef: string | undefined,
  targetRef = "HEAD",
): Promise<string | undefined> {
  const result = await probeReviewDiffFingerprint(worktreePath, baseRef, targetRef);
  if (result.state === "empty") return EMPTY_REVIEW_DIFF_FINGERPRINT;
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}
