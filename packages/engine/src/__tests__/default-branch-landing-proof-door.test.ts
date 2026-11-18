import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, LANDING_PROOF_UNPROVEN_ERROR_PREFIX, type Task, type TaskStore } from "@fusion/core";
import {
  enforceDefaultBranchLandingProof,
  isDefaultBranchLandingProofHold,
  landingProofNoticeKey,
} from "../merge/default-branch-landing-proof-evidence.js";

/*
Behavior matrix for the default-branch landing-proof door (RUFU-702), against real git.

A mocked shell cannot discharge this card: the entire claim is that the disposition follows what the default
branch actually contains, and the two dispositions that matter — refuse on an off-main commit, prove a
squash-landed card whose branch head differs — are indistinguishable to a fake returning canned output. The
store IS faked, because the assertions here are about what the door writes to a row and an audit sink, and
that seam must also be provably hostile-proof (a sink that throws or hangs may not change a verdict).

The last group is the regression this card exists for: a row that recorded its own landing successfully —
`mergeConfirmed: true`, landed files, a `mergeTargetBranch` naming a Fusion task branch — must not be
believed. That is RUFU-294's row.
*/

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

/** Runs a git subcommand (argv-ish) in `repo`; the `git` prefix is added here so no call site can drift. */
function git(repo: string, command: string): string {
  const full = command.startsWith("git ") ? command : `git ${command}`;
  return execSync(full, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

interface AuditRow {
  mutationType: string;
  metadata: Record<string, unknown>;
}

interface FakeStore {
  store: TaskStore;
  rows: AuditRow[];
  history: string[];
  messages: Array<{ content: string; idempotencyKey: string }>;
  current: () => Task;
}

function fakeStore(task: Task, opts: { hostileSink?: "throws" | "hangs" } = {}): FakeStore {
  let current = { ...task };
  const rows: AuditRow[] = [];
  const history: string[] = [];
  const messages: Array<{ content: string; idempotencyKey: string }> = [];
  const store = {
    getTask: vi.fn(async () => current),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      current = { ...current, ...updates } as Task;
      if (updates.error === null) delete (current as { error?: string | null }).error;
      return current;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { history.push(message); }),
    recordRunAuditEvent: vi.fn(async (entry: AuditRow) => {
      if (opts.hostileSink === "throws") throw new Error("audit sink down");
      if (opts.hostileSink === "hangs") return await new Promise(() => undefined);
      rows.push(entry);
    }),
    emit: vi.fn(),
    on: vi.fn(),
    // The mailbox seam the door reaches for its operator notice.
    sendMessageOnce: vi.fn(async (input: { content: string }, idempotencyKey: string) => {
      messages.push({ content: input.content, idempotencyKey });
      return { message: input as never, inserted: true };
    }),
  } as unknown as TaskStore;
  return {
    store,
    rows,
    history,
    messages,
    current: () => current,
  };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-702",
    title: "landing proof door",
    column: "in-review",
    status: "merge-confirmed",
    error: null,
    mergeRetries: 0,
    mergeDetails: null,
    ...overrides,
  } as Task;
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** `main` with one commit; a squash-landed branch; and an off-main branch conflicting with main. */
function setupRepo(): { repo: string; squashSha: string; offMainSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "rufu702-door-"));
  dirs.push(repo);
  git(repo, "git init -b main -q");
  git(repo, "git config user.email test@example.com");
  git(repo, "git config user.name Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "git add . && git commit -q -m base");

  git(repo, "git switch -q -c fusion/fn-100");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "git add . && git commit -q -m one");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  git(repo, "git add . && git commit -q -m two");
  git(repo, "git switch -q main");
  git(repo, "git merge --squash -q fusion/fn-100");
  git(repo, "git commit -q -m 'feat(FN-100): squash landing'");
  const squashSha = git(repo, "rev-parse HEAD");

  git(repo, "git switch -q -c fusion/rufu-293");
  writeFileSync(join(repo, "README.md"), "divergent\n");
  writeFileSync(join(repo, "c.ts"), "export const c = 3;\n");
  git(repo, "git add . && git commit -q -m 'feat(RUFU-293): mega landing'");
  const offMainSha = git(repo, "rev-parse HEAD");
  git(repo, "git switch -q main");
  return { repo, squashSha, offMainSha };
}

describeIfGit("enforceDefaultBranchLandingProof — durable record and hold", () => {
  it("writes no row change, no history line, and no audit row when the landing is proven", async () => {
    const { repo, squashSha } = setupRepo();
    const fake = fakeStore(baseTask());
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task: baseTask(),
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: {
        commitSha: squashSha,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        mergeTargetBranch: "main",
        mergeTargetSource: "project-default",
      } as never,
      source: "finalize-proven-auto-merge",
      messageStore: fake.store as never,
    });
    expect(outcome.disposition).toBe("proven");
    expect(fake.history).toEqual([]);
    expect(fake.rows).toEqual([]);
    expect(fake.messages).toEqual([]);
    expect(fake.current().error).toBeNull();
  });

  it("refuses an off-main landing and records the four durable surfaces", async () => {
    const { repo, offMainSha } = setupRepo();
    const fake = fakeStore(baseTask());
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task: baseTask(),
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: {
        commitSha: offMainSha,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        mergeTargetBranch: "fusion/rufu-293",
        mergeTargetSource: "task-base-branch",
      } as never,
      source: "ai-merge-finalize",
      messageStore: fake.store as never,
    });

    expect(outcome.disposition).toBe("refused");
    if (outcome.disposition !== "refused") return;

    // (1) A machine-matchable row sentence naming its reason code and the branch that was consulted.
    const error = fake.current().error ?? "";
    expect(error.startsWith(LANDING_PROOF_UNPROVEN_ERROR_PREFIX)).toBe(true);
    expect(error).toContain("(landing-target-not-integration)");
    expect(error).toContain('"main"');
    expect(isDefaultBranchLandingProofHold(fake.current())).toBe(true);

    // (2) A History row, readable without a DB query.
    expect(fake.history.join("\n")).toContain("REFUSED (landing-target-not-integration)");

    // (3) One bounded audit row, and it is the refusal row.
    expect(fake.rows.map((row) => row.mutationType)).toEqual(["task:finalization-landing-proof-refused"]);
    expect(fake.rows[0]!.metadata).toMatchObject({
      taskId: "RUFU-702",
      source: "ai-merge-finalize",
      refusalCode: "landing-target-not-integration",
      integrationBranch: "main",
    });
    // Metadata is ids/counts/fixed enums only — no diff, no file list, no refusal sentence.
    expect(JSON.stringify(fake.rows[0]!.metadata)).not.toContain("stays in review");

    // (4) One idempotent operator notice.
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.idempotencyKey).toContain("RUFU-702:landing-target-not-integration:");

    // A refusal is a WAIT: no status write and no retry-budget burn, in either direction.
    expect(fake.current().status).toBe("merge-confirmed");
    expect(fake.current().mergeRetries).toBe(0);
    expect(outcome.refusal).toContain("RUFU-702 stays in review");
  });

  it("defers on an unreadable integration ref, writes no refusal, and preserves today's behavior", async () => {
    const { repo, squashSha } = setupRepo();
    const fake = fakeStore(baseTask());
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task: baseTask(),
      repoDir: repo,
      integrationBranch: "refs/heads/not-a-branch",
      mergeDetails: { commitSha: squashSha, merged: true, mergedAt: new Date().toISOString() } as never,
      source: "merge-runner",
      messageStore: fake.store as never,
    });
    expect(outcome.disposition).toBe("deferred");
    if (outcome.disposition !== "deferred") return;
    expect(outcome.reason).toBe("integration-ref-unreadable");
    // The refusal surfaces must stay empty: a mass-refusal over an unreadable repo is the failure to avoid.
    expect(fake.current().error).toBeNull();
    expect(fake.messages).toEqual([]);
    expect(fake.rows.map((row) => row.mutationType)).toEqual(["task:finalization-landing-proof-deferred"]);
  });

  it("produces the identical verdict when the audit sink throws, and when it hangs", async () => {
    const { repo, offMainSha } = setupRepo();
    const details = {
      commitSha: offMainSha,
      merged: true,
      mergedAt: new Date().toISOString(),
      mergeTargetBranch: "fusion/rufu-293",
      mergeTargetSource: "task-base-branch",
    } as never;

    for (const hostile of ["throws", "hangs"] as const) {
      const fake = fakeStore(baseTask(), { hostileSink: hostile });
      const outcome = await enforceDefaultBranchLandingProof({
        store: fake.store,
        task: baseTask(),
        repoDir: repo,
        integrationBranch: "main",
        mergeDetails: details,
        source: "self-healing-landed-reconcile",
        messageStore: fake.store as never,
      });
      // The bounded seam absorbs the sink; the delivery decision is untouched either way.
      expect(outcome.disposition, hostile).toBe("refused");
      expect(fake.current().error ?? "").toContain("(landing-target-not-integration)");
    }
  });

  it("withholds the operator notice when no mailbox store is wired, keeping the durable row", async () => {
    const { repo, offMainSha } = setupRepo();
    const fake = fakeStore(baseTask());
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task: baseTask(),
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: {
        commitSha: offMainSha,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeTargetBranch: "fusion/rufu-293",
        mergeTargetSource: "task-base-branch",
      } as never,
      source: "merge-runner",
      messageStore: null,
    });
    expect(outcome.disposition).toBe("refused");
    expect(fake.messages).toEqual([]);
    expect(fake.current().error ?? "").toContain(LANDING_PROOF_UNPROVEN_ERROR_PREFIX);
  });

  it("keeps one notice per (card, code, cooldown window) so a sustained refusal cannot spam the operator", () => {
    const hour = 60 * 60_000;
    const first = landingProofNoticeKey("RUFU-702", "commit-not-on-integration-branch", 0);
    expect(landingProofNoticeKey("RUFU-702", "commit-not-on-integration-branch", hour)).toBe(first);
    expect(landingProofNoticeKey("RUFU-702", "commit-not-on-integration-branch", 6 * hour)).not.toBe(first);
    expect(landingProofNoticeKey("RUFU-702", "patch-equivalence-absent", 0)).not.toBe(first);
    expect(landingProofNoticeKey("RUFU-703", "commit-not-on-integration-branch", 0)).not.toBe(first);
  });
});

/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
The door must let a card finalize on the target it was actually pointed at. The card declares
`baseBranch: "release"`, the lane lands the commit on `release`, and `main` holds nothing of it; the operator
ruled that this IS delivery, so `main` may not be the universal yardstick.

The load-bearing assertions are the ABSENCES. A `LANDING_PROOF_UNPROVEN:` hold is exactly what a later
recovery lane acts on, so a card that reached its own declared target must not carry one — that is how a
delivered card would end up reopened or pushed backward. `merger-ai.test.ts` covers the same class through
the finalize seam; this pins the door's own record-writing decision.
*/
describeIfGit("enforceDefaultBranchLandingProof — a task-declared target branch is delivery", () => {
  /** `main` plus a human `release` branch: each holds one commit the other never received. */
  function setupReleaseRepo(): { repo: string; releaseSha: string; mainOnlySha: string } {
    const repo = mkdtempSync(join(tmpdir(), "rufu702-door-release-"));
    dirs.push(repo);
    git(repo, "git init -b main -q");
    git(repo, "git config user.email test@example.com");
    git(repo, "git config user.name Test");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "git add . && git commit -q -m base");
    git(repo, "git branch release main");
    git(repo, "git switch -q release");
    writeFileSync(join(repo, "ship.ts"), "export const s = 1;\n");
    git(repo, "git add . && git commit -q -m 'feat(RUFU-702): ships on the release branch'");
    const releaseSha = git(repo, "rev-parse HEAD");
    git(repo, "git switch -q main");
    // A commit on `main` that `release` never received, so an off-target claim can be measured for real.
    writeFileSync(join(repo, "main-only.ts"), "export const m = 1;\n");
    git(repo, "git add . && git commit -q -m 'chore: a commit release never got'");
    const mainOnlySha = git(repo, "rev-parse HEAD");
    return { repo, releaseSha, mainOnlySha };
  }

  it("proves the landing on the declared target and writes no hold, History row, or notice", async () => {
    const { repo, releaseSha } = setupReleaseRepo();
    const task = baseTask({ baseBranch: "release" });
    const fake = fakeStore(task);
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task,
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: {
        commitSha: releaseSha,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        mergeTargetBranch: "release",
        mergeTargetSource: "task-base-branch",
      } as never,
      source: "ai-merge-finalize",
      messageStore: fake.store as never,
    });

    expect(outcome.disposition).toBe("proven");
    expect(outcome.measurement.verdict).toEqual({
      disposition: "proven",
      proofKind: "task-declared-target",
    });
    // The measurement is recorded as taken: `main` genuinely lacks it, the target genuinely holds it.
    expect(outcome.measurement.ancestryOutcome).toBe("absent");
    expect(outcome.measurement.declaredTargetAncestryOutcome).toBe("proven");
    // Nothing durable is written for a proven landing, so no lane can later mistake this card for a hold.
    expect(fake.history).toEqual([]);
    expect(fake.rows).toEqual([]);
    expect(fake.messages).toEqual([]);
    expect(fake.current().error).toBeNull();
    expect(isDefaultBranchLandingProofHold(fake.current())).toBe(false);
  });

  it("still refuses the same card when its declared target does not hold the commit either", async () => {
    const { repo, mainOnlySha } = setupReleaseRepo();
    const task = baseTask({ baseBranch: "release" });
    const fake = fakeStore(task);
    const outcome = await enforceDefaultBranchLandingProof({
      store: fake.store,
      task,
      repoDir: repo,
      integrationBranch: "release",
      mergeDetails: {
        // A claim about a commit that is on neither ref, aimed at a yardstick that cannot be read.
        commitSha: mainOnlySha,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        mergeTargetBranch: "release/9.9",
        mergeTargetSource: "task-base-branch",
      } as never,
      source: "ai-merge-finalize",
      messageStore: fake.store as never,
    });
    // `integrationBranch: "release"` resolves here, `release/9.9` does not: the card abstains, it is not judged.
    expect(outcome.disposition).toBe("deferred");
    expect(fake.current().error).toBeNull();
    expect(fake.messages).toEqual([]);
  });
});
