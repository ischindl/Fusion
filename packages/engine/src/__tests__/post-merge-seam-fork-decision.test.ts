import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
FNXC:PostMergeSeamForkDecision 2026-11-12-23:51 (RUFU-557):
Machine-checkable drift guard for the post-merge review-recovery fork decision recorded in
docs/solutions/architecture/post-merge-review-recovery-seam-fork-decision.md. Our main lineage and
Runfusion/Fusion disagree about this seam; 12 disputed behaviors plus 7 keep-list invariants were
ruled per item against two blobs (OURS 99755fb1e7, UPSTREAM eb7eef49d5). A ruling is only durable if
its absence is detectable, because a future upstream sync silently re-adding or removing one of these
constructs looks like an ordinary merge.

Assert CODE CONSTRUCTS only, never prose or comments (AGENTS: tests assert behavior, never source
text or comments), so every file read here strips comments first through the shared
legacy-tombstones.test.ts pattern. A KEEP-OURS / KEEP-THEIRS-ADOPTED / REJECTED-UPSTREAM-DROPPED row
asserts the construct's presence or enforced absence in the current tree; an ADOPT-THEIRS-PENDING row
asserts the current state and is renamed "(pending adoption)" so a passing run reads as "not yet
adopted", never as "adopted". When a pending row is adopted, the guard for it is updated in the same
change that edits the document, not later.

Fast by construction (AGENTS: do not add slow tests): nine readFileSync calls over files this seam
owns, no engine boot, no timers, no network.
*/

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Strip block and line comments so a guard can never pass on a comment that merely names a symbol. */
function codeOf(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SEAM = "packages/engine/src/merge";
const postMergeSeam = () => codeOf(`${SEAM}/post-merge-gate-reseed.ts`);
const preMergeSeam = () => codeOf(`${SEAM}/pre-merge-gate-reseed.ts`);
const autoMergeFinalization = () => codeOf(`${SEAM}/auto-merge-finalization.ts`);
const mergeContentCapture = () => codeOf(`${SEAM}/merge-content-capture.ts`);
const mergerAi = () => codeOf(`${SEAM}/merger-ai.ts`);
const projectEngine = () => codeOf("packages/engine/src/project-engine.ts");
const selfHealing = () => codeOf("packages/engine/src/self-healing.ts");
const restartRoute = () => codeOf("packages/dashboard/src/routes/task-restart-stage.ts");
const postMergePrompt = () => codeOf("packages/core/src/workflows/builtin-post-merge-group.ts");

const DOC = "docs/solutions/architecture/post-merge-review-recovery-seam-fork-decision.md";
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("post-merge review-recovery fork decision (RUFU-557)", () => {
  it("the decision document exists and is the contract this guard mirrors", () => {
    expect(existsSync(resolve(REPO_ROOT, DOC))).toBe(true);
  });

  it("item 1: the rejected-evidence recheck ladder is live and rate-bounded, not count-bounded", () => {
    const source = postMergeSeam();
    // The 15/30/60-minute schedule saturating at one check per hour. Math.min(failures, 2) is the
    // saturation, and it is what makes the arm safe without an exhaustion park (item 2).
    expect(source).toContain("function isRejectedGateRecheckDue");
    expect(source).toContain("Math.min(failures, 2)");
    expect(source).toContain("15 * 60_000");
    expect(source).toContain("export function isPostMergeGateRecoveryDue");
  });

  it("item 1: the rejected arm never charges the missing arm's durable attempt budget", () => {
    const source = postMergeSeam();
    // Two arms, two markers. If the rejected sentence ever gains the counted prefix, a card whose CI
    // evidence lands late is terminally refused by a budget it never spent.
    expect(source).toContain("MAX_POST_MERGE_GATE_RESEED_ATTEMPTS = 3");
    expect(source).toContain("Rechecking rejected evidence at");
    expect(source).toContain("Resuming missing verification at");
    expect(source).toMatch(
      /function countReseedAttempts[\s\S]{0,600}postMergeGateReseedLogMarker/,
    );
    // The budget re-reads the durable row: a slim projection answers `log: []` and would hand a
    // looping gate a fresh budget on every pass (RUFU-502).
    expect(source).toMatch(/function countReseedAttempts[\s\S]{0,200}await store\.getTask\(task\.id\)/);
  });

  it("item 2: the exhaustion arm stays REJECTED-UPSTREAM-DROPPED (upstream deleted it too)", () => {
    // Upstream removed `hasExhaustedRechecks` at 32fb16778b; only the park SENTENCE survives on both
    // blobs, read-side, for cards an older build already terminalized. The predicate must not return.
    for (const file of [
      `${SEAM}/post-merge-gate-reseed.ts`,
      `${SEAM}/pre-merge-gate-reseed.ts`,
      "packages/engine/src/self-healing.ts",
      "packages/engine/src/merge/auto-merge-finalization.ts",
    ]) {
      expect(codeOf(file)).not.toContain("hasExhaustedRechecks");
    }
    // The legacy park remains RECOVERABLE: dropping this read strands those cards with no exit.
    expect(postMergeSeam()).toContain("Post-merge verification needs remediation");
    expect(postMergeSeam()).toContain("function hasLegacyRecoveryFailure");
  });

  it("item 3: operator manualRetry is an immediate recheck, option AND production caller, still guarded", () => {
    const seam = postMergeSeam();
    expect(seam).toContain("manualRetry?: boolean");
    // Only honored on the blocked/failed arm: it never exempts a refused recheck.
    expect(seam).toMatch(
      /const manualRetry = options\.manualRetry === true && decision\.outcome === "blocked" && decision\.reason === "failed"/,
    );
    // Its one effect: it bypasses the schedule test, nothing else. Every other guard in the seam still
    // refuses, so Retry can accelerate a recheck but never exempt one.
    expect(seam).toContain("(!manualRetry && !isPostMergeGateRecoveryDue(task, decision))");
    // The reconcile arm is the operator surface that sets it (self-healing.ts).
    expect(selfHealing()).toContain("manualRetry: rejectedEvidence");
  });

  it("item 3a: the dashboard stage restart stays a separate authority (intended asymmetry)", () => {
    const route = restartRoute();
    // A stage restart DISCARDS the current stage's work and refuses a live merge, so it must never be
    // rewired to the post-merge recheck. The pre-merge episode re-arms are its legitimate reach.
    expect(route).not.toContain("resumeMissingPostMergeGate");
    expect(route).not.toContain("manualRetry");
    expect(route).toContain("openVerdictlessGateRerunEpisode");
    expect(route).toContain("isLiveMergeRestart");
  });

  it("item 4: merge admission consumes the caller-resolved blocker for a landed card (RUFU-319)", () => {
    const engine = projectEngine();
    expect(engine).toContain("return !resolvedMergeBlocker;");
    // The pairing: landed cards still get a recheck offer, and a stale merge-active status is cleared
    // under a fence that requires mergeConfirmed plus an unchanged updatedAt.
    expect(engine).toContain("resumeMissingPostMergeGate(store, task,");
    expect(engine).toMatch(/mergeActive\.has\(task\.id\)/);
    expect(engine).toMatch(/current\.updatedAt !== task\.updatedAt/);
    expect(engine).toMatch(/!current\.mergeDetails\?\.mergeConfirmed/);
    expect(engine).toContain("Landing is complete; cleared stale merge activity");
  });

  it("item 5: the no-verdict loop bound is the durable strike budget (HYBRID authority, floor pending)", () => {
    const pre = preMergeSeam();
    expect(pre).toContain("MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS = 3");
    // The strike ledger reads the DURABLE row through one memoised reader; a rejected read is not
    // swallowed into "no strikes" (RUFU-452/RUFU-502: a slim projection answers `log: []`).
    expect(pre).toMatch(/async function countVerdictlessGateRerunAttempts[\s\S]{0,400}readLog \?\? createGateLogReader/);
    expect(pre).toMatch(/async function readGateLogLedger[\s\S]{0,160}await store\.getTask\(taskId\)/);
    // The reset marker is operator-only; upstream's content-keyed bound re-arms itself on any new
    // commit, which is the behavior RUFU-449/RUFU-452 rejected.
    expect(pre).toContain("VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX");
    expect(pre).toContain("export async function openVerdictlessGateRerunEpisode");
    for (const file of [`${SEAM}/pre-merge-gate-reseed.ts`, "packages/engine/src/self-healing.ts"]) {
      expect(codeOf(file)).not.toContain("hasExhaustedNoVerdictRecovery");
    }
  });

  it("item 5's floor (pending adoption): the same-content refusal is still absent from the seed lane", () => {
    // `bounds consecutive failed no-verdict attempts without discarding evidence` is red over exactly
    // this: the lane counts only its own durable markers, so a row that remembers three same-input
    // deaths dispatched elsewhere is still seeded. Adoption is a floor IN FRONT OF the marker budget,
    // never a replacement for it - the 35 green assertions in that file are the budget's own suite.
    const spec = codeOf("packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts");
    expect(spec).toContain("bounds consecutive failed no-verdict attempts without discarding evidence");
    expect(spec).toContain("allows recovery for new review input despite old failure history");
  });

  it("item 6 (pending adoption): the spec-lock exclusion is still absent, while our producer writes the diagnostic", () => {
    // Our classifier must not spend a dispatch on a deterministic spec-lock rejection. Recorded state:
    // not yet adopted, and the exclusion belongs inside the predicate so every consumer inherits it.
    expect(preMergeSeam()).not.toContain("isUnavailablePlanLockResult");
    // The producer half already exists, which is why adoption is a predicate clause, not new machinery.
    const graph = codeOf("packages/engine/src/executor/execute-workflow-graph.ts");
    expect(graph).toContain("isUnavailablePlanLockError");
    // The producer already writes the diagnostic into BOTH text fields of a verdict-less failed row,
    // which is the exact shape upstream's predicate reads. Adoption is therefore a clause in the
    // classifier, not new machinery.
    expect(graph).toContain("output: unavailablePlanLockDiagnostic");
    expect(graph).toContain("notes: unavailablePlanLockDiagnostic");
    // The predicate that must inherit the exclusion is exported and cause-blind today.
    expect(preMergeSeam()).toContain("export function isFailedNoVerdictPreMergeReviewResult");
    // The acceptance test is already in-tree and red: the door did not travel with its test, so the
    // adoption card's criterion is "these instances go green", never "write a test".
    const spec = codeOf("packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts");
    expect(spec).toContain("does not redispatch deterministic plan-lock failures carried in");
    expect(spec).toContain("Plan approved but spec lock unavailable:");
  });

  it("item 7: landed work publishes before hosted evidence exists (adopted, with our audit layers)", () => {
    expect(mergerAi()).toContain("function createPublishBeforeFinalizeLanding");
    expect(mergerAi()).toContain("publishLandedWork");
    expect(mergerAi()).toContain("publishRecordedLanding");
    // Composition that must not collapse into one push helper: RUFU-346's evidence-blocked pair and
    // RUFU-338's policy-withheld row are ours-only, KB-002's recovery branch is shared.
    expect(mergerAi()).toContain("task:merge-publish-before-finalize");
    expect(mergerAi()).toContain("classifyPublishBeforeFinalizeHold");
    expect(projectEngine()).toContain("recoverConfirmedMergePush(store, task, settings)");
  });

  it("item 8 (pending adoption): review-content capture still has no cleanliness door", () => {
    // The helper exists and is used by the step executor, but the capture seam that binds an approval
    // to a descriptor does not probe it. merge-content-descriptor-doors.test.ts is red over exactly
    // this and is this pending row's acceptance test; do not quarantine it.
    expect(mergeContentCapture()).not.toContain("probeReviewCheckout");
    expect(mergeContentCapture()).not.toContain("uncommitted-review-changes");
    expect(codeOf("packages/engine/src/worktree/review-checkout-clean.ts")).toContain("ReviewCheckoutProbe");
    expect(existsSync(resolve(REPO_ROOT, "packages/engine/src/__tests__/merge-content-descriptor-doors.test.ts"))).toBe(true);
  });

  it("item 9: the post-merge prompt demands an honest evidence-backed disposition, not success", () => {
    const prompt = postMergePrompt();
    // Full sentence with its period: the shorter phrase legitimately occurs in explanatory prose about
    // why the old demand was wrong, and comments are stripped here anyway.
    expect(prompt).toContain("The completed conclusion for Pipeline smoke tier.");
    expect(prompt).not.toContain("A successful conclusion for Pipeline smoke tier.");
    expect(codeOf("packages/core/src/__tests__/builtin-workflows.test.ts")).toContain("completed conclusion");
  });

  it("item 10 (pending adoption): the pre-merge seed still lacks a landedness refusal", () => {
    const pre = preMergeSeam();
    expect(pre).not.toContain("already-landed");
    expect(pre).not.toContain("mergeConfirmed");
    // Adopting it means adding the member, never renaming the two unrelated tokens that carry the same
    // spelling: the merge-value in workflow-merge-nodes.ts and the log prose in the post-merge file.
    expect(codeOf("packages/engine/src/workflows/workflow-merge-nodes.ts")).toContain("already-landed");
    expect(postMergeSeam()).toContain("already-landed implementation and merge will not run again");
    // Its acceptance test exists for BOTH pre-merge seed lanes and is red until the refusal lands.
    expect(codeOf("packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts"))
      .toContain("never seeds pre-merge work after landing");
  });

  it("item 11 (pending adoption): only the post-merge seed carries the taskUpdatedAt snapshot fence", () => {
    const post = postMergeSeam();
    expect(countOf(post, "expectedTaskUpdatedAt")).toBeGreaterThanOrEqual(1);
    expect(post).toContain("expectedWorkflowSelection");
    // The pre-merge seed is single-fenced here; the store seam already implements the second refusal,
    // so adoption is one argument plus one reason member (`task-state-changed`).
    expect(preMergeSeam()).not.toContain("expectedTaskUpdatedAt");
    const storeSeam = codeOf("packages/core/src/task-store/async/async-workflow-workitems.ts");
    expect(storeSeam).toContain("task-state-changed");
    expect(storeSeam).toContain("expectedTaskUpdatedAt");
  });

  it("keep-list K1-K7: the fork-only authorities survive", () => {
    const pre = preMergeSeam();
    const post = postMergeSeam();
    // K1/K2: a card whose only hold is the engine's own stall-deadlock park can lift here; upstream has
    // a blanket pause refusal and cannot. Permissive behind an explicit flag, never permissive by default.
    expect(pre).toContain("allowDeadlockPark?: boolean");
    expect(pre).toContain("options.allowDeadlockPark === true");
    expect(pre).toContain("export function isEngineAuthoredInReviewStallPark");
    // K3: named refusal taxonomy plus the operator notice, neither of which exists upstream.
    expect(autoMergeFinalization()).toContain("export async function notifyUnreachablePostMergeGate");
    expect(autoMergeFinalization()).toContain("system:unrun-post-merge-gate:");
    expect(post).toContain("export function isTerminalPostMergeReseedRefusal");
    // K4: the per-project evidence contract threads through the seam (0 occurrences upstream).
    expect(post).toContain("PostMergeEvidenceContract");
    // K5: workspace cards are refused by a named reason inside the terminal set.
    expect(post).toMatch(/isWorkspaceTask\(task\)[\s\S]{0,80}"workspace"/);
    // K6: an unreadable durable read is a named non-throwing refusal, not an escaping exception.
    expect(post).toContain('reason: "durable-read-unavailable"');
    // K7: the seed's target column is clamped through the shared authority, never taken from the IR pin.
    expect(pre).toContain("clampReviewGateEntry(ir, node, task.column)");
  });

  it("S0: the options-bearing signature stays the seam's extension surface", () => {
    const source = readFileSync(resolve(REPO_ROOT, `${SEAM}/post-merge-gate-reseed.ts`), "utf8");
    // Items 3, 4 and 11 are decided by this shape: upstream's fewer-argument form has nowhere to carry
    // the evidence contract, the manual-retry flag, or the snapshot fence.
    expect(source).toMatch(
      /export async function resumeMissingPostMergeGate\(\s*store: TaskStore,\s*task: Task,\s*options: /,
    );
    const optionsBlock = source.slice(
      source.indexOf("async function runPostMergeGateResume("),
      source.indexOf("async function runPostMergeGateResume(") + 2600,
    );
    for (const field of [
      "contract: PostMergeEvidenceContract | undefined",
      "manualRetry?: boolean",
      "fence?: MergeWriteFence",
      "producerSurface",
    ]) {
      expect(optionsBlock).toContain(field);
    }
    // Upstream's result shape must not return: `{outcome:"resumed"}|{outcome:"not-resumable"}` carries
    // no reason, so a refusal can be neither audited nor noticed. Our discriminant stays the pair, and
    // our own reason member `gate-not-resumable` (which survives comment-stripping as an enum member)
    // is a different token from that outcome value.
    const seamCode = codeOf(`${SEAM}/post-merge-gate-reseed.ts`);
    expect(seamCode).toContain('outcome: "seeded" | "not-seeded"');
    expect(seamCode).not.toContain('outcome: "not-resumable"');
    expect(seamCode).toContain('reason: "gate-not-resumable"');
  });
});
