import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  evaluateNoCommitsNoOpFinalize,
  getTaskMergeBlocker,
  isUncommittedWorkHold,
  type Task,
  type TaskStore,
} from "@fusion/core";

/*
FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274):
Symptom verification for RUFU-262 against a REAL repository, driven through the one door every finalization
lane shares. RUFU-262 finished `done` with its branch zero commits ahead of `main` and its worktree still
holding the work: the card's own `mergeConfirmed` flag was believed, the content was never delivered, and
cleanup could then destroy the only copy. The door under test is `enforceZeroCommitLandingProof`, which the
merge-runner, merge-queue-drain, merge-ai-arbitration, self-healing no-op finalize, finalize, and cleanup
lanes all route through, so a real-git result here is a statement about the fleet of lanes, not one call site.

Deliberately real git rather than a mocked shell: the whole claim is that the DECISION follows git's actual
content state, and the two dispositions that matter — refuse while files are at risk, allow when the tree
truly has nothing to deliver — are indistinguishable to a fake that returns a canned status.
*/

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createTaskStore(task: Task): TaskStore & { __audits: Array<{ type: string; metadata: Record<string, unknown> }> } {
  let current = { ...task };
  const audits: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  return {
    __audits: audits,
    getTask: vi.fn(async () => current),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS }) as any),
    // RUFU-274: the hold write is a single updateTask patch; the store applies it so assertions read the
    // durable row shape a later process (which re-reads the row) will see.
    // The real store REPLACES `mergeDetails` on an update; a permissive merge here would hide a clear.
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      current = { ...current, ...updates } as Task;
      if (updates.error === null) delete (current as { error?: string | null }).error;
      return current;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    // The audit envelope's discriminator is `mutationType` (the row is stored as JSON, not a typed column).
    recordRunAuditEvent: vi.fn(async (entry: { mutationType: string; metadata?: Record<string, unknown> }) => {
      audits.push({ type: entry.mutationType, metadata: entry.metadata ?? {} });
    }),
    moveTask: vi.fn(async () => current),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as TaskStore & { __audits: typeof audits };
}

describeIfGit("zero-commit landing-proof door (real git)", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** A main branch with one commit, plus a `fusion/rufu-274` worktree that is ZERO commits ahead. */
  function setupRepo(): { repo: string; worktree: string } {
    const repo = mkdtempSync(join(tmpdir(), "rufu274-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "rufu274-wt-"));
    rmSync(worktree, { recursive: true, force: true });
    dirs.push(repo, worktree);

    git(repo, "git init -b main -q");
    git(repo, "git config user.email test@example.com");
    git(repo, "git config user.name Test");
    writeFileSync(join(repo, "tracked.txt"), "original\n");
    git(repo, "git add -A");
    git(repo, 'git commit -q -m "seed"');
    // `git worktree add` refuses an existing directory, so hand it a path that does not exist yet.
    git(repo, `git worktree add -q "${worktree}" -b fusion/rufu-274 main`);
    return { repo, worktree };
  }

  function zeroCommitTask(worktree: string): Task {
    return {
      id: "RUFU-274",
      title: "Refuse zero-commit finalization with a dirty worktree",
      description: "",
      column: "in-review",
      status: "review-pending",
      paused: false,
      branch: "fusion/rufu-274",
      worktree,
      steps: [],
      mergeDetails: {
        // The claim under test. Nothing here may authorize the door — the git content state decides.
        mergeConfirmed: true,
        mergeAttemptSha: "0".repeat(40),
        mergeTargetBranch: "main",
        mergeSourceBranch: "fusion/rufu-274",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Task;
  }

  it("refuses finalization, holds the row visibly, and preserves the worktree pointers when content is at risk", async () => {
    const { enforceZeroCommitLandingProof, DELIVERY_UNPROVEN_ERROR_PREFIX } = await import("../merge/zero-commit-finalization-guard.js");
    const { repo, worktree } = setupRepo();
    // The RUFU-262 state: nothing committed, one tracked edit and one brand-new file still on disk.
    writeFileSync(join(worktree, "tracked.txt"), "rewritten by the card, never committed\n");
    writeFileSync(join(worktree, "brand-new.ts"), "export const neverCommitted = 1;\n");

    const store = createTaskStore(zeroCommitTask(worktree));
    const task = zeroCommitTask(worktree);
    const outcome = await enforceZeroCommitLandingProof({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      source: "merge-runner",
    });

    expect(outcome.disposition).toBe("held");

    const held = await store.getTask!(task.id);
    // Row-visible refusal: the marker plus the observable hold pair, and no lifecycle move.
    expect(held!.mergeDetails!.uncommittedWorkHold).toMatchObject({
      code: "uncommitted-work",
      source: "merge-runner",
      modifiedCount: 1,
      untrackedCount: 1,
    });
    expect(held!.paused).toBe(true);
    expect(held!.pausedReason).toBe("manual-hold");
    expect(held!.error).toContain(DELIVERY_UNPROVEN_ERROR_PREFIX);
    expect(held!.column).toBe("in-review");
    expect(held!.status).toBe("review-pending");
    expect(store.moveTask).not.toHaveBeenCalled();

    // The pointers are the only thing standing between the surviving files and deletion.
    expect(held!.worktree).toBe(worktree);
    expect(held!.branch).toBe("fusion/rufu-274");

    // The lane and the row state the refusal with the same words; the row copy is the canonical sentence.
    expect(held!.mergeDetails!.uncommittedWorkHold!.reason).toContain("survived on the branch");

    // Every merge door refuses, and it names the files rather than a bare state.
    const blocker = getTaskMergeBlocker(held!);
    expect(blocker).toContain("survived on the branch");
    expect(blocker).toContain("tracked.txt");
    expect(blocker).toContain("brand-new.ts");
    // The specific hold sentence wins over the generic pause answer, because the pause alone hides the remedy.
    expect(blocker).not.toBe("task is paused");

    // Bounded audit (fire-and-forget by design): ids/counts/fixed enums only — never a path, never content.
    await vi.waitFor(() => {
      expect(store.__audits.some((entry) => entry.type === "task:zero-commit-landing-proof-refused")).toBe(true);
    });
    const holdEvent = store.__audits.find((entry) => entry.type === "task:zero-commit-landing-proof-refused");
    expect(holdEvent).toBeTruthy();
    const serialized = JSON.stringify(holdEvent!.metadata);
    expect(serialized).not.toContain(worktree);
    expect(serialized).not.toContain("brand-new.ts");
    expect(holdEvent!.metadata).toMatchObject({ aheadCommitCount: 0, modifiedCount: 1, untrackedCount: 1 });
  });

  it("authorizes the legitimate no-op arm when the zero-commit worktree genuinely has nothing to deliver", async () => {
    const { enforceZeroCommitLandingProof } = await import("../merge/zero-commit-finalization-guard.js");
    const { repo, worktree } = setupRepo();

    const store = createTaskStore(zeroCommitTask(worktree));
    const task = zeroCommitTask(worktree);
    const outcome = await enforceZeroCommitLandingProof({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      source: "merge-runner",
    });

    // Already-landed / nothing-to-deliver cards must keep finalizing — refusing these is the false wedge.
    expect(outcome.disposition).toBe("allow");
    expect(await store.getTask!(task.id)).toMatchObject({ paused: false });
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 2 — high):
  The finalize guard and this door answer two different questions about the same card, and a card can fail
  BOTH at once: a required verification gate with no approving result AND the deliverable still sitting
  uncommitted in its checkout (RUFU-337's ledger + RUFU-262's tree). The guard used to report only the
  gate in that case, and because every lane routes on `evaluation.blocked && evaluation.deliveryUnproven`,
  the missing marker sent the card down the lane's incomplete-work branch — `error` + `status: "failed"` + a
  backward rebound out of the review lane — with the uncommitted files left in a tree nothing was protecting
  and no hold, row sentence, or audit row to say so. These tests drive the shipped lane sequence (collect →
  shared guard → door) against a real repository so the routing, not just each half, is on trial.
  */
  it("holds a gate-blocked card that ALSO has uncommitted deliverable content, instead of failing and rebounding it", async () => {
    const { enforceZeroCommitLandingProof, collectZeroCommitFinalizeEvidence, DELIVERY_UNPROVEN_ERROR_PREFIX } =
      await import("../merge/zero-commit-finalization-guard.js");
    const { repo, worktree } = setupRepo();
    writeFileSync(join(worktree, "tracked.txt"), "rewritten by the card, never committed\n");
    writeFileSync(join(worktree, "brand-new.ts"), "export const neverCommitted = 1;\n");

    const store = createTaskStore(zeroCommitTask(worktree));
    const task = zeroCommitTask(worktree);
    const requiredVerificationStepIds = new Set(["code-review"]);
    const collected = await collectZeroCommitFinalizeEvidence({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      requiredVerificationStepIds,
    });
    const evaluation = evaluateNoCommitsNoOpFinalize(task, collected);

    // The actionable reason still wins the message... and the content risk now rides alongside it.
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.reason).toContain("code-review");
    expect(evaluation.reason).not.toBe("worktree-content-unproven");
    expect(evaluation.deliveryUnproven).toMatchObject({ contentState: "deliverable", modifiedCount: 1, untrackedCount: 1 });

    // The shipped lane routing condition, verbatim from merger-ai/merger/self-healing.
    expect(evaluation.blocked && Boolean(evaluation.deliveryUnproven)).toBe(true);

    const outcome = await enforceZeroCommitLandingProof({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      source: "merge-ai-empty-lane",
      preCollected: collected,
    });
    expect(outcome.disposition).toBe("held");

    /*
    The symptom check: the card must NOT look like unfinished work. A backward rebound writes `status:
    "failed"` (or moves the column) and the incomplete-work branch writes the gate sentence as `error` —
    neither may appear here, and the pointers the rebound would clear are what keep cleanup off the files.
    */
    const held = (await store.getTask!(task.id))!;
    const lifecycleWrites = store.updateTask.mock.calls.map(([call]) => call as Partial<Task>);
    expect(lifecycleWrites.some((patch) => patch.status === "failed")).toBe(false);
    expect(lifecycleWrites.some((patch) => patch.column !== undefined)).toBe(false);
    expect(lifecycleWrites.some((patch) => typeof patch.error === "string" && patch.error.includes("code-review"))).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();

    expect(isUncommittedWorkHold(held.mergeDetails)).toBe(true);
    expect(held.error).toContain(DELIVERY_UNPROVEN_ERROR_PREFIX);
    expect(held.paused).toBe(true);
    expect(held.pausedReason).toBe("manual-hold");
    expect(held.column).toBe("in-review");
    expect(held.worktree).toBe(worktree);
    expect(held.branch).toBe("fusion/rufu-274");
    expect(getTaskMergeBlocker(held)).toContain("tracked.txt");

    await vi.waitFor(() => {
      expect(store.__audits.some((entry) => entry.type === "task:zero-commit-landing-proof-refused")).toBe(true);
    });
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 1 — critical):
  The other half of the same lane, from the opposite direction: a card whose required gate the operator
  waived (`skipped` + `bypassedBy`, the FN-7720 audited bypass) is approved by the merge door and must be
  finalized by the finalize guard too. The guard's raw `status === "passed"` scan refused it, which put the
  card in the incomplete-work branch — `error` + `status: "failed"` + a rebound — so the operator's
  documented remedy for a stranded review lane produced a card that looked like unfinished work.
  */
  it("finalizes a gate-blocked-looking card whose gate carries an audited operator waiver", async () => {
    const { collectZeroCommitFinalizeEvidence } = await import("../merge/zero-commit-finalization-guard.js");
    const { repo, worktree } = setupRepo();
    const waivedGate = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "skipped" as const,
      bypassedBy: "operator-1",
      bypassedAt: "2026-09-29T20:05:00.000Z",
      bypassReason: "review lane stranded: the reviewer harness emitted no verdict twice",
    };

    const store = createTaskStore(zeroCommitTask(worktree));
    const task = { ...zeroCommitTask(worktree), workflowStepResults: [waivedGate] };
    const collected = await collectZeroCommitFinalizeEvidence({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      requiredVerificationStepIds: new Set(["code-review"]),
    });

    expect(evaluateNoCommitsNoOpFinalize(task, collected)).toMatchObject({ blocked: false });
    // Nothing on the row changes: no hold, no refusal, so the lane is free to finalize as delivered.
    expect(isUncommittedWorkHold((await store.getTask!(task.id))!.mergeDetails)).toBe(false);

    // Control for the same lane: without the waiver the identical card is refused, not finalized.
    const unwritten = { ...task, workflowStepResults: [] };
    const unwaived = await collectZeroCommitFinalizeEvidence({
      store,
      task: unwritten,
      repoDir: repo,
      integrationBranch: "main",
      requiredVerificationStepIds: new Set(["code-review"]),
    });
    expect(evaluateNoCommitsNoOpFinalize(unwritten, unwaived).blocked).toBe(true);
  });

  it("holds a zero-commit card whose landing proof is asserted over an unreadable checkout instead of trusting the flag", async () => {
    const { enforceZeroCommitLandingProof } = await import("../merge/zero-commit-finalization-guard.js");
    const { repo } = setupRepo();
    /*
  FNXC:ZeroCommitLandingProof 2026-09-27-01:01 (RUFU-274):
  The reachability boundary of `content-unverifiable`, pinned rather than assumed. A checkout that EXISTS but
  cannot be probed is the refusal class: the lane cannot rule out uncommitted work while the card already
  claims delivery. A checkout that is simply gone has no content for a merge to destroy and belongs to the
  nothing-to-deliver arm above — treating absence as a refusal would be the false wedge where a card whose
  worktree was already cleaned up could never finalize. Pinning both keeps the class from widening either way.
  */
    const unreadable = mkdtempSync(join(tmpdir(), "rufu274-not-a-checkout-"));
    dirs.push(unreadable);
    writeFileSync(join(unreadable, "tracked.txt"), "work the card never committed\n");

    const store = createTaskStore(zeroCommitTask(unreadable));
    const task = zeroCommitTask(unreadable);
    const outcome = await enforceZeroCommitLandingProof({
      store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      source: "merge-queue-drain",
      // RUFU-262's exact shape: the lane asserts delivery with no durable sha to show for it.
      recordedProof: { kind: "caller-asserted" },
    });

    // `mergeConfirmed: true` over a checkout that cannot be read is an unaudited claim: hold, never finalize.
    expect(outcome.disposition).toBe("held");
    const held = await store.getTask!(task.id);
    expect(held!.mergeDetails!.uncommittedWorkHold?.code).toBe("content-unverifiable");
    // The refusal states the epistemic limit rather than inventing file names it could not observe.
    expect(getTaskMergeBlocker(held!)).toContain("could not be classified");
    expect(held!.worktree).toBe(unreadable);
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
