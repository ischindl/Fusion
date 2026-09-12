/*
FNXC:OrphanedGitChildren 2026-09-12-09:20 (RUFU-210):
Coverage for the bounded orphaned-git-child reaper. The predicate matrix enumerates every clause
(comm, reparent, ownership, age floor, deleted-cwd-in-worktrees-root) with its own exclusion; the
reaper tests SIGTERM→SIGKILL escalation, the per-sweep signal budget, and `/proc` unavailability;
the probe parser runs against a temp fixture procRoot (one-level writes only — never a recursive
walk of the OS temp root) proving comm/stat/uid/cwd parsing and both deletion-evidence sources.
No test here touches a real process table.
*/
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORPHANED_GIT_CHILD_GRACE_FLOOR_MS,
  createProcfsGitChildProbe,
  isReapableOrphan,
  reapOrphanedGitChildren,
  worktreePathForCwd,
  type GitChildProcessProbe,
  type OrphanedGitChildCandidate,
} from "../util/orphaned-git-child-reaper.js";

const WORKTREES_DIRS = ["/project/.fusion/worktrees"];

function candidate(overrides: Partial<OrphanedGitChildCandidate> = {}): OrphanedGitChildCandidate {
  return {
    pid: 41001,
    ppid: 1,
    comm: "git",
    ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS + 60_000,
    cwd: "/project/.fusion/worktrees/FN-TEST/repo",
    cwdMissing: true,
    cwdMissingSource: "path-gone",
    ownedBySelf: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<Parameters<typeof isReapableOrphan>[1]> = {}) {
  return { worktreesDirs: WORKTREES_DIRS, ...overrides };
}

describe("isReapableOrphan — every clause required", () => {
  it("accepts a fully-proved orphan (reparented to init)", () => {
    expect(isReapableOrphan(candidate(), ctx())).toBe(true);
  });

  it("accepts reparenting to a systemd supervisor (non-1 ppid)", () => {
    expect(isReapableOrphan(candidate({ ppid: 999, parentComm: "systemd" }), ctx())).toBe(true);
  });

  it("rejects a child whose parent is still a live non-systemd process", () => {
    expect(isReapableOrphan(candidate({ ppid: 2222, parentComm: "node" }), ctx())).toBe(false);
  });

  it("rejects unknown parent identity (ppid != 1, parentComm unreadable)", () => {
    expect(isReapableOrphan(candidate({ ppid: 2222 }), ctx())).toBe(false);
  });

  it("rejects non-git comm (the spawner shell stays running; only git children are reaped)", () => {
    expect(isReapableOrphan(candidate({ comm: "bash" }), ctx())).toBe(false);
    expect(isReapableOrphan(candidate({ comm: "git-core" }), ctx())).toBe(false);
  });

  it("rejects a candidate whose cwd still exists on disk", () => {
    expect(isReapableOrphan(candidate({ cwdMissing: false, cwdMissingSource: undefined }), ctx())).toBe(false);
  });

  it("rejects a foreign-uid candidate", () => {
    expect(isReapableOrphan(candidate({ ownedBySelf: false }), ctx())).toBe(false);
  });

  it("rejects under-age and accepts exactly-at-floor ages", () => {
    expect(isReapableOrphan(candidate({ ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS - 1 }), ctx())).toBe(false);
    expect(isReapableOrphan(candidate({ ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS }), ctx())).toBe(true);
  });

  it("clamps a configured graceMs up to the exported floor", () => {
    expect(isReapableOrphan(candidate({ ageMs: 1_000 }), ctx({ graceMs: 10 })), "floor is a clamp, not a tunable").toBe(false);
  });

  it("rejects a deleted cwd outside every configured worktrees root", () => {
    expect(isReapableOrphan(candidate({ cwd: "/home/user/checkout" }), ctx())).toBe(false);
  });

  it("rejects an unreadable cwd (no proof of location)", () => {
    expect(isReapableOrphan(candidate({ cwd: null }), ctx())).toBe(false);
  });

  it("never reaps pid <= 1 or this process", () => {
    expect(isReapableOrphan(candidate({ pid: 1 }), ctx())).toBe(false);
    expect(isReapableOrphan(candidate({ pid: process.pid }), ctx())).toBe(false);
  });

  it("grows listing-time age with `now` so a stale listing can never understate age", () => {
    const base = { observedAtMs: 1_000_000, ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS - 5_000 };
    expect(isReapableOrphan(candidate(base), ctx({ now: 1_000_000 }))).toBe(false);
    expect(isReapableOrphan(candidate(base), ctx({ now: 1_006_000 }))).toBe(true);
  });
});

function fakeProbe(candidates: OrphanedGitChildCandidate[], opts: { aliveAfterTerm?: boolean } = {}): GitChildProcessProbe & {
  signals: Array<{ pid: number; signal: string }>;
} {
  const signals: Array<{ pid: number; signal: string }> = [];
  const alive = new Set(candidates.map((c) => c.pid));
  return {
    available: true,
    signals,
    async list() {
      return candidates;
    },
    isAlive: (pid: number) => (opts.aliveAfterTerm === false ? false : alive.has(pid)),
    signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") alive.delete(pid);
    },
  };
}

const immediateSleep = async () => {};

describe("reapOrphanedGitChildren", () => {
  it("SIGTERMs then SIGKILLs a candidate still alive after the kill-grace window", async () => {
    const probe = fakeProbe([candidate()]);
    const result = await reapOrphanedGitChildren({
      probe,
      worktreesDirs: WORKTREES_DIRS,
      killGraceMs: 1,
      sleep: immediateSleep,
    });
    expect(result.reaped).toBe(1);
    expect(result.escalated).toBe(1);
    expect(probe.signals).toEqual([
      { pid: 41001, signal: "SIGTERM" },
      { pid: 41001, signal: "SIGKILL" },
    ]);
  });

  it("skips SIGKILL when SIGTERM alone cleared the process", async () => {
    const probe = fakeProbe([candidate()], { aliveAfterTerm: false });
    const result = await reapOrphanedGitChildren({
      probe,
      worktreesDirs: WORKTREES_DIRS,
      killGraceMs: 1,
      sleep: immediateSleep,
    });
    expect(result.reaped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(probe.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });

  it("respects the maxReaps signal budget per sweep", async () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate({ pid: 41100 + i }));
    const probe = fakeProbe(many, { aliveAfterTerm: false });
    const result = await reapOrphanedGitChildren({
      probe,
      worktreesDirs: WORKTREES_DIRS,
      killGraceMs: 0,
    });
    expect(result.scanned).toBe(12);
    expect(result.reapable).toBe(12);
    expect(result.reaped).toBe(10);
    expect(result.reaps).toHaveLength(10);
    expect(probe.signals).toHaveLength(10);
  });

  it("signals nothing when the probe has no process table", async () => {
    let listCalls = 0;
    const probe: GitChildProcessProbe = {
      available: false,
      async list() {
        listCalls += 1;
        return [];
      },
      isAlive: () => true,
      signal: () => {},
    };
    const result = await reapOrphanedGitChildren({ probe, worktreesDirs: WORKTREES_DIRS });
    expect(listCalls).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.reaped).toBe(0);
  });

  it("records the audit reason from the deletion evidence source", async () => {
    const probe = fakeProbe([
      candidate({ pid: 41201, cwdMissingSource: "deleted-suffix" }),
      candidate({ pid: 41202, cwdMissingSource: "path-gone" }),
    ], { aliveAfterTerm: false });
    const result = await reapOrphanedGitChildren({ probe, worktreesDirs: WORKTREES_DIRS, killGraceMs: 0 });
    expect(result.reaps.map((r) => r.reason)).toEqual(["deleted-cwd-suffix", "deleted-worktree-cwd"]);
  });
});

describe("worktreePathForCwd", () => {
  it("resolves the first segment under a scan root (the deleted task worktree directory)", () => {
    expect(worktreePathForCwd("/project/.fusion/worktrees/FN-T1/repo/sub", WORKTREES_DIRS))
      .toBe(join("/project/.fusion/worktrees", "FN-T1"));
  });

  it("falls back to the cwd itself when outside every root (predicate would have excluded it)", () => {
    expect(worktreePathForCwd("/home/user/checkout", WORKTREES_DIRS)).toBe("/home/user/checkout");
  });
});

/*
 * Probe-parser fixture: a temp procRoot with one level of writes
 * (proc/<pid>/{comm,stat,status,cwd} plus proc/uptime). proc(5) fields: after the last ')'
 * the stat fields start at state(idx0); ppid is idx1 and starttime is idx19 in USER_HZ ticks.
 */
describe("createProcfsGitChildProbe — proc fixture parsing", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rufu210-proc-"));
  const procRoot = join(fixtureRoot, "proc");

  const statLine = (pid: number, ppid: number, startTimeTicks: number): string => {
    const fields = ["S", String(ppid)];
    while (fields.length < 19) fields.push("0");
    fields.push(String(startTimeTicks));
    return `${pid} (git) ${fields.join(" ")}`;
  };

  const writePid = (pid: number, opts: {
    comm: string;
    ppid?: number;
    startTimeTicks?: number;
    uid?: number;
    cwdLink?: string;
  }) => {
    const dir = join(procRoot, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "comm"), `${opts.comm}\n`);
    writeFileSync(join(dir, "stat"), `${statLine(pid, opts.ppid ?? 1, opts.startTimeTicks ?? 3500)}\n`);
    const uid = opts.uid ?? process.getuid?.() ?? 0;
    writeFileSync(join(dir, "status"), `Name:\topts\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\n`);
    if (opts.cwdLink) symlinkSync(opts.cwdLink, join(dir, "cwd"));
  };

  try {
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(join(procRoot, "uptime"), "4000.00 8000.00\n");
    // Dangling cwd link: the link TARGET path simply does not exist (path-gone evidence).
    writePid(4242, { comm: "git", ppid: 1, cwdLink: join(fixtureRoot, "deleted-target") });
    // Non-git comm is filtered on the cheap read.
    writePid(4243, { comm: "node", cwdLink: join(fixtureRoot, "deleted-target") });
    // Live cwd: link target exists → cwdMissing false.
    mkdirSync(join(fixtureRoot, "live-target"), { recursive: true });
    writePid(4244, { comm: "git", cwdLink: join(fixtureRoot, "live-target") });
    // Kernel deleted-suffix: readlink target literally carries the " (deleted)" suffix.
    writePid(4245, { comm: "git", cwdLink: `${join(fixtureRoot, "gone")} (deleted)` });
    // Foreign uid candidate stays listed with ownedBySelf false (predicate, not probe, excludes).
    writePid(4246, { comm: "git", uid: 65534, cwdLink: join(fixtureRoot, "deleted-target") });
    // Non-numeric entry must be ignored without a read attempt.
    mkdirSync(join(procRoot, "self"), { recursive: true });
    writeFileSync(join(procRoot, "self", "comm"), "node\n");
  } catch {
    // Construction failure surfaces as failing tests below with a clear fixture path.
  }

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("parses comm/stat/uid/cwd into exactly the expected candidates", async () => {
    const probe = createProcfsGitChildProbe({ procRoot });
    expect(probe.available).toBe(true);
    const candidates = await probe.list();
    expect(candidates.map((c) => c.pid).sort((a, b) => a - b)).toEqual([4242, 4244, 4245, 4246]);

    const byPid = new Map(candidates.map((c) => [c.pid, c]));
    const orphan = byPid.get(4242)!;
    expect(orphan.comm).toBe("git");
    expect(orphan.ppid).toBe(1);
    expect(orphan.ownedBySelf).toBe(true);
    // uptime 4000s minus 3500 ticks * 10ms → ~66 minutes old.
    expect(orphan.ageMs).toBe(4_000_000 - 35_000);
    expect(orphan.cwdMissing).toBe(true);
    expect(orphan.cwdMissingSource).toBe("path-gone");
    expect(orphan.cwd).toBe(join(fixtureRoot, "deleted-target"));

    expect(byPid.get(4244)!.cwdMissing).toBe(false);
    expect(byPid.get(4245)!.cwdMissingSource).toBe("deleted-suffix");
    expect(byPid.get(4245)!.cwd).toBe(`${join(fixtureRoot, "gone")}`);
    expect(byPid.get(4246)!.ownedBySelf).toBe(false);
  });

  it("reports unavailable and lists nothing when the proc root does not exist (macOS shape)", async () => {
    const probe = createProcfsGitChildProbe({ procRoot: join(fixtureRoot, "no-such-proc") });
    expect(probe.available).toBe(false);
    expect(await probe.list()).toEqual([]);
  });

  it("end-to-end on the fixture: only the own-uid git children with deleted worktree cwds are reapable", async () => {
    const probe = createProcfsGitChildProbe({ procRoot });
    const candidates = await probe.list();
    const reapableDirs = [fixtureRoot];
    const reapable = candidates.filter((c) => isReapableOrphan(c, { worktreesDirs: reapableDirs, now: Date.now() }));
    // 4242 (path-gone) and 4245 (deleted-suffix) qualify; 4244 has a live cwd, 4246 is a foreign uid.
    expect(reapable.map((c) => c.pid)).toEqual([4242, 4245]);
  });
});
