// @vitest-environment node
/**
 * RUFU-760: the attribution primitive behind every scoped process probe.
 *
 * These tests drive the REAL link read against a temp-dir proc fixture built from REAL symlinks —
 * no real process table, no polling, no injected fake of the attribution decision itself. The only
 * unforgeable kernel shape (`/proc/<pid>/cwd` → `<path> (deleted)`) is exercised through the
 * documented `readlinkImpl` seam, because a fixture cannot make the kernel append that suffix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FUSION_PROC_ROOT_ENV,
  isCwdAttributedTo,
  isProcTableAvailable,
  readProcessCwd,
  readProcessCwds,
  resolveProcRoot,
} from "../process/proc-cwd.js";

const REAL_TMP = realpathSync(tmpdir());
const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(REAL_TMP, prefix));
  createdDirs.push(dir);
  return dir;
}

/** Lay down `<procRoot>/<pid>/cwd -> target` exactly as procfs presents a process's cwd. */
function linkProcessCwd(procRoot: string, pid: number, target: string): void {
  const pidDir = join(procRoot, String(pid));
  mkdirSync(pidDir, { recursive: true });
  symlinkSync(target, join(pidDir, "cwd"));
}

const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [FUSION_PROC_ROOT_ENV, "VITEST"];

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = envBackup[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveProcRoot", () => {
  it("takes the explicit option first, so a caller can pin the tree it measures", () => {
    process.env.VITEST = "true";
    process.env[FUSION_PROC_ROOT_ENV] = makeTempDir("proc-env-");
    expect(resolveProcRoot("/pinned/proc")).toBe("/pinned/proc");
  });

  it("honors the relocation inside a vitest run and ignores it the moment the flag is deleted", () => {
    const relocated = makeTempDir("proc-env-");
    process.env.VITEST = "true";
    process.env[FUSION_PROC_ROOT_ENV] = relocated;
    expect(resolveProcRoot()).toBe(relocated);

    // The production shape: the env survives in the operator's shell but no test runner is active.
    // Asserted with the flag DELETED, not set to "false", because that is the host state a stray
    // env var actually has outside CI.
    delete process.env.VITEST;
    expect(resolveProcRoot()).toBe("/proc");
  });

  it("ignores a non-true VITEST value and an empty relocation", () => {
    process.env.VITEST = "false";
    process.env[FUSION_PROC_ROOT_ENV] = "/should-be-ignored";
    expect(resolveProcRoot()).toBe("/proc");

    process.env.VITEST = "true";
    process.env[FUSION_PROC_ROOT_ENV] = "";
    expect(resolveProcRoot()).toBe("/proc");
  });

  it("defaults to /proc with nothing configured", () => {
    delete process.env.VITEST;
    delete process.env[FUSION_PROC_ROOT_ENV];
    expect(resolveProcRoot()).toBe("/proc");
  });
});

describe("isProcTableAvailable", () => {
  it("answers false for a proc root that does not exist (macOS/Windows shape)", () => {
    expect(isProcTableAvailable(join(REAL_TMP, "fusion-proc-absent-9x7y"))).toBe(false);
  });

  it("answers true for an existing proc root", () => {
    expect(isProcTableAvailable(makeTempDir("proc-present-"))).toBe(true);
  });
});

describe("readProcessCwd", () => {
  it("returns the link target for a pid with a proc cwd entry", () => {
    const procRoot = makeTempDir("proc-");
    const projectRoot = makeTempDir("checkout-a-");
    linkProcessCwd(procRoot, 3001, projectRoot);

    expect(readProcessCwd(3001, { procRoot })).toBe(projectRoot);
  });

  it("returns null for a pid with no proc entry, never an invented path", () => {
    const procRoot = makeTempDir("proc-");
    expect(readProcessCwd(3099, { procRoot })).toBeNull();
  });

  it("strips the kernel's deleted-cwd suffix so a removed worktree still attributes to its root", () => {
    const worktreeDir = "/home/dev/repo/.fusion/worktrees/rufu-1234";
    const readlinkImpl = (path: string): string => {
      expect(path).toBe(join("/fixture/proc", "3004", "cwd"));
      return `${worktreeDir}${" (deleted)"}`;
    };

    const cwd = readProcessCwd(3004, { procRoot: "/fixture/proc", readlinkImpl });

    expect(cwd).toBe(worktreeDir);
    expect(isCwdAttributedTo(cwd!, ["/home/dev/repo/.fusion/worktrees"])).toBe(true);
  });

  it("refuses a non-positive pid without touching the filesystem", () => {
    const readlinkImpl = (): string => {
      throw new Error("must not be called");
    };
    expect(readProcessCwd(0, { procRoot: "/fixture/proc", readlinkImpl })).toBeNull();
    expect(readProcessCwd(-7, { procRoot: "/fixture/proc", readlinkImpl })).toBeNull();
  });

  it("performs exactly one direct link read per pid", () => {
    const procRoot = makeTempDir("proc-");
    linkProcessCwd(procRoot, 3010, makeTempDir("checkout-"));
    const seen: string[] = [];
    const readlinkImpl = (path: string): string => {
      seen.push(path);
      return readlinkSync(path);
    };

    expect(readProcessCwd(3010, { procRoot, readlinkImpl })).not.toBeNull();
    expect(seen).toEqual([join(procRoot, "3010", "cwd")]);
  });
});

describe("readProcessCwds", () => {
  it("splits readable cwds from unattributable pids and keeps input order", () => {
    const procRoot = makeTempDir("proc-");
    const projectRoot = makeTempDir("checkout-a-");
    const otherCheckout = makeTempDir("checkout-b-");
    linkProcessCwd(procRoot, 3001, projectRoot);
    linkProcessCwd(procRoot, 3002, otherCheckout);

    const table = readProcessCwds([3002, 3003, 3001], { procRoot });

    expect([...table.cwds.entries()]).toEqual([[3002, otherCheckout], [3001, projectRoot]]);
    expect(table.unattributedPids).toEqual([3003]);
    expect(table.procTableAvailable).toBe(true);
  });

  it("reports every pid unattributed and the proc table unavailable when the proc root is absent", () => {
    const table = readProcessCwds([3001, 3002], { procRoot: join(REAL_TMP, "fusion-proc-absent-4k9z") });

    expect(table.cwds.size).toBe(0);
    expect(table.unattributedPids).toEqual([3001, 3002]);
    expect(table.procTableAvailable).toBe(false);
  });

  it("treats a dangling link as a readable cwd with the path it names", () => {
    const procRoot = makeTempDir("proc-");
    const removedWorktree = join(makeTempDir("worktrees-"), "rufu-42");
    linkProcessCwd(procRoot, 3005, removedWorktree);
    // The fixture removes the directory the link names; a plain readlink still reports its path.
    rmSync(removedWorktree, { recursive: true, force: true });

    expect(readProcessCwd(3005, { procRoot })).toBe(removedWorktree);
  });
});

describe("isCwdAttributedTo", () => {
  it("counts a cwd that IS a scope root as inside, so a runner started at the repo root stays in scope", () => {
    expect(isCwdAttributedTo("/home/dev/repo", ["/home/dev/repo"])).toBe(true);
  });

  it("counts a descendant cwd as inside, including a managed task worktree", () => {
    expect(isCwdAttributedTo("/home/dev/repo/packages/core", ["/home/dev/repo"])).toBe(true);
    expect(
      isCwdAttributedTo("/home/dev/repo/.fusion/worktrees/rufu-1", [
        "/home/dev/repo",
        "/home/dev/repo/.fusion/worktrees",
      ]),
    ).toBe(true);
  });

  it("rejects another checkout's directory and a parent directory", () => {
    expect(isCwdAttributedTo("/home/dev/other-checkout", ["/home/dev/repo"])).toBe(false);
    expect(isCwdAttributedTo("/home/dev", ["/home/dev/repo"])).toBe(false);
  });

  it("matches any supplied root, so a configured worktrees dir keeps its own workers in scope", () => {
    expect(
      isCwdAttributedTo("/srv/wt/rufu-9/packages/cli", [
        "/home/dev/repo",
        "/home/dev/repo/.fusion/worktrees",
        "/srv/wt",
      ]),
    ).toBe(true);
  });

  it("answers false for an empty root list or an empty cwd rather than defaulting to inside", () => {
    expect(isCwdAttributedTo("/home/dev/repo", [])).toBe(false);
    expect(isCwdAttributedTo("", ["/home/dev/repo"])).toBe(false);
  });

  it("resolves relative and normalized spellings against the same roots", () => {
    const projectRoot = makeTempDir("checkout-a-");
    expect(isCwdAttributedTo(join(projectRoot, "packages", ".."), [projectRoot])).toBe(true);
    expect(isCwdAttributedTo(resolve(projectRoot), [join(projectRoot, ".")])).toBe(true);
  });
});

describe("the host proc table itself", () => {
  const linux = process.platform === "linux";
  const itLinux = linux ? it : it.skip;

  itLinux("resolves this runner's own cwd, proving the reader uses /proc(5) and not only fixtures", () => {
    delete process.env[FUSION_PROC_ROOT_ENV];
    const cwd = readProcessCwd(process.pid);

    expect(cwd).not.toBeNull();
    expect(realpathSync(cwd as string)).toBe(realpathSync(process.cwd()));
  });
});
