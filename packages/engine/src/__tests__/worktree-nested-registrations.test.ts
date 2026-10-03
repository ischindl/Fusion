import { describe, expect, it, vi } from "vitest";
import {
  classifyTempSweepRegistrations,
  findRegistrationsWithin,
  isNestedBelowScratchRoot,
  owningScratchEntry,
  removeDescendantRegistrations,
  sortRegistrationsDeepestFirst,
  type NestedRegistrationDecision,
} from "../worktree/worktree-nested-registrations.js";

/*
FNXC:TempWorktreeSweep 2026-10-02-15:39, relocated 2026-10-02-16:05 (RUFU-290):
The registration list from `git worktree list --porcelain` is the only thing that can see a worktree
nested inside a clean-room scratch tree, and it is also strictly wider than Fusion's scratch namespace.
This pins the authority boundary itself — what discovery may hand to the reaper, what it must leave
alone, and what it must report — independently of whether real git is installed on the runner, so the
containment rule stays covered even where the real-git suite skips.
 */
const CLEAN_ROOM = "/project/.fusion/worktrees/.ai-merge";
const TMP = "/private/tmp";

function classify(registered: string[], exists: (path: string) => boolean = () => true) {
  return classifyTempSweepRegistrations({
    registered,
    cleanRoomRoots: [CLEAN_ROOM],
    tmpRoot: TMP,
    pathExists: exists,
  });
}

describe("classifyTempSweepRegistrations", () => {
  it("claims a registration nested under the clean-room root even when it is not scratch-named", () => {
    const parent = `${CLEAN_ROOM}/fusion-ai-merge-fn-2510-abc123`;
    const nested = `${parent}/.fusion/worktrees/.ai-merge/probe-main`;
    const [parentResult, nestedResult] = classify([parent, nested]);

    expect(parentResult).toMatchObject({ kind: "candidate", entry: "fusion-ai-merge-fn-2510-abc123", authority: "clean-room-root", phantom: false });
    expect(nestedResult).toMatchObject({ kind: "candidate", entry: "probe-main", authority: "clean-room-root", phantom: false });
  });

  it("flags a registration whose directory is already gone as residue rather than a live tree", () => {
    const nested = `${CLEAN_ROOM}/fusion-ai-merge-fn-2510-abc123/.fusion/worktrees/.ai-merge/probe-main`;
    const [result] = classify([nested], () => false);

    expect(result).toMatchObject({ kind: "candidate", phantom: true });
  });

  it("never claims the clean-room container root itself", () => {
    const [root] = classify([CLEAN_ROOM]);

    expect(root?.kind).not.toBe("candidate");
  });

  it("claims only scratch-prefixed direct children of tmpdir, and reports the deeper ones", () => {
    const merge = `${TMP}/fusion-ai-merge-fn-1-x1`;
    const verify = `${TMP}/fn-verify-app-y2`;
    const unrelated = `${TMP}/someone-else-scratch`;
    const deep = `${TMP}/fusion-ai-merge-fn-1-x1/.fusion/worktrees/.ai-merge/probe-main`;
    const results = classify([merge, verify, unrelated, deep]);

    expect(results[0]?.kind).toBe("candidate");
    expect(results[1]).toMatchObject({ kind: "candidate", authority: "tmpdir" });
    // A tmpdir child that is not Fusion scratch is nobody's business but its owner's.
    expect(results[2]).toEqual({ kind: "unrelated", path: unrelated });
    // tmpdir authority stops at the direct child, so a nested tree there is reported, not reaped.
    expect(results[3]).toMatchObject({ kind: "outside-authority", path: deep });
  });

  it("leaves unrelated registrations untouched and reports scratch-shaped ones outside every authority", () => {
    const mainCheckout = "/project";
    const poolWorktree = "/project/.fusion/worktrees/fusion-fn-777-pool";
    const strayScratch = "/elsewhere/.fusion/worktrees/.ai-merge/fusion-ai-merge-fn-9-solo";
    const results = classify([mainCheckout, poolWorktree, strayScratch]);

    expect(results[0]).toEqual({ kind: "unrelated", path: mainCheckout });
    expect(results[1]).toEqual({ kind: "unrelated", path: poolWorktree });
    expect(results[2]).toMatchObject({ kind: "outside-authority", path: strayScratch });
  });
});

describe("nested ordering and containment helpers", () => {
  const scratchRoots = new Set([CLEAN_ROOM]);

  it("orders a parent clean-room directory after everything registered inside it", () => {
    const parent = `${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1`;
    const child = `${parent}/.fusion/worktrees/.ai-merge/probe`;
    const grandchild = `${child}/nested/.fusion/worktrees/.ai-merge/deeper`;

    expect(sortRegistrationsDeepestFirst([parent, grandchild, child])).toEqual([grandchild, child, parent]);
  });

  it("distinguishes a nested registration from a direct scratch child", () => {
    expect(isNestedBelowScratchRoot(`${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1`, scratchRoots)).toBe(false);
    expect(isNestedBelowScratchRoot(`${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1/.fusion/probe`, scratchRoots)).toBe(true);
    expect(owningScratchEntry(`${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1/.fusion/probe`, scratchRoots))
      .toBe(`${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1`);
    expect(owningScratchEntry(`${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1`, scratchRoots)).toBeNull();
  });

  it("discovers contained registrations deepest-first and fails closed when the inventory is unreadable", async () => {
    const parent = `${CLEAN_ROOM}/fusion-ai-merge-fn-1-x1`;
    const nested = `${parent}/.fusion/worktrees/.ai-merge/probe`;
    const listRegistrations = vi.fn(async () => ["/project", nested, parent, `${CLEAN_ROOM}/other-pool-worktree`]);

    expect(await findRegistrationsWithin("/project", [parent], { listRegistrations })).toEqual([nested]);

    const hostile = vi.fn(async () => {
      throw new Error("git worktree list failed");
    });
    expect(await findRegistrationsWithin("/project", [parent], { listRegistrations: hostile })).toEqual([]);
  });
});

describe("removeDescendantRegistrations", () => {
  const parent = `${CLEAN_ROOM}/fusion-ai-merge-fn-2510-abc123`;
  const deep = `${parent}/.fusion/worktrees/.ai-merge/probe-deep`;
  const held = `${parent}/.fusion/worktrees/.ai-merge/probe-held`;
  const young = `${parent}/.fusion/worktrees/.ai-merge/probe-young`;
  const gone = `${parent}/.fusion/worktrees/.ai-merge/probe-gone`;
  const ALL = [deep, held, young, gone];

  function harness(overrides: Partial<Parameters<typeof removeDescendantRegistrations>[0]> = {}) {
    const removals: string[] = [];
    const decisions: NestedRegistrationDecision[] = [];
    const events: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
    const result = removeDescendantRegistrations({
      rootDir: "/project",
      authority: "clean-room-root",
      descendants: ALL,
      isPathActive: (path) => path === held,
      ageGateMs: () => 60_000,
      now: 1_000_000,
      // Every candidate exists except `gone`, which is registration-only residue.
      pathExists: (path) => path !== gone,
      mtimeMs: (path) => (path === young ? 999_990 : 100),
      removeRegistration: async (path) => {
        removals.push(path);
      },
      auditHost: {
        recordRunAuditEvent: (event: { mutationType: string; metadata: Record<string, unknown> }) => {
          events.push({ mutationType: event.mutationType, metadata: event.metadata });
        },
      },
      onDecision: (decision) => {
        decisions.push(decision);
      },
      ...overrides,
    });
    return { result, removals, decisions, events };
  }

  it("reaps deepest-first, defers the exact live path, waits out a young entry, and calls residue for a phantom", async () => {
    const { result, removals, decisions, events } = harness();
    const settled = await result;

    expect(removals).toEqual([deep]);
    expect(settled).toMatchObject({ found: 4, removed: 1, failed: 0, deferred: 2, residue: [gone] });
    expect(decisions.find((decision) => decision.path === held)).toEqual({ path: held, outcome: "deferred", deferredReason: "active-session" });
    expect(decisions.find((decision) => decision.path === young)).toEqual({ path: young, outcome: "deferred", deferredReason: "young" });
    expect(decisions.find((decision) => decision.path === gone)).toEqual({ path: gone, outcome: "residue" });

    // Aggregate telemetry counts and fixed enums only — a path never reaches these two rows.
    const removedRow = events.find((event) => event.mutationType === "worktree:merge-temp-nested-removed");
    const deferredRow = events.find((event) => event.mutationType === "worktree:merge-temp-nested-deferred");
    expect(removedRow?.metadata).toEqual({ authority: "clean-room-root", foundCount: 4, removedCount: 1, failedCount: 0 });
    expect(deferredRow?.metadata).toEqual({ authority: "clean-room-root", deferredCount: 1, deferredReason: "active-session" });
    expect(JSON.stringify(events)).not.toContain("probe-");
  });

  it("removes a deeper registration before the clean-room directory containing it", async () => {
    const shallow = `${parent}/.fusion/worktrees/.ai-merge/probe-shallow`;
    const deeper = `${shallow}/nested/.fusion/worktrees/.ai-merge/probe-deeper`;
    const removals: string[] = [];
    const { result } = harness({
      descendants: [shallow, deeper],
      mtimeMs: () => 100,
      removeRegistration: async (path) => {
        removals.push(path);
      },
    });

    await result;
    expect(removals).toEqual([deeper, shallow]);
  });

  it("never attempts a git removal or a directory delete for a registration whose path is already gone", async () => {
    const removeRegistration = vi.fn(async () => {});
    const removeDirectory = vi.fn(async () => true);
    const { result } = harness({ descendants: [gone], removeRegistration, removeDirectory });

    expect((await result).residue).toEqual([gone]);
    expect(removeRegistration).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("defers a worktree a resumable CLI session can still pick up", async () => {
    const { result, removals } = harness({ isResumeReserved: (path) => path === deep });

    expect((await result).deferred).toBe(3);
    expect(removals).toEqual([]);
  });

  it("reports a git refusal instead of pretending the path is gone", async () => {
    const removeRegistration = vi.fn(async () => {
      throw new Error("fatal: 'probe-deep' is a worktree of a submodule");
    });
    const { result, events } = harness({ descendants: [deep], removeRegistration });
    const settled = await result;

    expect(settled).toMatchObject({ found: 1, removed: 0, failed: 1 });
    expect(settled.decisions[0]).toMatchObject({ path: deep, outcome: "failed" });
    expect(events.find((event) => event.mutationType === "worktree:merge-temp-nested-removed")?.metadata)
      .toMatchObject({ failedCount: 1, removedCount: 0 });
  });

  it("still reaps when the audit sink is hostile, because telemetry is not a lifecycle dependency", async () => {
    const hostileHost = {
      recordRunAuditEvent: () => {
        throw new Error("audit store down");
      },
    };
    const { result, removals } = harness({ auditHost: hostileHost });

    expect((await result).removed).toBe(1);
    expect(removals).toEqual([deep]);
  });

  it("treats the age gate as a floor the caller resolves per entry name", async () => {
    // `deep` is older than the default gate, so it is reaped; the same entry held to a longer
    // per-entry floor (a non-terminal task's 2h window) must instead wait for the next pass.
    const reap = harness({ descendants: [deep] });
    expect((await reap.result).removed).toBe(1);

    const wait = harness({ descendants: [deep], ageGateMs: (entry) => (entry === "probe-deep" ? 2 * 60 * 60_000 : 0) });
    expect((await wait.result).deferred).toBe(1);
    expect((await wait.result).removed).toBe(0);
  });

  it("treats a zero age gate as \"age is not a criterion\", not as a smuggled clock comparison", async () => {
    // The landing lane's disposability proof is the landing itself, so its gate is zero. Consulting mtime
    // anyway turned that lane's one clock read (`now`, captured before the loop) into a second, undocumented
    // gate — and because no other authority ever revisits a nested registration, one deferral leaked it
    // forever. Both shapes below are the same millisecond of risk: an unknown age, and a future one.
    const unmeasurable = harness({ descendants: [deep], ageGateMs: () => 0, mtimeMs: () => null });
    expect((await unmeasurable.result).deferred).toBe(0);
    expect(unmeasurable.removals).toEqual([deep]);

    const futureDated = harness({ descendants: [deep], ageGateMs: () => 0, mtimeMs: () => 2_000_000 });
    expect((await futureDated.result).deferred).toBe(0);
    expect(futureDated.removals).toEqual([deep]);

    // Any positive gate keeps the fail-closed reading: an unknown age is never permission to delete.
    const gated = harness({ descendants: [deep], ageGateMs: () => 60_000, mtimeMs: () => null });
    expect((await gated.result).deferred).toBe(1);
    expect(gated.removals).toEqual([]);
  });
});
