import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
FNXC:VitestKillScope 2026-11-21-02:14 (RUFU-760):
The TUI's memory-pressure auto-kill and its [k] shortcut SIGKILL whatever the vitest probe returns.
Before this card that set was machine-wide, so a test run started from a DIFFERENT checkout died
while this board was under pressure. These cases hold the TUI to the same invariant the dashboard
route is held to, at the TUI's own seam: the real `findVitestProcessInventory`, the real procfs link
read, and a `process.kill` spy.

Two substitutions make that honest and host-independent:
  - `execFile` is stubbed so no real `pgrep`/`ps` runs (the TUI never injects `execFileImpl`), and
  - the proc table is relocated into a temp root via `FUSION_PROC_ROOT`, which `resolveProcRoot()`
    honors under vitest only. A synthetic pid such as 4101 exists on some runners and not others,
    and a test whose verdict depends on that is the flake this repo quarantines on sight.
    Nothing here reads the host's process table.
*/
const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const { DashboardTUI } = await import("../controller.js");
const defaultCallbacks = {
  onRefreshStats: async () => {},
  onClearLogs: () => {},
  onTogglePause: async (paused: boolean) => ({
    maxConcurrent: 1,
    maxWorktrees: 2,
    autoMerge: false,
    mergeStrategy: "direct" as const,
    pollIntervalMs: 60_000,
    enginePaused: paused,
    globalPause: false,
    remoteActiveProvider: null,
    remoteShortLivedEnabled: false,
    remoteShortLivedTtlMs: 900_000,
  }),
};

const cleanupDirs: string[] = [];
let probeProcRoot = "";

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** Lay down `<procRoot>/<pid>/cwd -> target`, the procfs(5) shape the resolver reads. */
function linkProcessCwd(pid: number, target: string): void {
  const pidDir = join(probeProcRoot, String(pid));
  mkdirSync(pidDir, { recursive: true });
  symlinkSync(target, join(pidDir, "cwd"));
}

/** Serve one scan: `pgrep -f vitest` returns pids, then `ps -o pid=,comm=` says all are node. */
function stubProbe(pids: number[]): void {
  execFileMock
    .mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, out?: string) => void) => {
      cb(null, `${pids.map((pid) => String(pid)).join("\n")}\n`);
    })
    .mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, out?: string) => void) => {
      cb(null, pids.map((pid) => `  ${pid} node`).join("\n"));
    });
}

function makeController(projectPath: string | null, worktreesDir?: string): InstanceType<typeof DashboardTUI> {
  const controller = new DashboardTUI();
  controller.setCallbacks({
    ...defaultCallbacks,
    onResolveWorktreesDir: worktreesDir === undefined ? undefined : async () => worktreesDir,
  });
  if (projectPath) controller.setBoardScopedProjectPath(projectPath);
  return controller;
}

function loggedMessages(controller: InstanceType<typeof DashboardTUI>): string {
  return controller.getSnapshot().logEntries.map((entry) => entry.message).join("\n");
}

beforeAll(() => {
  probeProcRoot = makeDir("tui-vitest-kill-proc-");
  process.env.FUSION_PROC_ROOT = probeProcRoot;
});

afterAll(() => {
  delete process.env.FUSION_PROC_ROOT;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  execFileMock.mockReset();
});

describe("DashboardTUI.killVitestProcesses — checkout attribution", () => {
  it("spares a vitest worker whose cwd provably belongs to another checkout", async () => {
    const projectA = makeDir("tui-checkout-a-");
    const projectB = makeDir("tui-checkout-b-");
    mkdirSync(join(projectA, "packages", "core"), { recursive: true });
    linkProcessCwd(4101, join(projectA, "packages", "core"));
    linkProcessCwd(4102, projectB);
    stubProbe([4101, 4102]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await makeController(projectA).killVitestProcesses();

    expect(result).toEqual({ killed: 1, pids: [4101] });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(4101, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(4102, "SIGKILL");
    killSpy.mockRestore();
  });

  it("explains a suppressed kill in the log an operator reads", async () => {
    const projectA = makeDir("tui-checkout-a-");
    const projectB = makeDir("tui-checkout-b-");
    linkProcessCwd(4111, projectB);
    stubProbe([4111]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = makeController(projectA);

    const result = await controller.killVitestProcesses();

    expect(result).toEqual({ killed: 0, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
    // A kill that did nothing must say why, or "No vitest processes found." reads like a false claim.
    expect(loggedMessages(controller)).toContain("cwd is outside this project's checkout");
    killSpy.mockRestore();
  });

  it("brings a worker under a configured worktreesDir into scope, and only via the host callback", async () => {
    const project = makeDir("tui-checkout-a-");
    const configuredRoot = makeDir("tui-configured-worktrees-");
    const worktreeDir = join(configuredRoot, "rufu-1");
    mkdirSync(worktreeDir, { recursive: true });
    linkProcessCwd(4121, worktreeDir);

    // A configured `worktreesDir` lives OUTSIDE the checkout, so the project root alone cannot cover
    // it: only the value read from the board's own project store puts this worker in scope.
    stubProbe([4121]);
    let killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const unhosted = await makeController(project).killVitestProcesses();
    expect(unhosted).toEqual({ killed: 0, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();

    stubProbe([4121]);
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const hosted = await makeController(project, configuredRoot).killVitestProcesses();
    expect(hosted).toEqual({ killed: 1, pids: [4121] });
    expect(killSpy).toHaveBeenCalledWith(4121, "SIGKILL");
    killSpy.mockRestore();
  });

  it("keeps a default-layout task worktree under the checkout in scope", async () => {
    const project = makeDir("tui-checkout-a-");
    const worktreeDir = join(project, ".fusion", "worktrees", "rufu-2");
    mkdirSync(worktreeDir, { recursive: true });
    linkProcessCwd(4131, worktreeDir);
    stubProbe([4131]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await makeController(project).killVitestProcesses();

    expect(result).toEqual({ killed: 1, pids: [4131] });
    killSpy.mockRestore();
  });

  it("keeps an unattributable candidate killable — unknown cwd is not foreign ownership", async () => {
    const project = makeDir("tui-checkout-a-");
    // No proc entry for 4151: another uid, or it exited between pgrep and the link read.
    stubProbe([4151]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await makeController(project).killVitestProcesses();

    expect(result).toEqual({ killed: 1, pids: [4151] });
    expect(killSpy).toHaveBeenCalledWith(4151, "SIGKILL");
    killSpy.mockRestore();
  });

  it("scopes by the launch directory when the board has no selected project", async () => {
    const launchCwd = process.cwd();
    const other = makeDir("tui-checkout-other-");
    linkProcessCwd(4161, launchCwd);
    linkProcessCwd(4162, join(other, "packages"));
    stubProbe([4161, 4162]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await makeController(null).killVitestProcesses();

    expect(result).toEqual({ killed: 1, pids: [4161] });
    killSpy.mockRestore();
  });
});
