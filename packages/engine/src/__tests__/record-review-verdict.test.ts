/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-20:17 (RUFU-531):
 * Acceptance for the heartbeat reviewer lane's verdict write surface. Two things make this suite
 * non-decorative:
 *
 * - Every content-proof case runs on a REAL tmpdir git repository against the REAL merge door
 *   (`captureMergeContentDescriptor` + `computeMergeStaleContentDecision`). A parity test that
 *   recomputed the fingerprint with the seam's own spelling would stay green while the two sides
 *   drifted, which is precisely how a verdict becomes dead on arrival at the door.
 * - Every refusal asserts the durable store stayed untouched, because FN-8141's laundering shape (a
 *   card that looks done with no verdict row) is what this lane must never add to.
 *
 * No pg harness, no network, no timers: fake store + real git plumbing (AGENTS.md "Do Not Add Slow
 * Tests").
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_REVIEW_GROUP_ID, evaluatePreMergeApprovals, type Task, type WorkflowStepResult } from "@fusion/core";
import { heartbeatReviewVerdictGateOpens, recordHeartbeatReviewVerdict } from "../review/record-review-verdict.js";
import { createRecordReviewVerdictTool } from "../agent-tools.js";
import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";
import { probeReviewDiffFingerprint, EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";

const REVIEWER = "reviewer-agent";
const TASK_ID = "RUFU-531";

/* ------------------------------------------------------------------ fake store */

interface FakeStoreOptions {
  /** `atomic` exercises the fenced `updateTaskAtomic` tier the production store uses. */
  tier?: "atomic" | "no-writer";
  auditMode?: "ok" | "absent" | "throws" | "rejects" | "pending";
}

function createStore(task: Task, options: FakeStoreOptions = {}) {
  const auditEvents: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const recordRunAuditEvent = (() => {
    switch (options.auditMode) {
      case "absent":
        return undefined;
      case "throws":
        return vi.fn(() => {
          throw new Error("audit sink down");
        });
      case "rejects":
        return vi.fn(async () => {
          throw new Error("audit sink down");
        });
      case "pending":
        return vi.fn(() => new Promise<void>(() => undefined));
      default:
        return vi.fn(async (event: { mutationType: string; metadata: Record<string, unknown> }) => {
          auditEvents.push(event);
        });
    }
  })();

  const writes = options.tier === "no-writer"
    ? {}
    : {
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
        Object.assign(task, patch);
        return task;
      }),
      updateTaskAtomic: vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
        const patch = compute(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };
  const store = {
    getTask: vi.fn(async () => task),
    ...writes,
    isBackendMode: vi.fn(() => false),
    recordAgentActivity: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    ...(recordRunAuditEvent ? { recordRunAuditEvent } : {}),
  };
  return {
    store: store as never,
    auditEvents,
    logEntry: store.logEntry,
    /** Number of durable writes the seam attempted (0 proves a refusal wrote nothing). */
    writeCount: () => ((writes as { updateTaskAtomic?: { mock: { calls: unknown[] } }; updateTask?: { mock: { calls: unknown[] } } })
      .updateTaskAtomic?.mock.calls.length ?? 0)
      + ((writes as { updateTask?: { mock: { calls: unknown[] } } }).updateTask?.mock.calls.length ?? 0),
  };
}

function pendingGate(extra: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: CODE_REVIEW_GROUP_ID,
    workflowStepName: "Code Review",
    phase: "pre-merge",
    source: "node",
    status: "pending",
    verdictRequired: true,
    reviewKind: "code",
    startedAt: "2026-11-12T10:00:00.000Z",
    ...extra,
  };
}

/**
 * Default shape: a review-lane card whose ONLY `code-review` row is the graph's pending gate - the
 * candidacy every test below starts from unless it names a different live row.
 */
function makeTask(worktree: string | undefined, extra: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    column: "in-review",
    worktree,
    branch: "fusion/RUFU-531",
    workflowStepResults: [pendingGate()],
    ...extra,
  } as Task;
}

const verdictsOf = (task: Task) => (task.workflowStepResults ?? []).filter((row) => row.workflowStepId === CODE_REVIEW_GROUP_ID);
const lastRow = (task: Task) => verdictsOf(task).at(-1);

function ledgerFor(row: { id: string; reviewerAgentId: string } | null, transitioned = true) {
  return {
    findLiveRun: vi.fn(async () => row),
    completeRun: vi.fn(async () => transitioned),
  };
}

/* ------------------------------------------------------------------ git fixture */

type Git = (...args: string[]) => string;
const directories: string[] = [];

function openRepo(): { repo: string; git: Git; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "fusion-heartbeat-review-verdict-"));
  directories.push(repo);
  const git: Git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  return { repo, git, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

/** Base commit on `main`; the recorded fork point every review input is measured against. */
function seedBase(git: Git, repo: string): string {
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "base");
  return git("rev-parse", "HEAD");
}

/** The card's own work, committed while HEAD sits on the task branch. Returns the branch tip. */
function commitOnBranch(git: Git, repo: string, file: string, body = "card work\n"): string {
  git("checkout", "-B", "fusion/RUFU-531");
  writeFileSync(join(repo, file), body);
  git("add", file);
  git("commit", "-m", `card work ${file}`);
  return git("rev-parse", "HEAD");
}

/** An unrelated integration commit on `main` the branch has never seen. */
function advanceMain(git: Git, repo: string, file: string): string {
  git("checkout", "main");
  writeFileSync(join(repo, file), "landed by somebody else\n");
  git("add", file);
  git("commit", "-m", `unrelated integration work ${file}`);
  return git("rev-parse", "HEAD");
}

afterEach(() => {
  while (directories.length) {
    const dir = directories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ parity with the door */

describe("heartbeat review verdict - merge-door parity (RUFU-521 authority)", () => {
  it("records the fingerprint the merge door itself derives, not a lookalike recomputation", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "Reviewed the card's own diff; clean." } },
      );

      expect(result.outcome).toBe("recorded");
      const row = lastRow(task);
      expect(row?.verdict).toBe("APPROVE");
      expect(row?.status).toBe("passed");

      // The door's own derivation over the same worktree — the drift guard.
      const door = await captureMergeContentDescriptor(task, { workspaceRootDir: repo, settings: {} });
      expect(door.kind).toBe("singular");
      expect(door.diff.state).toBe("fingerprint");
      expect(row?.reviewInputFingerprint).toBe(door.diff.state === "fingerprint" ? door.diff.fingerprint : undefined);
      expect(row?.reviewInputFingerprint).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("keeps the RUFU-521 negative: a checkout parked off the branch tip records real content, not the empty sentinel, and the door does not call it stale", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      const branchTip = commitOnBranch(git, repo, "card.txt");
      const drifted = advanceMain(git, repo, "main-only.txt");
      git("checkout", "--detach", drifted);

      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "Reviewed the branch delivery; clean." } },
      );
      expect(result.outcome).toBe("recorded");

      const row = lastRow(task)!;
      expect(row.reviewInputFingerprint).toBeDefined();
      expect(row.reviewInputFingerprint).not.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
      // The condemned HEAD-only computation would have produced the false empty sentinel here.
      const headOnly = await probeReviewDiffFingerprint(repo, git("merge-base", "HEAD", "main"));
      expect(headOnly).toEqual({ state: "empty" });

      // And the door, reading that same row over that same checkout, approves instead of calling the
      // content stale - the RUFU-290 false-`stale_content` wedge this ruling exists to prevent.
      const door = await captureMergeContentDescriptor(task, { workspaceRootDir: repo, settings: {} });
      expect(
        evaluatePreMergeApprovals(task, {
          requiredPreMergeStepIds: new Set([CODE_REVIEW_GROUP_ID]),
          mergeContent: door,
        }).map((gate) => gate.state),
      ).toEqual(["approved"]);
      expect(git("rev-parse", "fusion/RUFU-531")).toBe(branchTip);
    } finally {
      cleanup();
    }
  });

  it("refuses an approving verdict when the branch ref is unresolvable instead of degrading to the empty sentinel", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base, branch: "fusion/never-created" });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result).toMatchObject({ outcome: "refused", code: "fingerprint-unavailable", ledgerClosed: false });
      if (result.outcome === "refused") expect(result.message).toContain("branch-ref-unresolvable");
      expect(store.writeCount()).toBe(0);
      expect(verdictsOf(task)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("records the empty sentinel only when the branch genuinely delivered nothing", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      git("checkout", "-B", "fusion/RUFU-531");
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "No delivery to review; clean base." } },
      );

      expect(result).toMatchObject({ outcome: "recorded", fingerprintState: "empty" });
      expect(lastRow(task)?.reviewInputFingerprint).toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ candidacy matrix */

describe("heartbeat review verdict - live-row candidacy", () => {
  const refusalStore = (task: Task) => createStore(task);

  it("refuses an FN-295 archived carrier with zero writes and narrates it on the card", async () => {
    const task = makeTask(undefined, {
      workflowStepResults: [pendingGate({ status: "skipped", reviewInputFingerprint: "abc", remediationArchivedAt: "2026-11-11T10:00:00.000Z", remediationArchivedFromStatus: "failed" })],
    });
    const store = refusalStore(task);
    const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
    );

    expect(result).toMatchObject({ outcome: "refused", code: "archived-carrier", ledgerClosed: false });
    expect(store.writeCount()).toBe(0);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(ledger.completeRun).not.toHaveBeenCalled();
  });

  it("closes the ledger on an already-proven row whose verdict matches, and appends nothing", async () => {
    const task = makeTask(undefined, {
      workflowStepResults: [pendingGate({ reviewInputFingerprint: "known-input", verdict: "APPROVE", status: "passed", completedAt: "2026-11-12T10:05:00.000Z" })],
    });
    const store = refusalStore(task);
    const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
    );

    expect(result).toMatchObject({ outcome: "refused", code: "already-proven", recordedVerdict: "APPROVE", ledgerClosed: true });
    expect(store.writeCount()).toBe(0);
    expect(verdictsOf(task)).toHaveLength(1);
    expect(ledger.completeRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "run-1", status: "approve" }));
  });

  it("refuses a differing verdict on an already-proven row with zero writes and no ledger close", async () => {
    const task = makeTask(undefined, {
      workflowStepResults: [pendingGate({ reviewInputFingerprint: "known-input", verdict: "REVISE", status: "failed", completedAt: "2026-11-12T10:05:00.000Z" })],
    });
    const store = refusalStore(task);
    const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
    );

    expect(result).toMatchObject({ outcome: "refused", code: "verdict-contradiction", ledgerClosed: false });
    expect(store.writeCount()).toBe(0);
    expect(ledger.completeRun).not.toHaveBeenCalled();
  });

  it("treats a verdict-less fingerprinted row as already proven and leaves the ledger live for FN-279", async () => {
    const task = makeTask(undefined, {
      workflowStepResults: [pendingGate({ reviewInputFingerprint: "known-input" })],
    });
    const store = refusalStore(task);
    const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
    );

    expect(result).toMatchObject({ outcome: "refused", code: "already-proven", ledgerClosed: false });
    if (result.outcome === "refused") expect(result.message).toContain("unprovable");
    expect(ledger.completeRun).not.toHaveBeenCalled();
  });

  it("refuses content drift with zero rows appended and no ledger close", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      const firstTip = commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, {
        baseCommitSha: base,
        workflowStepResults: [pendingGate({ reviewInputFingerprint: "prior-round-input", reviewedCommitSha: firstTip })],
      });
      const store = createStore(task);
      const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );
      // The tip has moved past the commit the live row inspected.
      git("checkout", "fusion/RUFU-531");
      writeFileSync(join(repo, "more.txt"), "more work\n");
      git("add", "more.txt");
      git("commit", "-m", "more work");

      const drifted = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean again" } },
      );

      expect(result.outcome).not.toBe("recorded");
      expect(drifted).toMatchObject({ outcome: "refused", code: "content-drift", ledgerClosed: false });
      expect(verdictsOf(task)).toHaveLength(1);
      expect(ledger.completeRun).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("does not refuse a genuinely owed verdict when the reviewed commit is still the tip", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      const tip = commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, {
        baseCommitSha: base,
        // No fingerprint, so tip-frozen does not short-circuit into `already-proven`.
        workflowStepResults: [pendingGate({ reviewedCommitSha: tip })],
      });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result.outcome).toBe("recorded");
      expect(verdictsOf(task)).toHaveLength(1);
      expect(lastRow(task)?.verdict).toBe("APPROVE");
    } finally {
      cleanup();
    }
  });

  it("records over a verdict-less FAILED gate row - the reported symptom shape", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, {
        baseCommitSha: base,
        workflowStepResults: [pendingGate({ status: "failed", output: "Reviewer session ended before producing a verdict", completedAt: "2026-11-12T10:02:00.000Z" })],
      });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result).toMatchObject({ outcome: "recorded", ledgerClosed: true });
      const row = lastRow(task)!;
      expect(row.status).toBe("passed");
      expect(row.verdict).toBe("APPROVE");
      // The upsert replaces the live row in place and keeps the verdict-less round as history.
      expect(verdictsOf(task)).toHaveLength(1);
      expect(row.priorAttempts?.[0]?.status).toBe("failed");
    } finally {
      cleanup();
    }
  });

  it("refuses a workspace card honestly and writes nothing", async () => {
    const task = makeTask(undefined, {
      workspaceWorktrees: { "repo-a": { path: "/tmp/a", branch: "fusion/RUFU-531" } as never },
      workflowStepResults: [pendingGate()],
    });
    const store = refusalStore(task);
    const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
    );

    expect(result).toMatchObject({ outcome: "refused", code: "workspace-unsupported", ledgerClosed: false });
    expect(store.writeCount()).toBe(0);
    expect(ledger.completeRun).not.toHaveBeenCalled();
  });

  it("refuses a foreign live reviewer-run row rather than settling another agent's attempt", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);
      const ledger = ledgerFor({ id: "run-1", reviewerAgentId: "someone-else" });

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result).toMatchObject({ outcome: "refused", code: "task-not-owned", ledgerClosed: false });
      expect(store.writeCount()).toBe(0);
      expect(ledger.completeRun).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("records and reports ledgerClosed:false when no live reviewer-run row exists", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor(null) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result).toMatchObject({ outcome: "recorded", ledgerClosed: false, ledgerSkippedForeign: false });
    } finally {
      cleanup();
    }
  });

  it("treats an already-settled ledger row as success, not an error", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }, false) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      expect(result).toMatchObject({ outcome: "recorded", ledgerClosed: false, ledgerAlreadySettled: true });
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ verdict shape + persistence honesty */

describe("heartbeat review verdict - dispositions and persistence", () => {
  async function repoTask() {
    const fixture = openRepo();
    const base = seedBase(fixture.git, fixture.repo);
    commitOnBranch(fixture.git, fixture.repo, "card.txt");
    return { ...fixture, base };
  }

  it("records a REVISE carrying its findings and the same content proof the door derives", async () => {
    const { repo, git, cleanup, base } = await repoTask();
    void git;
    try {
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        {
          task,
          callingAgentId: REVIEWER,
          input: {
            verdict: "REVISE",
            summary: "The change writes outside the declared scope.",
            findings: [{ id: "f-1", title: "Out-of-scope write", body: "touching a second package", severity: "high" }],
          },
        },
      );

      expect(result).toMatchObject({ outcome: "recorded", fingerprintState: "fingerprint" });
      const row = lastRow(task)!;
      expect(row.status).toBe("failed");
      expect(row.verdict).toBe("REVISE");
      expect(row.findings).toHaveLength(1);
      const door = await captureMergeContentDescriptor(task, { workspaceRootDir: repo, settings: {} });
      expect(row.reviewInputFingerprint).toBe(door.diff.state === "fingerprint" ? door.diff.fingerprint : undefined);
    } finally {
      cleanup();
    }
  });

  it("refuses a REVISE with no actionable finding rather than fabricating an approval", async () => {
    const { repo, cleanup, base } = await repoTask();
    try {
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "REVISE", summary: "looks off somehow" } },
      );

      expect(result).toMatchObject({ outcome: "refused", code: "revise-without-finding", ledgerClosed: false });
      expect(store.writeCount()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("accepts a hard-blocker REVISE with no finding, as briefed", async () => {
    const { repo, cleanup, base } = await repoTask();
    try {
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "REVISE", summary: "Hard blocker: missing credential to reach the staging tenant." } },
      );

      expect(result.outcome).toBe("recorded");
      expect(lastRow(task)?.verdict).toBe("REVISE");
    } finally {
      cleanup();
    }
  });

  it("records a REVISE without a fingerprint when the probe is unavailable, because a block needs no proof", async () => {
    const task = makeTask("/path/that/does/not/exist-rufu-531");
    const store = createStore(task);

    const result = await recordHeartbeatReviewVerdict(
      { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
      {
        task,
        callingAgentId: REVIEWER,
        input: {
          verdict: "REVISE",
          summary: "Cannot run the suite.",
          findings: [{ id: "f-1", title: "No verification possible", body: "checkout missing", severity: "critical" }],
        },
      },
    );

    expect(result).toMatchObject({ outcome: "recorded", fingerprintState: "absent-revise" });
    expect(lastRow(task)?.reviewInputFingerprint).toBeUndefined();
  });

  it.each([
    ["no-writer", { tier: "no-writer" as const }, "no-writer"],
    ["aborted-before-write", {}, "aborted"],
  ])("reports the %s persist disposition as a refusal that leaves the ledger live", async (_label, options, expectedCode) => {
    const { repo, cleanup, base } = await repoTask();
    try {
      const task = makeTask(repo, { baseCommitSha: base });
      const store = createStore(task, options);
      const ledger = ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER });
      const controller = new AbortController();
      if (expectedCode === "aborted") controller.abort();

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger },
        {
          task,
          callingAgentId: REVIEWER,
          input: { verdict: "APPROVE", summary: "clean" },
          ...(expectedCode === "aborted" ? { signal: controller.signal } : {}),
        },
      );

      expect(result).toMatchObject({ outcome: "refused", code: expectedCode, ledgerClosed: false });
      expect(verdictsOf(task)).toHaveLength(1);
      expect(lastRow(task)?.status).toBe("pending");
      expect(ledger.completeRun).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("resolves the diff base through the door's helper, so an unreadable recorded base does not abort the record", async () => {
    const { repo, cleanup } = await repoTask();
    try {
      const task = makeTask(repo, { baseCommitSha: "0".repeat(40) });
      const store = createStore(task);

      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "clean" } },
      );

      // The recorded sha is invisible to this checkout; `resolveDiffBaseRef` derives the leg the door
      // would derive, and the recorded proof must equal the door's proof for that same task.
      expect(result.outcome).toBe("recorded");
      const door = await captureMergeContentDescriptor(task, { workspaceRootDir: repo, settings: {} });
      expect(lastRow(task)?.reviewInputFingerprint).toBe(door.diff.state === "fingerprint" ? door.diff.fingerprint : undefined);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ audit + sink health */

describe("heartbeat review verdict - run-audit provenance", () => {
  const FORBIDDEN_TOKENS = ["diff", "finding", "notes", "summary", "error", "empty-review-input"];
  const CLOCK = Date.parse("2026-11-12T12:00:00.000Z");

  async function recordWithAudit(auditMode: "ok" | "absent" | "throws" | "rejects") {
    const { repo, git, cleanup } = openRepo();
    const base = seedBase(git, repo);
    commitOnBranch(git, repo, "card.txt");
    const task = makeTask(repo, { baseCommitSha: base });
    const store = createStore(task, { auditMode });
    const result = await recordHeartbeatReviewVerdict(
      {
        store: store.store,
        ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }),
        getRunContextFor: () => ({ runId: "run-77", agentId: REVIEWER, source: "heartbeat" }),
        now: () => CLOCK,
      },
      { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "Reviewed; ship it." } },
    );
    return { result, store, task, cleanup };
  }

  it("emits ids/count/enum-only provenance for a recorded verdict", async () => {
    const { result, store, task, cleanup } = await recordWithAudit("ok");
    try {
      expect(result.outcome).toBe("recorded");
      const emitted = store.auditEvents.find((event) => event.mutationType === "task:review-verdict-recorded");
      expect(emitted?.metadata).toEqual({
        taskId: TASK_ID,
        reviewerAgentId: REVIEWER,
        verdict: "APPROVE",
        fingerprintState: "fingerprint",
        ledgerClosed: true,
      });
      // No board mutation: only the step-result write happened.
      expect(task.column).toBe("in-review");
    } finally {
      cleanup();
    }
  });

  it("keeps review prose and digests out of the audit row", async () => {
    const { result, store, cleanup } = await recordWithAudit("ok");
    try {
      expect(result.outcome).toBe("recorded");
      expect(store.auditEvents.length).toBeGreaterThan(0);
      for (const event of store.auditEvents) {
        const serialized = JSON.stringify(event.metadata).toLowerCase();
        for (const token of FORBIDDEN_TOKENS) expect(serialized).not.toContain(token);
      }
    } finally {
      cleanup();
    }
  });

  it("bounds a never-settling audit sink without changing the recorded verdict", async () => {
    const { repo, git, cleanup } = openRepo();
    const base = seedBase(git, repo);
    commitOnBranch(git, repo, "card.txt");
    const task = makeTask(repo, { baseCommitSha: base });
    const store = createStore(task, { auditMode: "pending" });
    try {
      /*
      Real timers, deliberately: the seam's content probe is real git I/O, and fake timers starve it, so
      the published `advanceTimersByTimeAsync` idiom from the other sink-health suites cannot be reused
      here. The cost is one bounded wait of `RUN_AUDIT_EMIT_TIMEOUT_MS`, which is the bound under test.
      */
      const result = await recordHeartbeatReviewVerdict(
        { store: store.store, ledger: ledgerFor({ id: "run-1", reviewerAgentId: REVIEWER }) },
        { task, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "Reviewed; ship it." } },
      );
      // The emit timed out inside the bounded seam; the durable row and the ledger close stand untouched.
      expect(result).toMatchObject({ outcome: "recorded", verdict: "APPROVE", ledgerClosed: true });
      expect(lastRow(task)?.verdict).toBe("APPROVE");
      expect(store.auditEvents).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, RUN_AUDIT_EMIT_TIMEOUT_MS + 15_000);

  it.each(["absent", "throws", "rejects"] as const)(
    "a %s audit sink changes nothing about the recorded verdict",
    async (auditMode) => {
      const { result, task, cleanup } = await recordWithAudit(auditMode);
      try {
        expect(result).toMatchObject({ outcome: "recorded", verdict: "APPROVE", ledgerClosed: true });
        expect(lastRow(task)?.verdict).toBe("APPROVE");
      } finally {
        cleanup();
      }
    },
  );
});

/* ------------------------------------------------------------------ tool surface */

describe("fn_record_review_verdict - tool schema refusals", () => {
  /**
   * Calls the tool body directly: a schema-declared enum is only a promise, and the briefed risk is a
   * caller that reaches `execute` with a missing verdict and gets a silent approval.
   */
  async function callTool(task: Task, params: Record<string, unknown>) {
    const store = createStore(task);
    const tool = createRecordReviewVerdictTool({ store: store.store, agentId: REVIEWER, currentTaskId: TASK_ID });
    const result = await tool.execute("call-1", params as never);
    return { result, store, task };
  }

  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((part) => part.text ?? "").join("\n");

  it("errors without a verdict and records nothing, never defaulting to APPROVE", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const { result, store, task: live } = await callTool(task, { summary: "Reviewed; ship it." });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result as never)).toContain("A verdict is required");
      expect(store.writeCount()).toBe(0);
      expect(lastRow(live)?.status).toBe("pending");
      expect(lastRow(live)?.verdict).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it.each(["RETHINK", "approve", ""] )("refuses the non-heartbeat verdict %j", async (verdict) => {
    const task = makeTask(undefined);
    const { result, store } = await callTool(task, { verdict, summary: "x" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(store.writeCount()).toBe(0);
  });

  it("refuses an empty summary instead of writing a verdict with no outcome", async () => {
    const task = makeTask(undefined);
    const { result, store } = await callTool(task, { verdict: "APPROVE", summary: "   " });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as never)).toContain("summary is required");
    expect(store.writeCount()).toBe(0);
  });

  it("refuses a caller-supplied content-proof key outright", async () => {
    const task = makeTask(undefined);
    const { result, store } = await callTool(task, {
      verdict: "APPROVE",
      summary: "clean",
      reviewInputFingerprint: "attacker-chosen-input",
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as never)).toContain("measured by the engine");
    expect(store.writeCount()).toBe(0);
  });

  it("records through the tool with the injected lane identity and never a board move", async () => {
    const { repo, git, cleanup } = openRepo();
    try {
      const base = seedBase(git, repo);
      commitOnBranch(git, repo, "card.txt");
      const task = makeTask(repo, { baseCommitSha: base });
      const { result, task: live } = await callTool(task, {
        verdict: "APPROVE_WITH_NOTES",
        summary: "Clean; two advisory notes.",
        findings: [{ title: "Naming", body: "Consider a clearer name", severity: "low" }],
      });

      expect((result as { isError?: boolean }).isError).toBeUndefined();
      const details = (result as { details: Record<string, unknown> }).details;
      expect(details).toMatchObject({ outcome: "recorded", verdict: "APPROVE_WITH_NOTES", fingerprintState: "fingerprint" });
      expect(live.column).toBe("in-review");
      const row = lastRow(live)!;
      expect(row.reviewKind).toBe("code");
      expect(row.verdictRequired).toBe(true);
      expect(row.findings?.[0]?.title).toBe("Naming");
    } finally {
      cleanup();
    }
  });
});

/**
 * FNXC:HeartbeatReviewVerdict 2026-11-12-21:55 (RUFU-531):
 * The wake-side predicate must never become a second opinion about candidacy. It is exported from THIS module
 * and computed over the same shipped row primitives the ladder uses; this test makes that structural claim
 * behavioral: for every withheld shape the predicate's answer and the write path's refusal code agree with no
 * row written, and for every shape the predicate calls open, the write path may still refuse (ownership, tip
 * movement, content measurement) but never with a candidacy code the predicate just called open.
 */
describe("wake-side candidacy predicate against the write path", () => {
  const CANDIDACY_CODES = new Set([
    "workspace-unsupported",
    "no-live-gate",
    "archived-carrier",
    "already-proven",
    "gate-not-pending",
    // The verdict-aware refinement the write path can make and the wake-side question cannot.
    "verdict-contradiction",
  ]);

  it("agrees with the ladder on every shape that decides tool injection", async () => {
    const shapes: Array<{ label: string; task: Task; opens: boolean; code?: string }> = [
      { label: "pending gate", task: makeTask("/tmp/rufu-531-unmeasured"), opens: true },
      {
        label: "verdict-less failed gate",
        task: makeTask("/tmp/rufu-531-unmeasured", {
          workflowStepResults: [pendingGate({ status: "failed", completedAt: "2026-11-12T00:00:00.000Z" })],
        }),
        opens: true,
      },
      {
        label: "superseded row leaves no live gate",
        task: makeTask("/tmp/rufu-531-unmeasured", {
          workflowStepResults: [pendingGate({ supersededAt: "2026-11-11T00:00:00.000Z" })],
        }),
        opens: false,
        code: "no-live-gate",
      },
      { label: "no gate at all", task: makeTask("/tmp/rufu-531-unmeasured", { workflowStepResults: [] }), opens: false, code: "no-live-gate" },
      {
        label: "already proven row",
        task: makeTask("/tmp/rufu-531-unmeasured", {
          workflowStepResults: [
            pendingGate({
              status: "passed",
              verdict: "APPROVE",
              completedAt: "2026-11-12T00:00:00.000Z",
              reviewInputFingerprint: "abc123def456",
            }),
          ],
        }),
        opens: false,
        code: "already-proven",
      },
      {
        label: "FN-295 archived carrier",
        task: makeTask("/tmp/rufu-531-unmeasured", {
          workflowStepResults: [
            pendingGate({
              status: "failed",
              verdict: "REVISE",
              completedAt: "2026-11-12T00:00:00.000Z",
              remediationArchivedAt: "2026-11-12T00:00:00.000Z",
            }),
          ],
        }),
        opens: false,
        code: "archived-carrier",
      },
      {
        // The predicate answers `gate-not-pending`; the write path refines it to `verdict-contradiction`
        // because only the write path knows the caller's verdict. Same withheld class, sharper code.
        label: "authored verdict with no proof",
        task: makeTask("/tmp/rufu-531-unmeasured", {
          workflowStepResults: [pendingGate({ status: "failed", verdict: "REVISE", completedAt: "2026-11-12T00:00:00.000Z" })],
        }),
        opens: false,
        code: "verdict-contradiction",
      },
      {
        label: "workspace card",
        task: makeTask("/tmp/rufu-531-unmeasured", { workspaceWorktrees: { "repo-a": { path: "/tmp/rufu-531-a" } as never } }),
        opens: false,
        code: "workspace-unsupported",
      },
    ];

    for (const shape of shapes) {
      expect(heartbeatReviewVerdictGateOpens(shape.task), shape.label).toBe(shape.opens);
      const { store, writeCount } = createStore(shape.task);
      const result = await recordHeartbeatReviewVerdict(
        { store },
        { task: { id: TASK_ID }, callingAgentId: REVIEWER, input: { verdict: "APPROVE", summary: "Ship it." } },
      );
      if (!shape.opens) {
        expect(result.outcome, shape.label).toBe("refused");
        expect(result.code, shape.label).toBe(shape.code);
        expect(writeCount(), shape.label).toBe(0);
      } else {
        expect(CANDIDACY_CODES.has(result.code ?? ""), shape.label).toBe(false);
      }
    }
  });
});
