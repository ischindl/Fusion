/**
 * Attribute a process to the checkout that owns it, via `/proc(5)`.
 *
 * FNXC:ProcessProbeAttribution 2026-11-21-01:37 (RUFU-760):
 * Operator rule this module exists to enforce: a process may be COUNTED or SIGNALED only after
 * its working directory has been attributed to this project. `pgrep -f <word>` matches FULL command
 * lines across every process on the host, so narrowing candidates by executable identity (the
 * 2026-06-03 fix in `vitest-processes.ts`) removes wrong-KIND matches and leaves wrong-OWNER
 * matches untouched — a vitest worker started from a different checkout on the same machine is a
 * perfect candidate. Measured instance of the same trap outside this repo: an unscoped
 * `pgrep -f 'bin.js dashboard'` on the production host returned two pids, one in the deploy
 * worktree and one in a developer checkout, and summing their RSS was read as one wedged process.
 *
 * Contract of this module, deliberately small:
 * - one direct `readlink` per pid, never a directory walk (repo rule against unbounded tree walks);
 * - never throws and never invents an answer — an unreadable cwd returns `null`, which callers must
 *   treat as UNKNOWN (keep the pid killable), never as FOREIGN (which would drop it);
 * - the proc-table root is decided in exactly ONE place, {@link resolveProcRoot}.
 */
import { existsSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isStrictDescendantPath } from "../tasks/worktree-layout.js";

/**
 * Environment variable that relocates the whole proc-table read to a fixture tree. Honored ONLY
 * inside a vitest run (see {@link resolveProcRoot}), which is what lets route- and controller-level
 * tests prove an attribution decision against the real resolver instead of a mock, without ever
 * touching the host's process table.
 */
export const FUSION_PROC_ROOT_ENV = "FUSION_PROC_ROOT";

/** Kernel suffix on a `/proc/<pid>/cwd` readlink whose target directory was unlinked. */
export const PROC_CWD_DELETED_SUFFIX = " (deleted)";

/**
 * The single decision point for the proc-table root: explicit option → `FUSION_PROC_ROOT` while
 * `VITEST === "true"` → `/proc`.
 *
 * FNXC:ProcessProbeAttribution 2026-11-21-01:37 (RUFU-760):
 * The relocation is gated on vitest for the same reason `TaskStore`'s global-settings-dir fallback
 * is: outside a test run the env must be inert, because this root feeds a destructive SIGKILL path
 * and a stray env var on a production host must never redirect which processes the dashboard can
 * see. The worst case a test can therefore cause with the env is today's machine-wide behavior —
 * never a new signal target.
 */
export function resolveProcRoot(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (process.env.VITEST === "true") {
    const relocated = process.env[FUSION_PROC_ROOT_ENV];
    if (typeof relocated === "string" && relocated.length > 0) return relocated;
  }
  return "/proc";
}

/** True when the host exposes a proc table at all (macOS/Windows: no directory → no attribution). */
export function isProcTableAvailable(procRoot?: string): boolean {
  try {
    return existsSync(resolveProcRoot(procRoot));
  } catch {
    return false;
  }
}

export interface ReadProcessCwdOptions {
  /** Explicit proc-table root. Omit it so {@link resolveProcRoot} stays the only decider. */
  procRoot?: string;
  /** Test seam for the link read itself (the ` (deleted)` shape is kernel-only and unforgeable by a fixture). */
  readlinkImpl?: (path: string) => string;
}

/**
 * `readlink(/proc/<pid>/cwd)` with the kernel's deleted-cwd suffix stripped, or `null` when the cwd
 * cannot be read (`ENOENT` — the process exited mid-scan, `EPERM` — another uid, or no `/proc`).
 * `null` means UNATTRIBUTED, not foreign: callers keep such a pid in a killable set.
 */
export function readProcessCwd(pid: number, options: ReadProcessCwdOptions = {}): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const readlink = options.readlinkImpl ?? readlinkSync;
  let raw: string;
  try {
    raw = readlink(join(resolveProcRoot(options.procRoot), String(pid), "cwd"));
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.endsWith(PROC_CWD_DELETED_SUFFIX)) {
    return raw.slice(0, -PROC_CWD_DELETED_SUFFIX.length);
  }
  return raw;
}

/** One pass of the proc table over a candidate pid set. */
export interface ProcessCwdTable {
  /** pid → resolved cwd, for every pid whose cwd WAS readable. */
  cwds: Map<number, string>;
  /** Pids with no readable cwd, in input order. */
  unattributedPids: number[];
  /** False only when the proc root itself is absent — "not attributable here", not "this pid is unattributable". */
  procTableAvailable: boolean;
}

/** Read every candidate's cwd in one non-recursive pass: one direct readlink per pid. */
export function readProcessCwds(pids: readonly number[], options: ReadProcessCwdOptions = {}): ProcessCwdTable {
  const procRoot = resolveProcRoot(options.procRoot);
  const cwds = new Map<number, string>();
  const unattributedPids: number[] = [];
  for (const pid of pids) {
    const cwd = readProcessCwd(pid, { ...options, procRoot });
    if (cwd === null) {
      unattributedPids.push(pid);
      continue;
    }
    cwds.set(pid, cwd);
  }
  return { cwds, unattributedPids, procTableAvailable: isProcTableAvailable(procRoot) };
}

/**
 * True when `cwd` lies inside one of `roots` — a cwd that IS a root counts as inside, because a
 * runner started at the repository root is that checkout's own process.
 */
export function isCwdAttributedTo(cwd: string, roots: readonly string[]): boolean {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  const resolvedCwd = resolve(cwd);
  return roots.some((root) => {
    if (typeof root !== "string" || root.length === 0) return false;
    const resolvedRoot = resolve(root);
    return resolvedCwd === resolvedRoot || isStrictDescendantPath(resolvedRoot, resolvedCwd);
  });
}
