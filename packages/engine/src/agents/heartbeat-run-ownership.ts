/*
FNXC:HeartbeatRunOwnership 2026-11-11-00:07 (step 0 of the process-split rollback):
A heartbeat run is a claim held by exactly ONE process: the process that opened the session, streams
its tokens, and can abort it. `trackedAgents` proves that claim only inside the owning process, while
`store.getActiveHeartbeatRun()` reads it from the shared database — so on a host that shares the same
database but does not own the agent, every live peer run reads as an orphan.

Measured on production 2026-11-10/11 with a `--no-engine` UI process and a `fn serve` engine process on
one PostgreSQL: six durable agents were driven by BOTH processes in the same hour (agent-ce645ede 5 runs
from the engine, 7 from the UI), and the UI process ended 10 of its 17 runs `terminated` at
`thresholdMs=120000` — each process reaping the other's live run and starting its own, at ~1M input
tokens per run. `source=timer` `reason=orphaned-run-reaped` was the fingerprint.

The run already records its owner (`AgentHeartbeatRun.processPid`, written at run start in
`agent-heartbeat.ts`). This module turns that field into the one question the reapers must ask before
they write: does this run belong to a Fusion host that is still alive? "Another process owns it" is
positive proof of life, never an orphan — the owner reaps its own runs.

The rules are deliberately asymmetric:
- Owner is this process, or the run predates the field: reap as before (no behaviour change for legacy rows).
- Owner is a live foreign pid: NEVER reap here. A dead owner is reaped immediately, which is faster than
  today's blind 120 s wait, so the guard also improves recovery, not just safety.
- The pid is alive but its identity cannot be read (permissions, non-Linux): withhold, because killing a
  live peer's run is the exact defect being closed and "cannot tell" must not become "kill it".
- The pid is alive but provably NOT a Fusion host (`/proc/<pid>/cmdline` names another program): a
  recycled pid is not the owner, so the run is orphaned after all.

Explicit operator stops are NOT routed through here. A human pressing Stop means it; and the surfaces
that could previously fake a stop against a peer run (the UI-only host's monitor-less `endHeartbeatRun`
fallback) now refuse instead — see `register-agent-runtime-routes.ts`.
*/

import { readFileSync } from "node:fs";
import { platform as hostPlatform, release as kernelRelease } from "node:os";
import type { AgentHeartbeatRun } from "@fusion/core";

/** Who the database says owns a heartbeat run, and what we could prove about that pid right now. */
export type HeartbeatRunOwnerVerdict =
  /** The run is this process's own claim. */
  | { kind: "self"; pid: number }
  /** Another live process owns it: it is running, not abandoned. */
  | { kind: "live-peer"; pid: number }
  /** The owning pid is gone: the run is a true orphan and may be closed now. */
  | { kind: "owner-gone"; pid: number }
  /** The pid is alive but runs a different program, so it is not the owner (recycled pid). */
  | { kind: "pid-recycled"; pid: number }
  /** Liveness cannot be determined on this host: withhold rather than guess. */
  | { kind: "unprovable"; pid: number }
  /** The run carries no owner pid (written before the field existed): today's behaviour applies. */
  | { kind: "unrecorded" };

export interface HeartbeatRunOwnershipDeps {
  currentPid?: number;
  platform?: NodeJS.Platform;
  isKernelLinux?: () => boolean;
  /** True = alive, false = proven gone, undefined = this host cannot tell. */
  isPidAlive?: (pid: number) => boolean | undefined;
  /** Linux process command line, or undefined when it cannot be read. */
  readProcCmdline?: (pid: number) => string | undefined;
}

/**
 * A pid that is alive but no longer runs Fusion is not the owner — it is a recycled pid.
 * Only a readable command line that provably names something else counts: an unreadable one leaves the
 * pid alive and unproven, which withholds the reap.
 */
const FUSION_HOST_SIGNATURES = ["fusion", "packages/cli", "bin.js", "fn-serve", "node"];

function defaultIsPidAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: the pid exists and belongs to another user — alive, just unqueryable.
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function defaultReadProcCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
}

function defaultIsKernelLinux(): boolean {
  return kernelRelease().toLowerCase().includes("linux");
}

/**
 * Resolve who owns `run` and whether that owner is still alive.
 *
 * `deps` exists so every branch is reachable from a fake: production call sites pass nothing.
 */
export function classifyHeartbeatRunOwner(
  run: Pick<AgentHeartbeatRun, "processPid"> | null | undefined,
  deps: HeartbeatRunOwnershipDeps = {},
): HeartbeatRunOwnerVerdict {
  const pid = run?.processPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { kind: "unrecorded" };
  }

  const currentPid = deps.currentPid ?? process.pid;
  if (pid === currentPid) {
    return { kind: "self", pid };
  }

  // A liveness probe that explodes must not crash a reaper, and must not be read as "the owner is gone"
  // either: an unknown is the only honest answer, and it withholds the write.
  let alive: boolean | undefined;
  try {
    alive = (deps.isPidAlive ?? defaultIsPidAlive)(pid);
  } catch {
    alive = undefined;
  }
  if (alive === undefined) {
    return { kind: "unprovable", pid };
  }
  if (alive === false) {
    return { kind: "owner-gone", pid };
  }

  // Recycled-pid check needs the process table; POSIX procfs is the only portable, permission-free read.
  // Elsewhere the honest answer is "alive, identity unknown" — which withholds the reap.
  const platform = deps.platform ?? hostPlatform();
  const isLinux = (deps.isKernelLinux ?? defaultIsKernelLinux)();
  if (platform !== "win32" && isLinux) {
    const cmdline = (deps.readProcCmdline ?? defaultReadProcCmdline)(pid);
    if (cmdline !== undefined) {
      const normalized = cmdline.replace(/\0/g, " ").toLowerCase();
      const looksLikeFusionHost = normalized.length === 0
        ? false
        : FUSION_HOST_SIGNATURES.some((signature) => normalized.includes(signature));
      if (!looksLikeFusionHost) {
        return { kind: "pid-recycled", pid };
      }
    }
  }

  return { kind: "live-peer", pid };
}

/**
 * The single decision every automatic reaper must take before closing a persisted run.
 *
 * Returns `false` only for a run whose owner is alive or whose liveness cannot be proven; both cases
 * leave the run row untouched, which is what makes a second Fusion host on one database safe. Both
 * reapers consult THIS predicate, so the allowed set cannot drift between them.
 */
export function isHeartbeatRunReapAllowedForOwner(verdict: HeartbeatRunOwnerVerdict): boolean {
  return verdict.kind === "self"
    || verdict.kind === "owner-gone"
    || verdict.kind === "pid-recycled"
    || verdict.kind === "unrecorded";
}

/** Fixed, low-cardinality reason for logs, audit rows, and HTTP `details.reason` — never prose, never the pid's command line. */
export function heartbeatRunOwnerReasonCode(verdict: HeartbeatRunOwnerVerdict): string {
  // Two kinds already name an owner, so prefixing them blindly yields `owner-owner-gone`.
  return verdict.kind.startsWith("owner-") ? verdict.kind : `owner-${verdict.kind}`;
}
