import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cardWorkspaceReleasable,
  findCardOwningArtifact,
  gateCardOwnedRemoval,
} from "../worktree/card-ownership.js";
import { RemovalReason, scanIdleWorktrees } from "../worktree/worktree-pool.js";

/*
STAS-273: a self-healing sweep proved a task branch was "already landed" by ancestry against the
project's local trunk — which was sitting on that card's own unmerged tip — and destroyed the checkout
and branch of a card that was still in `todo`, four times in eight hours. Ancestry is not ownership.
These tests pin the replacement rule: the card that names a workspace decides whether it may go, and a
card that has not reached a release lane keeps its workspace even when its recorded pointers have
drifted to null.
*/

function card(overrides: Record<string, unknown>) {
  return { id: "STAS-265", column: "todo", branch: "fusion/stas-265", worktree: null, ...overrides };
}

function fakeStore(rows: Array<Record<string, unknown>> = []) {
  const auditEvents: Array<Record<string, unknown>> = [];
  const entries: string[] = [];
  return {
    auditEvents,
    entries,
    listTasks: vi.fn(async () => rows),
    recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
      auditEvents.push(event);
    }),
    logEntry: vi.fn(async (_taskId: string, message: string) => {
      entries.push(message);
    }),
    getSettings: vi.fn(async () => ({})),
  } as never;
}

function auditorFor(store: ReturnType<typeof fakeStore>) {
  return {
    git: async (input: { type: string; target: string; metadata?: Record<string, unknown> }) => {
      await store.recordRunAuditEvent({
        domain: "git",
        mutationType: input.type,
        target: input.target,
        metadata: input.metadata,
      });
    },
    database: async () => {},
    runtime: async () => {},
    step: async () => {},
    endRun: async () => {},
  } as never;
}

describe("findCardOwningArtifact", () => {
  it("matches a checkout directory by card name even when its pointers drifted to null", () => {
    const drifted = card({ worktree: null, branch: null });
    const owner = findCardOwningArtifact([drifted], {
      worktreePath: "/home/dev/project/.fusion/worktrees/stas-265",
    });
    expect(owner?.id).toBe("STAS-265");
  });

  it("matches a branch by its canonical card name without trusting task metadata", () => {
    const owner = findCardOwningArtifact([card({ branch: null })], {
      branch: "fusion/stas-265",
    });
    expect(owner?.id).toBe("STAS-265");
  });

  it("claims nothing for a directory that names no card", () => {
    expect(findCardOwningArtifact([card({})], { worktreePath: "/tmp/scratch-checkout" })).toBeNull();
  });
});

describe("cardWorkspaceReleasable", () => {
  it("refuses a card still in a work lane", async () => {
    const store = fakeStore();
    expect(await cardWorkspaceReleasable(store, card({ column: "todo" }))).toBe(false);
    expect(await cardWorkspaceReleasable(store, card({ column: "in-progress" }))).toBe(false);
  });

  it("releases a card whose workflow marks the lane complete", async () => {
    const store = fakeStore();
    expect(await cardWorkspaceReleasable(store, card({ column: "done" }))).toBe(true);
    expect(await cardWorkspaceReleasable(store, card({ column: "any", archived: true }))).toBe(true);
  });
});

describe("gateCardOwnedRemoval", () => {
  it("refuses the destruction and records preservation without touching the card log", async () => {
    const store = fakeStore([card({ column: "todo" })]);
    const outcome = await gateCardOwnedRemoval({
      store,
      tasks: [card({ column: "todo" })],
      artifact: { worktreePath: "/srv/project/.fusion/worktrees/stas-265", branch: "fusion/stas-265" },
      reason: RemovalReason.SelfHealingBranchConflict,
      triggeredBy: "self-healing.sweepGhostConflict",
      audit: auditorFor(store),
    });

    expect(outcome.refuse).toBe(true);
    expect(outcome.taskId).toBe("STAS-265");
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      domain: "git",
      mutationType: "worktree:removal-preserved",
      target: "/srv/project/.fusion/worktrees/stas-265",
    });
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("allows a release-lane removal and names the card, lane, reason, and code path", async () => {
    const store = fakeStore([card({ column: "done" })]);
    const outcome = await gateCardOwnedRemoval({
      store,
      tasks: [card({ column: "done" })],
      artifact: { worktreePath: "/srv/project/.fusion/worktrees/stas-265", branch: "fusion/stas-265" },
      reason: RemovalReason.SelfHealingBranchConflict,
      triggeredBy: "self-healing.sweepGhostConflict",
      audit: auditorFor(store),
    });

    expect(outcome.refuse).toBe(false);
    expect(store.auditEvents[0]).toMatchObject({ mutationType: "worktree:removed-card-owned" });
    expect(store.auditEvents[0].metadata).toMatchObject({
      taskId: "STAS-265",
      lane: "done",
      reason: "self-healing-branch-conflict",
      triggeredBy: "self-healing.sweepGhostConflict",
    });
    expect(store.entries.join("\n")).toContain("lane=done");
    expect(store.entries.join("\n")).toContain("reason=self-healing-branch-conflict");
  });

  it("leaves a workspace that names no card alone to its own lifecycle", async () => {
    const store = fakeStore([card({})]);
    const outcome = await gateCardOwnedRemoval({
      store,
      tasks: [card({})],
      artifact: { worktreePath: "/srv/project/.fusion/worktrees/merge-target" },
      reason: RemovalReason.PoolPrune,
      triggeredBy: "worktree-pool.cleanupOrphanedWorktrees",
    });
    expect(outcome).toEqual({ refuse: false });
    expect(store.auditEvents).toHaveLength(0);
  });
});

describe("scanIdleWorktrees card-name protection", () => {
  it("never treats a non-terminal card's checkout as idle when its metadata drifted", async () => {
    // Registered checkouts are what the idle sweep prunes, so this uses a real git repo and real
    // worktrees: the card rows deliberately carry no pointer, which is the drift that made the
    // incident sweep see a live card's directory as reclaimable.
    const root = mkdtempSync(join(tmpdir(), `stas273-idle-${process.pid}-`));
    const git = (args: string) => execSync(`git ${args}`, { cwd: root, stdio: "pipe" });
    git("init -q -b main");
    git("config user.email t@example.com && git config user.name t");
    writeFileSync(join(root, "seed.txt"), "seed\n");
    git("add -A && git commit -qm seed");
    const worktreesDir = join(root, ".fusion", "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    git(`worktree add -q --detach ${JSON.stringify(join(worktreesDir, "stas-265"))}`);
    git(`worktree add -q --detach ${JSON.stringify(join(worktreesDir, "stas-001"))}`);

    const store = fakeStore([
      card({ id: "STAS-265", column: "todo", worktree: null, branch: null }),
      card({ id: "STAS-001", column: "done", worktree: null, branch: null }),
    ]);

    try {
      const idleNames = (await scanIdleWorktrees(root, store, {})).map((dir) => dir.split("/").pop());
      expect(idleNames).toContain("stas-001");
      expect(idleNames).not.toContain("stas-265");
      expect(readdirSync(worktreesDir)).toEqual(expect.arrayContaining(["stas-265", "stas-001"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
