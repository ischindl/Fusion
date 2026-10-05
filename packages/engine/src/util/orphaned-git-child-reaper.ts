/**
 * Bounded reaper for orphaned git children left in deleted worktrees.
 *
 * FNXC:OrphanedGitChildren 2026-09-12-09:20 (RUFU-210):
 * An autonomous session's shell chain `bash -c … → git rebase --continue → git commit -e` can
 * outlive its owning session and block forever on the interactive editor it was never allowed
 * to answer (the RUFU-194 incident chain sat wedged for 1d13h). Worktree deletion is guarded by
 * the active-session registry and a content classifier; both are structurally blind to a process
 * whose parent session already ended (the registry releases with the session). The honest
 * invariant is therefore: keep the removal refusal as-is, and reap the proven orphan afterwards.
 * This module is the reap. It signals processes and ONLY processes — it never mutates task,
 * worktree, or lifecycle state.
 *
 * Reapability is deliberately narrow (every clause is required, see `isReapableOrphan`): the
 * process comm is exactly `git`; it is reparented (ppid 1, or its parent's comm is a
 * `systemd*` supervisor — a live engine session child still has its spawner in the chain); it
 * runs under our own uid; it is at least the grace floor old (mirrors RUFU-144's 30-minute
 * stale-in-flight floor); and its cwd is strictly inside a configured worktrees root that no
 * longer exists on disk (or the `/proc/<pid>/cwd` readlink carries the kernel's ` (deleted)`
 * suffix). Anything less provable is left running — a healthy worktree's live git commands are
 * never touched.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isStrictDescendantPath } from "@fusion/core";

/**
 * FNXC:OrphanedGitChildren 2026-09-12-09:20 (RUFU-210):
 * Grace floor for reaping, mirroring RUFU-144's 30-minute stale-in-flight floor. Below this age
 * a wedged git may still be legitimately working (a large rebase/commit runs for minutes); the
 * floor is a clamp, not a tunable — configuration can only raise it.
 */
export const ORPHANED_GIT_CHILD_GRACE_FLOOR_MS = 30 * 60_000;

/** SIGTERM→SIGKILL escalation window; injectable sleep keeps tests instant. */
export const ORPHANED_GIT_CHILD_KILL_GRACE_MS = 5_000;

/** Hard budget of signals per sweep so a pathological host scan cannot fan out unbounded. */
export const ORPHANED_GIT_CHILD_MAX_REAPS_PER_SWEEP = 10;

/** proc(5): /proc/<pid>/stat starttime is expressed in USER_HZ ticks, fixed at 100 Hz. */
const PROC_TICK_MS = 10;

/** Kernel suffix appended to a /proc/<pid>/cwd readlink whose target directory was unlinked. */
const DELETED_CWD_SUFFIX = " (deleted)";

/** One observed process that might be a reapable orphaned git child (all fields fs-derived). */
export interface OrphanedGitChildCandidate {
  pid: number;
  ppid: number;
  /** Contents of /proc/<pid>/comm. */
  comm: string;
  /** Contents of /proc/<ppid>/comm at listing time; undefined when unreadable. */
  parentComm?: string;
  /** Process age at observation time. */
  ageMs: number;
  /** Epoch ms when ageMs was measured; lets the predicate grow age with `now` (age is monotonic). */
  observedAtMs?: number;
  /** readlink(/proc/<pid>/cwd) with any ` (deleted)` suffix stripped; null when unreadable. */
  cwd: string | null;
  /** True when the cwd target is gone: deleted-suffix readlink or dangling link. */
  cwdMissing: boolean;
  /** Which observation proved the deletion; drives the audit reason enum. */
  cwdMissingSource?: "deleted-suffix" | "path-gone";
  /** True when the real or effective uid equals this process's uid. */
  ownedBySelf: boolean;
}

/** Process-table seam. Production uses /proc; tests inject fakes — nothing here ever is real. */
export interface GitChildProcessProbe {
  /** False when the platform/host exposes no usable process table (e.g. macOS `/proc` absent). */
  readonly available: boolean;
  list(): Promise<OrphanedGitChildCandidate[]>;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/**
 * Pure reapability predicate — every clause is required. `worktreesDirs` is the caller-resolved
 * set from `resolveWorktreesDirScanRoots`; keeping it as data (not settings+rootDir lookups that
 * canonicalize via realpath) keeps this function fs-free and exhaustively testable. `now` grows a
 * listing-time `ageMs` by the elapsed observation lag, so a stale listing can never understate
 * age. The graceMs argument is clamped UP to the floor: it can be made more conservative, never
 * less.
 */
export function isReapableOrphan(
  candidate: OrphanedGitChildCandidate,
  ctx: { graceMs?: number; now?: number; worktreesDirs: readonly string[] },
): boolean {
  const graceMs = Math.max(ctx.graceMs ?? ORPHANED_GIT_CHILD_GRACE_FLOOR_MS, ORPHANED_GIT_CHILD_GRACE_FLOOR_MS);
  if (candidate.comm !== "git") return false;
  if (candidate.pid <= 1 || candidate.pid === process.pid) return false;
  if (!candidate.ownedBySelf) return false;
  const reparented = candidate.ppid === 1
    || (candidate.parentComm !== undefined && candidate.parentComm.startsWith("systemd"));
  if (!reparented) return false;
  const effectiveAgeMs = candidate.observedAtMs !== undefined && ctx.now !== undefined
    ? candidate.ageMs + Math.max(0, ctx.now - candidate.observedAtMs)
    : candidate.ageMs;
  if (effectiveAgeMs < graceMs) return false;
  if (candidate.cwd === null || !candidate.cwdMissing) return false;
  const cwd = candidate.cwd;
  return ctx.worktreesDirs.some((dir) => isStrictDescendantPath(dir, cwd));
}

/** One executed reap, grouped-able for audit by worktree path. */
export interface OrphanedGitChildReap {
  pid: number;
  /** The deleted worktree directory (first segment under a scan root) the orphan was cwd'd in. */
  worktreePath: string;
  ageMs: number;
  reason: "deleted-worktree-cwd" | "deleted-cwd-suffix";
}

export interface OrphanedGitChildReaperResult {
  /** Candidates the probe listed before predicate filtering. */
  scanned: number;
  /** Candidates that passed every reapability clause. */
  reapable: number;
  /** Candidates signalled SIGTERM within the budget. */
  reaped: number;
  /** Candidates still alive after the kill-grace window and SIGKILL'd. */
  escalated: number;
  reaps: OrphanedGitChildReap[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Resolve the worktree directory (first path segment under a scan root) containing `cwd`. */
export function worktreePathForCwd(cwd: string, worktreesDirs: readonly string[]): string {
  for (const dir of worktreesDirs) {
    if (!isStrictDescendantPath(dir, cwd)) continue;
    const rel = relative(resolve(dir), resolve(cwd));
    const firstSegment = rel.split(sep)[0];
    return join(resolve(dir), firstSegment);
  }
  return resolve(cwd);
}

/**
 * SIGTERM each reapable candidate within `maxReaps`, then SIGKILL only those still alive after
 * the (injected) grace window. Defense-in-depth on top of the predicate: pid ≤ 1, this process,
 * and !ownedBySelf candidates are never signalled even if a fake probe listed them.
 */
export async function reapOrphanedGitChildren(input: {
  probe: GitChildProcessProbe;
  worktreesDirs: readonly string[];
  graceMs?: number;
  maxReaps?: number;
  killGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<OrphanedGitChildReaperResult> {
  const empty: OrphanedGitChildReaperResult = { scanned: 0, reapable: 0, reaped: 0, escalated: 0, reaps: [] };
  if (!input.probe.available) return empty;
  const now = input.now ?? Date.now;
  const candidates = await input.probe.list();
  const reapable = candidates.filter((candidate) => isReapableOrphan(candidate, {
    graceMs: input.graceMs,
    now: now(),
    worktreesDirs: input.worktreesDirs,
  }));
  const result: OrphanedGitChildReaperResult = { scanned: candidates.length, reapable: reapable.length, reaped: 0, escalated: 0, reaps: [] };
  if (reapable.length === 0) return result;
  const maxReaps = Math.max(0, input.maxReaps ?? ORPHANED_GIT_CHILD_MAX_REAPS_PER_SWEEP);
  const killGraceMs = input.killGraceMs ?? ORPHANED_GIT_CHILD_KILL_GRACE_MS;
  const sleep = input.sleep ?? defaultSleep;
  for (const candidate of reapable.slice(0, maxReaps)) {
    if (candidate.pid <= 1 || candidate.pid === process.pid || !candidate.ownedBySelf) continue;
    input.probe.signal(candidate.pid, "SIGTERM");
    result.reaped += 1;
    result.reaps.push({
      pid: candidate.pid,
      worktreePath: candidate.cwd === null ? "unknown" : worktreePathForCwd(candidate.cwd, input.worktreesDirs),
      ageMs: candidate.ageMs,
      reason: candidate.cwdMissingSource === "deleted-suffix" ? "deleted-cwd-suffix" : "deleted-worktree-cwd",
    });
    if (killGraceMs > 0) {
      await sleep(killGraceMs);
      if (input.probe.isAlive(candidate.pid)) {
        input.probe.signal(candidate.pid, "SIGKILL");
        result.escalated += 1;
      }
    }
  }
  return result;
}

/**
 * Linux `/proc` probe. `procRoot` is injectable so the parser is testable against a temp fixture
 * directory; availability is a plain `/proc` existence check (macOS: no directory → false, and
 * `list()` returns []). Scanning is one non-recursive readdir plus per-PID direct file reads —
 * never a recursive walk, per the repo's temp-tree/proc scanning rules.
 */
export function createProcfsGitChildProbe(options: { procRoot?: string } = {}): GitChildProcessProbe {
  const procRoot = options.procRoot ?? "/proc";
  const readFirstLine = (path: string): string | null => {
    try {
      const text = readFileSync(path, "utf8");
      const line = text.split("\n", 1)[0]?.trim();
      return line && line.length > 0 ? line : null;
    } catch {
      return null;
    }
  };
  /** `/proc/<pid>/stat` fields after the last ')': state, ppid, …, starttime (proc(5)). */
  const parseStat = (stat: string): { ppid: number; startTimeTicks: number } | null => {
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    // fields[0]=state, fields[1]=ppid, fields[19]=starttime (USER_HZ ticks since boot).
    const ppid = Number(fields[1]);
    const startTimeTicks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(startTimeTicks)) return null;
    return { ppid, startTimeTicks };
  };
  const readUptimeMs = (): number | null => {
    try {
      const seconds = Number.parseFloat(readFileSync(join(procRoot, "uptime"), "utf8").split(/\s+/)[0]);
      return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
    } catch {
      return null;
    }
  };
  /** `/proc/<pid>/status` "Uid:\treal\teffective\tsaved\tfs". */
  const readOwnedBySelf = (pid: number, selfUid: number | undefined): boolean => {
    if (selfUid === undefined) return false;
    try {
      const status = readFileSync(join(procRoot, String(pid), "status"), "utf8");
      const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
      if (!match) return false;
      return Number(match[1]) === selfUid || Number(match[2]) === selfUid;
    } catch {
      return false;
    }
  };
  const readCwd = (pid: number): Pick<OrphanedGitChildCandidate, "cwd" | "cwdMissing" | "cwdMissingSource"> | null => {
    let raw: string;
    try {
      raw = readlinkSync(join(procRoot, String(pid), "cwd"));
    } catch {
      // Unreadable (EPERM/EACCES) proves nothing; ENOENT means the process is gone mid-scan.
      return null;
    }
    if (raw.endsWith(DELETED_CWD_SUFFIX)) {
      return { cwd: raw.slice(0, -DELETED_CWD_SUFFIX.length), cwdMissing: true, cwdMissingSource: "deleted-suffix" };
    }
    if (!existsSync(raw)) {
      return { cwd: raw, cwdMissing: true, cwdMissingSource: "path-gone" };
    }
    return { cwd: raw, cwdMissing: false };
  };
  return {
    get available() {
      return existsSync(procRoot);
    },
    async list() {
      const selfUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const uptimeMs = readUptimeMs();
      if (uptimeMs === null) return [];
      let entries: Dirent[];
      try {
        entries = readdirSync(procRoot, { withFileTypes: true });
      } catch {
        return [];
      }
      const candidates: OrphanedGitChildCandidate[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (pid <= 1 || pid === process.pid) continue;
        // comm-first filter: the vast majority of host processes are filtered on one small read.
        const comm = readFirstLine(join(procRoot, entry.name, "comm"));
        if (comm !== "git") continue;
        let statText: string;
        try {
          statText = readFileSync(join(procRoot, entry.name, "stat"), "utf8");
        } catch {
          continue;
        }
        const stat = parseStat(statText);
        if (!stat) continue;
        const observedAtMs = Date.now();
        const ageMs = Math.max(0, uptimeMs - stat.startTimeTicks * PROC_TICK_MS);
        const cwdInfo = readCwd(pid);
        if (!cwdInfo) continue;
        const parentComm = stat.ppid > 1 ? readFirstLine(join(procRoot, String(stat.ppid), "comm")) ?? undefined : undefined;
        candidates.push({
          pid,
          ppid: stat.ppid,
          comm,
          parentComm,
          ageMs,
          observedAtMs,
          cwd: cwdInfo.cwd,
          cwdMissing: cwdInfo.cwdMissing,
          cwdMissingSource: cwdInfo.cwdMissingSource,
          ownedBySelf: readOwnedBySelf(pid, selfUid),
        });
      }
      return candidates;
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        // EPERM means the process exists but is not ours (the predicate excludes it anyway).
        return (err as NodeJS.ErrnoException)?.code === "EPERM";
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // ESRCH: the process exited between listing and signalling — exactly the benign case.
        // EPERM: ownership disappeared; the predicate already required ownedBySelf.
      }
    },
  };
}
