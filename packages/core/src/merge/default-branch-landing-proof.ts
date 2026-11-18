/*
FNXC:DefaultBranchLandingProof 2026-11-05-18:40 (RUFU-702):
**Invariant: a card may claim `landed` only when its recorded commit is reachable from the project's
resolved default/integration branch, or is proven equivalent to content that is.** Nothing else is
delivery. In particular, advancing a branch ref is not delivery — not the task's own branch, and emphatically
not a SIBLING card's branch.

RUFU-294 is the measured failure. The AI merge lane advanced `fusion/rufu-293` (the *sibling* card's branch)
to `62804b4340a3ac40e7d1e94216782e1d75b168d3` inside a refreshed worktree, wrote
`mergeDetails = { commitSha: 62804b4340…, mergeTargetBranch: "fusion/rufu-293",
mergeTargetSource: "task-base-branch", mergeConfirmed: true }`, and finalized `in-review → done`. Live
git on 2026-11-05: `git merge-base --is-ancestor 62804b4340 main` → NO; the only ref containing it is
`remotes/lan/fusion/rufu-293`; `git merge-tree --write-tree main 62804b4340` reports 238 CONFLICT lines
against a 22-day-stale merge base, so it is not "will land later"; and both test files its own commit
message names (`packages/engine/src/__tests__/review-verdict-durable-advance.test.ts`,
`packages/core/src/__tests__/move-done-failed-premerge-refusal.test.ts`) are absent from `main`
(`git cat-file -e main:<path>` fails, `git grep -l` on `main` finds nothing). Zero delivery.

Why the pre-existing containment check could not catch it: `auto-merge-finalization.ts` asked
`enforceZeroCommitLandingProof({ integrationBranch: mergeDetails.mergeTargetBranch })` — containment
against the **recorded** target, a field written by the very lane asking to be believed. A lane that
advanced `fusion/rufu-293` and recorded `mergeTargetBranch = fusion/rufu-293` therefore proved its own
delivery. The core resolver guard that was supposed to prevent the whole shape
(`task-merge.ts` → `isFusionSiblingBranch`) only recognized `fusion/fn-*`, so on an `RUFU-`/`SANE-`/`KB-`
board it never fired. The lesson is general: **the ref a landing claim is measured against must come from
the resolver (`resolveIntegrationBranch`), never from the row under test.**

Why a `refreshed-worktree` branch-ref advance can NEVER satisfy this predicate on its own: the advance
happens inside a worktree whose checked-out ref may be any branch (the landing target the row named), and
`LocalSyncOutcome` reports only that ref+index+tree moved together. It is a statement about *a* checkout,
not about the default branch. RUFU-294's `localSync` was `refreshed-worktree` and its delivery was zero, so
this module treats the sync outcome as evidence about the worktree and takes default-branch reachability
as the only delivery question.

Why ancestry alone is also insufficient — in BOTH directions:
- **False negative under `always-squash`** (the project default): a squash landing creates a NEW sha on the
  default branch, so the branch head legitimately differs from the landed sha and a rebase/`auto` strategy
  rewrites it too. A predicate that demanded the branch tip be an ancestor would reopen genuinely delivered
  cards. Hence `patchEquivalentOutcome` and `squashRecordedOnIntegration` are first-class proofs.
- **False positive for the RUFU-294 shape**: that sha WAS reachable from *a* ref (`lan/fusion/rufu-293`).
  Ancestry is only meaningful against the resolved integration ref, which is why the input names the
  outcome as measured against `integrationBranch` and why an unreadable integration ref is a DEFERRAL,
  never an absence.

`conflictCount` is deliberately never a proof in either direction: a conflict-free merge is not a
delivery, and a conflicted one is only "not yet delivered" information. It enriches the recorded refusal
so an operator can tell "stale, will land later" from "cannot land as-is".
*/

import type { MergeDetails, PrInfo } from "../types.js";

/** Where the recorded commit sits relative to the RESOLVED integration branch. Three-valued on purpose. */
export type IntegrationAncestryOutcome = "proven" | "absent" | "unreadable";

/** The same three-valued answer for patch-equivalence (`git cherry` / `patch-id`) against integration. */
export type PatchEquivalenceOutcome = "proven" | "absent" | "unreadable";

/**
 * How a landing was proven. Each value names the observation that earned it so a caller cannot cite a
 * kind it did not measure, and so the audit row answers "on what grounds did this card close?".
 */
export type DefaultBranchProofKind =
  /** The recorded sha is an ancestor of the resolved integration branch. */
  | "integration-ancestry"
  /** The lane recorded a squash commit that is itself on the integration branch. */
  | "recorded-squash-on-integration"
  /** Branch history was rewritten (squash/rebase); the content is patch-equivalent to integration content. */
  | "patch-equivalent"
  /** An open PR entity is the landing vehicle — delivery is owed by the host, not by local ancestry. */
  | "pr-backed"
  /** Shared-branch-group member landing onto a live group branch: proven-for-member, promotion still owed. */
  | "group-intermediate"
  /*
  FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
  The operator answered the question the merge lane put to it: a task-declared target branch that is NOT a
  `fusion/*` task branch (`release`, `release/9.9`, `integration/v2`) IS a valid delivery vehicle, so a card
  that delivered to its own declared target must not be reported undelivered because the yardstick was
  `resolveIntegrationBranch()` -> `main`. `main` is not a universal yardstick.
  */
  /** The recorded commit is on the card's OWN declared target branch, which is a human ref, not a task ref. */
  | "task-declared-target"
  /** Every workspace repository proved its own per-repo default-branch landing. */
  | "workspace-per-repo"
  /** A verified no-op: every branch commit was observed already on integration. */
  | "verified-no-op";

/**
 * Why automatic delivery was refused. A closed vocabulary, so a query answers "why is this card still in
 * review" without reading prose, and so no lane can author its own excuse.
 */
export type LandingProofRefusalCode =
  /** A recorded sha exists, the integration ref is readable, and it is neither an ancestor nor patch-equivalent. */
  | "commit-not-on-integration-branch"
  /** The lane claims a squash landing on the integration branch itself, but that squash sha is not there. */
  | "squash-commit-not-recorded-on-integration"
  /** History was rewritten (recorded sha ≠ landed branch tip), ancestry fails, and the content match was measured ABSENT. */
  | "patch-equivalence-absent"
  /** The recorded landing target is a Fusion task branch — a ref that can never be delivery. */
  | "landing-target-not-integration"
  /** A workspace card whose per-repository landing is unproven in at least one repository. */
  | "workspace-repo-landing-unproven";

/**
 * Why the predicate abstained. A deferral is never a refusal: unreadable evidence is the absence of an
 * observation, and refusing on it would convert a bare or mid-operation repository into a false
 * delivery claim on the innocent cards it hosts.
 */
export type LandingProofDeferralReason =
  /** The resolved integration branch does not resolve to a readable ref (bare repo, no `origin/HEAD`, mid-operation). */
  | "integration-ref-unreadable"
  /** The card carries no delivery claim to test, or the probe could not complete the measurement the decision needs. */
  | "landing-evidence-incomplete";

export type DefaultBranchLandingProofVerdict =
  | { disposition: "proven"; proofKind: DefaultBranchProofKind }
  | { disposition: "refused"; refusalCode: LandingProofRefusalCode; reason: string }
  | { disposition: "deferred"; reason: LandingProofDeferralReason };

export interface DefaultBranchLandingProofInput {
  /** The RESOLVED default/integration branch (`resolveIntegrationBranch`), never `mergeDetails.mergeTargetBranch`. */
  integrationBranch: string;
  /** Whether that branch resolves to a readable ref. False ⇒ defer, unconditionally. */
  integrationRefReadable: boolean;
  /** `mergeDetails.commitSha`. */
  recordedSha?: string | null;
  /** `mergeDetails.landedBranchTipSha` — the branch tip the lane saw when it landed. */
  landedBranchTipSha?: string | null;
  /** `mergeDetails.mergeTargetBranch` — the target the lane believes it landed to. Evidence, never the yardstick. */
  mergeTargetBranch?: string | null;
  /** `mergeDetails.mergeTargetSource` — who supplied that target. */
  mergeTargetSource?: MergeDetails["mergeTargetSource"] | null;
  /** The PR entity number when the landing vehicle is a pull request. */
  prNumber?: number | null;
  /** Whether that PR entity is open/active (`isPrBacked`). */
  prStateOpen?: boolean;
  /** Ancestry of `recordedSha` (or `landedBranchTipSha`) against `integrationBranch`. */
  ancestryOutcome: IntegrationAncestryOutcome;
  /**
   * Ancestry of `recordedSha` against the card's OWN declared target branch, measured only for a card whose
   * delivery vehicle is that target (`isTaskDeclaredLandingTarget`). Three-valued like `ancestryOutcome`: an
   * unreadable target ref (a remote-only branch that was never materialized) must never read as absence.
   */
  declaredTargetAncestryOutcome?: IntegrationAncestryOutcome;
  /** Patch-equivalence of the card's content against `integrationBranch` content. */
  patchEquivalentOutcome: PatchEquivalenceOutcome;
  /** The lane recorded a squash commit that the probe found ON the integration branch. */
  squashRecordedOnIntegration?: boolean;
  /** `git merge-tree` CONFLICT line count against integration. Record-enriching only, never a proof. */
  conflictCount?: number | null;
  /** The shared group branch named by `mergeTargetBranch` exists as a live ref. */
  groupBranchIsLive?: boolean;
  /** Per-repository workspace landings: repository key → that repo proved its own default-branch landing. */
  workspaceRepoLanding?: Record<string, "proven" | "absent" | "unreadable">;
  /** `mergeDetails.noOpVerifiedShortCircuit` — a positive observation, not a claim of emptiness. */
  noOpVerified?: boolean;
  /** The lane reports zero landed files (a no-op finalize). Diagnostic only: it never widens permission. */
  reportsNoOp?: boolean;
}

/** Task-branch refs are start points and rebase anchors; a landing onto one is a stranded commit, never delivery. */
/*
FNXC:TaskBranchTargetGuard 2026-11-05-18:40 (RUFU-702):
Generalized from `task-merge.ts`'s `^fusion/fn-` (which is why RUFU-294's `fusion/rufu-293` target passed)
to the structural task-branch shape: `fusion/<BOARD-PREFIX>-<number>`, plus the `-stranded` recovery-ref
family. Deliberately NOT "any single-segment `fusion/*`" and deliberately NOT a prefix test:
`fusion/groups/<slug>` is a sanctioned intermediate target (resolved through the group arm) and a human
branch that merely shares the prefix (`fusion/release-1.0`) keeps its current behavior. A false positive
(a human branch named exactly `<word>-<digits>`) costs a fall-through to the project default, which is
conservative; a false negative costs lost work, which is what this card measured.
*/
const FUSION_TASK_BRANCH_RE = /^fusion\/[a-z][a-z0-9]*-\d+(?:-stranded)?$/i;

/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702):
The shared-branch-group namespace. Naming it as a constant rather than inlining the literal, because two
arms of this decision have to agree that a group branch is platform-owned: the group arm proves a member
landing FOR THE MEMBER ONLY, and the task-declared-target arm must therefore never read the same ref as that
card's own delivery vehicle. The group's promotion to the default branch stays separately owed either way.
*/
const SHARED_GROUP_BRANCH_NAMESPACE = "fusion/groups/";

/** Whether a ref name is shaped like a Fusion-owned task branch (any board id prefix), not an integration ref. */
export function isFusionTaskBranchRefName(branch: string | null | undefined): boolean {
  if (!branch) return false;
  const trimmed = branch.trim();
  if (trimmed.length === 0) return false;
  return FUSION_TASK_BRANCH_RE.test(trimmed);
}

/*
FNXC:DefaultBranchLandingProof 2026-11-17-20:23 (RUFU-702, code-review P1):
`pr-backed` was a proof kind no production lane could ever reach: the door took `prStateOpen` as an input
and only the unit test ever set it, so a card whose landing vehicle is an open pull request was measured as
an ordinary direct-merge card and could be refused for content the hosted PR still owes. The reason it never
 got wired is that the two PR surfaces speak different vocabularies — the unified `PrEntity.state`
(`creating | open | responding | merged | closed | failed`, read through `isPrBacked`) and the row-carried
`PrInfo.status` (`open | draft | merged | closed`). This mapper is the legacy half of that read, kept here so
the mapping exists once and both lanes (`Task.mergeTaskImpl` in core, `enforceDefaultBranchLandingProof` in
the engine) state the same rule over the same field.

The group carve-out is copied from `isPrBacked`, not reinvented: a shared-group MEMBER landing onto its group
branch is never PR-backed, or members could never land and the group's PR could never advance.
*/
/** Whether the task's own legacy PR-info row is a live pull request, i.e. the landing vehicle is the host. */
export function isPrInfoLandingVehicleOpen(
  prInfo: Pick<PrInfo, "status"> | null | undefined,
  mergeTargetSource?: MergeDetails["mergeTargetSource"] | null,
): boolean {
  if (!prInfo) return false;
  if (mergeTargetSource === "branch-group-integration") return false;
  return prInfo.status === "open" || prInfo.status === "draft";
}

/** True when the row's own claim is "I landed a squash onto the integration branch itself". */
function claimsIntegrationTarget(input: DefaultBranchLandingProofInput): boolean {
  const target = input.mergeTargetBranch?.trim();
  if (!target) return false;
  return target.replace(/^refs\/heads\//, "") === input.integrationBranch.trim();
}

/** A shared-group member landing onto its group branch is proven-for-member; group→default promotion is separately owed. */
/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
Which cards are measured against a yardstick other than the resolved default branch: exactly those whose
landing target came from the CARD'S OWN declared `baseBranch` (`mergeTargetSource: "task-base-branch"`),
resolves to a ref that is not a Fusion task branch, and differs from the resolved integration branch.

Why `mergeTargetSource` is the discriminator and not the branch name: `task-branch-context` (a shared group
inheritance) and `branch-group-integration` (whose `group-intermediate` arm already carries its own, weaker
verdict) both name a branch the card does not own, so landing on them is not that card's delivery decision.
`project-default` and `legacy-main` name the default branch itself, which the ordinary arms already measure.
The operator decision named only "the card's own declared target branch", so only `task-base-branch` qualifies.

Why the task-ref exclusion stays: `landing-target-not-integration` exists because RUFU-294 advanced the
SIBLING card's branch `fusion/rufu-293` and called that delivery. A sibling's task branch is a ref another
card's delivery claim owns; `release/9.9` is nobody's working branch. `isFusionTaskBranchRefName` is the same
structural predicate the refusal uses, so the two arms can never disagree about which class a ref is in.
*/
export function isTaskDeclaredLandingTarget(
  input: Pick<DefaultBranchLandingProofInput, "mergeTargetSource" | "mergeTargetBranch" | "integrationBranch">,
): boolean {
  const target = input.mergeTargetBranch?.trim() ?? "";
  const integrationBranch = input.integrationBranch?.trim() ?? "";
  if (!target || !integrationBranch || target === integrationBranch) return false;
  if (input.mergeTargetSource !== "task-base-branch") return false;
  // The shared-group namespace is platform-owned, whatever shape the row's `baseBranch` happens to hold: a
  // group branch's landing semantics belong to the group arm (`group-intermediate`, proven-for-member), and
  // reading one as this card's own delivery vehicle would silently promote a member-only verdict to delivery.
  if (target.toLowerCase().startsWith(SHARED_GROUP_BRANCH_NAMESPACE)) return false;
  return !isFusionTaskBranchRefName(target);
}

function isGroupIntermediateTarget(input: DefaultBranchLandingProofInput): boolean {
  return input.mergeTargetSource === "branch-group-integration"
    && input.groupBranchIsLive === true
    && Boolean(input.mergeTargetBranch?.trim());
}

function refusal(code: LandingProofRefusalCode, detail: string): DefaultBranchLandingProofVerdict {
  return { disposition: "refused", refusalCode: code, reason: detail };
}

/**
 * Decide whether a delivery claim is substantiated by the resolved default branch.
 *
 * Pure: every input is an already-measured observation, so the decision is reproducible, unit-testable,
 * and identical for every lane. Git lives in the engine probe
 * (`packages/engine/src/merge/default-branch-landing-proof-evidence.ts`); this module only ever answers
 * "do these measurements license `done`?".
 *
 * Ladder (first match wins):
 * 1. no delivery claim at all → `deferred: landing-evidence-incomplete`; a verified no-op is proven.
 * 2. unreadable/blank integration ref → `deferred: integration-ref-unreadable` (never a refusal).
 * 3. ANY positive observation → `proven` (ancestry, recorded squash on integration, patch-equivalence,
 *    all-repos-proven workspace land, open-PR vehicle, live group intermediate, the card's own declared
 *    target branch holding the commit — `task-declared-target`).
 * 4. a workspace card with a repository measured ABSENT → `refused: workspace-repo-landing-unproven`;
 *    with a repository merely unreadable → `deferred: landing-evidence-incomplete`.
 * 5. the recorded target names a Fusion task branch → `refused: landing-target-not-integration`.
 * 6. patch-equivalence measured absent on a rewritten-history card → `refused: patch-equivalence-absent`;
 *    for a task-declared-target card whose own target could not be read, `deferred` instead, because an
 *    unmeasured yardstick is not an absence.
 * 7. otherwise the content is simply not there → `refused: commit-not-on-integration-branch`,
 *    unless the patch probe could not run → `deferred: landing-evidence-incomplete`.
 *
 * `mergeConfirmed`, `noOpMerge`, and `mergeDetails` themselves are NOT inputs: they are the claim under
 * test, and a lane that could approve itself by setting a flag it is being guarded on is the exact shape
 * both RUFU-262 and RUFU-294 demonstrate.
 */
export function evaluateDefaultBranchLandingProof(
  input: DefaultBranchLandingProofInput,
): DefaultBranchLandingProofVerdict {
  const integrationBranch = input.integrationBranch?.trim() ?? "";
  const recordedSha = input.recordedSha?.trim() || input.landedBranchTipSha?.trim() || "";
  const hasWorkspaceLanding = Object.keys(input.workspaceRepoLanding ?? {}).length > 0;
  const hasDeliveryClaim = recordedSha.length > 0
    || hasWorkspaceLanding
    || input.squashRecordedOnIntegration === true
    || input.noOpVerified === true;

  if (input.noOpVerified === true) {
    return { disposition: "proven", proofKind: "verified-no-op" };
  }
  if (!hasDeliveryClaim) {
    return { disposition: "deferred", reason: "landing-evidence-incomplete" };
  }
  if (!integrationBranch || input.integrationRefReadable !== true) {
    return { disposition: "deferred", reason: "integration-ref-unreadable" };
  }

  // ── Positive observations: any one of these is delivery. ─────────────────────────
  if (input.squashRecordedOnIntegration === true) {
    return { disposition: "proven", proofKind: "recorded-squash-on-integration" };
  }
  if (input.ancestryOutcome === "proven") {
    return { disposition: "proven", proofKind: "integration-ancestry" };
  }
  if (input.patchEquivalentOutcome === "proven") {
    return { disposition: "proven", proofKind: "patch-equivalent" };
  }
  if (hasWorkspaceLanding) {
    const outcomes = Object.values(input.workspaceRepoLanding!);
    if (outcomes.every((outcome) => outcome === "proven")) {
      return { disposition: "proven", proofKind: "workspace-per-repo" };
    }
    // One unproven repository is enough to withhold the aggregate claim, but only a MEASURED absence
    // refuses; an unreadable repo must not spend the card's retries.
    if (outcomes.some((outcome) => outcome === "absent")) {
      const missing = outcomes.filter((outcome) => outcome === "absent").length;
      return refusal(
        "workspace-repo-landing-unproven",
        `${missing} workspace repository/repositories could not be shown to hold the recorded landing on their own default branch`,
      );
    }
    return { disposition: "deferred", reason: "landing-evidence-incomplete" };
  }
  if (typeof input.prNumber === "number" && input.prStateOpen === true) {
    return { disposition: "proven", proofKind: "pr-backed" };
  }
  if (isGroupIntermediateTarget(input)) {
    // Proven for the member only: `isBranchGroupMemberLanded` is the same predicate, and the group→default
    // promotion owes this card's own proof separately. Do not read this arm as delivery to main.
    return { disposition: "proven", proofKind: "group-intermediate" };
  }
  if (isTaskDeclaredLandingTarget(input) && input.declaredTargetAncestryOutcome === "proven") {
    /*
    FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
    The card delivered to the ref it declared as its target, and that ref is a human branch, so the delivery
    claim is substantiated. Read it as the operator chose to read it: the yardstick moved to the target the
    card was pointed at, it did NOT move to "any ref". A card that named a sibling task branch still fails
    above (`landing-target-not-integration`), and a card whose declared target is unreachable is still refused
    below, because this arm requires the target's OWN ancestry to be measured `proven`.
    */
    return { disposition: "proven", proofKind: "task-declared-target" };
  }

  // ── Nothing proved it. Name why. ────────────────────────────────────────────────
  // `conflictCount` never decides anything here — it only tells the operator whether the stale base is a
  // wait-for-a-slot situation or a cannot-land-as-is one, which is the difference between RUFU-294 and a
  // merely-old branch.
  const conflictNote = typeof input.conflictCount === "number" && input.conflictCount > 0
    ? ` (${input.conflictCount} merge conflicts against ${integrationBranch})`
    : "";
  /*
  A refusal of a task-declared-target card must name BOTH refs it was measured against, because the operator's
  first question is "which ref did you look at", and for this class the answer is "its target, and also the
  default branch". Only the sentence changes; the closed refusal-code vocabulary does not.
  */
  const declaredTargetNote = isTaskDeclaredLandingTarget(input)
    ? ` and not on this card's declared target branch "${input.mergeTargetBranch!.trim()}"`
    : "";
  if (isFusionTaskBranchRefName(input.mergeTargetBranch)) {
    return refusal(
      "landing-target-not-integration",
      `the recorded landing target is the Fusion task branch "${input.mergeTargetBranch!.trim()}", not the integration branch "${integrationBranch}"; a branch-ref advance on a task branch is not delivery${conflictNote}`,
    );
  }
  if (input.ancestryOutcome === "absent") {
    /*
    FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702):
    The other half of the task-declared-target rule, and the half that keeps the decision honest: a card whose
    yardstick is its own target may only be refused once THAT yardstick has been read. An unreadable target ref
    is the absence of an observation, exactly like an unreadable integration ref, so this defers instead of
    spending the card's retries on a ref nobody measured.
    */
    if (isTaskDeclaredLandingTarget(input) && input.declaredTargetAncestryOutcome !== "absent") {
      return { disposition: "deferred", reason: "landing-evidence-incomplete" };
    }
    const historyRewritten = Boolean(input.landedBranchTipSha?.trim())
      && input.landedBranchTipSha!.trim() !== input.recordedSha?.trim();
    // A rewritten-history card (recorded sha ≠ landed tip, the squash/rebase/`Direct Merge Commit
    // Strategy:` override shape) whose content match was measured absent gets its own code, because "the
    // sha moved" and "the content is missing" are different operator remedies. The proven arms above are
    // already discharged by the ladder order, so reaching here means nothing positive was observed.
    if (historyRewritten && input.patchEquivalentOutcome === "absent") {
      return refusal(
        "patch-equivalence-absent",
        `neither the recorded commit nor a patch-equivalent of it is on "${integrationBranch}"${declaredTargetNote}${conflictNote}`,
      );
    }
    if (input.patchEquivalentOutcome === "unreadable") {
      // Refusing here would close the door on a card whose content match git could not measure.
      return { disposition: "deferred", reason: "landing-evidence-incomplete" };
    }
    if (claimsIntegrationTarget(input)) {
      return refusal(
        "squash-commit-not-recorded-on-integration",
        `the landing claims a squash on "${integrationBranch}" but that commit is not on it${conflictNote}`,
      );
    }
    return refusal(
      "commit-not-on-integration-branch",
      `the recorded commit is not on the integration branch "${integrationBranch}"${declaredTargetNote}${conflictNote}`,
    );
  }
  // Ancestry could not be measured at all while the ref resolves — mid-operation repository, etc.
  return { disposition: "deferred", reason: "landing-evidence-incomplete" };
}

/*
FNXC:DefaultBranchLandingProof 2026-11-05-18:40 (RUFU-702):
The durable refusal sentence one lane may write, built here so the card's History, the operator mailbox
notice, and every machine-matchable error prefix quote ONE measurement in ONE wording. It names the
reason code because the code is the operator's query key; it names the integration branch because "on
which ref did you look" is the first question a false-landing report has to answer. It never carries a
commit subject, a diff, a file list, or a blocker sentence.
*/
export function describeDefaultBranchLandingRefusal(
  verdict: Extract<DefaultBranchLandingProofVerdict, { disposition: "refused" }>,
  input: { taskId: string; integrationBranch: string; recordedSha?: string | null },
): string {
  const sha = input.recordedSha?.trim();
  const shaPart = sha ? ` Commit ${sha.slice(0, 10)}.` : "";
  return `Landing not proven on "${input.integrationBranch}" (${verdict.refusalCode}): ${verdict.reason}.${shaPart} `
    + `${input.taskId} stays in review; the work was NOT delivered — re-deliver it on the default branch, then reconcile.`;
}

/** Machine-matchable prefix for the row's `error` field, mirroring `DELIVERY_UNPROVEN:`. */
export const LANDING_PROOF_UNPROVEN_ERROR_PREFIX = "LANDING_PROOF_UNPROVEN:";

/** Every refusal code, exported for tests and CLI help so the vocabulary cannot silently grow. */
export const LANDING_PROOF_REFUSAL_CODES: readonly LandingProofRefusalCode[] = [
  "commit-not-on-integration-branch",
  "squash-commit-not-recorded-on-integration",
  "patch-equivalence-absent",
  "landing-target-not-integration",
  "workspace-repo-landing-unproven",
];

/** Every deferral reason. */
export const LANDING_PROOF_DEFERRAL_REASONS: readonly LandingProofDeferralReason[] = [
  "integration-ref-unreadable",
  "landing-evidence-incomplete",
];
