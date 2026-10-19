import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchConflictError } from "../execution/branch-conflicts.js";

/*
FNXC:BranchPhantomEcho 2026-10-19 (RUFU-376):
The phantom-echo gate. A `foreign-unmerged` refusal is produced at the moment git has just proved the
branch is held by NO checkout, yet every downstream surface — the refusal sentence, the formatted log
lines, the card's `error` and `worktree` columns, the dispatcher evidence, and the operator notice —
rendered the caller's *desired* path as if it were that checkout. Operators were told to clear a
worktree that did not exist.

These cases hold the truthful contract on the surfaces that outlive the call frame:
- `conflictingWorktreePath` carries only a proven live checkout (empty means "proven: none"),
- the requested path rides only on `desiredWorktreePath` (audit/diagnostics), never in a slot or a
  sentence that reads as a checkout,
- the task row persists no checkout for that shape, which also repairs a row already carrying one,
- and the liveness/ownership probes are never fed a desired path, because a desired path can name a
  directory some other session has open and decline a recovery for a phantom owner.
*/

const mocks = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/branch-conflicts.js")>()),
  inspectBranchConflict: mocks.inspectBranchConflict,
}));

const { handleBranchConflict } = await import("../executor/worktree-branch-conflict-handle.js");
const { desiredPathFor, liveCheckoutPathFor } = await import("../execution/branch-conflicts.js");

const DESIRED = "/repo/.worktrees/fn-500";
const LIVE = "/repo/.worktrees/other-fn-500";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-500",
    title: "Phantom echo",
    column: "in-progress",
    branch: "fusion/fn-500",
    baseBranch: "main",
    worktree: null,
    paused: false,
    userPaused: false,
    ...overrides,
  } as any;
}

function foreignUnmergedError() {
  return new BranchConflictError({
    branchName: "fusion/fn-500",
    conflictingWorktreePath: "",
    desiredWorktreePath: DESIRED,
    existingTipSha: "abc123def456789",
    strandedCommits: [],
    startPoint: "main",
    recommendedAction: "Preserve this unregistered branch and inspect its foreign or unattributed commits before retrying.",
    collisionKind: "foreign-unmerged",
  });
}

function liveForeignError() {
  return new BranchConflictError({
    branchName: "fusion/fn-500",
    conflictingWorktreePath: LIVE,
    desiredWorktreePath: DESIRED,
    existingTipSha: "abc123def456789",
    strandedCommits: [],
    startPoint: "main",
    recommendedAction: "Preserve the live foreign checkout or discard it explicitly.",
    collisionKind: "live-foreign",
  });
}

function createFixtures() {
  const rootDir = mkdtempSync(join(tmpdir(), "rufu-376-phantom-"));
  const writes: Record<string, unknown>[] = [];
  const logLines: string[] = [];
  const agentLogLines: string[] = [];
  const store = {
    getSettings: async () => ({}),
    getTask: async () => task(),
    updateTask: async (_id: string, patch: Record<string, unknown>) => { writes.push(patch); return task(patch); },
    updateTaskAtomic: async (_id: string, _update: (current: any) => unknown) => task(),
    logEntry: async (_id: string, message: string) => { logLines.push(message); },
    appendAgentLog: async (_id: string, _title: string, _type: string, message: string) => { agentLogLines.push(message); },
  } as any;
  const dispatched: any[] = [];
  const deps = {
    rootDir,
    store,
    getRunContextFor: () => undefined,
    findActiveWorktreeOwner: vi.fn(async () => null),
    normalizeReclaimableWorktreePath: async (source: string) => source,
    cleanupConflictingWorktree: async () => true,
    getAutoRecoveryDispatcher: () => ({
      dispatch: async (failure: any) => {
        dispatched.push(failure);
        return { action: "pause", rationale: "deterministic-pause" } as any;
      },
    }),
    createRunAuditor: () => ({ database: async () => undefined, git: async () => undefined, filesystem: async () => undefined }) as any,
    persistTokenUsage: async () => undefined,
  };
  return {
    deps,
    writes,
    logLines,
    agentLogLines,
    dispatched,
    allRenderedText: () => [
      ...logLines,
      ...agentLogLines,
      ...writes.map((patch) => String(patch.error ?? "")),
    ].join("\n"),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectBranchConflict.mockResolvedValue({ kind: "stale" });
});

let fixtures: ReturnType<typeof createFixtures> | undefined;
afterEach(() => {
  fixtures?.cleanup();
  fixtures = undefined;
});

describe("branch-conflict phantom echo (RUFU-376)", () => {
  it("names no checkout on any surface of a foreign-unmerged sticky pause", async () => {
    fixtures = createFixtures();
    const result = await handleBranchConflict(fixtures.deps as any, task(), foreignUnmergedError());

    expect(result).toBe("sticky");
    // FK-1: neither the refusal sentence nor either formatted line states a path.
    expect(fixtures.allRenderedText()).not.toContain(DESIRED);
    expect(fixtures.logLines.some((line) => line.includes("not checked out in any live worktree"))).toBe(true);
    expect(fixtures.agentLogLines.some((line) => line.includes("worktree=none"))).toBe(true);
    // FK-5: the row persists no checkout, so nothing downstream can read the wanted path as one.
    const pause = fixtures.writes.find((patch) => patch.pausedReason === "branch-conflict-unrecoverable");
    expect(pause).toBeDefined();
    expect(pause?.worktree).toBeNull();
    // FK-7: the surviving operator sentence states the absence instead of pointing at a phantom.
    expect(String(pause?.error)).toContain("no live checkout of it was found");
    expect(String(pause?.error)).not.toContain(DESIRED);
    // FK-2: no ownership probe runs over a refusal that proved there is no filesystem to hold.
    expect(fixtures.deps.findActiveWorktreeOwner).not.toHaveBeenCalled();
  });

  it("keeps the requested path out of the checkout-named evidence slot and into its own key", async () => {
    fixtures = createFixtures();
    await handleBranchConflict(fixtures.deps as any, task(), foreignUnmergedError());

    // FK-6: the recovery handler consumes `conflictingWorktreePath` as an existing checkout and probes
    // it for session liveness, so the no-live shape omits the key rather than sending "" or a
    // requested path. The handler still learns the refused destination under `desiredWorktreePath`.
    expect(fixtures.dispatched).toHaveLength(1);
    const evidence = fixtures.dispatched[0].evidence;
    expect(Object.keys(evidence)).not.toContain("conflictingWorktreePath");
    expect(evidence.desiredWorktreePath).toBe(DESIRED);
    expect(evidence.collisionKind).toBe("foreign-unmerged");
  });

  it("still names and persists the checkout the live-foreign shape actually proved", async () => {
    fixtures = createFixtures();
    const error = liveForeignError();
    mocks.inspectBranchConflict.mockResolvedValue({ kind: "stale" });

    const result = await handleBranchConflict(fixtures.deps as any, task(), error);

    expect(result).toBe("sticky");
    // The live shape already told the truth; RUFU-376 must not degrade it into a vague refusal.
    expect(fixtures.logLines.some((line) => line.includes(`is already checked out at ${LIVE}`))).toBe(true);
    expect(fixtures.agentLogLines.some((line) => line.includes(`worktree=${LIVE}`))).toBe(true);
    const pause = fixtures.writes.find((patch) => patch.pausedReason === "branch-conflict-unrecoverable");
    expect(pause?.worktree).toBe(LIVE);
    // FK-2: the ownership probe runs against the proven live path only.
    expect(fixtures.deps.findActiveWorktreeOwner).toHaveBeenCalledWith(LIVE, "FN-500");
    expect(fixtures.dispatched[0].evidence.conflictingWorktreePath).toBe(LIVE);
    expect(fixtures.dispatched[0].evidence.desiredWorktreePath).toBe(DESIRED);
  });

  it("resolves the two paths from the error so no consumer has to re-derive them", () => {
    const phantom = foreignUnmergedError();
    expect(liveCheckoutPathFor(phantom)).toBe("");
    expect(desiredPathFor(phantom)).toBe(DESIRED);
    // A refusal sentence may never be a path source; the structured fields are the only authority.
    expect(phantom.message).not.toContain(DESIRED);
    expect(phantom.conflictingWorktreePath).toBe("");

    const live = liveForeignError();
    expect(liveCheckoutPathFor(live)).toBe(LIVE);
    expect(desiredPathFor(live)).toBe(DESIRED);
    expect(live.message).toContain(LIVE);
  });
});
