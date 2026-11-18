/*
FNXC:DefaultBranchLandingProof 2026-11-05-16:44 (RUFU-702):
The git half of the landing proof, expressed over an INJECTED read-only runner so every landing authority
can ask the same question with the same probes. Every production lane injects the SAME runner —
`createArgvGitLandingRunner` below — because the engine's finalize seams and core's `mergeTaskImpl` door
reaching a repository through two different executors is exactly how one of them grew a shell (see the P0
block on that factory). One probe implementation, one decision, one way to run git.

The runner stays injectable for tests: a fake `runGit` is what lets the pure decision be exercised over
every three-valued answer without a repository.

The runner contract is deliberately three-valued and code-carrying, because two of its answers are
observations and one is a malfunction: `git merge-base --is-ancestor` and `git rev-parse --verify` say "no"
with exit 1, while any other non-zero exit means git could not answer at all. Collapsing those would turn
an unreadable repository into a fabricated delivery failure — the mass-refusal outcome this card must not
introduce.
*/

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  evaluateDefaultBranchLandingProof,
  isTaskDeclaredLandingTarget,
  type DefaultBranchLandingProofVerdict,
  type IntegrationAncestryOutcome,
  type PatchEquivalenceOutcome,
} from "./default-branch-landing-proof.js";
import type { MergeDetails } from "../types.js";

/**
 * Read-only git invocation: `args` are argv (never a shell string), and the exit code must survive.
 *
 * The type says "argv" because one of the arguments is repository-derived CONTENT: the content-equivalence
 * probe feeds paths read back from `git show --name-only` into the next call, and whoever commits a file
 * chooses its name. An argv element that reaches a shell is therefore an injection surface owned by whoever
 * wrote the commit, not by the platform.
 */
export type LandingProofGitRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string; code: number }>;

/*
FNXC:DefaultBranchLandingProof 2026-11-17-20:23 (RUFU-702, code-review P0):
One argv-only runner for every landing lane, because the core lane had a shell in it.

The docstring above promised "argv (never a shell string)" and the engine kept that promise with
`execFileAsync`, while `mergeTaskImpl` — the queue / dashboard / `fn task merge` door in core — built the
promise back into a command string and handed it to `TaskStore.runGitCommand`, which is
`spawn(command, { shell: true })` (`packages/core/src/process/run-command.ts`). Double-quoting each element
does not help: a POSIX shell performs `$(…)` and `$VAR` substitution *inside double quotes*, so a committed
filename such as `src/$(rm -rf .).ts` reached `git ls-tree` as code and ran in the project checkout on every
core-lane landing. That is not a hypothetical-input concern — the argv is exactly what `git show --name-only`
printed for the squash commit that lane had just created.

So the runner is built here, in the module that owns the contract, from `execFile` (argv, no shell, so there
is no quoting rule left to get wrong on either POSIX or `cmd.exe`), and both the core door and the engine
evidence module call THIS. A shared implementation is the point: two runners is how one lane grew a shell
while the other stayed clean and every review round read only the clean one.
*/
const execFileAsync = promisify(execFile);

/** A landing probe must never be able to hang a merge; both lanes used to carry their own copy of this bound. */
export const LANDING_PROBE_GIT_TIMEOUT_MS = 15_000;
/** Bounds what a probe may read, not what it may change — every probe here is read-only. */
export const LANDING_PROBE_GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface ArgvGitLandingRunnerOptions {
  /** Repository the probes run in — the SUB-REPO root for one workspace repository. */
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Async, bounded, argv-only git. The exit code and stdout both survive a non-zero exit because
 * `git merge-tree` prints its tree OID plus CONFLICT lines that way, and `merge-base --is-ancestor`
 * answers "no" with exit 1 — an observation, not a malfunction.
 */
export function createArgvGitLandingRunner(options: ArgvGitLandingRunnerOptions): LandingProofGitRunner {
  const timeout = options.timeoutMs ?? LANDING_PROBE_GIT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? LANDING_PROBE_GIT_MAX_BUFFER;
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf-8",
        timeout,
        maxBuffer,
        // No console window on Windows for a probe nobody asked to see.
        windowsHide: true,
      });
      return { ok: true, stdout: stdout ?? "", code: 0 };
    } catch (error) {
      const execError = error as { code?: number | string; stdout?: string };
      return {
        ok: false,
        stdout: typeof execError.stdout === "string" ? execError.stdout : "",
        // A non-numeric code (ENOENT, ETIMEDOUT, ABSDIR) is "git could not answer", which the probe
        // contract already treats as -1 and therefore as unreadable — never as an absent delivery.
        code: typeof execError.code === "number" ? execError.code : -1,
      };
    }
  };
}

export interface DefaultBranchLandingProofProbeInput {
  runGit: LandingProofGitRunner;
  integrationBranch: string;
  /** The delivery claim as the caller is about to record it. A null/blank sha carries no claim. */
  recordedSha?: string | null;
  landedBranchTipSha?: string | null;
  mergeTargetBranch?: string | null;
  mergeTargetSource?: MergeDetails["mergeTargetSource"] | null;
  prNumber?: number | null;
  prStateOpen?: boolean;
  squashRecordedOnIntegration?: boolean;
  /** Workspace per-repo results for an aggregate card; omit for a singular repository. */
  workspaceRepoLanding?: Record<string, "proven" | "absent" | "unreadable">;
  noOpVerified?: boolean;
  reportsNoOp?: boolean;
  /** Paths compared for content equivalence. Bounded so a 1 459-path landing costs two calls, not 1 459. */
  contentProbePathLimit?: number;
}

/** What the probes observed, plus the verdict the decision reached over them. */
export interface DefaultBranchLandingProofObservation {
  integrationBranch: string;
  integrationRefReadable: boolean;
  ancestryOutcome: IntegrationAncestryOutcome;
  /*
  FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
  Ancestry against the card's OWN declared target branch, for the one class that is measured against that
  yardstick (`isTaskDeclaredLandingTarget`). `"unreadable"` doubles as "not asked": a card already proven
  against the default branch never needs this probe, so the observation records the absence of a measurement
  rather than inventing one.
  */
  declaredTargetAncestryOutcome: IntegrationAncestryOutcome;
  patchEquivalentOutcome: PatchEquivalenceOutcome;
  conflictCount: number | null;
  groupBranchIsLive: boolean;
  verdict: DefaultBranchLandingProofVerdict;
}

type ObservationFacts = Omit<DefaultBranchLandingProofObservation, "verdict">;

async function resolveCommit(runGit: LandingProofGitRunner, revision: string): Promise<boolean | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (result.ok && result.stdout.trim().length > 0) return true;
  // Exit 1 from `rev-parse --verify` means "no such revision"; anything else means git could not answer.
  return result.code === 1 ? false : null;
}

/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
One ancestry probe, asked of whichever ref is the yardstick for this card: the resolved default branch, or
for a task-declared-target card its own target ref. Both refs and the commit are read back through
`rev-parse` BEFORE `merge-base`, so "the ref is not here" answers `unreadable` (no observation) and never
`absent` (an observation that refuses). A missing commit OBJECT stays `absent`: a repository that does not
hold the claimed commit cannot substantiate the claim, and that is evidence about the delivery, not a git
malfunction.
*/
async function ancestryAgainstRef(
  runGit: LandingProofGitRunner,
  sha: string,
  ref: string,
): Promise<IntegrationAncestryOutcome> {
  const commitExists = await resolveCommit(runGit, sha);
  if (commitExists === null) return "unreadable";
  if (commitExists === false) return "absent";
  if ((await resolveCommit(runGit, ref)) !== true) return "unreadable";
  const result = await runGit(["merge-base", "--is-ancestor", sha, ref]);
  if (result.ok) return "proven";
  return result.code === 1 ? "absent" : "unreadable";
}

/**
 * Content equivalence: is the recorded commit's post-image already on the integration branch?
 *
 * `git cherry` runs first because it is cheap and settles the rebase/`auto` shape. It is NOT sufficient: a
 * squash of SEVERAL commits combines them into one patch, so no per-commit patch-id matches and every
 * delivered commit reads `+` — RUFU-450's erratum measured exactly that on an already-delivered branch.
 * (A single-commit squash does preserve its patch-id and reads `-`, which is why `cherry` stays a useful
 * first pass rather than being simply wrong.) The decider is post-image blob identity over the paths the
 * commit touched, read in two batched `ls-tree` calls: a squash cannot forge a byte-identical blob at the
 * same path, so the match survives history rewriting where a three-dot `diff --stat` would re-report a
 * stale delta as a missing delivery.
 */
async function measurePatchEquivalence(
  runGit: LandingProofGitRunner,
  sha: string,
  integrationBranch: string,
  pathLimit: number,
): Promise<PatchEquivalenceOutcome> {
  const cherry = await runGit(["cherry", integrationBranch, sha]);
  if (cherry.ok) {
    const lines = cherry.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) => line.startsWith("-"))) return "proven";
  }

  const nameStatus = await runGit(["show", "--format=", "--name-only", "--no-renames", sha]);
  if (!nameStatus.ok) return "unreadable";
  const paths = Array.from(new Set(nameStatus.stdout.split("\n").map((line) => line.trim()).filter(Boolean)));
  if (paths.length === 0) {
    // A commit touching no path adds nothing; reporting equivalence is trivially true and keeps a
    // merge-commit-with-no-diff from reading as a missing delivery.
    return "proven";
  }
  const probed = paths.slice(0, pathLimit);

  const blobsAt = async (ref: string): Promise<Map<string, string> | null> => {
    const result = await runGit(["ls-tree", "-r", "--format=%(objectname) %(path)", ref, "--", ...probed]);
    if (!result.ok) return null;
    const map = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf(" ");
      if (split <= 0) continue;
      map.set(trimmed.slice(split + 1), trimmed.slice(0, split));
    }
    return map;
  };

  const [onCommit, onIntegration] = await Promise.all([blobsAt(sha), blobsAt(integrationBranch)]);
  if (!onCommit || !onIntegration) return "unreadable";

  for (const path of probed) {
    // A path the commit CREATED must exist on integration with the same blob; a path it DELETED must be
    // gone there too, so both sides being absent is a match.
    if (onCommit.get(path) !== onIntegration.get(path)) return "absent";
  }
  if (paths.length > probed.length) {
    // Only part of the delta was measurable. `proven` would overstate the observation and `absent` would
    // invent a failure, so the honest answer is "could not measure".
    return "unreadable";
  }
  return "proven";
}

/**
 * `git merge-tree --write-tree` conflict count — record-enriching only. It tells an operator whether a
 * card whose content is not on the default branch is merely stale (0 conflicts) or cannot land as-is
 * (RUFU-294 measured 238 CONFLICT lines), and never moves a verdict either way.
 */
async function measureConflictCount(
  runGit: LandingProofGitRunner,
  sha: string,
  integrationBranch: string,
): Promise<number | null> {
  const result = await runGit(["merge-tree", "--write-tree", integrationBranch, sha]);
  if (result.stdout.length === 0) return null;
  const conflicts = result.stdout.split("\n").filter((line) => line.startsWith("CONFLICT")).length;
  // A clean merge-tree exits 0 printing the tree OID; a conflicted one exits non-zero and still prints the
  // OID plus CONFLICT lines. Anything else means the probe did not run.
  if (!result.ok && conflicts === 0 && !result.stdout.includes("\n\nConflicts:")) return null;
  return conflicts;
}

function decideFromObservation(
  input: DefaultBranchLandingProofProbeInput,
  observed: ObservationFacts,
): DefaultBranchLandingProofVerdict {
  return evaluateDefaultBranchLandingProof({
    integrationBranch: observed.integrationBranch,
    integrationRefReadable: observed.integrationRefReadable,
    recordedSha: input.recordedSha ?? null,
    landedBranchTipSha: input.landedBranchTipSha ?? null,
    mergeTargetBranch: input.mergeTargetBranch ?? null,
    mergeTargetSource: input.mergeTargetSource ?? null,
    prNumber: input.prNumber ?? null,
    prStateOpen: input.prStateOpen === true,
    ancestryOutcome: observed.ancestryOutcome,
    declaredTargetAncestryOutcome: observed.declaredTargetAncestryOutcome,
    patchEquivalentOutcome: observed.patchEquivalentOutcome,
    squashRecordedOnIntegration: input.squashRecordedOnIntegration === true,
    conflictCount: observed.conflictCount,
    groupBranchIsLive: observed.groupBranchIsLive,
    workspaceRepoLanding: input.workspaceRepoLanding,
    noOpVerified: input.noOpVerified === true,
    reportsNoOp: input.reportsNoOp === true,
  });
}

/** Run every probe against one repository and hand the observations to the pure decision. */
export async function measureDefaultBranchLandingProofWithRunner(
  input: DefaultBranchLandingProofProbeInput,
): Promise<DefaultBranchLandingProofObservation> {
  const runGit = input.runGit;
  const integrationBranch = input.integrationBranch.trim();
  const recordedSha = input.recordedSha?.trim() || input.landedBranchTipSha?.trim() || "";
  const pathLimit = input.contentProbePathLimit ?? 40;

  const undecidable = (facts: ObservationFacts): DefaultBranchLandingProofObservation =>
    ({ ...facts, verdict: decideFromObservation(input, facts) });

  if (integrationBranch.length === 0) {
    return undecidable({
      integrationBranch,
      integrationRefReadable: false,
      ancestryOutcome: "unreadable",
      declaredTargetAncestryOutcome: "unreadable",
      patchEquivalentOutcome: "unreadable",
      conflictCount: null,
      groupBranchIsLive: false,
    });
  }

  const refReadable = (await resolveCommit(runGit, integrationBranch)) === true;
  const groupBranch = input.mergeTargetSource === "branch-group-integration"
    ? input.mergeTargetBranch?.trim()
    : undefined;
  const groupBranchIsLive = Boolean(groupBranch) && (await resolveCommit(runGit, groupBranch!)) === true;

  if (!refReadable || recordedSha.length === 0) {
    return undecidable({
      integrationBranch,
      integrationRefReadable: refReadable,
      ancestryOutcome: "unreadable",
      declaredTargetAncestryOutcome: "unreadable",
      patchEquivalentOutcome: "unreadable",
      conflictCount: null,
      groupBranchIsLive,
    });
  }

  const [ancestryOutcome, patchEquivalentOutcome, conflictCount] = await Promise.all([
    ancestryAgainstRef(runGit, recordedSha, integrationBranch),
    measurePatchEquivalence(runGit, recordedSha, integrationBranch, pathLimit),
    measureConflictCount(runGit, recordedSha, integrationBranch),
  ]);

  /*
  FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
  The second yardstick, asked only when it can still change the verdict. A card that already proved against
  the default branch never needs it (that observation is the stronger claim), so the extra probe is bounded to
  two read-only calls on the one class whose delivery vehicle is its own declared target, and a card that names
  a sibling task branch never pays for it at all.
  */
  const declaredTarget = input.mergeTargetBranch?.trim() ?? "";
  const asksDeclaredTarget = isTaskDeclaredLandingTarget({
    mergeTargetSource: input.mergeTargetSource,
    mergeTargetBranch: input.mergeTargetBranch,
    integrationBranch,
  }) && ancestryOutcome !== "proven" && patchEquivalentOutcome !== "proven";
  const declaredTargetAncestryOutcome = asksDeclaredTarget && declaredTarget.length > 0
    ? await ancestryAgainstRef(runGit, recordedSha, declaredTarget)
    : "unreadable";

  return undecidable({
    integrationBranch,
    integrationRefReadable: true,
    ancestryOutcome,
    declaredTargetAncestryOutcome,
    patchEquivalentOutcome,
    conflictCount,
    groupBranchIsLive,
  });
}
