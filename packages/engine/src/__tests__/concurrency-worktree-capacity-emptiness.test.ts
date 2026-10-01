import { describe, it, expect } from "vitest";
import type { Task } from "@fusion/core";
import { persistedWorktreeHolderTaskIdsFromStore } from "../concurrency/concurrency.js";
import { CheckoutEmptinessProver } from "../worktree/checkout-emptiness.js";

/*
FNXC:OverlapScheduling 2026-09-09-00:40 (RUFU-200):
The proof-map → capacity-holder mapping seam of `persistedWorktreeHolderTaskIdsFromStore`. The core
predicate only sees the downgrade-only `checkoutProvenEmpty` boolean; THIS layer decides when it is
earned — every retained repository entry proven `empty`, anything else (occupied, unknown, missing
verdict, or no proof requested at all) keeps the card a holder. RUFU-198 consumed one of the
operator's `maxWorktrees` slots from a planning lane with a clean, zero-commits-ahead checkout, so
the readout reported 3/4 while nothing on disk needed protecting; these tests pin the exact evidence
that releases a slot and the fail-closed direction for everything else.
*/

const testIr = {
  version: "v2",
  id: "custom:test",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "in-progress", name: "Doing", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "Review", traits: [{ trait: "review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
} as any;

const store = {
  getTaskWorkflowSelection: () => ({ workflowId: "custom:test", stepIds: [] }),
  getWorkflowDefinition: async () => ({ ir: testIr }),
} as any;

/** A planning-lane card that retained a checkout after a replan bounce — the RUFU-198 shape. */
function retainedHolder(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "RUFU-TEST",
    title: "t",
    description: "",
    column: "todo",
    status: "needs-replan",
    dependencies: [],
    steps: [],
    log: [],
    ...overrides,
  } as unknown as Task;
}

interface FakeGit {
  /** `git status --porcelain` stdout for the entry path (default clean). */
  status?: string;
  /** Throw to simulate a dead/unregistered path. */
  statusFails?: boolean;
  /** `rev-list --count base..HEAD` stdout (default "0"). */
  ahead?: string;
  /** Throw to simulate an unresolvable base/branch ref. */
  aheadFails?: boolean;
}

/**
 * A prover with an injected git runner. Table keys are working directories; the `ref-only` mode
 * probes run in the prover's rootDir, so dead-path cases key their ref answer under ROOT.
 */
const ROOT = "/main-checkout";
function fakeProver(table: Record<string, FakeGit>) {
  const calls: string[] = [];
  const prover = new CheckoutEmptinessProver({
    rootDir: ROOT,
    integrationBranch: "main",
    execImpl: async (command, options) => {
      calls.push(`${options.cwd} ${command}`);
      const entry = table[options.cwd] ?? {};
      if (command.startsWith("git status")) {
        if (entry.statusFails) throw new Error("fatal: not a worktree");
        return { stdout: entry.status ?? "" };
      }
      if (entry.aheadFails) throw new Error("fatal: ambiguous argument");
      return { stdout: `${entry.ahead ?? "0"}\n` };
    },
  });
  return { prover, calls };
}

const proof = (prover: CheckoutEmptinessProver) => ({
  rootDir: ROOT,
  settings: { integrationBranch: "main" },
  prover,
});

describe("persistedWorktreeHolderTaskIdsFromStore emptiness proof", () => {
  it("excludes a singular checkout proven clean and zero commits ahead", async () => {
    const { prover } = fakeProver({ "/wt/clean": { status: "", ahead: "0" } });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [retainedHolder({ worktree: "/wt/clean", branch: "fusion/rufu-test", baseCommitSha: "B" })],
      proof(prover),
    );
    expect(ids).toEqual([]);
  });

  it.each([
    ["a dirty tree", { status: "?? scratch.txt", ahead: "0" }],
    ["an untracked-only tree", { status: "?? newfile.ts", ahead: "0" }],
    ["one commit ahead of base", { status: "", ahead: "1" }],
    ["a failed git call (unknown)", { statusFails: true, aheadFails: true }],
  ])("still counts a retained checkout with %s (fail-closed)", async (_label, git) => {
    const { prover } = fakeProver({ "/wt/holder": git, [ROOT]: { aheadFails: true } });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [retainedHolder({ worktree: "/wt/holder", branch: "fusion/rufu-test", baseCommitSha: "B" })],
      proof(prover),
    );
    expect(ids).toEqual(["RUFU-TEST"]);
  });

  it("excludes a dead/unregistered path whose branch ref is proven zero-commits-ahead (ref-only mode)", async () => {
    const { prover } = fakeProver({ "/wt/dead": { statusFails: true }, [ROOT]: { ahead: "0" } });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [retainedHolder({ worktree: "/wt/dead", branch: "fusion/rufu-test", baseCommitSha: "B" })],
      proof(prover),
    );
    expect(ids).toEqual([]);
  });

  it("per repository: one empty sub-repo does not release a mixed workspace card", async () => {
    const { prover } = fakeProver({
      "/wt/a": { status: "", ahead: "0" },
      "/wt/b": { status: "", ahead: "2" },
    });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [retainedHolder({
        branch: "fusion/rufu-test",
        workspaceWorktrees: {
          "packages/core": { worktreePath: "/wt/a", branch: "fusion/rufu-test-core" },
          "packages/engine": { worktreePath: "/wt/b", branch: "fusion/rufu-test-engine" },
        },
      })],
      proof(prover),
    );
    expect(ids).toEqual(["RUFU-TEST"]);
  });

  it("excludes a workspace card whose every retained repository is proven empty", async () => {
    const { prover } = fakeProver({
      "/wt/a": { status: "", ahead: "0" },
      "/wt/b": { status: "", ahead: "0" },
    });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [retainedHolder({
        branch: "fusion/rufu-test",
        workspaceWorktrees: {
          "packages/core": { worktreePath: "/wt/a", branch: "fusion/rufu-test-core" },
          "packages/engine": { worktreePath: "/wt/b", branch: "fusion/rufu-test-engine" },
        },
      })],
      proof(prover),
    );
    expect(ids).toEqual([]);
  });

  it("keeps today's exact counting when no proof is requested (legacy callers unchanged)", async () => {
    const clean = retainedHolder({ id: "CLEAN", worktree: "/wt/clean", branch: "fusion/a", baseCommitSha: "B" });
    const workspace = retainedHolder({
      id: "WS",
      branch: "fusion/b",
      workspaceWorktrees: { "packages/core": { worktreePath: "/wt/a", branch: "fusion/b-core" } },
    });
    const checkoutFree = retainedHolder({ id: "FREE" });
    const ids = await persistedWorktreeHolderTaskIdsFromStore(store, [clean, workspace, checkoutFree]);
    expect(ids).toEqual(["CLEAN", "WS"]);
  });

  it("proves once per prover instance (shared TTL cache, no re-fan-out on the next pass)", async () => {
    const { prover, calls } = fakeProver({ "/wt/clean": { status: "", ahead: "0" } });
    const task = retainedHolder({ worktree: "/wt/clean", branch: "fusion/rufu-test", baseCommitSha: "B" });
    await persistedWorktreeHolderTaskIdsFromStore(store, [task], proof(prover));
    const firstPass = calls.length;
    expect(firstPass).toBeGreaterThan(0);
    await persistedWorktreeHolderTaskIdsFromStore(store, [task], proof(prover));
    expect(calls.length).toBe(firstPass);
  });

  it("never runs git for checkout-free cards or already-terminal holders", async () => {
    const { prover, calls } = fakeProver({});
    const ids = await persistedWorktreeHolderTaskIdsFromStore(
      store,
      [
        retainedHolder({ id: "FREE" }),
        retainedHolder({ id: "DONE", column: "done", worktree: "/wt/done", branch: "fusion/done" }),
        retainedHolder({ id: "PAUSED", paused: true, worktree: "/wt/paused", branch: "fusion/paused" }),
      ],
      proof(prover),
    );
    expect(ids).toEqual([]);
    expect(calls).toEqual([]);
  });
});
