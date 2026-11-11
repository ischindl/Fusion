import { describe, it, expect } from "vitest";
import {
  classifyHeartbeatRunOwner,
  heartbeatRunOwnerReasonCode,
  isHeartbeatRunReapAllowedForOwner,
  type HeartbeatRunOwnershipDeps,
} from "../agents/heartbeat-run-ownership.js";

/*
FNXC:HeartbeatRunOwnership 2026-11-11-00:07:
The classifier is the only thing standing between two Fusion hosts on one database and a war over every
durable agent. Measured 2026-11-10/11: a `--no-engine` UI process and a `fn serve` engine process reaped
each other's live runs at the 120 s stale threshold — six agents driven by both in one hour, 10 of the UI
process's 17 runs ended `terminated`. These cases pin the verdicts, because the failure mode is silent
corruption of another host's run, not an error anyone sees.
*/

const deps = (over: Partial<HeartbeatRunOwnershipDeps>): HeartbeatRunOwnershipDeps => ({
  currentPid: 1000,
  platform: "linux",
  isKernelLinux: () => true,
  isPidAlive: () => false,
  readProcCmdline: () => "/usr/bin/node\0packages/cli/dist/bin.js\0serve",
  ...over,
});

describe("classifyHeartbeatRunOwner", () => {
  it("claims a run carrying no owner pid as unrecorded, keeping legacy rows reapable", () => {
    expect(classifyHeartbeatRunOwner({}, deps({}))).toEqual({ kind: "unrecorded" });
    expect(classifyHeartbeatRunOwner(undefined, deps({}))).toEqual({ kind: "unrecorded" });
    expect(classifyHeartbeatRunOwner({ processPid: 0 }, deps({}))).toEqual({ kind: "unrecorded" });
    expect(classifyHeartbeatRunOwner({ processPid: 12.5 }, deps({}))).toEqual({ kind: "unrecorded" });
  });

  it("recognises its own run", () => {
    expect(classifyHeartbeatRunOwner({ processPid: 1000 }, deps({}))).toEqual({ kind: "self", pid: 1000 });
  });

  it("calls a dead owner's run an orphan", () => {
    const verdict = classifyHeartbeatRunOwner({ processPid: 4242 }, deps({ isPidAlive: () => false }));
    expect(verdict).toEqual({ kind: "owner-gone", pid: 4242 });
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(true);
  });

  it("treats a live foreign Fusion host as the owner, never as an orphan", () => {
    const verdict = classifyHeartbeatRunOwner(
      { processPid: 4242 },
      deps({ isPidAlive: () => true }),
    );
    expect(verdict).toEqual({ kind: "live-peer", pid: 4242 });
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(false);
    expect(heartbeatRunOwnerReasonCode(verdict)).toBe("owner-live-peer");
  });

  it("treats a peer it cannot query the identity of (EPERM-shaped) as alive", () => {
    // The real probe maps EPERM to "alive"; that mapping lives in `defaultIsPidAlive` and needs another
    // user's pid to hit honestly, so the branch is pinned through the seam instead of faked at the syscall.
    const verdict = classifyHeartbeatRunOwner(
      { processPid: 4242 },
      deps({ isPidAlive: () => true, readProcCmdline: () => undefined }),
    );
    expect(verdict.kind).toBe("live-peer");
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(false);
  });

  it("withholds when the liveness probe throws — unknown is never read as dead", () => {
    const verdict = classifyHeartbeatRunOwner(
      { processPid: 4242 },
      deps({
        isPidAlive: () => {
          throw new Error("process table unreadable");
        },
      }),
    );
    expect(verdict).toEqual({ kind: "unprovable", pid: 4242 });
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(false);
  });

  it("answers from the real process table for a pid that cannot exist", () => {
    // Only `currentPid` is injected: liveness and the procfs read take the production defaults.
    const verdict = classifyHeartbeatRunOwner({ processPid: 0x7ffffff0 }, { currentPid: 1000 });
    expect(verdict).toEqual({ kind: "owner-gone", pid: 0x7ffffff0 });
  });

  it("sees a recycled pid: alive, but running a different program", () => {
    const verdict = classifyHeartbeatRunOwner(
      { processPid: 4242 },
      deps({ isPidAlive: () => true, readProcCmdline: () => "/usr/bin/postgres\0-d\0/data" }),
    );
    expect(verdict).toEqual({ kind: "pid-recycled", pid: 4242 });
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(true);
  });

  it("does not claim a recycled pid where the process table cannot be read (non-procfs)", () => {
    const verdict = classifyHeartbeatRunOwner(
      { processPid: 4242 },
      deps({ isPidAlive: () => true, isKernelLinux: () => false, readProcCmdline: () => undefined }),
    );
    expect(verdict.kind).toBe("live-peer");
    expect(isHeartbeatRunReapAllowedForOwner(verdict)).toBe(false);
  });

  it("uses the real process table when no deps are injected and the pid is this one", () => {
    // No injected deps: the production path must resolve its own pid without touching /proc.
    expect(classifyHeartbeatRunOwner({ processPid: process.pid })).toEqual({ kind: "self", pid: process.pid });
  });
});
