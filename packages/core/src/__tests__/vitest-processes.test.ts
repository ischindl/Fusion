import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { execFile as nodeExecFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVitestProcessIds, findVitestProcessInventory } from "../process/vitest-processes.js";
import { resolveWorktreesDirCandidates } from "../tasks/worktree-layout.js";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

function makeExecFileMock(responses: { pgrep?: string; ps?: string; pgrepError?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl = ((cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
    calls.push({ cmd, args });
    if (cmd === "pgrep") {
      if (responses.pgrepError) {
        cb(new Error("pgrep: no matches"), "", "");
      } else {
        cb(null, responses.pgrep ?? "", "");
      }
      return {} as never;
    }
    if (cmd === "ps") {
      cb(null, responses.ps ?? "", "");
      return {} as never;
    }
    cb(new Error(`unexpected command ${cmd}`), "", "");
    return {} as never;
  }) as unknown as typeof nodeExecFile;
  return { impl, calls };
}

describe("findVitestProcessIds", () => {
  it("returns only pids whose executable is node — wrapper shells and monitors are spared", async () => {
    const { impl, calls } = makeExecFileMock({
      // pgrep -f vitest matches the runner, two workers, a zsh wrapper whose
      // command line contains "npx vitest run", and a watch loop grepping for
      // "node (vitest".
      pgrep: "101\n102\n103\n104\n105\n",
      ps: [
        "  101 /opt/homebrew/bin/node",
        "  102 node",
        "  103 /usr/local/bin/node",
        "  104 zsh",
        "  105 /bin/zsh",
      ].join("\n"),
    });

    const pids = await findVitestProcessIds({ execFileImpl: impl });

    expect(pids).toEqual([101, 102, 103]);
    expect(calls[0]).toEqual({ cmd: "pgrep", args: ["-f", "vitest"] });
    expect(calls[1]?.cmd).toBe("ps");
    expect(calls[1]?.args).toEqual(["-o", "pid=,comm=", "-p", "101,102,103,104,105"]);
  });

  it("always excludes the calling process and any caller-supplied pids", async () => {
    const self = process.pid;
    const { impl } = makeExecFileMock({
      pgrep: `${self}\n201\n202\n`,
      ps: [`  ${self} node`, "  201 node", "  202 node"].join("\n"),
    });

    const pids = await findVitestProcessIds({ execFileImpl: impl, excludePids: [202] });

    expect(pids).toEqual([201]);
  });

  it("returns empty when pgrep finds nothing (non-zero exit)", async () => {
    const { impl, calls } = makeExecFileMock({ pgrepError: true });

    const pids = await findVitestProcessIds({ execFileImpl: impl });

    expect(pids).toEqual([]);
    // ps must not run with an empty pid list.
    expect(calls.map((c) => c.cmd)).toEqual(["pgrep"]);
  });

  it("returns empty on win32 without spawning anything", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { impl, calls } = makeExecFileMock({ pgrep: "999\n", ps: "  999 node" });
      const pids = await findVitestProcessIds({ execFileImpl: impl });
      expect(pids).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      platformSpy.mockRestore();
    }
  });
});

/*
FNXC:ProcessProbeAttribution 2026-11-21-01:37 (RUFU-760):
Fixtures for the attribution half of the probe. The fake proc table is a real temp tree holding
REAL symlinks, so the real resolver decides attribution and the test asserts a decision, not a mock
return value. The kernel's ` (deleted)` link text is reproducible verbatim here because symlink(2)
stores an arbitrary target string and readlink(2) returns exactly that text — which is precisely how
`/proc/<pid>/cwd` looks when the directory a process is standing in has been unlinked.
*/
const REAL_TMP = realpathSync(tmpdir());
const createdProbeDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(REAL_TMP, prefix));
  createdProbeDirs.push(dir);
  return dir;
}

function linkProcessCwd(procRoot: string, pid: number, targetText: string): void {
  const pidDir = join(procRoot, String(pid));
  mkdirSync(pidDir, { recursive: true });
  symlinkSync(targetText, join(pidDir, "cwd"));
}

function nodeCandidateOutput(pids: number[]): { pgrep: string; ps: string } {
  return {
    pgrep: `${pids.map((pid) => String(pid)).join("\n")}\n`,
    ps: pids.map((pid) => `  ${pid} node`).join("\n"),
  };
}

afterEach(() => {
  while (createdProbeDirs.length > 0) {
    const dir = createdProbeDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("findVitestProcessInventory - checkout attribution", () => {
  it("drops only the candidate proved to stand in another checkout, and names it foreign", async () => {
    const procRoot = makeTempDir("proc-");
    const projectA = makeTempDir("checkout-a-");
    const projectB = makeTempDir("checkout-b-");
    linkProcessCwd(procRoot, 3001, projectA);
    linkProcessCwd(procRoot, 3002, join(projectB, "packages", "core"));
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: [projectA],
      procRoot,
    });

    expect(inventory.pids).toEqual([3001]);
    expect(inventory.foreignPids).toEqual([3002]);
    expect(inventory.unattributedPids).toEqual([]);
    expect(inventory.scoped).toBe(true);
  });

  it("keeps every candidate whose cwd resolves inside the project, runner and pool workers alike", async () => {
    const procRoot = makeTempDir("proc-");
    const projectA = makeTempDir("checkout-a-");
    mkdirSync(join(projectA, "packages", "core"), { recursive: true });
    linkProcessCwd(procRoot, 3001, projectA);
    linkProcessCwd(procRoot, 3002, join(projectA, "packages", "core"));
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: [projectA],
      procRoot,
    });

    expect(inventory.pids).toEqual([3001, 3002]);
    expect(inventory.foreignPids).toEqual([]);
    expect(inventory.scoped).toBe(true);
  });

  it("keeps a managed task worktree's worker, including one whose worktree directory is gone", async () => {
    const procRoot = makeTempDir("proc-");
    const project = makeTempDir("checkout-a-");
    const worktreeRoot = join(project, ".fusion", "worktrees");
    const liveWorktree = join(worktreeRoot, "rufu-1");
    mkdirSync(liveWorktree, { recursive: true });
    linkProcessCwd(procRoot, 3001, liveWorktree);
    // The kernel shape for a worktree removed while its worker still runs.
    linkProcessCwd(procRoot, 3002, `${join(worktreeRoot, "rufu-2")} (deleted)`);
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: resolveWorktreesDirCandidates(project, undefined),
      procRoot,
    });

    expect(inventory.pids).toEqual([3001, 3002]);
    expect(inventory.foreignPids).toEqual([]);
  });

  it("keeps an unattributable candidate and reports it as unattributed, never as foreign", async () => {
    const procRoot = makeTempDir("proc-");
    const project = makeTempDir("checkout-a-");
    linkProcessCwd(procRoot, 3001, project);
    // 3003 has no proc entry at all: exited between pgrep and readlink, or another uid.
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3003]));

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: [project],
      procRoot,
    });

    expect(inventory.pids).toEqual([3001, 3003]);
    expect(inventory.unattributedPids).toEqual([3003]);
    expect(inventory.foreignPids).toEqual([]);
    expect(inventory.scoped).toBe(true);
  });

  it("reports the scan unscoped and changes nothing where no proc table exists (macOS shape)", async () => {
    const project = makeTempDir("checkout-a-");
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: [project],
      procRoot: join(REAL_TMP, "fusion-proc-absent-7q2m"),
    });

    expect(inventory.pids).toEqual([3001, 3002]);
    expect(inventory.foreignPids).toEqual([]);
    expect(inventory.unattributedPids).toEqual([3001, 3002]);
    expect(inventory.scoped).toBe(false);
  });

  it("treats an all-empty scope list as a misconfiguration: unscoped, warned, never a silent no-op", async () => {
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inventory = await findVitestProcessInventory({
        execFileImpl: impl,
        scopeRoots: [],
        procRoot: makeTempDir("proc-"),
      });

      expect(inventory.pids).toEqual([3001]);
      expect(inventory.scoped).toBe(false);
      expect(warnSpy.mock.calls.map((call) => String(call[0])).join(" ")).toContain("unscoped");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("stays unscoped and silent when no scope roots were requested at all", async () => {
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inventory = await findVitestProcessInventory({ execFileImpl: impl });

      expect(inventory.pids).toEqual([3001, 3002]);
      expect(inventory.scoped).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("findVitestProcessIds delegates, so a scoped caller never sees a foreign pid", async () => {
    const procRoot = makeTempDir("proc-");
    const projectA = makeTempDir("checkout-a-");
    const projectB = makeTempDir("checkout-b-");
    linkProcessCwd(procRoot, 3001, projectA);
    linkProcessCwd(procRoot, 3002, projectB);
    const { impl } = makeExecFileMock(nodeCandidateOutput([3001, 3002]));

    await expect(
      findVitestProcessIds({ execFileImpl: impl, scopeRoots: [projectA], procRoot }),
    ).resolves.toEqual([3001]);
  });

  it("still spares non-node wrapper shells and monitors while attributing the survivors", async () => {
    const procRoot = makeTempDir("proc-");
    const project = makeTempDir("checkout-a-");
    const other = makeTempDir("checkout-b-");
    linkProcessCwd(procRoot, 3001, project);
    linkProcessCwd(procRoot, 3002, other);
    const { impl } = makeExecFileMock({
      pgrep: "3001\n3002\n3003\n",
      ps: ["  3001 node", "  3002 node", "  3003 zsh"].join("\n"),
    });

    const inventory = await findVitestProcessInventory({
      execFileImpl: impl,
      scopeRoots: [project, ...resolveWorktreesDirCandidates(project, undefined)],
      procRoot,
    });

    expect(inventory.pids).toEqual([3001]);
    expect(inventory.foreignPids).toEqual([3002]);
  });
});
