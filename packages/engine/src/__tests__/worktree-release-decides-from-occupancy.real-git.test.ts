/*
STAS-397 guard: an automatic checkout release decides from OCCUPANCY only.

Occupancy is content git counts as occupying a checkout - a tracked modification, a staged
change, or an untracked path. A git-IGNORED path is not occupancy, so a checkout whose only
content is ignored build output releases, and the case below named `ignored-only` IS the
invariant this file installs. It is the state seven board cards sat in on 2026-08-11 while a
half-hourly sweep retried a removal that could never succeed: `--untracked-files=all` empty,
the tip an ancestor of the integration ref, zero commits ahead, and `.venv/` plus
`stashai.egg-info/` on disk - a checkout produced by following this repository's own
documented development procedure.

The three refusal cases beside it are the other half of the contract and are NOT negotiable:
each differs from the released case by exactly one porcelain class, and each must keep the
content it is refusing to throw away. Weakening or deleting one of them to make a suite green
trades the wedge for data loss.

Like the real-git suites beside it, this file deliberately mocks nothing: a mock of the status
probe would reproduce the defect's own blind spot, because the bug lives in how the real
porcelain read is classified.
*/
import { exec, spawnSync } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RemovalReason, removeWorktree } from "../worktree/worktree-backend.js";
import type { GitAuditInput, RunAuditor } from "../util/run-audit.js";

const execAsync = promisify(exec);

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/*
The wedge shape, reproduced on a throwaway repository: `.venv/` and a `*.egg-info/` directory
are the two ignored artifacts the board's cards actually held, one of them a name the retired
basename allowlist knew and the other a name it never could have known.
*/
const IGNORED_ARTIFACTS = [".venv/lib/sitecustomize.py", "stashai.egg-info/PKG-INFO"];

async function createWedgedFixture(lane: string): Promise<{
  repoDir: string;
  worktreePath: string;
  auditEvents: GitAuditInput[];
}> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "stas-397-release-"));
  tempDirs.push(repoDir);
  await run('git init -q -b main', repoDir);
  await run('git config user.email "engine-test@example.com" && git config user.name "Engine Test"', repoDir);
  await writeFile(path.join(repoDir, ".gitignore"), ".venv/\n*.egg-info/\n.env\n", "utf-8");
  await writeFile(path.join(repoDir, "README.md"), "# trunk\n", "utf-8");
  await run("git add -A && git commit -qm init", repoDir);
  await run("git branch fusion/wedged", repoDir);
  // The lane branch must be a true ANCESTOR of the integration ref, as it is on a card whose
  // work already landed: trunk moves past it, so the lane holds zero commits of its own.
  await writeFile(path.join(repoDir, "LANDED.md"), "# the lane work, landed on trunk\n", "utf-8");
  await run("git add LANDED.md && git commit -qm 'land the lane work on trunk'", repoDir);

  await mkdir(path.join(repoDir, ".worktrees"), { recursive: true });
  const worktreePath = path.join(repoDir, ".worktrees", lane);
  await run(`git worktree add -q ${JSON.stringify(worktreePath)} fusion/wedged`, repoDir);
  for (const artifact of IGNORED_ARTIFACTS) {
    const target = path.join(worktreePath, artifact);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "regenerable build output\n", "utf-8");
  }

  const auditEvents: GitAuditInput[] = [];
  return { repoDir, worktreePath, auditEvents };
}

/** The engine's own automatic release entry point, with the reason the recovery sweep passes. */
function releaseCheckout(fixture: { repoDir: string; worktreePath: string; auditEvents: GitAuditInput[] }) {
  return removeWorktree({
    rootDir: fixture.repoDir,
    worktreePath: fixture.worktreePath,
    settings: {},
    taskId: "STAS-397",
    reason: RemovalReason.SelfHealingBranchConflict,
    audit: { git: async (event: GitAuditInput) => { fixture.auditEvents.push(event); } } as unknown as RunAuditor,
  });
}

/*
Every fixture states its own premise, so a fixture that silently stopped resembling the wedge
fails here instead of quietly proving nothing.
*/
async function assertWedgedPremise(fixture: { repoDir: string; worktreePath: string }): Promise<void> {
  const expandedUntracked = await run("git status --porcelain --untracked-files=all", fixture.worktreePath);
  expect(expandedUntracked, "fixture holds no untracked content").toBe("");
  const ahead = await run("git rev-list --count refs/heads/main..HEAD", fixture.worktreePath);
  expect(ahead, "fixture holds no commits of its own").toBe("0");
  await run("git merge-base --is-ancestor HEAD refs/heads/main", fixture.worktreePath);
  const ignored = await run("git status --porcelain=v1 --ignored=matching --untracked-files=normal", fixture.worktreePath);
  const ignoredLines = ignored.split("\n").filter((line) => line.startsWith("!! "));
  expect(ignoredLines.length).toBeGreaterThanOrEqual(1);
  expect(ignoredLines.some((line) => line.includes(".venv/"))).toBe(true);
  expect(ignoredLines.some((line) => line.includes("stashai.egg-info/"))).toBe(true);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describeIfGit("STAS-397 automatic checkout release decides from occupancy only", () => {
  it("releases a checkout whose only content is ignored build output, recording the discard", async () => {
    const fixture = await createWedgedFixture("ignored-only");
    await assertWedgedPremise(fixture);

    await expect(releaseCheckout(fixture)).resolves.toMatchObject({ removed: true });

    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(await run("git worktree list --porcelain", fixture.repoDir)).not.toContain(fixture.worktreePath);

    const discard = fixture.auditEvents.find((event) => event.type === "worktree:removal-discarded-ignored-content");
    expect(discard, "the release names what it threw away").toBeDefined();
    const discardedPaths = (discard?.metadata as { discardedIgnoredPaths?: string[] }).discardedIgnoredPaths ?? [];
    expect(discardedPaths).toEqual(expect.arrayContaining([".venv/", "stashai.egg-info/"]));
  });

  it("refuses and preserves a checkout holding one tracked modification", async () => {
    const fixture = await createWedgedFixture("tracked-modified");
    await writeFile(path.join(fixture.worktreePath, "README.md"), "# trunk\n\nwork in progress\n", "utf-8");
    const occupied = await run("git status --porcelain --untracked-files=all", fixture.worktreePath);
    expect(occupied).toContain("README.md");

    await expect(releaseCheckout(fixture)).rejects.toThrow(/preserving .*: uncommitted or ignored content present/);

    expect(await readFile(path.join(fixture.worktreePath, "README.md"), "utf-8")).toContain("work in progress");
    expect(await pathExists(fixture.worktreePath)).toBe(true);
  });

  it("refuses and preserves a checkout holding one untracked file", async () => {
    const fixture = await createWedgedFixture("untracked");
    await writeFile(path.join(fixture.worktreePath, "notes.md"), "unfinished work\n", "utf-8");

    await expect(releaseCheckout(fixture)).rejects.toThrow(/preserving .*: uncommitted or ignored content present/);

    expect(await readFile(path.join(fixture.worktreePath, "notes.md"), "utf-8")).toBe("unfinished work\n");
    expect(await pathExists(fixture.worktreePath)).toBe(true);
  });

  it("refuses a checkout holding one untracked path git reports quoted", async () => {
    const fixture = await createWedgedFixture("quoted-untracked");
    await writeFile(path.join(fixture.worktreePath, 'we"ird.md'), "unfinished work\n", "utf-8");
    const occupied = await run("git status --porcelain --untracked-files=all", fixture.worktreePath);
    expect(occupied.startsWith('?? "'), "git must report this path quoted for the case to mean anything").toBe(true);

    await expect(releaseCheckout(fixture)).rejects.toThrow(/preserving .*: uncommitted or ignored content present/);

    expect(await readFile(path.join(fixture.worktreePath, 'we"ird.md'), "utf-8")).toBe("unfinished work\n");
  });
});
