import { describe, it, expect, vi, beforeEach } from "vitest";

/*
FNXC:WorktreePreservation 2026-11-08-04:20 (RUFU-278):
RUFU-260 terminalised a card whose deliverable was already committed, orphaned the checkout that refusal had just
protected, and left the card with no Retry remedy — because a content-preservation refusal reached a lane as a bare
`Error` indistinguishable from a removal failure. This suite owns the invariant that no lane can re-derive: the
content-preservation policy is CLASSIFIABLE from every raise site and from a re-wrapped message, and only from the
content decisions. The project-root and branch-rebind refusals share the `preserving ` prefix but are genuine
misconfigurations; absorbing them into the preserve path would mean deleting a root checkout or trusting an unproven
rebind, so they are asserted OUTSIDE the predicate here rather than left to a reviewer's reading of the code.

The narrow seams below are deliberate: `removeWorktree` under a mocked git so the real raise sites are exercised (not
a hand-written fixture that could drift from the sentence), and a structural store double for the settlement so no
mock-the-world TaskStore is needed.
*/
const {
  execMock,
  execFileMock,
  accessMock,
  readdirMock,
  rmMock,
  chmodMock,
  existsSyncMock,
  parseIndexLockPathMock,
  classifyStaleLockMock,
  tryRemoveStaleLockMock,
  parseStaleRegistrationPathMock,
  recoverStaleRegistrationMock,
  installGuardMock,
  pruneWorktreeAdminEntriesMock,
} = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  const execFileMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  (execFileMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execFileMock;
  return {
    execMock: mock,
    execFileMock,
    accessMock: vi.fn(),
    readdirMock: vi.fn(),
    rmMock: vi.fn(),
    chmodMock: vi.fn(),
    existsSyncMock: vi.fn().mockReturnValue(true),
    parseIndexLockPathMock: vi.fn(),
    classifyStaleLockMock: vi.fn(),
    tryRemoveStaleLockMock: vi.fn(),
    parseStaleRegistrationPathMock: vi.fn(),
    recoverStaleRegistrationMock: vi.fn(),
    installGuardMock: vi.fn(),
    pruneWorktreeAdminEntriesMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({ exec: execMock, execFile: execFileMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("node:fs/promises", () => ({ access: accessMock, chmod: chmodMock, readdir: readdirMock, rm: rmMock }));
vi.mock("../execution/branch-conflicts.js", () => ({
  inspectBranchConflict: vi.fn().mockResolvedValue({ kind: "stale" }),
}));
vi.mock("../worktree/worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: installGuardMock,
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));
vi.mock("../worktree/worktree-stale-lock.js", () => ({
  StaleWorktreeIndexLockError: class StaleWorktreeIndexLockError extends Error {},
  parseIndexLockPath: parseIndexLockPathMock,
  classifyStaleLock: classifyStaleLockMock,
  tryRemoveStaleLock: tryRemoveStaleLockMock,
}));
vi.mock("../worktree/worktree-stale-registration.js", () => ({
  parseStaleRegistrationPath: parseStaleRegistrationPathMock,
  recoverStaleRegistration: recoverStaleRegistrationMock,
}));
vi.mock("../worktree/worktree-prune.js", () => ({
  pruneWorktreeAdminEntries: pruneWorktreeAdminEntriesMock,
}));

import { removeWorktree, RemovalReason } from "../worktree/worktree-backend.js";
import {
  isWorktreePreservationRefusal,
  settlePreservedWorktreeRemoval,
  worktreeCheckoutIsReleased,
  worktreePreservationRefusal,
} from "../worktree/worktree-preservation.js";
import {
  isWorktreePreservationRefusal as pooledPredicate,
  settlePreservedWorktreeRemoval as pooledSettle,
} from "../worktree/worktree-pool.js";

/** Drive the real defensive-removal guard with a scripted `git status --porcelain=v1` read. */
async function captureDefensiveRefusal(
  worktreePath: string,
  porcelain: string | { rejects: string },
): Promise<unknown> {
  if (typeof porcelain === "string") {
    execFileMock.mockResolvedValue({ stdout: porcelain, stderr: "" });
  } else {
    execFileMock.mockRejectedValue(new Error(porcelain.rejects));
  }
  try {
    await removeWorktree({
      worktreePath,
      rootDir: "/repo",
      settings: {},
      reason: RemovalReason.PoolPrune,
      taskId: "RUFU-260",
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the defensive removal to refuse");
}

describe("isWorktreePreservationRefusal classifies every content refusal at its raise site", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("classifies a deliverable (uncommitted) tree refusal raised by removeWorktree", async () => {
    const error = await captureDefensiveRefusal("/repo/.worktrees/rufu-260", "?? deliverable.ts\n");

    expect(error).toBeInstanceOf(Error);
    expect(isWorktreePreservationRefusal(error)).toBe(true);
    expect(worktreePreservationRefusal(error)?.classification).toBe("deliverable");
  });

  it("classifies the status-probe refusal, the shape RUFU-260 died on, as an unverifiable content refusal", async () => {
    const error = await captureDefensiveRefusal("/repo/.worktrees/rufu-260", { rejects: "not a git repository" });

    // The sentence is byte-stable: real-git suites and the self-healing cap lane still match this wording.
    expect((error as Error).message).toMatch(/^preserving \/repo\/\.worktrees\/rufu-260: status probe failed \(/);
    expect(isWorktreePreservationRefusal(error)).toBe(true);
    expect(worktreePreservationRefusal(error)?.classification).toBe("unverifiable");
  });

  it("classifies an ignored-only refusal without landing proof, carrying its own classification", async () => {
    const error = await captureDefensiveRefusal("/repo/.worktrees/rufu-260", "!! .env\n");

    expect(isWorktreePreservationRefusal(error)).toBe(true);
    expect(worktreePreservationRefusal(error)?.classification).toBe("ignored-only");
  });

  it("classifies a re-wrapped refusal that lost the class, by sentence shape", () => {
    const wrapped = new Error(
      `Worktree acquisition failed: preserving /repo/.worktrees/rufu-260: uncommitted or ignored content present`,
    );
    const probeFailure = new Error("acquisition detail: preserving /x: status probe failed (EIO)");

    expect(isWorktreePreservationRefusal(wrapped)).toBe(true);
    expect(worktreePreservationRefusal(wrapped)?.classification).toBe("deliverable");
    expect(worktreePreservationRefusal(probeFailure)?.classification).toBe("unverifiable");
    expect(isWorktreePreservationRefusal("preserving /x: uncommitted or ignored content present")).toBe(true);
  });
});

describe("isWorktreePreservationRefusal refuses to absorb the shared-prefix refusals", () => {
  it("excludes the project-root refusal: a bare Error that is a misconfiguration, not a content decision", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    const error = await captureDefensiveRefusal("/repo", "");

    expect((error as Error).message).toContain("refusing to remove the project root checkout");
    expect(isWorktreePreservationRefusal(error)).toBe(false);
    expect(worktreePreservationRefusal(error)).toBeNull();
  });

  it("excludes the branch-rebind refusal that shares the preserving prefix", () => {
    const rebind = new Error(
      "preserving /repo/.worktrees/rufu-260: task-owned branch rebind could not be proven",
    );

    expect(isWorktreePreservationRefusal(rebind)).toBe(false);
  });

  it.each([
    ["a live-session refusal", new Error("worktree /x is held by active session abc")],
    ["a stale index lock", new Error("preserving /x: index.lock is held")],
    ["a native removal failure", new Error("git worktree remove failed with exit 128")],
    ["an undefined non-error", undefined],
    ["a plain object", { message: "preserving /x: uncommitted or ignored content present-ish" }],
  ])("excludes %s", (_name, value) => {
    expect(isWorktreePreservationRefusal(value)).toBe(false);
  });

  it("is the same classifier through the pool barrel the executor lanes import", () => {
    // A lane whose test doubles `vi.mock("../worktree/worktree-pool.js")` must still reach one classifier, not a
    // second opinion that can drift from the first.
    expect(pooledPredicate).toBe(isWorktreePreservationRefusal);
    expect(pooledSettle).toBe(settlePreservedWorktreeRemoval);
  });
});

describe("settlePreservedWorktreeRemoval records the settled decision and hands control back", () => {
  const refusal = new Error("preserving /repo/.worktrees/rufu-260: uncommitted or ignored content present");

  function makeStore(overrides: Record<string, unknown> = {}) {
    return {
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("writes the operator-readable card sentence naming the preserved path and returns the discriminator", async () => {
    const store = makeStore();

    const settled = await settlePreservedWorktreeRemoval({
      store,
      taskId: "RUFU-260",
      worktreePath: "/repo/.worktrees/rufu-260",
      reason: "executor-transient-retry",
      lane: "executor-transient-retry",
      error: refusal,
    });

    expect(settled?.settled).toBe(true);
    expect(settled?.classification).toBe("deliverable");
    const sentence = store.logEntry.mock.calls[0]?.[1] as string;
    expect(sentence).toContain("/repo/.worktrees/rufu-260");
    expect(sentence.toLowerCase()).toContain("preserved");
    // The operator must be able to see it was a protection and that the pointers were kept.
    expect(sentence.toLowerCase()).toContain("not a failure");
    expect(sentence.toLowerCase()).toContain("pointers are kept");
  });

  it("emits ids, counts and fixed outcomes only — no path, sentence, or error text in the audit row", async () => {
    const store = makeStore();

    await settlePreservedWorktreeRemoval({
      store,
      taskId: "RUFU-260",
      worktreePath: "/repo/.worktrees/rufu-260",
      reason: "pool-prune",
      lane: "session-start-recovery",
      error: refusal,
      runId: "run-1",
    });

    const event = store.recordRunAuditEvent.mock.calls[0]?.[0];
    expect(event.mutationType).toBe("worktree:removal-preserved");
    expect(event.target).toBe("RUFU-260");
    expect(event.runId).toBe("run-1");
    expect(event.metadata).toEqual({
      taskId: "RUFU-260",
      reason: "pool-prune",
      classification: "deliverable",
      lane: "session-start-recovery",
      outcome: "continued",
    });
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain("/repo/");
    expect(serialized).not.toContain("preserving");
  });

  it("reports the parked outcome for the escalation half", async () => {
    const store = makeStore();

    await settlePreservedWorktreeRemoval({
      store,
      taskId: "RUFU-260",
      worktreePath: "/repo/.worktrees/rufu-260",
      reason: "step-session-cleanup",
      lane: "step-session-cleanup",
      outcome: "parked",
      error: refusal,
    });

    expect(store.recordRunAuditEvent.mock.calls[0]?.[0].metadata.outcome).toBe("parked");
  });

  it("returns null for a non-refusal so the caller's existing failure handling stays untouched", async () => {
    const store = makeStore();

    const settled = await settlePreservedWorktreeRemoval({
      store,
      taskId: "RUFU-260",
      worktreePath: "/repo/.worktrees/rufu-260",
      reason: "pool-prune",
      lane: "session-start-recovery",
      error: new Error("git worktree remove failed with exit 128"),
    });

    expect(settled).toBeNull();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["an absent store", null],
    ["a throwing logEntry", { logEntry: vi.fn().mockImplementation(() => { throw new Error("history down"); }), recordRunAuditEvent: vi.fn().mockResolvedValue(undefined) }],
    ["a rejecting audit sink", { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent: vi.fn().mockRejectedValue(new Error("audit down")) }],
    ["an audit sink that never settles", { logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent: () => new Promise(() => {}) }],
  ])("settles identically under %s — telemetry can never become a lifecycle dependency", async (_name, store) => {
    vi.useFakeTimers();
    try {
      const pending = settlePreservedWorktreeRemoval({
        store: store as never,
        taskId: "RUFU-260",
        worktreePath: "/repo/.worktrees/rufu-260",
        reason: "pool-prune",
        lane: "session-start-recovery",
        error: refusal,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const settled = await pending;

      expect(settled).toMatchObject({ settled: true, classification: "deliverable" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worktreeCheckoutIsReleased is the only basis a pointer clear may take", () => {
  it.each([
    ["a real removal", { removed: true, classification: "removed" }, true],
    ["already unregistered and gone after prune", { removed: false, harmless: true }, true],
    ["a preserved refusal that never returned", null, false],
    ["no outcome at all", null, false],
    ["an undefined outcome", undefined, false],
    ["an empty object", {}, false],
    ["a not-removed outcome without the harmless proof", { removed: false }, false],
  ])("%s clears pointers: %s", (_name, outcome, expected) => {
    expect(worktreeCheckoutIsReleased(outcome as never)).toBe(expected);
  });
});
