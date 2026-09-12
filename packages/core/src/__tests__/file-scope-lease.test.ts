import { describe, expect, it } from "vitest";
import {
  fileScopeLeaseBlocksCandidate,
  isSharedBarrelExportPath,
  isSharedBarrelOnlyMatch,
  normalizeOverlapScopeForTask,
  taskHoldsUnmergedCheckout,
  type CheckoutEmptinessProofMap,
  type CheckoutEmptinessVerdict,
  type FileScopeLeaseClassification,
  type Task,
} from "../index.js";
import {
  isSharedBarrelExportPath as isSharedBarrelExportPathGate,
  isSharedBarrelOnlyMatch as isSharedBarrelOnlyMatchGate,
} from "../index.gate.js";
import { classifyRepairFileScopeLease } from "../store.js";

const active: FileScopeLeaseClassification = { kind: "active", waivedForTaskIds: [] };
const none: FileScopeLeaseClassification = { kind: "none", waivedForTaskIds: [] };
const dormant: FileScopeLeaseClassification = { kind: "dormant", waivedForTaskIds: [] };

function task(id: string, priority: "low" | "normal" | "high" | "urgent" = "normal", createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, priority, createdAt };
}

describe("fileScopeLeaseBlocksCandidate", () => {
  it("does not let a lease block its own task", () => {
    const holder = task("FN-001");

    expect(fileScopeLeaseBlocksCandidate(holder, holder, active)).toBe(false);
  });

  it("honors targeted dependency waivers without releasing the lease to other work", () => {
    const holder = task("FN-001");
    const waived = task("FN-002");
    const unrelated = task("FN-003");
    const classification: FileScopeLeaseClassification = {
      kind: "active",
      waivedForTaskIds: [waived.id],
    };

    expect(fileScopeLeaseBlocksCandidate(holder, waived, classification)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(holder, unrelated, classification)).toBe(true);
  });

  it("orders dormant holders by priority, age, then numeric task id", () => {
    const candidate = task("FN-100", "normal", "2026-01-02T00:00:00.000Z");

    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "high"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "low"), candidate, dormant)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "normal", "2026-01-01T00:00:00.000Z"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-001", "normal", candidate.createdAt),
      task("FN-002", "normal", candidate.createdAt),
      dormant,
    )).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-002", "normal", candidate.createdAt),
      task("FN-001", "normal", candidate.createdAt),
      dormant,
    )).toBe(false);
  });

  it("never blocks when no lease exists", () => {
    expect(fileScopeLeaseBlocksCandidate(task("FN-001"), task("FN-002"), none)).toBe(false);
  });
});

describe("planning checkout evidence", () => {
  const lanes = {
    wip: new Set(["building"]),
    review: new Set(["reviewing"]),
    terminal: new Set(["shipped", "filed"]),
  };

  it("classifies a checkout-free planning card as no repair lease", () => {
    expect(classifyRepairFileScopeLease({ column: "drafting" }, lanes)).toBe("none");
  });

  it("keeps a replanned hold card with a retained checkout as a dormant repair lease", () => {
    expect(classifyRepairFileScopeLease({ column: "drafting", worktree: "/worktrees/FN-282" }, lanes)).toBe("dormant");
    expect(classifyRepairFileScopeLease({
      column: "drafting",
      workspaceWorktrees: { repo: { worktreePath: "/worktrees/FN-282/repo", branch: "fusion/fn-282" } },
    }, lanes)).toBe("dormant");
  });
});

describe("workspace checkout and overlap-scope helpers", () => {
  const workspaceTask = (workspaceWorktrees: unknown, worktree?: string) => ({
    worktree,
    workspaceWorktrees,
  }) as Pick<Task, "worktree" | "workspaceWorktrees">;

  it("keeps the singular checkout and scope behavior unchanged without workspace entries", () => {
    const singular = workspaceTask(undefined);
    const scope = ["src/b.ts", "src/a.ts"];

    expect(taskHoldsUnmergedCheckout(singular)).toBe(false);
    expect(normalizeOverlapScopeForTask(singular, scope)).toEqual(scope);
    expect(normalizeOverlapScopeForTask(workspaceTask(undefined, "/worktree"), scope)).toEqual(scope);
  });

  it("recognizes only non-empty workspace checkout paths", () => {
    expect(taskHoldsUnmergedCheckout(workspaceTask({ "repo-a": { worktreePath: "/worktrees/repo-a" } }))).toBe(true);
    expect(taskHoldsUnmergedCheckout(workspaceTask({ "repo-a": { worktreePath: "" } }))).toBe(false);
  });

  it("expands unprefixed workspace scope while preserving qualified and root declarations", () => {
    const task = workspaceTask({ "./repo-b": {}, "repo-a": {} });
    const scope = normalizeOverlapScopeForTask(task, ["repo-a/src/index.ts", "src/shared.ts", "repo-b"]);

    expect(scope).toEqual([
      "repo-a/src/index.ts",
      "repo-a/src/shared.ts",
      "repo-b",
      "repo-b/src/shared.ts",
      "src/shared.ts",
    ]);
    expect(normalizeOverlapScopeForTask(task, scope)).toEqual(scope);
  });
});

/*
FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
A retained checkout is a lease holder only while it has something to preserve. These cases pin the
one contract the scheduler's dormant branch and the dispatch-gate holder side depend on: the proof is
DOWNGRADE-ONLY. `empty` is the single verdict that can release a lease; `occupied`, `unknown`, and a
missing map entry must all keep the pre-RUFU-200 answer, because guessing `empty` wrongly is what
would destroy uncommitted work.
*/
describe("checkout-emptiness proof input (RUFU-200)", () => {
  const singularTask = (worktree = "/worktrees/RUFU-198") =>
    ({ worktree, workspaceWorktrees: undefined }) as Pick<Task, "worktree" | "workspaceWorktrees">;
  const proof = (entries: Array<[string, CheckoutEmptinessVerdict]>): CheckoutEmptinessProofMap =>
    new Map<string, CheckoutEmptinessVerdict>(entries);

  it("stays byte-for-byte on the path-presence answer when no proof is supplied", () => {
    expect(taskHoldsUnmergedCheckout(singularTask())).toBe(true);
    expect(taskHoldsUnmergedCheckout(singularTask("   "))).toBe(false);
    expect(taskHoldsUnmergedCheckout(singularTask(""))).toBe(false);
  });

  it("releases the singular checkout only on a proven-empty verdict", () => {
    expect(taskHoldsUnmergedCheckout(singularTask(), proof([["", "empty"]]))).toBe(false);
    expect(taskHoldsUnmergedCheckout(singularTask(), proof([["", "occupied"]]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(singularTask(), proof([["", "unknown"]]))).toBe(true);
  });

  it("treats a missing proof entry as unknown rather than empty (fail-closed)", () => {
    expect(taskHoldsUnmergedCheckout(singularTask(), proof([]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(singularTask(), proof([["other-repo", "empty"]]))).toBe(true);
  });

  it("keeps a checkout-free task lease-free even when a proof is supplied", () => {
    expect(taskHoldsUnmergedCheckout(singularTask(""), proof([["", "occupied"]]))).toBe(false);
  });

  it("proves emptiness per repository, never all-or-nothing", () => {
    const workspace = {
      "packages/core": { worktreePath: "/wt/RUFU-198/packages/core", branch: "fusion/rufu-198" },
      "packages/engine": { worktreePath: "/wt/RUFU-198/packages/engine", branch: "fusion/rufu-198" },
    } as unknown as Task["workspaceWorktrees"];
    const task = { worktree: undefined, workspaceWorktrees: workspace } as Pick<Task, "worktree" | "workspaceWorktrees">;

    expect(taskHoldsUnmergedCheckout(task, proof([
      ["packages/core", "empty"],
      ["packages/engine", "empty"],
    ]))).toBe(false);
    expect(taskHoldsUnmergedCheckout(task, proof([
      ["packages/core", "empty"],
      ["packages/engine", "occupied"],
    ]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(task, proof([["packages/core", "empty"]]))).toBe(true);
  });

  it("requires every entry of a task holding both a singular and workspace checkouts to be empty", () => {
    const task = {
      worktree: "/wt/RUFU-198",
      workspaceWorktrees: { "packages/engine": { worktreePath: "/wt/RUFU-198/packages/engine" } },
    } as unknown as Pick<Task, "worktree" | "workspaceWorktrees">;

    expect(taskHoldsUnmergedCheckout(task, proof([["", "empty"], ["packages/engine", "empty"]]))).toBe(false);
    expect(taskHoldsUnmergedCheckout(task, proof([["", "empty"], ["packages/engine", "unknown"]]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(task, proof([["", "occupied"], ["packages/engine", "empty"]]))).toBe(true);
  });

  it("ignores an empty-path workspace entry so a stale row cannot block on a proof", () => {
    const task = {
      worktree: undefined,
      workspaceWorktrees: { "packages/core": { worktreePath: "" } },
    } as unknown as Pick<Task, "worktree" | "workspaceWorktrees">;

    expect(taskHoldsUnmergedCheckout(task)).toBe(false);
    expect(taskHoldsUnmergedCheckout(task, proof([["packages/core", "occupied"]]))).toBe(false);
  });

  /*
  FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
  The store's repair classifier deliberately does NOT take a proof. It runs inside an overlap-repair
  store transaction (store.ts:3229/:3402), and AGENTS.md permits synchronous shellout only for short
  git plumbing outside a write path — a transaction must never wait on git. So repair keeps the
  path-based, fail-closed answer: it can retain a lease on a checkout that admission would release,
  which costs one extra scheduling pass, never anybody's work. This assertion pins that asymmetry so
  it is not later "harmonized" by moving git I/O into the store.
  */
  it("keeps the store repair classifier path-based so no git runs inside a repair transaction", () => {
    const lanes = {
      wip: new Set(["building"]),
      review: new Set(["reviewing"]),
      terminal: new Set(["shipped", "filed"]),
    };

    expect(classifyRepairFileScopeLease({ column: "drafting", worktree: "/wt/RUFU-198" }, lanes)).toBe("dormant");
    expect(classifyRepairFileScopeLease({ column: "reviewing", worktree: "/wt/RUFU-198" }, lanes)).toBe("active");
    expect(classifyRepairFileScopeLease({ column: "drafting" }, lanes)).toBe("none");
  });
});

/*
FNXC:OverlapScheduling 2026-09-11-22:49:
The shared-barrel exemption suppresses a queue-safety mechanism, so the pattern's breadth is the
risk. This block pins the accepted shapes (canonical package barrels, optionally workspace-prefixed)
and every rejected shape (bare/glob/nested/extension-variant paths) so a widening edit fails here
before it can silently serialize or silently waive real collisions.
*/
describe("shared barrel export exemption predicate", () => {
  it("recognizes canonical package barrel export paths only", () => {
    for (const path of [
      "packages/core/src/index.ts",
      "packages/core/src/index.gate.ts",
      "./packages/core/src/index.ts",
      "packages/engine/src/index.ts",
      "repo-a/packages/core/src/index.ts",
    ]) {
      expect(isSharedBarrelExportPath(path)).toBe(true);
    }
    for (const path of [
      "src/index.ts",
      "repo-a/src/index.ts",
      "packages/core/src/index.tsx",
      "packages/core/src/routes/index.ts",
      "packages/core/src/index.d.ts",
      "packages/core/*",
      "packages/core/",
      "",
    ]) {
      expect(isSharedBarrelExportPath(path)).toBe(false);
    }
  });

  it("exempts only an identical concrete barrel pair, never a glob or a different path", () => {
    expect(isSharedBarrelOnlyMatch("packages/core/src/index.ts", "packages/core/src/index.ts")).toBe(true);
    expect(isSharedBarrelOnlyMatch("./packages/core/src/index.ts", "packages/core/src/index.ts")).toBe(true);
    expect(isSharedBarrelOnlyMatch("packages/core/src/index.ts", "./packages/core/src/index.ts")).toBe(true);
    expect(isSharedBarrelOnlyMatch("packages/core/*", "packages/core/src/index.ts")).toBe(false);
    expect(isSharedBarrelOnlyMatch("packages/core/src/index.ts", "packages/core/*")).toBe(false);
    expect(isSharedBarrelOnlyMatch("packages/core/", "packages/core/src/index.ts")).toBe(false);
    expect(isSharedBarrelOnlyMatch("packages/core/src/index.ts", "packages/engine/src/index.ts")).toBe(false);
    expect(isSharedBarrelOnlyMatch("packages/core/src/store.ts", "packages/core/src/store.ts")).toBe(false);
    expect(isSharedBarrelOnlyMatch("repo-a/src/index.ts", "repo-a/src/index.ts")).toBe(false);
    expect(isSharedBarrelOnlyMatch("src/index.ts", "src/index.ts")).toBe(false);
  });

  it("exposes the predicate from BOTH barrels (index + index.gate stay in sync)", () => {
    // The engine-core vitest project resolves @fusion/core through index.gate.ts, so a
    // gate-barrel omission TypeErrors in the merge gate. Both barrels must resolve the same
    // functions and agree on the fixture verdicts.
    expect(typeof isSharedBarrelExportPath).toBe("function");
    expect(typeof isSharedBarrelOnlyMatch).toBe("function");
    expect(isSharedBarrelExportPathGate).toBe(isSharedBarrelExportPath);
    expect(isSharedBarrelOnlyMatchGate).toBe(isSharedBarrelOnlyMatch);
    expect(isSharedBarrelExportPathGate("packages/core/src/index.ts")).toBe(true);
    expect(isSharedBarrelOnlyMatchGate("packages/core/src/index.ts", "packages/core/src/index.ts")).toBe(true);
    expect(isSharedBarrelOnlyMatchGate("packages/core/*", "packages/core/src/index.ts")).toBe(false);
  });
});
