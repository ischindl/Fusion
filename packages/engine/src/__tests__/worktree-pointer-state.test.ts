/*
 * Surface enumeration (docs/testing.md → Surface Enumeration checklist): this file covers the pure
 * classifier, its one bounded git read, and the subprocess budget. The board faces that consume a verdict
 * are covered in `worktree-pointer-symptom.test.ts` (the new sweep) and
 * `worktree-metadata-reconcile.test.ts` (the hardened rebind arm); no desktop or mobile surface applies to
 * a recovery classifier.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:42 (RUFU-1054):
 * Every data state the card enumerates is asserted here with its exact `state`, `code`, and (where the
 * verdict carries one) `adoptPath`, including the states no repair exists for. A classifier whose `unknown`
 * arms are untested is a classifier whose refusals nobody has ever seen, and this module's whole contract
 * is refusing when it cannot prove which side of the row/git pair is wrong.
 *
 * The `stale-pointer` and adopt cases run against a REAL repository rather than a stubbed listing on
 * purpose. `describeRegisteredWorktrees` swallowing its own failure into an empty list is the defect this
 * module closes, so a mocked reader could not show what git actually reports for a directory deleted
 * underneath a registration — measured in this card's preflight: after `rm -rf <worktree>` with the
 * `.git/worktrees/<name>` admin record intact, `git worktree list --porcelain` still prints the path and
 * marks it `prunable`. That line is why the reader drops prunable entries, and it is asserted below rather
 * than assumed, because the state-B repair for the exact reproduction the card names depends on it.
 *
 * Invariants pinned here:
 * - `unknown` always carries a code from the closed set and never a path, branch, or reason string;
 * - an unreadable registry is `unknown/registry-unreadable`, NEVER `stale-pointer` — the empty-map collapse
 *   that let a healthy pointer look stale is unreachable by construction, and the contrast case (a registry
 *   read successfully that lists nothing) is asserted to still be `stale-pointer` so the two cannot be
 *   conflated by a future refactor;
 * - one collector reads the registry at most once for any number of rows;
 * - the classifier removes nothing: the tree still exists after every verdict.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyTaskWorktreeState,
  createWorktreePointerFactsCollector,
  readWorktreeRegistrations,
  type WorktreePointerFacts,
  type WorktreePointerRefusalCode,
  type WorktreeRegistration,
} from "../worktree/worktree-pointer-state.js";

const REFUSAL_CODES = new Set<WorktreePointerRefusalCode>([
  "registry-unreadable",
  "registered-other-branch",
  "registration-ambiguous",
  "shape-incomplete",
  "outside-work-tree",
  "adopt-path-not-canonical",
  "pointer-absent",
  "workspace-task",
  "no-branch",
]);

const registryOf = (...entries: WorktreeRegistration[]): WorktreePointerFacts => ({
  registry: { status: "ok", entries },
});

const identity = (p: string): string => p;

// ── The pure verdict table ──────────────────────────────────────────────────────

describe("classifyTaskWorktreeState — the verdict table", () => {
  it("reports consistent when the pointer is live and registered for this branch", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/card", branch: "fusion/card" }), exists: () => true, canonical: identity },
    )).toEqual({ state: "consistent" });
  });

  it("reports consistent through a symlinked worktrees root, the FN-5256 false-stale this module must not repeat", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/linked/card", branch: "fusion/card" },
      {
        ...registryOf({ worktreePath: "/linked/card", branch: "fusion/card" }),
        // Only the canonical target is on disk; `existsSync(raw)` alone is the read that lied in FN-5256.
        exists: (p) => p === "/real/card",
        canonical: () => "/real/card",
      },
    )).toEqual({ state: "consistent" });
  });

  it("reports stale-pointer for a dead directory with no registration at it and none for the branch", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/other", branch: "fusion/other" }), exists: () => false, canonical: identity },
    )).toEqual({ state: "stale-pointer" });
  });

  it("adopts exactly one live tree the row never claimed, carrying git's own path as adoptPath", () => {
    expect(classifyTaskWorktreeState(
      { worktree: null, branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/live", branch: "fusion/card" }), exists: () => false, canonical: identity },
    )).toEqual({ state: "unclaimed-live-tree", adoptPath: "/trees/live" });
  });

  it("adopts from a dead pointer too, so the rebind arm's existing behaviour survives integration", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/gone", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/live", branch: "fusion/card" }), exists: () => false, canonical: identity },
    )).toEqual({ state: "unclaimed-live-tree", adoptPath: "/trees/live" });
  });

  it("refuses registered-other-branch when the pointer is a live checkout of a different branch", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/foreign", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/foreign", branch: "fusion/somebody-else" }), exists: () => true, canonical: identity },
    )).toEqual({ state: "unknown", code: "registered-other-branch" });
  });

  it("refuses outside-work-tree for a live directory git does not register at all", () => {
    // The shape the old predicate called stale and cleared `worktree` AND `branch` over. Acquisition's
    // contained pinned reclaim owns it; a read-only sweep must not.
    expect(classifyTaskWorktreeState(
      { worktree: "/somewhere/else", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/other", branch: "fusion/other" }), exists: () => true, canonical: identity },
    )).toEqual({ state: "unknown", code: "outside-work-tree" });
  });

  it("refuses registration-ambiguous rather than guess which of two live trees is this card's", () => {
    expect(classifyTaskWorktreeState(
      { worktree: null, branch: "fusion/card" },
      {
        ...registryOf(
          { worktreePath: "/trees/a", branch: "fusion/card" },
          { worktreePath: "/trees/b", branch: "fusion/card" },
        ),
        exists: () => false,
        canonical: identity,
      },
    )).toEqual({ state: "unknown", code: "registration-ambiguous" });
  });

  it("refuses shape-incomplete when the directory is gone but git still lists the path as this branch's live checkout", () => {
    // Only `git worktree prune` speaks to a dead record, and the card forbids using it as this remedy.
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/card", branch: "fusion/card" }), exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "shape-incomplete" });
  });

  it("refuses registered-other-branch when the dead pointer's path is another card's registration", () => {
    // The card's own data state: clearing here would orphan the other card's recovery.
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/foreign", branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/foreign", branch: "fusion/somebody-else" }), exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "registered-other-branch" });
  });

  it("refuses adopt-path-not-canonical rather than name a path that is not its own canonical form", () => {
    expect(classifyTaskWorktreeState(
      { worktree: null, branch: "fusion/card" },
      {
        ...registryOf({ worktreePath: "/linked/card", branch: "fusion/card" }),
        exists: () => true,
        canonical: (p) => (p === "/linked/card" ? "/real/card" : p),
      },
    )).toEqual({ state: "unknown", code: "adopt-path-not-canonical" });
  });

  it("refuses registry-unreadable and NEVER reads it as stale-pointer", () => {
    const verdict = classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "fusion/card" },
      { registry: { status: "unreadable" }, exists: () => false, canonical: identity },
    );
    expect(verdict).toEqual({ state: "unknown", code: "registry-unreadable" });
    // The contrast case that makes the distinction real: a registry that WAS read and lists nothing is
    // still state B. Conflating the two is the defect this type exists to prevent.
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "fusion/card" },
      { ...registryOf(), exists: () => false, canonical: identity },
    )).toEqual({ state: "stale-pointer" });
  });

  it("refuses pointer-absent when neither side claims a checkout, so there is no disagreement to repair", () => {
    expect(classifyTaskWorktreeState(
      { worktree: null, branch: "fusion/card" },
      { ...registryOf({ worktreePath: "/trees/other", branch: "fusion/other" }), exists: () => true, canonical: identity },
    )).toEqual({ state: "unknown", code: "pointer-absent" });
  });

  it("refuses no-branch, because without the branch nothing can prove the pointer wrong", () => {
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/card", branch: "  " },
      { ...registryOf(), exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "no-branch" });
  });

  it("refuses a workspace card from both the context shape and the workspaceWorktrees shape", () => {
    const registry = registryOf({ worktreePath: "/trees/live", branch: "fusion/card" });
    expect(classifyTaskWorktreeState(
      {
        worktree: "/trees/gone",
        branch: "fusion/card",
        workspaceWorktrees: { workspaceId: "ws-1", repos: [{ repoPath: "a", worktreePath: "/trees/gone" }] },
      },
      { ...registry, exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "workspace-task" });

    expect(classifyTaskWorktreeState(
      { worktree: "/trees/gone", branch: "fusion/card", workspaceWorktrees: ["/trees/a", "/trees/b"] as never },
      { ...registry, exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "workspace-task" });

    // A half-materialised row: `isWorkspaceTask` reads only `workspaceWorktrees`, so the id alone is the
    // other shape a multi-repo card arrives as.
    expect(classifyTaskWorktreeState(
      { worktree: "/trees/gone", branch: "fusion/card", workspaceId: "ws-9" },
      { ...registry, exists: () => false, canonical: identity },
    )).toEqual({ state: "unknown", code: "workspace-task" });
  });

  it("keeps `unknown` diagnosable and leak-free: every refusal names a code and nothing else", () => {
    const rows = [
      { worktree: "/trees/card", branch: "" },
      { worktree: "/trees/card", branch: "fusion/card" },
      { worktree: null, branch: "fusion/card" },
      { worktree: "/trees/card", branch: "fusion/card", workspaceWorktrees: [] },
    ];
    const registries: WorktreePointerFacts[] = [
      { registry: { status: "unreadable" } },
      registryOf({ worktreePath: "/trees/card", branch: "fusion/other" }),
      registryOf({ worktreePath: "/trees/a", branch: "fusion/card" }, { worktreePath: "/trees/b", branch: "fusion/card" }),
      registryOf(),
    ];
    for (const facts of registries) {
      for (const row of rows) {
        const verdict = classifyTaskWorktreeState(row, { ...facts, exists: () => true, canonical: identity });
        const keys = Object.keys(verdict).sort();
        if (verdict.state === "unknown") {
          expect(REFUSAL_CODES.has(verdict.code as WorktreePointerRefusalCode)).toBe(true);
          expect(keys).toEqual(["code", "state"]);
        } else if (verdict.state === "unclaimed-live-tree") {
          expect(keys).toEqual(["adoptPath", "state"]);
          expect(typeof verdict.adoptPath).toBe("string");
        } else {
          expect(keys).toEqual(["state"]);
        }
      }
    }
  });

  it("never mutates its inputs — the classifier reports, the pass writes", () => {
    const row = { worktree: "/trees/card", branch: "fusion/card" };
    classifyTaskWorktreeState(row, { ...registryOf(), exists: () => false, canonical: identity });
    expect(row).toEqual({ worktree: "/trees/card", branch: "fusion/card" });
  });
});

// ── The bounded registry read, against real git ─────────────────────────────────

const git = (cwd: string, argv: string) =>
  execSync(`git ${argv}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const tracked: string[] = [];
function repoFixture(): { repoDir: string; cardPath: string; branch: string } {
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "rufu-1054-pointer-")));
  git(repoDir, "init -q -b main");
  git(repoDir, "config user.email pointer@example.invalid");
  git(repoDir, "config user.name Pointer");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git(repoDir, "add -A");
  git(repoDir, 'commit -q -m "chore: seed"');
  mkdirSync(join(repoDir, ".fusion", "worktrees"), { recursive: true });
  tracked.push(repoDir);
  return { repoDir, cardPath: join(repoDir, ".fusion", "worktrees", "rufu-1054x"), branch: "fusion/rufu-1054x" };
}

describe("readWorktreeRegistrations / classifyTaskWorktreeState — against real git", () => {
  it("reads a live registration and calls the row consistent", async () => {
    const f = repoFixture();
    git(f.repoDir, `worktree add -q -b ${f.branch} "${f.cardPath}" HEAD`);

    const read = await readWorktreeRegistrations(f.repoDir);
    expect(read.status).toBe("ok");
    const entries = read.status === "ok" ? read.entries : [];
    expect(entries).toContainEqual({ worktreePath: f.cardPath, branch: f.branch });
    expect(entries.some((entry) => entry.branch === "main")).toBe(true);

    expect(classifyTaskWorktreeState({ worktree: f.cardPath, branch: f.branch }, { registry: read }))
      .toEqual({ state: "consistent" });
  });

  it("proves stale-pointer from a real `rm -rf` that leaves the registration and admin entry intact", async () => {
    const f = repoFixture();
    git(f.repoDir, `worktree add -q -b ${f.branch} "${f.cardPath}" HEAD`);
    rmSync(f.cardPath, { recursive: true, force: true });

    // The preflight measurement, asserted rather than assumed: git still prints the path, marked prunable,
    // because `.git/worktrees/<name>` survived the directory.
    expect(git(f.repoDir, "worktree list --porcelain")).toContain("prunable");
    expect(existsSync(join(f.repoDir, ".git", "worktrees", "rufu-1054x"))).toBe(true);

    const read = await readWorktreeRegistrations(f.repoDir);
    const entries = read.status === "ok" ? read.entries : [];
    expect(entries.some((entry) => entry.worktreePath === f.cardPath)).toBe(false);
    expect(classifyTaskWorktreeState({ worktree: f.cardPath, branch: f.branch }, { registry: read }))
      .toEqual({ state: "stale-pointer" });
  });

  it("proves unclaimed-live-tree from a real checkout the row never claimed, adopting git's own path", async () => {
    const f = repoFixture();
    git(f.repoDir, `worktree add -q -b ${f.branch} "${f.cardPath}" HEAD`);
    const read = await readWorktreeRegistrations(f.repoDir);

    expect(classifyTaskWorktreeState({ worktree: null, branch: f.branch }, { registry: read }))
      .toEqual({ state: "unclaimed-live-tree", adoptPath: f.cardPath });
    // Nothing was removed while deciding that.
    expect(existsSync(f.cardPath)).toBe(true);
  });

  it("answers unreadable for a directory that is not a repository, instead of an empty list", async () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "rufu-1054-notrepo-")));
    tracked.push(notARepo);
    expect(await readWorktreeRegistrations(notARepo)).toEqual({ status: "unreadable" });
  });

  it("reads the registry at most once per collector however many rows it classifies", async () => {
    const f = repoFixture();
    git(f.repoDir, `worktree add -q -b ${f.branch} "${f.cardPath}" HEAD`);
    const collector = createWorktreePointerFactsCollector(f.repoDir);
    expect(collector.reads()).toBe(0);

    const facts = await collector.facts();
    for (const row of [
      { worktree: f.cardPath, branch: f.branch },
      { worktree: join(f.repoDir, "gone"), branch: f.branch },
      { worktree: null, branch: f.branch },
    ]) {
      classifyTaskWorktreeState(row, facts);
    }
    await collector.facts();
    expect(collector.reads()).toBe(1);
  });

  it("treats a throwing reader as an unreadable registry, never as an empty one", async () => {
    const collector = createWorktreePointerFactsCollector("/nonexistent", async () => {
      throw new Error("git exploded");
    });
    const facts = await collector.facts();
    expect(facts.registry).toEqual({ status: "unreadable" });
    expect(classifyTaskWorktreeState({ worktree: "/x", branch: "fusion/x" }, facts))
      .toEqual({ state: "unknown", code: "registry-unreadable" });
  });
});

afterAll(() => {
  for (const dir of tracked) rmSync(dir, { recursive: true, force: true });
});
