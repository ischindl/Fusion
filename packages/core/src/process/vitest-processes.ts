import { execFile as nodeExecFile } from "node:child_process";
import { createLogger } from "./logger.js";
import { isCwdAttributedTo, readProcessCwds } from "./proc-cwd.js";

const log = createLogger("vitest-processes");

/**
 * Locate running vitest processes safely.
 *
 * `pgrep -f vitest` matches FULL command lines, so a bare pattern also matches
 * innocent bystanders whose argv merely mentions vitest:
 *   - wrapper shells (`zsh -c '... npx vitest run ...'`) — killing these
 *     strands the `$?` handler so failures look like silent truncation,
 *   - monitoring/grep one-liners that mention vitest,
 *   - editors or tools opened on `vitest.config.ts`.
 * Root cause of the 2026-06-03 incident where the memory-pressure auto-kill
 * SIGKILLed unrelated process trees every 30s.
 *
 * That incident was fixed by filtering candidates to processes whose executable
 * (`comm`) is actually node, so only the vitest runner and its workers remain.
 *
 * FNXC:ProcessProbeAttribution 2026-11-21-01:37 (RUFU-760):
 * The executable filter answers "is this the right KIND of process?" and says nothing about
 * "whose process is this?". `pgrep -f` scans every checkout on the host, so a vitest worker started
 * from another repository is a perfect candidate, and both callers of this probe — Command Center's
 * `POST /api/kill-vitest` and the terminal dashboard's memory-pressure auto-kill — send SIGKILL.
 * The requirement now: a candidate may be counted or signalled only once its working directory has
 * been attributed to the caller's own checkout. `scopeRoots` carries that checkout (project root +
 * its managed worktree roots); a candidate is dropped ONLY on positive proof of foreignness (its cwd
 * resolved and lies outside every root). An unreadable cwd is never treated as foreign — macOS,
 * other-uid, and exited-mid-scan processes stay killable exactly as before.
 */

export interface FindVitestProcessIdsOptions {
  /** PIDs to exclude in addition to the calling process. */
  excludePids?: number[];
  /** Test seam — injected execFile. */
  execFileImpl?: typeof nodeExecFile;
  /**
   * Directories whose cwd proves a candidate belongs to this project: the project root plus every
   * managed task-worktree root. Omitted → today's machine-wide candidate set (`scoped: false`).
   * Supplied but empty (a misconfiguration, never an intent) → also unscoped, plus a warn: an
   * operator's kill must never silently become a no-op.
   */
  scopeRoots?: readonly string[];
  /**
   * Explicit proc-table override for tests that inject `execFileImpl`. Omit it in every production
   * caller so `resolveProcRoot()` stays the single decider of where the process table is read.
   */
  procRoot?: string;
}

/** One scoped scan's result: what may be killed, what was proved foreign, and what stayed unknown. */
export interface VitestProcessInventory {
  /** Candidates that may be counted and signalled: in-scope plus every UNATTRIBUTABLE candidate. */
  pids: number[];
  /** Candidates proved to belong to another checkout — reported, never signalled. */
  foreignPids: number[];
  /** Candidates whose cwd could not be read; they remain in `pids`. */
  unattributedPids: number[];
  /** False when the scan ran machine-wide (no usable scope roots, or no attribution possible). */
  scoped: boolean;
}

function execToStdout(
  execFileImpl: typeof nodeExecFile,
  cmd: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve) => {
    execFileImpl(cmd, args, { encoding: "utf8" }, (err, out) => {
      // pgrep/ps exit non-zero when nothing matches — treat as empty result.
      resolve(err ? "" : (typeof out === "string" ? out : ""));
    });
  });
}

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Keep only pids whose executable is node (vitest runner + pool workers). */
async function filterToNodeProcesses(
  execFileImpl: typeof nodeExecFile,
  pids: number[],
): Promise<number[]> {
  if (pids.length === 0) return [];
  const stdout = await execToStdout(execFileImpl, "ps", [
    "-o",
    "pid=,comm=",
    "-p",
    pids.join(","),
  ]);
  const nodePids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const comm = trimmed.slice(spaceIdx + 1).trim();
    const executable = comm.split("/").pop() ?? comm;
    if (executable === "node" || executable === "node.exe" || executable === "nodejs") {
      nodePids.push(pid);
    }
  }
  return nodePids;
}

/**
 * Scan for vitest processes and attribute every candidate to a checkout.
 *
 * Dropping a candidate is the only destructive decision here, and it is taken on positive proof
 * only: `cwd` resolved AND outside every scope root. Everything else — no proc table, another uid,
 * a process that exited between `pgrep` and `readlink` — stays in `pids` so a host without `/proc`
 * (macOS) keeps the behavior it had before attribution existed.
 */
export async function findVitestProcessInventory(
  options: FindVitestProcessIdsOptions = {},
): Promise<VitestProcessInventory> {
  // pgrep/ps are POSIX-only; Windows callers treat this as a no-op.
  if (process.platform === "win32") {
    return { pids: [], foreignPids: [], unattributedPids: [], scoped: false };
  }

  const execFileImpl = options.execFileImpl ?? nodeExecFile;
  const excluded = new Set<number>([process.pid, ...(options.excludePids ?? [])]);

  const candidates = parsePids(await execToStdout(execFileImpl, "pgrep", ["-f", "vitest"]));
  const nodePids = await filterToNodeProcesses(execFileImpl, candidates);
  const killable = nodePids.filter((pid) => !excluded.has(pid));

  const requested = options.scopeRoots;
  const scopeRoots = (requested ?? []).filter((root) => typeof root === "string" && root.trim().length > 0);
  if (scopeRoots.length === 0) {
    if (requested !== undefined) {
      // Every supplied root was blank: a caller misconfiguration. Warn rather than obey, because
      // obeying would answer an operator's "Kill vitest" with `killed: 0` and no explanation.
      log.warn(
        `Vitest probe received ${requested.length} scope root(s) but none was usable; running unscoped (machine-wide) rather than silently killing nothing.`,
      );
    }
    return { pids: killable, foreignPids: [], unattributedPids: [], scoped: false };
  }

  const table = readProcessCwds(killable, { procRoot: options.procRoot });
  if (!table.procTableAvailable) {
    /*
    FNXC:ProcessProbeAttribution 2026-11-21-01:37 (RUFU-760):
    No proc table (macOS, Windows-without-procfs, an unrelocatable host) means attribution is
    impossible for EVERY candidate, so reporting the scan as "scoped" would claim a guarantee the
    platform cannot give. The candidate set stays exactly what it was before attribution existed.
    */
    return { pids: killable, foreignPids: [], unattributedPids: table.unattributedPids, scoped: false };
  }
  const pids: number[] = [];
  const foreignPids: number[] = [];
  for (const pid of killable) {
    const cwd = table.cwds.get(pid);
    if (cwd === undefined) {
      // Unattributable: unknown is not foreign.
      pids.push(pid);
      continue;
    }
    if (isCwdAttributedTo(cwd, scopeRoots)) pids.push(pid);
    else foreignPids.push(pid);
  }
  return { pids, foreignPids, unattributedPids: table.unattributedPids, scoped: true };
}

export async function findVitestProcessIds(
  options: FindVitestProcessIdsOptions = {},
): Promise<number[]> {
  return (await findVitestProcessInventory(options)).pids;
}
